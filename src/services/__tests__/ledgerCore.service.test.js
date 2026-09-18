/**
 * Unit tests for ledgerCore.service.js — createLedgerEntry validation and insert.
 */

const pool = require("../../db");

jest.mock("../../db", () => ({
  query: jest.fn(),
}));

const { createLedgerEntry, validateRequired, REQUIRED_FIELDS } = require("../ledgerCore.service");

const validPayload = {
  entry_type: "CREDIT_ALLOCATION",
  user_id: 1,
  role: "promoter",
  territory_id: 1,
  amount: 100,
  status: "POSTED",
};

describe("ledgerCore.service", () => {
  describe("validateRequired", () => {
    it("throws LEDGER_MISSING_FIELD: entry_type when entry_type is missing", () => {
      const data = { ...validPayload, entry_type: undefined };
      expect(() => validateRequired(data)).toThrow("LEDGER_MISSING_FIELD: entry_type");
    });

    it("throws LEDGER_MISSING_FIELD: entry_type when entry_type is null", () => {
      const data = { ...validPayload, entry_type: null };
      expect(() => validateRequired(data)).toThrow("LEDGER_MISSING_FIELD: entry_type");
    });

    it("throws LEDGER_MISSING_FIELD: user_id when user_id is missing", () => {
      const data = { ...validPayload, user_id: undefined };
      expect(() => validateRequired(data)).toThrow("LEDGER_MISSING_FIELD: user_id");
    });

    it("throws LEDGER_MISSING_FIELD: user_id when user_id is null", () => {
      const data = { ...validPayload, user_id: null };
      expect(() => validateRequired(data)).toThrow("LEDGER_MISSING_FIELD: user_id");
    });

    it("throws LEDGER_MISSING_FIELD: territory_id when territory_id is missing", () => {
      const data = { ...validPayload, territory_id: undefined };
      expect(() => validateRequired(data)).toThrow("LEDGER_MISSING_FIELD: territory_id");
    });

    it("throws LEDGER_MISSING_FIELD: role when role is missing", () => {
      const data = { ...validPayload, role: undefined };
      expect(() => validateRequired(data)).toThrow("LEDGER_MISSING_FIELD: role");
    });

    it("throws LEDGER_MISSING_FIELD: amount when amount is missing", () => {
      const data = { ...validPayload, amount: undefined };
      expect(() => validateRequired(data)).toThrow("LEDGER_MISSING_FIELD: amount");
    });

    it("throws LEDGER_MISSING_FIELD: status when status is missing", () => {
      const data = { ...validPayload, status: undefined };
      expect(() => validateRequired(data)).toThrow("LEDGER_MISSING_FIELD: status");
    });

    it("does not throw when all required fields are present", () => {
      expect(() => validateRequired(validPayload)).not.toThrow();
    });
  });

  describe("createLedgerEntry", () => {
    it("throws LEDGER_MISSING_FIELD: entry_type when entry_type is missing", async () => {
      const data = { ...validPayload, entry_type: undefined };
      await expect(createLedgerEntry(data)).rejects.toThrow("LEDGER_MISSING_FIELD: entry_type");
    });

    it("throws LEDGER_MISSING_FIELD: user_id when user_id is missing", async () => {
      const data = { ...validPayload, user_id: undefined };
      await expect(createLedgerEntry(data)).rejects.toThrow("LEDGER_MISSING_FIELD: user_id");
    });

    it("throws LEDGER_MISSING_FIELD: territory_id when territory_id is missing", async () => {
      const data = { ...validPayload, territory_id: undefined };
      await expect(createLedgerEntry(data)).rejects.toThrow("LEDGER_MISSING_FIELD: territory_id");
    });

    it("with all valid fields returns entry id from insert", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });
      const id = await createLedgerEntry(validPayload);
      expect(id).toBe(42);
      expect(pool.query).toHaveBeenCalled();
    });
  });

  describe("REQUIRED_FIELDS", () => {
    it("includes entry_type, user_id, role, territory_id, amount, status", () => {
      expect(REQUIRED_FIELDS).toContain("entry_type");
      expect(REQUIRED_FIELDS).toContain("user_id");
      expect(REQUIRED_FIELDS).toContain("role");
      expect(REQUIRED_FIELDS).toContain("territory_id");
      expect(REQUIRED_FIELDS).toContain("amount");
      expect(REQUIRED_FIELDS).toContain("status");
    });
  });
});
