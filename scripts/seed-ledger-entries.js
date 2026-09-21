/**
 * Seed sample ledger entries for testing (list, filter, export).
 * Uses createLedgerEntry() so entries are valid and immutable.
 *
 * Usage:
 *   node scripts/seed-ledger-entries.js
 *
 * Prerequisites:
 *   - ledger_entries table exists (migration 001)
 *   - At least one user and territory (e.g. UK territory id 1)
 */

require("dotenv").config();
const pool = require("../src/db");
const { createLedgerEntry } = require("../src/services/ledgerCore.service");

async function getSeedIds() {
  const [userRes, territoryRes] = await Promise.all([
    pool.query("SELECT id FROM users ORDER BY id LIMIT 1"),
    pool.query("SELECT id FROM territories ORDER BY id LIMIT 1"),
  ]);
  const userId = userRes.rows[0]?.id;
  const territoryId = territoryRes.rows[0]?.id;
  if (!userId || !territoryId) {
    throw new Error("Need at least one user and one territory. Run migrations and seed users/territories first.");
  }
  return { userId, territoryId };
}

const ENTRIES = [
  {
    entry_type: "CREDIT_ALLOCATION",
    user_id: null, // set at runtime
    role: "promoter",
    level: "L1",
    territory_id: null,
    amount: 15000,
    rate_applied: 0.1,
    gross_credit: 15000,
    net_credit: 13500,
    reference_id: null,
    reference_type: "EVENT",
    status: "POSTED",
  },
  {
    entry_type: "SERVICE_FEE",
    user_id: null,
    role: "promoter",
    territory_id: null,
    amount: 1500,
    rate_applied: 0.1,
    gross_credit: 15000,
    net_credit: 13500,
    reference_id: null,
    reference_type: "EVENT",
    status: "POSTED",
  },
  {
    entry_type: "PAYOUT",
    user_id: null,
    role: "promoter",
    territory_id: null,
    amount: 5000,
    status: "POSTED",
    approval_actor_id: null,
  },
  {
    entry_type: "REFUND",
    user_id: null,
    role: "buyer",
    territory_id: null,
    amount: -2500,
    reference_type: "TICKET",
    status: "POSTED",
  },
  {
    entry_type: "REFERRAL_PAYOUT",
    user_id: null,
    role: "promoter",
    level: "L2",
    territory_id: null,
    amount: 500,
    reference_type: "REFERRAL",
    status: "POSTED",
  },
  {
    entry_type: "REINVESTMENT",
    user_id: null,
    role: "guru",
    level: "L3",
    territory_id: null,
    amount: 10000,
    status: "POSTED",
  },
  {
    entry_type: "LEDGER_EXPORT",
    user_id: null,
    role: "kings_account",
    territory_id: null,
    amount: 0,
    status: "POSTED",
    approval_actor_id: null,
    proof_reference: "export_range:2024-01-01_to_2024-01-31",
  },
];

async function main() {
  console.log("Seeding sample ledger entries...");
  const { userId, territoryId } = await getSeedIds();
  console.log("Using user_id:", userId, "territory_id:", territoryId);

  for (const e of ENTRIES) {
    const data = {
      ...e,
      user_id: e.user_id ?? userId,
      territory_id: e.territory_id ?? territoryId,
      approval_actor_id: e.approval_actor_id ?? userId,
    };
    const id = await createLedgerEntry(data);
    console.log("  Created ledger entry id:", id, "type:", data.entry_type);
  }

  console.log("Done. You can test GET /api/v1/ledger and export with a King's Account token.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
