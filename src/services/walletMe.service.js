
const pool = require("../db");
const { UNLOCK_THRESHOLD } = require("./promoterCreditWallet.service");
const { countSettledTicketsForPromoter, countSettledTicketsForGuru } = require("./settledTicket.service");

const WALLET_ROLES = ["promoter", "guru", "network_manager"];

const SPRINT_TICKETS_REQUIRED = 5000;
const NM_LICENCE_FEE_GBP_DEFAULT = 2500;

function penceToGbp(pence) {
  const n = Number(pence);
  if (!Number.isFinite(n)) return 0;
  return Number((n / 100).toFixed(2));
}

function parseGuruLevel(levelRaw, levelStatusRaw) {
  const s = String(levelRaw || levelStatusRaw || "L1").toUpperCase();
  const m = s.match(/L?(\d+)/);
  return m ? Math.min(3, Math.max(1, parseInt(m[1], 10))) : 1;
}

function isWalletAccessBlocked(userRoles) {
  if (!userRoles || userRoles.length === 0) return true;
  if (userRoles.includes("kings_account")) return true;
  const hasWalletRole = userRoles.some((r) => WALLET_ROLES.includes(r));
  if (userRoles.some((r) => ["finance", "staff_finance"].includes(r)) && !hasWalletRole) return true;
  return false;
}

/**
 * First wallet-eligible role (promoter → guru → network_manager) that has a credit_wallets row.
 * @param {number} userId
 * @param {string[]} userRoles
 * @returns {Promise<string|null>}
 */
async function resolveWalletRole(userId, userRoles) {
  const order = ["promoter", "guru", "network_manager"];
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

async function loadGuruMeta(userId) {
  const gp = await pool.query(`SELECT level FROM guru_profiles WHERE user_id = $1 LIMIT 1`, [userId]);
  const tl = await pool.query(
    `SELECT level_status, service_fee_rate_current, territory_id
     FROM territory_licences
     WHERE user_id = $1 AND licence_status IN ('ACTIVE', 'CLEARED')
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [userId]
  );
  const level = parseGuruLevel(gp.rows[0]?.level, tl.rows[0]?.level_status);
  const territoryId = tl.rows[0]?.territory_id ?? null;
  const serviceFeeRate = tl.rows[0]?.service_fee_rate_current != null
    ? Number(tl.rows[0].service_fee_rate_current)
    : level >= 3 ? 0.15 : level >= 2 ? 0.15 : 0.2;
  return { level, territoryId, serviceFeeRate };
}

async function loadNetworkManagerMeta(userId) {
  const tl = await pool.query(
    `SELECT licence_fee_amount_snapshot, licence_balance_remaining, territory_id, service_fee_rate_current
     FROM territory_licences
     WHERE user_id = $1 AND licence_status IN ('ACTIVE', 'CLEARED')
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [userId]
  );
  if (tl.rowCount === 0) {
    return {
      territoryId: null,
      licenceOwedGbp: NM_LICENCE_FEE_GBP_DEFAULT,
      licenceRemainingGbp: NM_LICENCE_FEE_GBP_DEFAULT,
      serviceFeeRate: 0.2,
    };
  }
  const row = tl.rows[0];
  const owed = penceToGbp(row.licence_fee_amount_snapshot);
  const remaining = penceToGbp(row.licence_balance_remaining);
  return {
    territoryId: row.territory_id,
    licenceOwedGbp: owed || NM_LICENCE_FEE_GBP_DEFAULT,
    licenceRemainingGbp: remaining,
    serviceFeeRate: Number(row.service_fee_rate_current) || 0.2,
  };
}

function quarterWindowUtc() {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), (q + 1) * 3, 1, 0, 0, 0, 0));
  return { windowStart: start, windowExpires: end };
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

  if (walletRole === "guru") {
    const meta = await loadGuruMeta(userId);
    base.level = meta.level;
    base.territory_id = meta.territory_id != null ? String(meta.territory_id) : null;
    base.service_fee.rate = meta.serviceFeeRate;
    base.unlock_status = { unlocked: true };

    if (meta.level >= 3) {
      const nw = Number((confirmedGbp * 0.5).toFixed(2));
      base.balances.net_withdrawable = nw;
      base.withdrawal_eligibility = {
        eligible_percent: 50,
        withdrawable_amount: nw,
        reason: "50% of confirmed credit withdrawable monthly",
      };
    } else if (meta.level === 2) {
      base.balances.sprint_credit = confirmedGbp;
      base.balances.net_withdrawable = 0;
      base.withdrawal_eligibility = {
        eligible_percent: 0,
        reason: "No cash withdrawal at Level 2 without enhanced licence. All confirmed credit held as sprint credit.",
      };
      const { windowStart, windowExpires } = quarterWindowUtc();
      const ticketsInWindow = await countSettledTicketsForGuru(userId, windowStart.toISOString(), new Date().toISOString());
      const daysRemaining = Math.max(0, Math.ceil((windowExpires - Date.now()) / 86400000));
      base.sprint = {
        active: true,
        tickets_in_window: ticketsInWindow,
        tickets_required: SPRINT_TICKETS_REQUIRED,
        progress_percent: Number(Math.min(100, (ticketsInWindow / SPRINT_TICKETS_REQUIRED) * 100).toFixed(1)),
        window_start: windowStart.toISOString(),
        window_expires: windowExpires.toISOString(),
        days_remaining: daysRemaining,
      };
    } else {
      base.balances.net_withdrawable = 0;
      base.withdrawal_eligibility = {
        eligible_percent: 0,
        reason: "Withdrawals not available at Level 1",
      };
    }
    return { ok: true, body: base };
  }

  /* network_manager */
  const nm = await loadNetworkManagerMeta(userId);
  base.level = 1;
  base.territory_id = nm.territoryId != null ? String(nm.territoryId) : null;
  base.service_fee.rate = nm.serviceFeeRate;
  base.balances.licence_owed = nm.licenceOwedGbp;
  base.balances.licence_remaining = nm.licenceRemainingGbp;
  base.balances.net_withdrawable = nm.licenceRemainingGbp <= 0 ? Number((confirmedGbp * 0.5).toFixed(2)) : 0;
  base.withdrawal_eligibility =
    nm.licenceRemainingGbp > 0
      ? {
          eligible_percent: 0,
          reason: `Licence fee of £${nm.licenceOwedGbp.toFixed(2)} not yet cleared from credit`,
        }
      : {
          eligible_percent: 50,
          withdrawable_amount: base.balances.net_withdrawable,
          reason: "50% of confirmed credit withdrawable monthly",
        };
  return { ok: true, body: base };
}

module.exports = {
  getWalletMeForUser,
  isWalletAccessBlocked,
  resolveWalletRole,
  loadCreditWalletRow,
  penceToGbp,
  WALLET_ROLES,
};
