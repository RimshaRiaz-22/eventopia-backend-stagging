/**
 * Contract 25 — GET /api/v1/wallet/transactions
 * Paginated credit_ledger history for the authenticated wallet role.
 */

const pool = require("../db");
const {
  isWalletAccessBlocked,
  resolveWalletRole,
  loadCreditWalletRow,
  penceToGbp,
} = require("./walletMe.service");

function parsePositiveInt(raw, fallback) {
  const n = raw === undefined || raw === null || raw === "" ? NaN : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

/** @returns {{ ok: true, page: number } | { ok: false }} */
function parsePageParam(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, page: 1 };
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return { ok: false };
  return { ok: true, page: n };
}

function parseEventId(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Map DB row → API status + entry_type (Contract 25 names).
 * @param {object} row - credit_ledger row with optional event_title from join
 */
function mapLedgerRowToTransaction(row) {
  const meta = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  const eventTitle = row.event_title != null ? row.event_title : null;
  const amountPence = Number(row.amount) || 0;
  const amountGbp = penceToGbp(amountPence);
  const tierFromMeta = meta.tier_label != null ? Number(meta.tier_label) : null;
  const ticketId = meta.ticket_id != null ? String(meta.ticket_id) : null;

  const entryTypeDb = String(row.entry_type || "");

  if (entryTypeDb === "SERVICE_FEE_DEDUCTED" || entryTypeDb === "SERVICE_FEE_DEDUCTION") {
    const month = meta.month != null ? String(meta.month) : "";
    const rate = meta.rate != null ? meta.rate : "";
    const note =
      month && rate !== ""
        ? `Service fee deduction — ${month} (rate: ${Number(rate) * 100}%)`
        : month
          ? `Service fee deduction — ${month}`
          : "Service fee deduction";
    return {
      entry_id: String(row.id),
      entry_type: "SERVICE_FEE_DEDUCTION",
      status: "CONFIRMED",
      amount: Number(amountGbp.toFixed(2)),
      role: row.role,
      tier_number: null,
      event_id: null,
      event_title: null,
      ticket_id: ticketId,
      reference_note: note,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  if (entryTypeDb === "WITHDRAWAL") {
    return {
      entry_id: String(row.id),
      entry_type: "WITHDRAWAL",
      status: "CONFIRMED",
      amount: Number(amountGbp.toFixed(2)),
      role: row.role,
      tier_number: null,
      event_id: row.event_id != null ? String(row.event_id) : null,
      event_title: eventTitle,
      ticket_id: ticketId,
      reference_note: meta.note != null ? String(meta.note) : null,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  if (entryTypeDb === "CREDIT_VOID_REFUND" || entryTypeDb === "CREDIT_VOID_CANCEL") {
    const apiType = entryTypeDb === "CREDIT_VOID_CANCEL" ? "CREDIT_VOID_CANCEL" : "CREDIT_VOID_REFUND";
    return {
      entry_id: String(row.id),
      entry_type: apiType,
      status: "VOID",
      amount: Math.abs(Number(amountGbp.toFixed(2))),
      role: row.role,
      tier_number: Number.isFinite(tierFromMeta) ? tierFromMeta : null,
      event_id: row.event_id != null ? String(row.event_id) : null,
      event_title: eventTitle,
      ticket_id: ticketId,
      reference_note: meta.reference_note != null ? String(meta.reference_note) : null,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  if (entryTypeDb === "REFERRAL_BONUS") {
    const st = meta.status === "CONFIRMED" ? "CONFIRMED" : "PROJECTED";
    return {
      entry_id: String(row.id),
      entry_type: "REFERRAL_BONUS",
      status: st,
      amount: Math.abs(Number(amountGbp.toFixed(2))),
      role: row.role,
      tier_number: Number.isFinite(tierFromMeta) ? tierFromMeta : null,
      event_id: row.event_id != null ? String(row.event_id) : null,
      event_title: eventTitle,
      ticket_id: ticketId,
      reference_note: meta.reference_note != null ? String(meta.reference_note) : null,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  /* CREDIT_ALLOCATION and legacy credit rows */
  const metaStatus = meta.status != null ? String(meta.status).toUpperCase() : "PROJECTED";
  if (metaStatus === "VOID" || meta.void === true || meta.ledger_void === true) {
    const isCancel = meta.void_reason === "cancel" || meta.void_type === "CANCEL";
    return {
      entry_id: String(row.id),
      entry_type: isCancel ? "CREDIT_VOID_CANCEL" : "CREDIT_VOID_REFUND",
      status: "VOID",
      amount: Math.abs(Number(amountGbp.toFixed(2))),
      role: row.role,
      tier_number: Number.isFinite(tierFromMeta) ? tierFromMeta : null,
      event_id: row.event_id != null ? String(row.event_id) : null,
      event_title: eventTitle,
      ticket_id: ticketId,
      reference_note: meta.reference_note != null ? String(meta.reference_note) : null,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  if (metaStatus === "CONFIRMED") {
    return {
      entry_id: String(row.id),
      entry_type: "CREDIT_CONFIRMED",
      status: "CONFIRMED",
      amount: Math.abs(Number(amountGbp.toFixed(2))),
      role: row.role,
      tier_number: Number.isFinite(tierFromMeta) ? tierFromMeta : null,
      event_id: row.event_id != null ? String(row.event_id) : null,
      event_title: eventTitle,
      ticket_id: ticketId,
      reference_note: meta.reference_note != null ? String(meta.reference_note) : null,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  return {
    entry_id: String(row.id),
    entry_type: "CREDIT_PROJECTED",
    status: "PROJECTED",
    amount: Math.abs(Number(amountGbp.toFixed(2))),
    role: row.role,
    tier_number: Number.isFinite(tierFromMeta) ? tierFromMeta : null,
    event_id: row.event_id != null ? String(row.event_id) : null,
    event_title: eventTitle,
    ticket_id: ticketId,
    reference_note: meta.reference_note != null ? String(meta.reference_note) : null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function transactionMatchesStatusFilter(tx, filter) {
  if (filter === "all") return true;
  if (filter === "projected") return tx.status === "PROJECTED";
  if (filter === "confirmed") return tx.status === "CONFIRMED";
  if (filter === "void") return tx.status === "VOID";
  return true;
}

/**
 * SQL predicate aligned with mapLedgerRowToTransaction status (for count + page).
 */
function statusSqlClause(statusFilter) {
  if (statusFilter === "all") return { sql: "TRUE", params: [] };

  if (statusFilter === "projected") {
    return {
      sql: `cl.entry_type = 'CREDIT_ALLOCATION'
            AND COALESCE(UPPER(cl.metadata_json->>'status'), 'PROJECTED') = 'PROJECTED'
            AND COALESCE((cl.metadata_json->>'void')::boolean, false) IS NOT TRUE
            AND COALESCE((cl.metadata_json->>'ledger_void')::boolean, false) IS NOT TRUE`,
      params: [],
    };
  }

  if (statusFilter === "confirmed") {
    return {
      sql: `(
          (cl.entry_type = 'CREDIT_ALLOCATION' AND UPPER(cl.metadata_json->>'status') = 'CONFIRMED')
          OR cl.entry_type IN ('SERVICE_FEE_DEDUCTED', 'SERVICE_FEE_DEDUCTION', 'WITHDRAWAL')
          OR (cl.entry_type = 'REFERRAL_BONUS' AND UPPER(COALESCE(cl.metadata_json->>'status','PROJECTED')) = 'CONFIRMED')
        )`,
      params: [],
    };
  }

  if (statusFilter === "void") {
    return {
      sql: `(
          cl.entry_type IN ('CREDIT_VOID_REFUND', 'CREDIT_VOID_CANCEL')
          OR (cl.entry_type = 'CREDIT_ALLOCATION' AND (
              UPPER(COALESCE(cl.metadata_json->>'status','')) = 'VOID'
              OR COALESCE((cl.metadata_json->>'void')::boolean, false) IS TRUE
              OR COALESCE((cl.metadata_json->>'ledger_void')::boolean, false) IS TRUE
            ))
          OR (cl.entry_type = 'REFERRAL_BONUS' AND UPPER(COALESCE(cl.metadata_json->>'status','')) = 'VOID')
        )`,
      params: [],
    };
  }

  return { sql: "TRUE", params: [] };
}

function summarizePage(transactions) {
  let total_projected_in_view = 0;
  let total_confirmed_in_view = 0;
  let total_void_in_view = 0;
  for (const tx of transactions) {
    if (tx.status === "PROJECTED") total_projected_in_view += tx.amount;
    else if (tx.status === "VOID") total_void_in_view += tx.amount;
    else if (tx.status === "CONFIRMED") total_confirmed_in_view += tx.amount;
  }
  return {
    total_projected_in_view: Number(total_projected_in_view.toFixed(2)),
    total_confirmed_in_view: Number(total_confirmed_in_view.toFixed(2)),
    total_void_in_view: Number(total_void_in_view.toFixed(2)),
  };
}

async function loadPromoterWalletIdString(promoterUserId) {
  const r = await pool.query(`SELECT wallet_id FROM promoter_credit_wallets WHERE promoter_id = $1 LIMIT 1`, [
    promoterUserId,
  ]);
  return r.rowCount ? String(r.rows[0].wallet_id) : null;
}

/**
 * @param {number} userId
 * @param {string[]} userRoles
 * @param {object} query - req.query
 */
async function getWalletTransactions(userId, userRoles, query) {
  if (isWalletAccessBlocked(userRoles)) {
    return { ok: false, code: "BLOCKED" };
  }

  const walletRole = await resolveWalletRole(userId, userRoles);
  if (!walletRole) {
    return { ok: false, code: "NO_WALLET" };
  }

  const cw = await loadCreditWalletRow(userId, walletRole);
  if (!cw) {
    return { ok: false, code: "NO_WALLET" };
  }

  const pageParsed = parsePageParam(query.page);
  if (!pageParsed.ok) {
    return { ok: false, code: "INVALID_PAGE" };
  }
  const page = pageParsed.page;

  let limit = parsePositiveInt(query.limit, 20);
  if (limit < 1) limit = 20;
  limit = Math.min(100, limit);

  const statusRaw = String(query.status || "all").toLowerCase();
  const statusFilter = ["all", "projected", "confirmed", "void"].includes(statusRaw) ? statusRaw : "all";

  const fromDate = query.from != null && String(query.from).trim() !== "" ? String(query.from).trim() : null;
  const toDate = query.to != null && String(query.to).trim() !== "" ? String(query.to).trim() : null;
  if (fromDate && toDate && fromDate > toDate) {
    return { ok: false, code: "INVALID_DATE_RANGE" };
  }

  const eventId = parseEventId(query.event_id);

  const params = [userId, walletRole];
  let p = 3;
  const parts = [`cl.user_id = $1`, `cl.role = $2`];

  const stClause = statusSqlClause(statusFilter);
  parts.push(`(${stClause.sql})`);

  if (eventId != null) {
    parts.push(`cl.event_id = $${p++}`);
    params.push(eventId);
  }

  if (fromDate) {
    parts.push(`cl.created_at >= $${p++}::date`);
    params.push(fromDate);
  }
  if (toDate) {
    parts.push(`cl.created_at < ($${p++}::date + INTERVAL '1 day')`);
    params.push(toDate);
  }

  const whereSql = parts.join(" AND ");

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM credit_ledger cl
     WHERE ${whereSql}`,
    params
  );
  const totalEntries = parseInt(countResult.rows[0]?.c, 10) || 0;
  const totalPages = totalEntries === 0 ? 0 : Math.ceil(totalEntries / limit);
  const offset = (page - 1) * limit;

  const listParams = [...params, limit, offset];
  const limitIdx = p;
  const offsetIdx = p + 1;
  const dataResult = await pool.query(
    `SELECT cl.*, e.title AS event_title
     FROM credit_ledger cl
     LEFT JOIN events e ON e.id = cl.event_id
     WHERE ${whereSql}
     ORDER BY cl.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    listParams
  );

  const transactions = dataResult.rows.map((row) => mapLedgerRowToTransaction(row));

  const walletIdOut =
    walletRole === "promoter" ? (await loadPromoterWalletIdString(userId)) || String(cw.id) : String(cw.id);

  const body = {
    wallet_id: walletIdOut,
    role: walletRole,
    pagination: {
      page,
      limit,
      total_entries: totalEntries,
      total_pages: totalPages,
    },
    summary: summarizePage(transactions),
    transactions,
    retrieved_at: new Date().toISOString(),
  };

  return { ok: true, body };
}

module.exports = {
  getWalletTransactions,
  mapLedgerRowToTransaction,
};
