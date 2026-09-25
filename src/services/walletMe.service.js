
const pool = require("../db");
const { UNLOCK_THRESHOLD } = require("./promoterCreditWallet.service");
const { countSettledTicketsForPromoter } = require("./settledTicket.service");

const WALLET_ROLES = ["promoter"];

function penceToGbp(pence) {
  const n = Number(pence);
  if (!Number.isFinite(n)) return 0;
  return Number((n / 100).toFixed(2));
}

function isWalletAccessBlocked(userRoles) {
  if (!userRoles || userRoles.length === 0) return true;
  if (userRoles.includes("kings_account")) return true;
  const hasWalletRole = userRoles.some((r) => WALLET_ROLES.includes(r));
  if (userRoles.some((r) => ["finance", "staff_finance"].includes(r)) && !hasWalletRole) return true;
  return false;
}

/**
 * First wallet-eligible role (promoter) that has a credit_wallets row.
 * @param {number} userId
 * @param {string[]} userRoles
 * @returns {Promise<string|null>}
 */
async function resolveWalletRole(userId, userRoles) {
  const order = ["promoter"];
  for (const role of order) {
    if (!userRoles.includes(role)) continue;
    const w = await pool.query(`SELECT 1 FROM credit_wallets WHERE user_id = $1 AND role = $2 LIMIT 1`, [
      userId,
      role,
    ]);
    if (w.rowCount > 0) return role;
  }
  return null;
}

async function loadCreditWalletRow(userId, role) {
  const r = await pool.query(`SELECT * FROM credit_wallets WHERE user_id = $1 AND role = $2 LIMIT 1`, [
    userId,
    role,
  ]);
  return r.rowCount ? r.rows[0] : null;
}

async function sumLedgerPence(userId, role, status) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS s
     FROM credit_ledger
     WHERE user_id = $1 AND role = $2
       AND entry_type = 'CREDIT_ALLOCATION'
       AND COALESCE(metadata_json->>'status', 'PROJECTED') = $3`,
    [userId, role, status]
  );
  return Number(r.rows[0]?.s) || 0;
}

async function loadServiceFeeTotals(userId, role) {
  const monthRow = await pool.query(
    `SELECT COALESCE(SUM(service_fee_amount), 0)::bigint AS s
     FROM service_fee_statements
     WHERE user_id = $1 AND role = $2
       AND statement_month = to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), 'YYYY-MM')`,
    [userId, role]
  );
  const lifeRow = await pool.query(
    `SELECT COALESCE(SUM(service_fee_amount), 0)::bigint AS s
     FROM service_fee_statements
     WHERE user_id = $1 AND role = $2`,
    [userId, role]
  );
  return {
    thisMonthPence: Number(monthRow.rows[0]?.s) || 0,
    lifetimePence: Number(lifeRow.rows[0]?.s) || 0,
  };
}

async function loadPromoterMeta(userId) {
  const pcw = await pool.query(`SELECT wallet_id, status, unlock_date, service_fee_rate FROM promoter_credit_wallets WHERE promoter_id = $1 LIMIT 1`, [
    userId,
  ]);
  const pp = await pool.query(`SELECT territory_id FROM promoter_profiles WHERE user_id = $1 LIMIT 1`, [userId]);
  return {
    walletId: pcw.rowCount ? pcw.rows[0].wallet_id : null,
    pcwStatus: pcw.rowCount ? pcw.rows[0].status : null,
    unlockDate: pcw.rowCount ? pcw.rows[0].unlock_date : null,
    serviceFeeRate: pcw.rowCount ? Number(pcw.rows[0].service_fee_rate) : 0.1,
    territoryId: pp.rowCount ? pp.rows[0].territory_id : null,
  };
}

/**
 * @param {number} userId
 * @param {string[]} userRoles
 * @returns {Promise<{ ok: true, body: object } | { ok: false, code: 'NO_WALLET' | 'BLOCKED' }>}
 */
async function getWalletMeForUser(userId, userRoles) {
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

  const [projectedPence, confirmedLedgerPence, feeTotals] = await Promise.all([
    sumLedgerPence(userId, walletRole, "PROJECTED"),
    sumLedgerPence(userId, walletRole, "CONFIRMED"),
    loadServiceFeeTotals(userId, walletRole),
  ]);

  const availablePence = Number(cw.available_balance) || 0;
  const confirmedPence = confirmedLedgerPence > 0 ? confirmedLedgerPence : availablePence;
  const projectedGbp = penceToGbp(projectedPence);
  const confirmedGbp = penceToGbp(confirmedPence);
  const lifetimeEarnedGbp = confirmedLedgerPence > 0 ? confirmedGbp : penceToGbp(availablePence);

  const retrievedAt = new Date().toISOString();
  const base = {
    wallet_id: String(cw.id),
    user_id: String(userId),
    role: walletRole,
    balances: {
      projected: projectedGbp,
      confirmed: confirmedGbp,
      net_withdrawable: 0,
      lifetime_earned: lifetimeEarnedGbp,
    },
    service_fee: {
      rate: 0.1,
      deducted_this_month: penceToGbp(feeTotals.thisMonthPence),
      deducted_lifetime: penceToGbp(feeTotals.lifetimePence),
    },
    withdrawal_eligibility: {
      eligible_percent: 0,
      reason: "",
    },
    retrieved_at: retrievedAt,
  };

  if (walletRole === "promoter") {
    const meta = await loadPromoterMeta(userId);
    const ticketsSettled = await countSettledTicketsForPromoter(userId);
    const unlocked = ticketsSettled >= UNLOCK_THRESHOLD || meta.pcwStatus === "UNLOCKED";
    base.wallet_id = meta.walletId || base.wallet_id;
    base.territory_id = meta.territoryId != null ? String(meta.territory_id) : null;
    base.service_fee.rate = meta.serviceFeeRate;
    base.balances.net_withdrawable = unlocked ? Number((confirmedGbp * 0.5).toFixed(2)) : 0;
    if (!unlocked) {
      const remaining = Math.max(0, UNLOCK_THRESHOLD - ticketsSettled);
      const progress = Number(Math.min(100, (ticketsSettled / UNLOCK_THRESHOLD) * 100).toFixed(1));
      base.unlock_status = {
        unlocked: false,
        tickets_settled: ticketsSettled,
        tickets_required: UNLOCK_THRESHOLD,
        progress_percent: progress,
        message: `Sell ${remaining} more tickets from concluded events to unlock your credit wallet.`,
      };
      base.balances.confirmed = 0;
      base.balances.net_withdrawable = 0;
      base.balances.lifetime_earned = 0;
      base.withdrawal_eligibility = {
        eligible_percent: 0,
        reason: "Wallet locked until 575 tickets threshold met",
      };
    } else {
      base.unlock_status = {
        unlocked: true,
        tickets_settled: ticketsSettled,
        unlock_date: meta.unlockDate ? new Date(meta.unlockDate).toISOString() : null,
      };
      base.withdrawal_eligibility = {
        eligible_percent: 50,
        withdrawable_amount: base.balances.net_withdrawable,
        reason: "50% of confirmed credit withdrawable monthly",
      };
    }
    return { ok: true, body: base };
  }

  return { ok: false, code: "NO_WALLET" };
}

module.exports = {
  getWalletMeForUser,
  isWalletAccessBlocked,
  resolveWalletRole,
  loadCreditWalletRow,
  penceToGbp,
  WALLET_ROLES,
};
