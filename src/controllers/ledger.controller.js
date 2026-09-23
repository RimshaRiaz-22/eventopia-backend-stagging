/**
 * Ledger API controller — King's Account only.
 * GET /api/v1/ledger (list), GET /api/v1/ledger/:entry_id (detail), GET /api/v1/ledger/export (CSV).
 */

const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");
const { createLedgerEntry } = require("../services/ledgerCore.service");

const LEDGER_COLUMNS =
  "id, entry_type, user_id, role, level, territory_id, network_id, amount, rate_applied, gross_credit, net_credit, reference_id, reference_type, approval_actor_id, proof_reference, status, created_at";

/** Normalize row to always include all 16 fields (null when not set) for API/CSV consistency */
function toEntry(row) {
  return {
    id: row.id,
    entry_type: row.entry_type,
    user_id: row.user_id,
    role: row.role,
    level: row.level ?? null,
    territory_id: row.territory_id,
    network_id: row.network_id ?? null,
    amount: row.amount,
    rate_applied: row.rate_applied != null ? Number(row.rate_applied) : null,
    gross_credit: row.gross_credit ?? null,
    net_credit: row.net_credit ?? null,
    reference_id: row.reference_id ?? null,
    reference_type: row.reference_type ?? null,
    approval_actor_id: row.approval_actor_id ?? null,
    proof_reference: row.proof_reference ?? null,
    status: row.status,
    created_at: row.created_at,
  };
}

function escapeCsvCell(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_HEADER =
  "id,entry_type,user_id,role,level,territory_id,network_id,amount,rate_applied,gross_credit,net_credit,reference_id,reference_type,approval_actor_id,proof_reference,status,created_at\n";

function parseStrictDateInput(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();

  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    const isRealDate =
      candidate.getUTCFullYear() === year &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day;
    return isRealDate ? candidate : null;
  }

  const candidate = new Date(trimmed);
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

/**
 * GET /api/v1/ledger/territories — list active territories valid for ledger export/filter IDs.
 * Uses `territories` table so IDs match ledger_entries.territory_id FK.
 */
async function getLedgerTerritories(req, res) {
  try {
    const { country, search } = req.query;

    const conditions = ["COALESCE(is_active, TRUE) = TRUE", "(status IS NULL OR LOWER(status) = 'active')"];
    const params = [];
    let idx = 1;

    if (country) {
      conditions.push(`country = $${idx}`);
      params.push(country);
      idx++;
    }
    if (search && String(search).trim()) {
      conditions.push(`name ILIKE $${idx}`);
      params.push(`%${String(search).trim()}%`);
      idx++;
    }

    const result = await pool.query(
      `
      SELECT id, name, country, currency
      FROM territories
      WHERE ${conditions.join(" AND ")}
      ORDER BY name ASC, id ASC
      `,
      params
    );

    const territories = result.rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      country: row.country,
      currency: row.currency || "GBP",
      ui_status: "AVAILABLE",
    }));

    return ok(res, req, {
      territories,
      count: territories.length,
    });
  } catch (err) {
    console.error("Ledger territories error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load territories");
  }
}

/**
 * GET /api/v1/ledger/users — list users for King's Account ledger filters/export UI
 */
async function getLedgerUsers(req, res) {
  try {
    const result = await pool.query(
      `
      SELECT id, name, email, role, account_status
      FROM users
      ORDER BY name ASC NULLS LAST, id ASC
      `
    );

    const users = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      account_status: row.account_status,
    }));

    return ok(res, req, {
      users,
      count: users.length,
    });
  } catch (err) {
    console.error("Ledger users error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load users");
  }
}

/**
 * GET /api/v1/ledger — paginated list with optional filters
 */
async function getLedgerList(req, res) {
  try {
    const {
      territory_id,
      entry_type,
      user_id,
      from,
      to,
      page = "1",
      limit = "50",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (territory_id) {
      conditions.push(`territory_id = $${idx}`);
      params.push(territory_id);
      idx++;
    }
    if (entry_type) {
      conditions.push(`entry_type = $${idx}`);
      params.push(entry_type);
      idx++;
    }
    if (user_id) {
      conditions.push(`user_id = $${idx}`);
      params.push(user_id);
      idx++;
    }
    if (from) {
      conditions.push(`created_at >= $${idx}::timestamptz`);
      params.push(from);
      idx++;
    }
    if (to) {
      conditions.push(`created_at <= $${idx}::timestamptz`);
      params.push(to);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ledger_entries ${where}`,
      params
    );
    const total = countResult.rows[0]?.total ?? 0;

    params.push(limitNum, offset);
    const result = await pool.query(
      `SELECT ${LEDGER_COLUMNS} FROM ledger_entries ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );

    const entries = result.rows.map(toEntry);
    return ok(res, req, { entries, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error("Ledger list error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load ledger");
  }
}

/**
 * GET /api/v1/ledger/:entry_id — single entry; 404 if not found
 */
async function getLedgerEntry(req, res) {
  try {
    const { entry_id } = req.params;
    const result = await pool.query(
      `SELECT ${LEDGER_COLUMNS} FROM ledger_entries WHERE id = $1`,
      [entry_id]
    );
    if (result.rows.length === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Ledger entry not found");
    }
    return ok(res, req, toEntry(result.rows[0]));
  } catch (err) {
    console.error("Ledger entry error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load ledger entry");
  }
}

/**
 * GET /api/v1/ledger/export — CSV download. Required: territory_id, from, to. Max 90 days.
 * Records a LEDGER_EXPORT entry before returning the file.
 */
async function exportLedgerCsv(req, res) {
  try {
    const { territory_id, from, to } = req.query;

    if (!territory_id || !from || !to) {
      return fail(
        res,
        req,
        400,
        "MISSING_PARAMS",
        "territory_id, from, and to are required for export"
      );
    }

    const fromDate = parseStrictDateInput(from);
    const toDate = parseStrictDateInput(to);
    if (!fromDate || !toDate) {
      return fail(res, req, 400, "INVALID_DATE", "from and to must be valid ISO dates");
    }

    const daysDiff = (toDate - fromDate) / (1000 * 60 * 60 * 24);
    if (daysDiff > 90) {
      return fail(res, req, 400, "DATE_RANGE_TOO_LARGE", "Export date range cannot exceed 90 days");
    }

    const userId = req.user?.id;
    if (!userId) {
      return fail(res, req, 401, "UNAUTHORIZED", "User not found");
    }

    const territoryIdNum = parseInt(territory_id, 10);
    if (!territoryIdNum || territoryIdNum <= 0) {
      return fail(res, req, 400, "INVALID_TERRITORY", "territory_id must be a positive integer");
    }

    const territoryCheck = await pool.query(
      `
      SELECT id
      FROM territories
      WHERE id = $1
        AND COALESCE(is_active, TRUE) = TRUE
        AND (status IS NULL OR LOWER(status) = 'active')
      `,
      [territoryIdNum]
    );
    if (territoryCheck.rowCount === 0) {
      return fail(res, req, 400, "INVALID_TERRITORY", "Invalid or inactive territory_id");
    }

    const conditions = ["territory_id = $1", "created_at >= $2::timestamptz", "created_at <= $3::timestamptz"];
    const params = [territoryIdNum, from, to];

    const result = await pool.query(
      `SELECT ${LEDGER_COLUMNS} FROM ledger_entries WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
      params
    );

    const exportRangeRef = `export_range:${from}_to_${to}`;
    await createLedgerEntry({
      entry_type: "LEDGER_EXPORT",
      user_id: userId,
      role: "kings_account",
      territory_id: territoryIdNum,
      amount: 0,
      status: "POSTED",
      approval_actor_id: userId,
      proof_reference: exportRangeRef,
    });

    const rows = result.rows.map((r) =>
      [
        r.id,
        escapeCsvCell(r.entry_type),
        r.user_id,
        escapeCsvCell(r.role),
        escapeCsvCell(r.level),
        r.territory_id,
        r.network_id,
        r.amount,
        r.rate_applied,
        r.gross_credit,
        r.net_credit,
        r.reference_id,
        escapeCsvCell(r.reference_type),
        r.approval_actor_id,
        escapeCsvCell(r.proof_reference),
        escapeCsvCell(r.status),
        r.created_at,
      ].join(",")
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="ledger_export.csv"');
    return res.send(CSV_HEADER + rows.join("\n"));
  } catch (err) {
    if (err.message && err.message.startsWith("LEDGER_MISSING_FIELD:")) {
      return fail(res, req, 500, "INTERNAL_ERROR", "Failed to record export audit entry");
    }
    console.error("Ledger export error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Export failed");
  }
}

module.exports = {
  getLedgerTerritories,
  getLedgerUsers,
  getLedgerList,
  getLedgerEntry,
  exportLedgerCsv,
};
