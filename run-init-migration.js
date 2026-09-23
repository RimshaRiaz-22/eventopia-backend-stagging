/**
 * Database bootstrap migration runner.
 * Loads environment config, executes the consolidated init SQL file, and verifies required tables.
 */

// #!/usr/bin/env node

require("dotenv").config();
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// Database connection values come from environment config, with local fallbacks.
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 5433,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "mtechub123",
  database: process.env.DB_NAME || "eventopia-fatima",
});

/**
 * Runs the bootstrap migration and verifies core runtime tables.
 */
async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🔄 Running database bootstrap migration...");
    console.log("📊 Database:", process.env.DB_NAME || "eventopia-fatima");
    console.log("🏠 Host:", process.env.DB_HOST || "localhost");
    console.log("📦 Migration Source: src/db/init.sql (consolidated)");

    const migrationFiles = [
      path.join(__dirname, "src/db/init.sql"),
    ];

    for (const sqlPath of migrationFiles) {
      if (!fs.existsSync(sqlPath)) {
        throw new Error(`Migration file not found: ${sqlPath}`);
      }
      const sqlContent = fs.readFileSync(sqlPath, "utf8");
      console.log(`📄 Loaded ${path.relative(__dirname, sqlPath)} successfully`);
      console.log(`⚡ Executing ${path.relative(__dirname, sqlPath)}...`);
      await client.query(sqlContent);
    }

    console.log("✅ Database bootstrap migration completed successfully!");
    console.log(
      "🎉 All database tables, indexes, and constraints have been created/updated"
    );
    console.log("🔗 Base + post-init schema migrations are applied");

    // Confirms tables needed by runtime controllers and services exist.
    const requiredTables = [
      "users",
      "territories",
      "events",
      "ledger_entries",
      "promoter_credit_wallets",
    ];
    const verifyResult = await client.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name;
      `,
      [requiredTables]
    );
    const createdSet = new Set(verifyResult.rows.map((r) => r.table_name));
    const missingTables = requiredTables.filter((name) => !createdSet.has(name));
    if (missingTables.length > 0) {
      throw new Error(
        `Migration completed but required tables are missing: ${missingTables.join(", ")}`
      );
    }

    const tablesQuery = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `;

    const result = await client.query(tablesQuery);
    console.log(`\n📋 Created ${result.rows.length} tables:`);
    result.rows.forEach((row) => {
      console.log(`   - ${row.table_name}`);
    });
  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    console.error("\n📝 Full error details:");
    console.error(error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);