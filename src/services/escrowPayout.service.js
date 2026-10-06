/**
 * Escrow payouts: the King releases a concluded event's held money to its promoter.
 *
 * Rules:
 *  - only a PAYOUT_ELIGIBLE liability can be paid, and only once, after the settlement window
 *  - settlement window is 7 days after the event concluded, or 1 day once the promoter has 575 settled tickets
 *  - if territory coverage is below 1.0 (RED) the payout needs an override reason
 *  - one transaction: escrow balance down, liability PAID_OUT, payout row, ledger PAYOUT entry
 */

const pool = require("../db");
const { createLedgerEntry } = require("./ledgerCore.service");
const { getEscrowColumns, readEscrowPence, adjustEscrowPence } = require("./escrowAccount.util");

const DEFAULT_SETTLEMENT_DAYS = 7;
const FAST_SETTLEMENT_DAYS = 1;
const FAST_SETTLEMENT_TICKETS = 575;
const DAY_MS = 24 * 60 * 60 * 1000;

class PayoutError extends Error {
  constructor(code, message, status = 409, data = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

function settlementWindowDays(ticketCountSettled) {
  return Number(ticketCountSettled || 0) >= FAST_SETTLEMENT_TICKETS ? FAST_SETTLEMENT_DAYS : DEFAULT_SETTLEMENT_DAYS;
}

/** Date from which a concluded event can be paid out, or null if the event has not concluded. */
function settlementEligibleFrom(concludedAt, ticketCountSettled) {
  if (!concludedAt) return null;
  return new Date(new Date(concludedAt).getTime() + settlementWindowDays(ticketCountSettled) * DAY_MS);
}

function toPence(pounds) {
  return Math.round(Number(pounds || 0) * 100);
}

/**
 * List liabilities that are, or were, payout-eligible.
 * @param {{territoryId?: number, status?: 'eligible'|'paid'|'all', page?: number, limit?: number}} opts
 */
async function listPayouts({ territoryId = null, status = "eligible", page = 1, limit = 10 } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const statuses =
    status === "paid" ? ["PAID_OUT"] : status === "all" ? ["PAYOUT_ELIGIBLE", "PAID_OUT"] : ["PAYOUT_ELIGIBLE"];

  const params = [statuses];
  let where = "el.status = ANY($1::text[])";
  if (territoryId) {
    params.push(territoryId);
    where += ` AND el.territory_id = $${params.length}`;
  }

  const totals = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(el.net_liability), 0) AS total
     FROM escrow_liabilities el WHERE ${where}`,
    params
  );

  params.push(safeLimit, (safePage - 1) * safeLimit);
  const rows = await pool.query(
    `SELECT el.liability_id, el.event_id, el.territory_id, el.status,
            el.gross_ticket_revenue, el.refund_deductions, el.net_liability,
            e.title AS event_title, e.start_at AS event_date, e.completed_at AS concluded_at,
            pp.ticket_count_settled,
            u.name AS promoter_name, u.email AS promoter_email,
            t.name AS territory_name,
            ep.approved_at AS paid_at, ep.notes, ep.override_reason, au.name AS approved_by_name
     FROM escrow_liabilities el
     JOIN events e ON e.id = el.event_id
     JOIN promoter_profiles pp ON pp.id = el.promoter_id
     JOIN users u ON u.id = pp.user_id
     LEFT JOIN territories t ON t.id = el.territory_id
     LEFT JOIN escrow_payouts ep ON ep.liability_id = el.liability_id
     LEFT JOIN users au ON au.id = ep.approved_by
     WHERE ${where}
     ORDER BY (el.status = 'PAYOUT_ELIGIBLE') DESC, e.completed_at ASC NULLS LAST, el.liability_id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const now = Date.now();
  const items = rows.rows.map((r) => {
    const eligibleFrom = settlementEligibleFrom(r.concluded_at, r.ticket_count_settled);
    const net = parseFloat(r.net_liability);
    const paid = r.status === "PAID_OUT";
    const windowOpen = !paid && eligibleFrom && eligibleFrom.getTime() > now;
    return {
      liability_id: r.liability_id,
      event_id: r.event_id,
      event_title: r.event_title,
      event_date: r.event_date,
      concluded_at: r.concluded_at,
      territory_id: r.territory_id,
      territory_name: r.territory_name,
      promoter_name: r.promoter_name || r.promoter_email,
      promoter_email: r.promoter_email,
      gross_ticket_revenue: parseFloat(r.gross_ticket_revenue),
      refund_deductions: parseFloat(r.refund_deductions),
      net_amount: net,
      settlement_eligible_from: eligibleFrom ? eligibleFrom.toISOString() : null,
      payout_status: paid ? "PAID" : windowOpen ? "SETTLEMENT_PERIOD" : "READY",
      can_approve: !paid && !windowOpen && net > 0,
      paid_at: r.paid_at,
      approved_by_name: r.approved_by_name,
      notes: r.notes,
      override_reason: r.override_reason,
    };
  });

  return {
    items,
    summary: { count: totals.rows[0].count, total_amount: parseFloat(totals.rows[0].total) },
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: totals.rows[0].count,
      total_pages: Math.max(1, Math.ceil(totals.rows[0].count / safeLimit)),
    },
    retrieved_at: new Date().toISOString(),
  };
}

/**
 * Pay out one liability.
 * @param {number} liabilityId
 * @param {{id: number}} actor - the approving user
 * @param {{notes?: string, override_reason?: string}} options
 */
async function approvePayout(liabilityId, actor, { notes = null, override_reason = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT el.liability_id, el.event_id, el.promoter_id, el.territory_id, el.status, el.net_liability,
              e.completed_at, pp.user_id AS promoter_user_id, pp.ticket_count_settled
       FROM escrow_liabilities el
       JOIN events e ON e.id = el.event_id
       JOIN promoter_profiles pp ON pp.id = el.promoter_id
       WHERE el.liability_id = $1
       FOR UPDATE OF el`,
      [liabilityId]
    );
    if (found.rowCount === 0) throw new PayoutError("LIABILITY_NOT_FOUND", "Liability not found.", 404);

    const liability = found.rows[0];
    if (liability.status === "PAID_OUT") {
      throw new PayoutError("ALREADY_PAID_OUT", "This event has already been paid out.");
    }
    if (liability.status !== "PAYOUT_ELIGIBLE") {
      throw new PayoutError("NOT_PAYOUT_ELIGIBLE", "Only concluded events can be paid out.");
    }

    const amountPence = toPence(liability.net_liability);
    if (amountPence <= 0) throw new PayoutError("NOTHING_TO_PAY", "There is no amount to pay out for this event.");

    const eligibleFrom = settlementEligibleFrom(liability.completed_at, liability.ticket_count_settled);
    if (!eligibleFrom || eligibleFrom.getTime() > Date.now()) {
      throw new PayoutError(
        "SETTLEMENT_WINDOW_OPEN",
        eligibleFrom
          ? `Settlement window is still open. Payout is available from ${eligibleFrom.toISOString().split("T")[0]}.`
          : "The event has not been marked as concluded.",
        409,
        { settlement_eligible_from: eligibleFrom ? eligibleFrom.toISOString() : null }
      );
    }

    // Coverage before this payout, for the territory's whole pot
    const cols = await getEscrowColumns(client);
    const { balancePence } = await readEscrowPence(client, liability.territory_id, cols);
    const owed = await client.query(
      `SELECT COALESCE(SUM(net_liability), 0) AS total
       FROM escrow_liabilities
       WHERE territory_id = $1 AND status IN ('HOLDING', 'PAYOUT_ELIGIBLE', 'PARTIAL_REFUND')`,
      [liability.territory_id]
    );
    const owedPence = toPence(owed.rows[0].total);
    const coverageRatio = owedPence > 0 ? balancePence / owedPence : null;
    const coverageStatus =
      coverageRatio === null ? "NO_LIABILITIES" : coverageRatio >= 1.1 ? "GREEN" : coverageRatio >= 1 ? "AMBER" : "RED";

    const reason = override_reason && String(override_reason).trim() ? String(override_reason).trim() : null;
    if (coverageStatus === "RED" && !reason) {
      throw new PayoutError(
        "COVERAGE_RED",
        "Escrow coverage is below 1.0. An override reason is required to approve this payout.",
        409,
        { coverage_ratio: coverageRatio, coverage_status: coverageStatus }
      );
    }
    if (balancePence < amountPence) {
      throw new PayoutError("INSUFFICIENT_ESCROW", "The escrow balance is lower than this payout amount.", 409, {
        escrow_balance_pence: balancePence,
        payout_pence: amountPence,
      });
    }

    await adjustEscrowPence(client, liability.territory_id, cols, { balanceDeltaPence: -amountPence });
    await client.query(
      `UPDATE escrow_accounts
       SET total_withdrawn = COALESCE(total_withdrawn, 0) + $2::numeric
       WHERE territory_id = $1 ${cols.hasType ? "AND account_type = 'escrow'" : ""}`,
      [liability.territory_id, amountPence / 100]
    );

    await client.query(
      `UPDATE escrow_liabilities SET status = 'PAID_OUT', updated_at = NOW() WHERE liability_id = $1`,
      [liabilityId]
    );

    const payout = await client.query(
      `INSERT INTO escrow_payouts
         (liability_id, event_id, promoter_id, territory_id, amount, status, coverage_status, override_reason, notes, approved_by)
       VALUES ($1, $2, $3, $4, $5, 'PAID', $6, $7, $8, $9)
       RETURNING payout_id, approved_at`,
      [
        liabilityId,
        liability.event_id,
        liability.promoter_id,
        liability.territory_id,
        amountPence / 100,
        coverageStatus,
        reason,
        notes ? String(notes).trim() || null : null,
        actor.id,
      ]
    );

    await createLedgerEntry(
      {
        entry_type: "PAYOUT",
        user_id: liability.promoter_user_id,
        role: "promoter",
        territory_id: liability.territory_id,
        amount: amountPence,
        reference_id: liabilityId,
        reference_type: "ESCROW_LIABILITY",
        approval_actor_id: actor.id,
        status: "POSTED",
      },
      { client }
    );

    await client.query("COMMIT");
    return {
      payout_id: payout.rows[0].payout_id,
      liability_id: liabilityId,
      event_id: liability.event_id,
      amount: amountPence / 100,
      coverage_status: coverageStatus,
      paid_at: payout.rows[0].approved_at,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  PayoutError,
  settlementWindowDays,
  settlementEligibleFrom,
  listPayouts,
  approvePayout,
};
