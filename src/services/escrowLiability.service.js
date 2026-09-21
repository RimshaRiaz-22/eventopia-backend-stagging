const pool = require("../db");

async function resolvePromoterProfileId(clientOrDb, promoterUserId) {
  const result = await clientOrDb.query(
    `SELECT id FROM promoter_profiles WHERE user_id = $1 LIMIT 1`,
    [promoterUserId]
  );
  return result.rows[0]?.id || null;
}

async function fetchEventEscrowContext(clientOrDb, eventId) {
  const eventResult = await clientOrDb.query(
    `SELECT id, promoter_id, territory_id
     FROM events
     WHERE id = $1
     LIMIT 1`,
    [eventId]
  );
  if (eventResult.rowCount === 0) return null;

  const event = eventResult.rows[0];
  if (!event.promoter_id || !event.territory_id) return null;

  const promoterProfileId = await resolvePromoterProfileId(clientOrDb, event.promoter_id);
  if (!promoterProfileId) return null;

  return {
    eventId: event.id,
    territoryId: event.territory_id,
    promoterProfileId,
  };
}

async function ensureEscrowLiabilityForEvent(eventId, options = {}) {
  const clientOrDb = options.client || pool;
  const context = await fetchEventEscrowContext(clientOrDb, eventId);
  if (!context) return null;

  const existing = await clientOrDb.query(
    `SELECT liability_id
     FROM escrow_liabilities
     WHERE event_id = $1
     LIMIT 1`,
    [context.eventId]
  );
  if (existing.rowCount > 0) return existing.rows[0].liability_id;

  const inserted = await clientOrDb.query(
    `INSERT INTO escrow_liabilities (
       territory_id, promoter_id, event_id, gross_ticket_revenue, refund_deductions, status
     )
     VALUES ($1, $2, $3, 0.00, 0.00, 'HOLDING')
     RETURNING liability_id`,
    [context.territoryId, context.promoterProfileId, context.eventId]
  );

  return inserted.rows[0]?.liability_id || null;
}

async function addGrossRevenueToLiability(eventId, amountPence, options = {}) {
  if (!eventId || !Number.isFinite(Number(amountPence)) || Number(amountPence) <= 0) return false;

  const clientOrDb = options.client || pool;
  await ensureEscrowLiabilityForEvent(eventId, { client: clientOrDb });
  await clientOrDb.query(
    `UPDATE escrow_liabilities
     SET gross_ticket_revenue = gross_ticket_revenue + ($2::numeric / 100.0),
         updated_at = NOW()
     WHERE event_id = $1`,
    [eventId, Number(amountPence)]
  );
  return true;
}

async function markPayoutEligibleForEvent(eventId, options = {}) {
  if (!eventId) return false;
  const clientOrDb = options.client || pool;
  await ensureEscrowLiabilityForEvent(eventId, { client: clientOrDb });
  await clientOrDb.query(
    `UPDATE escrow_liabilities
     SET status = 'PAYOUT_ELIGIBLE',
         updated_at = NOW()
     WHERE event_id = $1
       AND status IN ('HOLDING', 'PARTIAL_REFUND')`,
    [eventId]
  );
  return true;
}

module.exports = {
  ensureEscrowLiabilityForEvent,
  addGrossRevenueToLiability,
  markPayoutEligibleForEvent,
};
