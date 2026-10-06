/**
 * One place that completes an event, used by the promoter, the King and the hourly scheduler.
 *
 * Completing an event:
 *  - sets events.status = 'completed' (what every screen and filter reads) and completion_status = 'completed'
 *  - stamps completed_at / completed_by
 *  - turns the event's escrow liability into PAYOUT_ELIGIBLE, which starts the settlement window
 *  - confirms the credit earned on the event's ticket sales (projected -> confirmed, available)
 *
 * Rewards are issued after the transaction commits (see issueRewardsAfterCompletion).
 */

const { markPayoutEligibleForEvent } = require("./escrowLiability.service");
const { confirmCreditForEvent } = require("./creditConfirmation.service");

// Events in these statuses were live at some point and can be completed once they have ended.
const COMPLETABLE_STATUSES = ["published", "unpublished", "active"];

class CompletionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Complete one event inside the caller's transaction.
 * @param {import("pg").PoolClient} client - client with an open transaction
 * @param {number|string} eventId
 * @param {{actorId?: number|null, requireEnded?: boolean}} options
 *   requireEnded: refuse unless the event's end time has passed (promoters and the scheduler).
 *   The King may complete an event early.
 * @returns {Promise<{id: number, completedAt: Date}>}
 * @throws {CompletionError}
 */
async function completeEventInTransaction(client, eventId, { actorId = null, requireEnded = true } = {}) {
  const found = await client.query(
    `SELECT id, status, completion_status, end_at FROM events WHERE id = $1 FOR UPDATE`,
    [eventId]
  );
  if (found.rowCount === 0) throw new CompletionError("NOT_FOUND", "Event not found", 404);

  const event = found.rows[0];

  if (event.completion_status === "completed" || event.status === "completed") {
    throw new CompletionError("ALREADY_COMPLETED", "Event already completed");
  }
  if (event.status === "cancelled" || event.status === "cancellation_requested") {
    throw new CompletionError("INVALID_STATE", "Cancelled or cancellation-requested events cannot be completed");
  }
  if (!COMPLETABLE_STATUSES.includes(event.status)) {
    throw new CompletionError("INVALID_STATE", "Only published events can be completed");
  }
  if (requireEnded && event.end_at && new Date(event.end_at).getTime() > Date.now()) {
    throw new CompletionError(
      "EVENT_NOT_ENDED",
      "This event has not ended yet. It can be completed once its end time has passed."
    );
  }

  const updated = await client.query(
    `UPDATE events
     SET status = 'completed',
         completion_status = 'completed',
         settlement_status = 'SETTLED',
         completed_at = NOW(),
         completed_by = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING completed_at`,
    [eventId, actorId]
  );

  // Starts the settlement window. Only the escrow view depends on it, so it must not block completion.
  try {
    await markPayoutEligibleForEvent(eventId, { client });
  } catch (err) {
    console.warn("[eventCompletion] payout-eligible sync skipped:", err.message);
  }

  // Part of the same transaction: if confirming credit fails, the event is not completed.
  await confirmCreditForEvent(client, eventId);

  return { id: Number(eventId), completedAt: updated.rows[0].completed_at };
}

/**
 * Issue promoter rewards and send the notification emails. Idempotent, never throws.
 * Call after the completion transaction has committed.
 */
async function issueRewardsAfterCompletion(eventId, actorId = null) {
  try {
    const { issueRewardsForEvent } = require("./reward.service");
    const { sendRewardNotificationEmails } = require("./email.service");
    const rewards = await issueRewardsForEvent(eventId, actorId);
    sendRewardNotificationEmails(eventId, rewards).catch((err) =>
      console.error("[eventCompletion] reward emails failed:", err.message)
    );
    return {
      promoterReward: rewards.promoterReward,
      ticketsSold: rewards.ticketsSold,
    };
  } catch (err) {
    console.error(`[eventCompletion] rewards failed for event ${eventId}:`, err.message);
    return { error: err.message };
  }
}

module.exports = {
  COMPLETABLE_STATUSES,
  CompletionError,
  completeEventInTransaction,
  issueRewardsAfterCompletion,
};
