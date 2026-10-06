#!/usr/bin/env node
/**
 * Run a single migration file.
 * Usage: node scripts/run-migration.js [migration-file]
 * Default: migrations/001_add_core_tables.sql
 * Uses same DB config as app (env: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD).
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const pool = require("../src/db");

const migrationFile = process.argv[2] || path.join(__dirname, "..", "migrations", "001_add_core_tables.sql");

async function run() {
  if (!fs.existsSync(migrationFile)) {
    console.error("Migration file not found:", migrationFile);
    process.exit(1);
  }
  const sql = fs.readFileSync(migrationFile, "utf8");
  console.log("Running migration:", path.basename(migrationFile));
  try {
    await pool.query(sql);
    console.log("Migration completed successfully.");
  } catch (err) {
    const msg =
      err?.message ||
      (err?.code ? `${err.code}: ${err}` : String(err));
    console.error("Migration failed:", msg);
    if (err?.errors?.length) err.errors.forEach((e) => console.error(" ", e.message || e));
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
