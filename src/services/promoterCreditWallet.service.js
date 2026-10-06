const { randomBytes } = require("crypto");
const pool = require("../db");
const { countSettledTicketsForPromoter } = require("./settledTicket.service");

const UNLOCK_THRESHOLD = 575;

function generateWalletId() {
  return `wlt_${randomBytes(12).toString("hex")}`;
}

function penceToGbp(pence) {
  const n = Number(pence);
  if (!Number.isFinite(n)) return 0;
  return Number((n / 100).toFixed(2));
}

/**
 * Create wallet row inside an open transaction. Fails with PG 23505 if one already exists.
 * @param {import("pg").PoolClient} client
 * @param {number} promoterUserId users.id
 */
async function insertPromoterCreditWallet(client, promoterUserId) {
  const walletId = generateWalletId();
  const result = await client.query(
    `INSERT INTO promoter_credit_wallets (wallet_id, promoter_id, status, ticket_count, service_fee_rate)
     VALUES ($1, $2, 'LOCKED', 0, 0.10)
     RETURNING *`,
    [walletId, promoterUserId]
  );
  return result.rows[0];
}

/**
 * Idempotent: return existing row or insert. For registration / approval flows (must not 409).
 * @param {import("pg").PoolClient} client
 */
async function ensurePromoterCreditWallet(client, promoterUserId) {
  await client.query(
    `INSERT INTO credit_wallets (user_id, role, projected_balance, available_balance, held_balance, currency)
     VALUES ($1, 'promoter', 0, 0, 0, 'GBP')
     ON CONFLICT (user_id, role) DO NOTHING`,
    [promoterUserId]
  );

  const existing = await client.query(
    `SELECT * FROM promoter_credit_wallets WHERE promoter_id = $1`,
    [promoterUserId]
  );
  if (existing.rowCount > 0) return existing.rows[0];
  return insertPromoterCreditWallet(client, promoterUserId);
}

function serializeCreatedRow(row) {
  return {
    wallet_id: row.wallet_id,
    promoter_id: String(row.promoter_id),
    balance: 0,
    projected_balance: 0,
    status: row.status,
    ticket_count: 0,
    unlock_date: null,
    service_fee_rate: Number(row.service_fee_rate),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Strict create for POST /credit/wallets/create — 409 if already exists.
 * @param {import("pg").PoolClient} client
 */
async function createWalletStrict(client, promoterUserId) {
  const userCheck = await client.query(`SELECT id, role FROM users WHERE id = $1`, [promoterUserId]);
  if (userCheck.rowCount === 0) {
    const err = new Error("User not found");
    err.code = "PROMOTER_NOT_FOUND";
    throw err;
  }
  if (userCheck.rows[0].role !== "promoter") {
    const err = new Error("User is not a promoter");
    err.code = "NOT_PROMOTER";
    throw err;
  }
  const row = await insertPromoterCreditWallet(client, promoterUserId);
  return serializeCreatedRow(row);
}

/**
 * Active promoters who never got a row (legacy flows, pre-migration, or non-referral registration)
 * get one created here so GET wallet matches product expectations.
 */
async function ensurePromoterCreditWalletIfActivePromoter(promoterUserId) {
  const u = await pool.query(`SELECT role, account_status FROM users WHERE id = $1`, [promoterUserId]);
  if (
    u.rowCount === 0 ||
    u.rows[0].role !== "promoter" ||
    (u.rows[0].account_status || "active") !== "active"
  ) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensurePromoterCreditWallet(client, promoterUserId);
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Load wallet, sync ticket_count, auto-unlock at threshold, merge balances from credit_wallets.
 * @param {number} promoterUserId
 */
async function getWalletForPromoter(promoterUserId) {
  let walletRes = await pool.query(`SELECT * FROM promoter_credit_wallets WHERE promoter_id = $1`, [
    promoterUserId,
  ]);
  if (walletRes.rowCount === 0) {
    await ensurePromoterCreditWalletIfActivePromoter(promoterUserId);
    walletRes = await pool.query(`SELECT * FROM promoter_credit_wallets WHERE promoter_id = $1`, [
      promoterUserId,
    ]);
  }
  if (walletRes.rowCount === 0) return null;

  const wallet = walletRes.rows[0];
  const ticketCount = await countSettledTicketsForPromoter(promoterUserId);

  const cwRes = await pool.query(
    `SELECT projected_balance, available_balance FROM credit_wallets WHERE user_id = $1 AND role = 'promoter'`,
    [promoterUserId]
  );
  const projectedPence = cwRes.rows[0]?.projected_balance ?? 0;
  const availablePence = cwRes.rows[0]?.available_balance ?? 0;

  let status = wallet.status;
  let unlockDate = wallet.unlock_date;

  if (ticketCount >= UNLOCK_THRESHOLD && status === "LOCKED") {
    const upd = await pool.query(
      `UPDATE promoter_credit_wallets
       SET status = 'UNLOCKED',
           unlock_date = COALESCE(unlock_date, NOW()),
           ticket_count = $2,
           updated_at = NOW()
       WHERE promoter_id = $1 AND status = 'LOCKED'
       RETURNING status, unlock_date`,
      [promoterUserId, ticketCount]
    );
    if (upd.rowCount > 0) {
      status = upd.rows[0].status;
      unlockDate = upd.rows[0].unlock_date;
    } else {
      const again = await pool.query(`SELECT status, unlock_date FROM promoter_credit_wallets WHERE promoter_id = $1`, [
        promoterUserId,
      ]);
      status = again.rows[0].status;
      unlockDate = again.rows[0].unlock_date;
    }
  } else {
    await pool.query(
      `UPDATE promoter_credit_wallets SET ticket_count = $2, updated_at = NOW() WHERE promoter_id = $1`,
      [promoterUserId, ticketCount]
    );
  }

  const balanceGbp = status === "UNLOCKED" ? penceToGbp(availablePence) : 0;
  const projectedGbp = penceToGbp(projectedPence);
  const unlockProgressPercent = Number(
    Math.min(100, (ticketCount / UNLOCK_THRESHOLD) * 100).toFixed(2)
  );

  return {
    wallet_id: wallet.wallet_id,
    promoter_id: String(promoterUserId),
    balance: balanceGbp,
    projected_balance: projectedGbp,
    status,
    ticket_count: ticketCount,
    unlock_threshold: UNLOCK_THRESHOLD,
    unlock_progress_percent: unlockProgressPercent,
    unlock_date: unlockDate ? new Date(unlockDate).toISOString() : null,
    service_fee_rate: Number(wallet.service_fee_rate),
    created_at: new Date(wallet.created_at).toISOString(),
  };
}

module.exports = {
  UNLOCK_THRESHOLD,
  generateWalletId,
  ensurePromoterCreditWallet,
  ensurePromoterCreditWalletIfActivePromoter,
  createWalletStrict,
  getWalletForPromoter,
  serializeCreatedRow,
  insertPromoterCreditWallet,
};
