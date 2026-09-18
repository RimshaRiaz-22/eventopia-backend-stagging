/**
 * Credit Allocation — creates projected credit for Promoter, Guru, Network Manager
 * on every ticket purchase. Writes to credit_wallets (projected_balance) and ledger_entries (audit).
 */

const pool = require("../db");
const { createLedgerEntry } = require("./ledgerCore.service");
const {
  getActiveReferralByReferredPromoter,
  applyReferralTicketProgress,
  REFERRAL_PER_TICKET_PENCE,
} = require("./promoterReferral.service");

// Per-ticket credit split in pence by tier (Promoter, Guru, Network Manager). Eventopia share not credited to a role.
const TIER_CREDIT_SPLITS_PENCE = {
  1: { promoter: 50, guru: 30, network_manager: 10 },
  2: { promoter: 65, guru: 40, network_manager: 15 },
  3: { promoter: 95, guru: 55, network_manager: 20 },
  4: { promoter: 130, guru: 75, network_manager: 25 },
  5: { promoter: 180, guru: 100, network_manager: 35 },
  6: { promoter: 250, guru: 140, network_manager: 50 },
};

/**
 * Allocate projected credit to promoter, guru, network_manager for a ticket purchase.
 * @param {Object} params
 * @param {number} params.event_id
 * @param {number} params.tier_label - 1-6
 * @param {number} params.quantity
 * @param {number} params.promoter_id
 * @param {number|null} params.guru_id
 * @param {number|null} params.network_manager_id
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
    guru_id,
    network_manager_id,
    territory_id,
    order_id = null,
  },
  options = {}
) {
  const splits = TIER_CREDIT_SPLITS_PENCE[tier_label];
  if (!splits) throw new Error("allocateCredit: invalid tier_label " + tier_label);

  const client = options.client || null;
  const db = client || pool;

  const entries = [
    {
      role: "promoter",
      user_id: promoter_id,
      amount_pence: splits.promoter * quantity,
    },
    {
      role: "guru",
      user_id: guru_id,
      amount_pence: splits.guru * quantity,
    },
    {
      role: "network_manager",
      user_id: network_manager_id,
      amount_pence: splits.network_manager * quantity,
    },
  ].filter((e) => e.user_id != null && e.amount_pence > 0);

  // Promoter -> Promoter referral mode:
  // divert £0.30/ticket from guru share to referrer while referral is active.
  const activeReferral = await getActiveReferralByReferredPromoter(promoter_id);
  if (activeReferral) {
    const diversionPerTicket = REFERRAL_PER_TICKET_PENCE;
    const referralAmount = diversionPerTicket * quantity;

    const guruEntry = entries.find((e) => e.role === "guru");
    if (guruEntry) {
      const diverted = Math.min(guruEntry.amount_pence, referralAmount);
      guruEntry.amount_pence = guruEntry.amount_pence - diverted;
      if (guruEntry.amount_pence <= 0) {
        const idx = entries.findIndex((e) => e.role === "guru");
        if (idx >= 0) entries.splice(idx, 1);
      }
      if (diverted > 0) {
        entries.push({
          role: "referrer",
          user_id: activeReferral.referrer_id,
          amount_pence: diverted,
        });
      }
    }
  }

  if (client) await client.query("BEGIN");

  try {
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
        { client }
      );
    }

    if (client) await client.query("COMMIT");

    // Increment referral ticket tracker and evaluate payout trigger.
    if (activeReferral) {
      await applyReferralTicketProgress(activeReferral.id, quantity);
    }
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    throw err;
  }
}

module.exports = {
  allocateCredit,
  TIER_CREDIT_SPLITS_PENCE,
};
