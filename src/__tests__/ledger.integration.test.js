/**
 * Integration tests for Ledger Core: DB immutability and API.
 * Run with TEST_INTEGRATION=1 npm test -- --testPathPattern=ledger.integration
 * Requires DB and migrated ledger_entries table with trigger.
 */

const pool = require("../db");
const { createLedgerEntry } = require("../services/ledgerCore.service");

const runIntegration = process.env.TEST_INTEGRATION === "1";

describe("Ledger integration", () => {
  describe("Database immutability", () => {
    it("rejects UPDATE on ledger_entries", async () => {
      if (!runIntegration) {
        return; // skip when not in integration mode
      }
      const id = await createLedgerEntry({
        entry_type: "CREDIT_ALLOCATION",
        user_id: 1,
        role: "promoter",
        territory_id: 1,
        amount: 1,
        status: "POSTED",
      });
      await expect(
        pool.query("UPDATE ledger_entries SET amount = 0 WHERE id = $1", [id])
      ).rejects.toThrow();
    });

    it("rejects DELETE on ledger_entries", async () => {
      if (!runIntegration) return;
      const id = await createLedgerEntry({
        entry_type: "CREDIT_ALLOCATION",
        user_id: 1,
        role: "promoter",
        territory_id: 1,
        amount: 1,
        status: "POSTED",
      });
      await expect(
        pool.query("DELETE FROM ledger_entries WHERE id = $1", [id])
      ).rejects.toThrow();
    });
  });
});
