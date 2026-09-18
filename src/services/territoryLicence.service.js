const pool = require("../db");
const TerritoryReservationService = require("./territoryReservation.service");
const TerritoryLicenceInventoryService = require("./territoryLicenceInventory.service");
const NetworkManagerApplicationService = require("./networkManagerApplication.service");
const {
  LICENCE_STATUS,
  PAYMENT_MODE,
  CONTRACT_DURATION_MONTHS,
  SERVICE_FEE_RATE_UNCLEARED,
  SERVICE_FEE_RATE_CLEARED,
  LEVEL_STATUS,
  LICENCE_STATUSES_HOLDING_SLOT,
} = require("../config/networkManagerTerritory.config");

/**
 * Activate a territory licence (create licence from reservation or from approved application).
 * @param {Object} params - { userId, territoryId?, reservationId?, payment_mode, terms_accepted }
 * @returns {Promise<{ licence_id: number, territory_id: number, payment_required: boolean }>}
 */
async function activateLicence(params) {
  const { userId, territoryId, reservationId, payment_mode, terms_accepted } = params;

  if (!terms_accepted) {
    throw new Error("TERMS_REQUIRED");
  }
  const mode = payment_mode === PAYMENT_MODE.CLEAR_FROM_EARNINGS ? PAYMENT_MODE.CLEAR_FROM_EARNINGS : PAYMENT_MODE.PAY_NOW;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let territoryIdResolved;
    let feeSnapshot;

    if (reservationId) {
      const reservation = await TerritoryReservationService.getValidReservation(reservationId, userId);
      if (!reservation) {
        throw new Error("RESERVATION_INVALID");
      }
      territoryIdResolved = reservation.territory_id;
      const territory = await TerritoryLicenceInventoryService.getTerritoryRow(territoryIdResolved);
      if (!territory) {
        throw new Error("TERRITORY_NOT_FOUND");
      }
      feeSnapshot = territory.licence_fee_amount;
      await TerritoryReservationService.markConverted(client, reservationId);
    } else if (territoryId) {
      territoryIdResolved = parseInt(territoryId, 10);
      const approved = await NetworkManagerApplicationService.getApprovedApplicationForTerritory(
        userId,
        territoryIdResolved
      );
      if (!approved) {
        throw new Error("NO_APPROVED_APPLICATION");
      }
      const territory = await TerritoryLicenceInventoryService.getTerritoryRow(territoryIdResolved);
      if (!territory) {
        throw new Error("TERRITORY_NOT_FOUND");
      }
      feeSnapshot = territory.licence_fee_amount;
    } else {
      throw new Error("RESERVATION_OR_TERRITORY_REQUIRED");
    }

    const existing = await client.query(
      `SELECT id FROM territory_licences
       WHERE territory_id = $1 AND user_id = $2 AND licence_status = ANY($3::text[])`,
      [territoryIdResolved, userId, LICENCE_STATUSES_HOLDING_SLOT]
    );
    if (existing.rowCount > 0) {
      throw new Error("ALREADY_LICENSED");
    }

    const activeCount = await client.query(
      `SELECT COUNT(*)::int AS c FROM territory_licences WHERE territory_id = $1 AND licence_status = ANY($2::text[])`,
      [territoryIdResolved, LICENCE_STATUSES_HOLDING_SLOT]
    );
    const territoryRow = await TerritoryLicenceInventoryService.getTerritoryRow(territoryIdResolved);
    if (activeCount.rows[0].c >= territoryRow.max_slots) {
      throw new Error("NO_SLOTS_AVAILABLE");
    }

    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + CONTRACT_DURATION_MONTHS);

    const licenceBalanceRemaining =
      mode === PAYMENT_MODE.CLEAR_FROM_EARNINGS ? feeSnapshot : 0;

    const insert = await client.query(
      `INSERT INTO territory_licences
         (territory_id, user_id, licence_fee_amount_snapshot, payment_mode, licence_status,
          licence_balance_remaining, contract_start_date, contract_end_date, auto_renew_enabled, identity_verified, non_transferable, level_status, service_fee_rate_current)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, FALSE, TRUE, $9, $10)
       RETURNING id`,
      [
        territoryIdResolved,
        userId,
        feeSnapshot,
        mode,
        LICENCE_STATUS.ACTIVE,
        licenceBalanceRemaining,
        startDate.toISOString().slice(0, 10),
        endDate.toISOString().slice(0, 10),
        LEVEL_STATUS.L1,
        SERVICE_FEE_RATE_UNCLEARED,
      ]
    );
    const licenceId = insert.rows[0].id;

    await client.query("COMMIT");

    return {
      licence_id: licenceId,
      territory_id: territoryIdResolved,
      payment_required: mode === PAYMENT_MODE.PAY_NOW,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get licences for the current user.
 */
async function getMyLicences(userId) {
  const result = await pool.query(
    `SELECT tl.*, tli.region_name, tli.country_code
     FROM territory_licences tl
     JOIN territory_licence_inventory tli ON tli.id = tl.territory_id
     WHERE tl.user_id = $1
     ORDER BY tl.created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    territory_id: row.territory_id,
    territory_name: row.region_name,
    country: row.country_code,
    licence_status: row.licence_status,
    licence_balance_remaining: row.licence_balance_remaining,
    contract_start_date: row.contract_start_date,
    contract_end_date: row.contract_end_date,
    payment_mode: row.payment_mode,
    level_status: row.level_status || "L1",
    service_fee_rate_current: row.service_fee_rate_current != null ? Number(row.service_fee_rate_current) : 0.2,
  }));
}

/**
 * Get licence by id if it belongs to user.
 */
async function getLicenceForUser(licenceId, userId) {
  const result = await pool.query(
    `SELECT * FROM territory_licences WHERE id = $1 AND user_id = $2`,
    [licenceId, userId]
  );
  return result.rowCount ? result.rows[0] : null;
}

/**
 * Simulate payment: set licence_balance_remaining = 0 and add ledger entry.
 */
async function recordLicencePayment(licenceId, userId, paymentReference = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lic = await getLicenceForUser(licenceId, userId);
    if (!lic) {
      throw new Error("LICENCE_NOT_FOUND");
    }
    if (lic.licence_balance_remaining <= 0) {
      throw new Error("LICENCE_ALREADY_PAID");
    }
    const amount = lic.licence_balance_remaining;
    await client.query(
      `UPDATE territory_licences
       SET licence_balance_remaining = 0, licence_status = $1, level_status = $2, service_fee_rate_current = $3, updated_at = NOW()
       WHERE id = $4`,
      [LICENCE_STATUS.CLEARED, LEVEL_STATUS.L2, SERVICE_FEE_RATE_CLEARED, licenceId]
    );
    await client.query(
      `INSERT INTO credit_ledger (user_id, role, territory_id, network_licence_id, entry_type, amount, metadata_json)
       VALUES ($1, 'network_manager', $2, $3, 'LICENCE_PAID', $4, $5)`,
      [
        userId,
        lic.territory_id,
        licenceId,
        amount,
        JSON.stringify({ payment_reference: paymentReference || "SIMULATED" }),
      ]
    );
    await client.query("COMMIT");
    return { amount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Suspend a licence (admin).
 */
async function suspendLicence(licenceId) {
  const result = await pool.query(
    `UPDATE territory_licences SET licence_status = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
    [LICENCE_STATUS.SUSPENDED, licenceId]
  );
  return result.rowCount > 0;
}

module.exports = {
  activateLicence,
  getMyLicences,
  getLicenceForUser,
  recordLicencePayment,
  suspendLicence,
};
