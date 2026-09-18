/**
 * Credit Engine — promoter credit wallets
 * POST /api/v1/credit/wallets/create (internal: admin/founder JWT)
 * GET  /api/v1/credit/wallets/:promoter_id (promoter: own wallet only)
 */

const pool = require("../db");
const { createWalletStrict, getWalletForPromoter } = require("../services/promoterCreditWallet.service");

function parsePromoterId(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** node-pg often returns BIGINT user ids as strings; compare numerically */
function userOwnsPromoterRoute(reqUserId, routePromoterId) {
  const a = Number(reqUserId);
  const b = Number(routePromoterId);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * POST /api/v1/credit/wallets/create
 */
async function createWallet(req, res) {
  const promoterId = parsePromoterId(req.body?.promoter_id);
  if (promoterId == null) {
    return res.status(400).json({
      error: "Bad Request",
      reason: "promoter_id missing or malformed",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const body = await createWalletStrict(client, promoterId);
    await client.query("COMMIT");
    return res.status(201).json(body);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    if (err.code === "23505") {
      return res.status(409).json({
        error: "Conflict",
        reason: "Wallet already exists for this promoter_id",
      });
    }
    if (err.code === "PROMOTER_NOT_FOUND" || err.code === "NOT_PROMOTER") {
      return res.status(400).json({
        error: "Bad Request",
        reason: err.message,
      });
    }
    console.error("createWallet error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      reason: "Wallet creation failed",
    });
  } finally {
    client.release();
  }
}

/**
 * GET /api/v1/credit/wallets/:promoter_id
 */
async function getWallet(req, res) {
  const promoterId = parsePromoterId(req.params.promoter_id);
  if (promoterId == null) {
    return res.status(400).json({
      error: "Bad Request",
      reason: "promoter_id missing or malformed",
    });
  }

  if (!req.user || !userOwnsPromoterRoute(req.user.id, promoterId)) {
    return res.status(403).json({
      error: "Forbidden",
      reason: "Authenticated user does not own this wallet",
    });
  }

  if (!req.userRoles || !req.userRoles.includes("promoter")) {
    return res.status(403).json({
      error: "Forbidden",
      reason: "Promoter role required",
    });
  }

  try {
    const body = await getWalletForPromoter(promoterId);
    if (!body) {
      return res.status(404).json({
        error: "Not Found",
        reason: "No wallet found for this promoter_id",
      });
    }
    return res.status(200).json(body);
  } catch (err) {
    console.error("getWallet error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      reason: "Unable to load wallet",
    });
  }
}

module.exports = {
  createWallet,
  getWallet,
};
