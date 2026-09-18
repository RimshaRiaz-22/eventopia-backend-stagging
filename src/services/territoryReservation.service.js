const pool = require("../db");
const {
  RESERVATION_TTL_MINUTES,
  RESERVATION_STATUS,
  UI_STATUS,
  LICENCE_STATUSES_HOLDING_SLOT,
} = require("../config/networkManagerTerritory.config");
const TerritoryLicenceInventoryService = require("./territoryLicenceInventory.service");

/**
 * Create a reservation for a territory (10 min hold).
 * Validates: territory AVAILABLE, user has no ACTIVE licence for this territory.
 * @param {number} territoryId
 * @param {number} userId
 * @returns {Promise<{ reservation_id: number, expires_at: Date }>}
 */
async function createReservation(territoryId, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const territory = await TerritoryLicenceInventoryService.getTerritoryById(territoryId);
    if (!territory) {
      throw new Error("TERRITORY_NOT_FOUND");
    }
    if (territory.ui_status === UI_STATUS.LOCKED) {
      throw new Error("TERRITORY_LOCKED");
    }
    if (territory.ui_status === UI_STATUS.WAITLIST) {
      throw new Error("TERRITORY_FULL");
    }

    const existingLicence = await client.query(
      `SELECT 1 FROM territory_licences
       WHERE territory_id = $1 AND user_id = $2 AND licence_status = ANY($3::text[])`,
      [territoryId, userId, LICENCE_STATUSES_HOLDING_SLOT]
    );
    if (existingLicence.rowCount > 0) {
      throw new Error("ALREADY_LICENSED");
    }

    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);
    const insert = await client.query(
      `INSERT INTO territory_reservations (territory_id, user_id, status, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, expires_at`,
      [territoryId, userId, RESERVATION_STATUS.HELD, expiresAt]
    );
    const row = insert.rows[0];

    await client.query("COMMIT");
    return {
      reservation_id: row.id,
      expires_at: row.expires_at,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Validate reservation: HELD, not expired, belongs to user.
 */
async function getValidReservation(reservationId, userId) {
  const result = await pool.query(
    `SELECT * FROM territory_reservations
     WHERE id = $1 AND user_id = $2 AND status = $3 AND expires_at > NOW()`,
    [reservationId, userId, RESERVATION_STATUS.HELD]
  );
  return result.rowCount ? result.rows[0] : null;
}

/**
 * Mark reservation as CONVERTED (after licence created).
 */
async function markConverted(client, reservationId) {
  await client.query(
    `UPDATE territory_reservations SET status = $1 WHERE id = $2`,
    [RESERVATION_STATUS.CONVERTED, reservationId]
  );
}

/**
 * Expire held reservations that are past expires_at (job).
 */
async function expireHeldReservations() {
  const result = await pool.query(
    `UPDATE territory_reservations
     SET status = $1
     WHERE status = $2 AND expires_at <= NOW()
     RETURNING id`,
    [RESERVATION_STATUS.EXPIRED, RESERVATION_STATUS.HELD]
  );
  return result.rowCount;
}

module.exports = {
  createReservation,
  getValidReservation,
  markConverted,
  expireHeldReservations,
};
