#!/usr/bin/env node
/**
 * Apply full local schema in one go (stops "missing table/column" whack-a-mole).
 *
 * Order:
 *   1. src/db/init.sql          — main app tables (events, job_runs, escrow v2, …)
 *   2. migrations/run_migration.sql — core add-ons (networks, guru_profiles, ledger, …) idempotent
 *   3. migrations/003–005       — enum + promoter_credit_wallets (002 omitted; same trigger as run_migration)
 *
 * Usage:
 *   node scripts/bootstrap-db.js
 *
 * Fresh DB: create empty database, set .env, run this once.
 * Existing DB: safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 *
 * Requires: same env as the app (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD).
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const pool = require("../src/db");

const ROOT = path.join(__dirname, "..");

const FILES = [
  path.join(ROOT, "src", "db", "init.sql"),
  path.join(ROOT, "migrations", "run_migration.sql"),
  path.join(ROOT, "migrations", "003_add_pending_approval_event_status.sql"),
  path.join(ROOT, "migrations", "004_add_active_event_status.sql"),
  path.join(ROOT, "migrations", "005_promoter_credit_wallets.sql"),
];

async function main() {
  try {
    for (const file of FILES) {
      if (!fs.existsSync(file)) {
        console.error("Missing file:", file);
        process.exit(1);
      }
      const sql = fs.readFileSync(file, "utf8");
      const name = path.relative(ROOT, file);
      console.log("→", name, `(${Math.round(sql.length / 1024)} KB)`);
      try {
        await pool.query(sql);
      } catch (err) {
        console.error("Failed on:", name);
        console.error(err?.message || err);
        if (err?.stack) console.error(err.stack);
        throw err;
      }
    }
    console.log("Bootstrap finished successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
