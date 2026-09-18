const pool = require("../db");
const TerritoryLicenceInventoryService = require("./territoryLicenceInventory.service");
const TerritoryReservationService = require("./territoryReservation.service");

/**
 * Submit or update Network Manager application (Agreement + Identity).
 * New flow: territory_id (+ optional reservation_id), applicant_profile, docs.
 * @param {Object} params - { userId, territory_id?, reservation_id?, territory_name?, applicant_profile?, docs?, avatar_url? }
 * @param {Object} client - pg client (for transaction)
 * @returns {Promise<{ application: object, isNew: boolean }>}
 */
async function submitApplication(client, params) {
  const {
    userId,
    territory_id,
    reservation_id,
    territory_name,
    applicant_profile,
    docs,
    avatar_url,
  } = params;

  let effectiveTerritoryName = territory_name;
  let effectiveTerritoryId = territory_id || null;
  let effectiveReservationId = reservation_id || null;
  let applicantProfileJson = applicant_profile ? JSON.stringify(applicant_profile) : null;
  let docsJson = docs ? JSON.stringify(docs) : null;

  if (territory_id) {
    const territory = await TerritoryLicenceInventoryService.getTerritoryRow(territory_id);
    if (!territory) {
      throw new Error("TERRITORY_NOT_FOUND");
    }
    effectiveTerritoryName = territory.region_name;
    if (reservation_id) {
      const reservation = await TerritoryReservationService.getValidReservation(reservation_id, userId);
      if (!reservation) {
        throw new Error("RESERVATION_INVALID");
      }
      if (Number(reservation.territory_id) !== Number(territory_id)) {
        throw new Error("RESERVATION_TERRITORY_MISMATCH");
      }
    }
  } else if (!territory_name || !territory_name.trim()) {
    throw new Error("TERRITORY_REQUIRED");
  }

  if (effectiveTerritoryId != null) {
    const existingForTerritory = await client.query(
      "SELECT id, account_status FROM network_manager_applications WHERE user_id = $1 AND territory_id = $2",
      [userId, effectiveTerritoryId]
    );
    if (existingForTerritory.rowCount > 0) {
      const app = existingForTerritory.rows[0];
      if (app.account_status !== "pending") {
        throw new Error("APPLICATION_ALREADY_SUBMITTED");
      }
      await client.query(
        `UPDATE network_manager_applications
         SET reservation_id = $1, territory_name = $2, applicant_profile_json = $3, docs_json = $4,
             avatar_url = COALESCE($5, avatar_url), updated_at = NOW()
         WHERE user_id = $6 AND territory_id = $7`,
        [
          effectiveReservationId,
          effectiveTerritoryName,
          applicantProfileJson,
          docsJson,
          avatar_url || null,
          userId,
          effectiveTerritoryId,
        ]
      );
      const updated = await client.query(
        "SELECT * FROM network_manager_applications WHERE user_id = $1 AND territory_id = $2",
        [userId, effectiveTerritoryId]
      );
      return { application: updated.rows[0], isNew: false };
    }
  } else {
    const existingLegacy = await client.query(
      "SELECT id, account_status FROM network_manager_applications WHERE user_id = $1 AND territory_id IS NULL",
      [userId]
    );
    if (existingLegacy.rowCount > 0) {
      const app = existingLegacy.rows[0];
      if (app.account_status !== "pending") {
        throw new Error("APPLICATION_ALREADY_SUBMITTED");
      }
      await client.query(
        `UPDATE network_manager_applications
         SET territory_name = $1, applicant_profile_json = $2, docs_json = $3,
             avatar_url = COALESCE($4, avatar_url), updated_at = NOW()
         WHERE user_id = $5 AND territory_id IS NULL`,
        [
          effectiveTerritoryName,
          applicantProfileJson,
          docsJson,
          avatar_url || null,
          userId,
        ]
      );
      const updated = await client.query(
        "SELECT * FROM network_manager_applications WHERE user_id = $1 AND territory_id IS NULL",
        [userId]
      );
      return { application: updated.rows[0], isNew: false };
    }
  }

  if (effectiveTerritoryId != null) {
    const existingLicence = await client.query(
      `SELECT 1 FROM territory_licences
       WHERE user_id = $1 AND territory_id = $2 AND licence_status = ANY(ARRAY['ACTIVE', 'CLEARED'])`,
      [userId, effectiveTerritoryId]
    );
    if (existingLicence.rowCount > 0) {
      throw new Error("ALREADY_LICENSED_FOR_TERRITORY");
    }
  }

  const insert = await client.query(
    `INSERT INTO network_manager_applications
       (user_id, territory_id, reservation_id, territory_name, avatar_url,
        applicant_profile_json, docs_json, account_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING *`,
    [
      userId,
      effectiveTerritoryId,
      effectiveReservationId,
      effectiveTerritoryName,
      avatar_url || null,
      applicantProfileJson,
      docsJson,
    ]
  );
  return { application: insert.rows[0], isNew: true };
}

/**
 * Get all applications for user with territory display info (supports territory expansion).
 */
async function getMyApplications(userId) {
  const result = await pool.query(
    `SELECT nma.*, tli.region_name AS territory_region_name, tli.country_code AS territory_country
     FROM network_manager_applications nma
     LEFT JOIN territory_licence_inventory tli ON tli.id = nma.territory_id
     WHERE nma.user_id = $1
     ORDER BY nma.created_at DESC`,
    [userId]
  );
  return result.rows;
}

/** @deprecated Use getMyApplications. Returns first application for backward compatibility. */
async function getMyApplication(userId) {
  const rows = await getMyApplications(userId);
  return rows.length ? rows[0] : null;
}

/**
 * Get approved application for user and territory (for activate without reservation).
 * Supports: (1) territory_id exact match, (2) legacy apps (territory_id NULL) matched by territory_name
 * vs region_name (case-insensitive, trimmed).
 */
async function getApprovedApplicationForTerritory(userId, territoryId) {
  const result = await pool.query(
    `SELECT * FROM network_manager_applications
     WHERE user_id = $1
       AND account_status = 'approved'
       AND (
         territory_id = $2
         OR (
           territory_id IS NULL
           AND TRIM(LOWER(COALESCE(territory_name, ''))) = TRIM(LOWER(COALESCE((SELECT region_name FROM territory_licence_inventory WHERE id = $2), '')))
         )
       )`,
    [userId, territoryId]
  );
  return result.rowCount ? result.rows[0] : null;
}

module.exports = {
  submitApplication,
  getMyApplication,
  getMyApplications,
  getApprovedApplicationForTerritory,
};
