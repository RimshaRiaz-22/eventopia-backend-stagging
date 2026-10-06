/**
 * Credit Allocation — creates projected credit for the Promoter (and an active referrer)
 * on every ticket purchase. Writes to credit_wallets (projected_balance) and ledger_entries (audit).
 */

const pool = require("../db");
const { createLedgerEntry } = require("./ledgerCore.service");
const {
  getActiveReferralByReferredPromoter,
  applyReferralTicketProgress,
  REFERRAL_PER_TICKET_PENCE,
} = require("./promoterReferral.service");

// Per-ticket credit split in pence by tier (see config/credit.config.js, shared with the Credit Engine tab).
const { TIER_CREDIT_SPLITS_PENCE } = require("../config/credit.config");

/**
 * Allocate projected credit to the promoter (and referrer, if any) for a ticket purchase.
 * @param {Object} params
 * @param {number} params.event_id
 * @param {number} params.tier_label - 1-6
 * @param {number} params.quantity
 * @param {number} params.promoter_id
 * @param {number} params.territory_id
 * @param {number} [params.order_id] - for ledger reference
 * @param {Object} [options.client] - pg Client for transaction
 */
async function allocateCredit(
  {
    event_id,
    tier_label,
    quantity,
    promoter_id,
    territory_id,
    order_id = null,
  },
  options = {}
) {
  const splits = TIER_CREDIT_SPLITS_PENCE[tier_label];
  if (!splits) throw new Error("allocateCredit: invalid tier_label " + tier_label);

  // A caller-supplied client means the caller owns the transaction. Otherwise open our own so the
  // credit_ledger, credit_wallets and ledger_entries writes commit or roll back together.
  const callerClient = options.client || null;
  const ownsTransaction = !callerClient;

  const entries = [
    {
      role: "promoter",
      user_id: promoter_id,
      amount_pence: splits.promoter * quantity,
    },
  ].filter((e) => e.user_id != null && e.amount_pence > 0);

  // Promoter -> Promoter referral mode:
  // pay £0.30/ticket to the referrer while the referral is active. It comes out of the share Eventopia
  // retains (the former Guru share); whatever is not diverted stays with Eventopia.
  const activeReferral = await getActiveReferralByReferredPromoter(promoter_id);
  if (activeReferral) {
    const referralAmount = REFERRAL_PER_TICKET_PENCE * quantity;
    const diverted = Math.min(splits.retained * quantity, referralAmount);
    if (diverted > 0) {
      entries.push({
        role: "referrer",
        user_id: activeReferral.referrer_id,
        amount_pence: diverted,
      });
    }
  }

  const db = callerClient || (await pool.connect());
  try {
    if (ownsTransaction) await db.query("BEGIN");

    for (const e of entries) {
      await db.query(
        `INSERT INTO credit_ledger (user_id, role, event_id, entry_type, amount, metadata_json)
         VALUES ($1, $2, $3, 'CREDIT_ALLOCATION', $4, $5::jsonb)`,
        [
          e.user_id,
          e.role,
          event_id,
          e.amount_pence,
          JSON.stringify({ status: "PROJECTED", order_id, tier_label, quantity, territory_id }),
        ]
      );

      await db.query(
        `INSERT INTO credit_wallets (user_id, role, projected_balance, available_balance, held_balance, updated_at)
         VALUES ($1, $2, $3, 0, 0, NOW())
         ON CONFLICT (user_id, role) DO UPDATE SET
           projected_balance = credit_wallets.projected_balance + $3,
           updated_at = NOW()`,
        [e.user_id, e.role, e.amount_pence]
      );

      await createLedgerEntry(
        {
          entry_type: "CREDIT_ALLOCATION",
          user_id: e.user_id,
          role: e.role,
          territory_id,
          amount: e.amount_pence,
          reference_id: order_id ?? event_id,
          reference_type: order_id ? "ORDER" : "EVENT",
          status: "POSTED",
        },
        { client: db }
      );
    }

    if (ownsTransaction) await db.query("COMMIT");

    // Increment referral ticket tracker and evaluate payout trigger.
    if (activeReferral) {
      await applyReferralTicketProgress(activeReferral.id, quantity);
    }
  } catch (err) {
    if (ownsTransaction) await db.query("ROLLBACK");
    throw err;
  } finally {
    if (ownsTransaction) db.release();
  }
}

module.exports = {
  allocateCredit,
  TIER_CREDIT_SPLITS_PENCE,
};
