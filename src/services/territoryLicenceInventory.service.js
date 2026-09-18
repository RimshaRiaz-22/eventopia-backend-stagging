const pool = require("../db");
const {
  UI_STATUS,
  TERRITORY_STATUS,
  LICENCE_STATUSES_HOLDING_SLOT,
} = require("../config/networkManagerTerritory.config");

/**
 * Get list of territory licence inventory with computed availability and slots.
 * @param {Object} options - { country, status (all|ACTIVE|LOCKED), search }
 * @returns {Promise<Array>} territories with id, name, country, licence_fee, contract_months, max_slots, active_slots, remaining_slots, ui_status, available_from_label
 */
async function getTerritoriesWithAvailability(options = {}) {
  const { country, status: statusFilter = "all", search = "" } = options;

  let where = ["1=1"];
  const params = [];
  let n = 1;

  if (country) {
    where.push(`tli.country_code = $${n++}`);
    params.push(country);
  }
  if (statusFilter !== "all") {
    where.push(`tli.status = $${n++}`);
    params.push(statusFilter);
  }
  if (search && search.trim()) {
    where.push(`(tli.region_name ILIKE $${n} OR tli.region_slug ILIKE $${n})`);
    params.push(`%${search.trim()}%`);
    n++;
  }

  params.push(LICENCE_STATUSES_HOLDING_SLOT);
  const slotStatusesParam = `$${params.length}`;
  const sql = `
    SELECT
      tli.id,
      tli.region_name AS name,
      tli.country_code AS country,
      tli.currency,
      tli.licence_fee_amount,
      tli.contract_duration_months AS contract_months,
      tli.max_slots,
      tli.status AS territory_status,
      tli.available_from,
      COALESCE(lic_counts.active_count, 0)::int AS active_slots
    FROM territory_licence_inventory tli
    LEFT JOIN (
      SELECT territory_id, COUNT(*)::int AS active_count
      FROM territory_licences
      WHERE licence_status = ANY(${slotStatusesParam}::text[])
      GROUP BY territory_id
    ) lic_counts ON lic_counts.territory_id = tli.id
    WHERE ${where.join(" AND ")}
    ORDER BY tli.region_name
  `;

  const result = await pool.query(sql, params);
  const now = new Date();

  return result.rows.map((row) => {
    const activeSlots = row.active_slots || 0;
    const maxSlots = row.max_slots || 0;
    const remainingSlots = Math.max(0, maxSlots - activeSlots);

    let uiStatus = UI_STATUS.AVAILABLE;
    let availableFromLabel = null;

    const isLockedOrUpcoming =
      row.territory_status === TERRITORY_STATUS.LOCKED ||
      row.territory_status === TERRITORY_STATUS.UPCOMING;
    if (isLockedOrUpcoming && row.available_from) {
      const availableFrom = new Date(row.available_from);
      if (availableFrom > now) {
        uiStatus = UI_STATUS.LOCKED;
        const year = availableFrom.getFullYear();
        const month = availableFrom.toLocaleString("default", { month: "short" });
        availableFromLabel = `Available early ${year}`;
      }
    }
    if (uiStatus !== UI_STATUS.LOCKED && remainingSlots <= 0) {
      uiStatus = UI_STATUS.WAITLIST;
    }

    return {
      id: row.id,
      name: row.name,
      country: row.country,
      currency: row.currency,
      licence_fee: row.licence_fee_amount,
      contract_months: row.contract_months,
      max_slots: maxSlots,
      active_slots: activeSlots,
      remaining_slots: remainingSlots,
      ui_status: uiStatus,
      available_from_label: availableFromLabel,
    };
  });
}

/**
 * Get single territory by id with same computed fields.
 * (Id comparison is numeric: pg BIGINT can come back as string.)
 */
async function getTerritoryById(territoryId) {
  const list = await getTerritoriesWithAvailability({ status: "all" });
  const id = Number(territoryId);
  if (Number.isNaN(id) || id <= 0) return null;
  return list.find((t) => Number(t.id) === id) || null;
}

/**
 * Get raw territory row from territory_licence_inventory for summary.
 */
async function getTerritoryRow(territoryId) {
  const result = await pool.query(
    `SELECT * FROM territory_licence_inventory WHERE id = $1`,
    [territoryId]
  );
  return result.rowCount ? result.rows[0] : null;
}

/**
 * Create a new territory in territory_licence_inventory (admin only).
 * @param {Object} body - { country_code, region_name, region_slug, currency?, licence_fee_amount?, contract_duration_months?, renewal_type?, max_slots?, status?, available_from? }
 * @returns {Promise<Object|null>} created row or null if duplicate region_slug
 */
async function createTerritory(body) {
  const {
    country_code,
    region_name,
    region_slug,
    currency = "GBP",
    licence_fee_amount = 250000,
    contract_duration_months = 12,
    renewal_type = "MANUAL",
    max_slots = 12,
    status = "ACTIVE",
    available_from,
  } = body || {};

  if (!country_code || !region_name || !region_slug || !String(region_slug).trim()) {
    return { error: "country_code, region_name and region_slug are required." };
  }

  const slug = String(region_slug).trim().toLowerCase();
  const result = await pool.query(
    `INSERT INTO territory_licence_inventory (
      country_code, region_name, region_slug, currency, licence_fee_amount,
      contract_duration_months, renewal_type, max_slots, status, available_from
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      String(country_code).trim(),
      String(region_name).trim(),
      slug,
      currency || "GBP",
      Number(licence_fee_amount) || 250000,
      Number(contract_duration_months) || 12,
      renewal_type || "MANUAL",
      Number(max_slots) || 12,
      status || "ACTIVE",
      available_from == null || available_from === "" ? null : new Date(available_from),
    ]
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

module.exports = {
  getTerritoriesWithAvailability,
  getTerritoryById,
  getTerritoryRow,
  createTerritory,
};
