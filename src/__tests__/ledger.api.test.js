/**
 * API/controller unit tests: ledger list pagination, export 90-day rule, WRONG_ROLE.
 */

const pool = require("../db");
const ledgerService = require("../services/ledgerCore.service");

jest.mock("../db", () => ({ query: jest.fn() }));
jest.mock("../services/ledgerCore.service", () => ({ createLedgerEntry: jest.fn() }));

const { getLedgerList, getLedgerEntry, exportLedgerCsv } = require("../controllers/ledger.controller");
const { requireKingsAccount } = require("../middlewares/auth.middleware");

function mockRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(), setHeader: jest.fn().mockReturnThis() };
  return res;
}
function mockReq(overrides = {}) {
  return { query: {}, params: {}, user: { id: 1 }, requestId: "test", requestTimestamp: new Date().toISOString(), ...overrides };
}

describe("Ledger API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getLedgerList", () => {
    it("returns paginated results with default page 1 and limit 50", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      const req = mockReq({ query: {} });
      const res = mockRes();
      await getLedgerList(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBe(false);
      expect(body.data).toBeDefined();
      expect(body.data.entries).toEqual([]);
      expect(body.data.total).toBe(0);
      expect(body.data.page).toBe(1);
      expect(body.data.limit).toBe(50);
    });
  });

  describe("exportLedgerCsv", () => {
    it("returns 400 DATE_RANGE_TOO_LARGE when date range exceeds 90 days", async () => {
      const req = mockReq({
        query: { territory_id: "1", from: "2024-01-01", to: "2024-05-01" },
      });
      const res = mockRes();
      await exportLedgerCsv(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("DATE_RANGE_TOO_LARGE");
    });

    it("calls createLedgerEntry with LEDGER_EXPORT when export is valid", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      ledgerService.createLedgerEntry.mockResolvedValueOnce(999);
      const req = mockReq({
        query: { territory_id: "1", from: "2024-01-01", to: "2024-01-15" },
        user: { id: 5 },
      });
      const res = mockRes();
      await exportLedgerCsv(req, res);
      expect(ledgerService.createLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          entry_type: "LEDGER_EXPORT",
          user_id: 5,
          role: "kings_account",
          territory_id: 1,
          approval_actor_id: 5,
          status: "POSTED",
        })
      );
    });
  });

  describe("requireKingsAccount middleware", () => {
    it("returns 403 WRONG_ROLE when user has no kings_account role", () => {
      const req = mockReq({ userRoles: ["promoter"] });
      const res = mockRes();
      const next = jest.fn();
      requireKingsAccount(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBeDefined();
      expect(body.error && body.error.code).toBe("WRONG_ROLE");
    });

    it("calls next when user has kings_account role", () => {
      const req = mockReq({ userRoles: ["kings_account"] });
      const res = mockRes();
      const next = jest.fn();
      requireKingsAccount(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
