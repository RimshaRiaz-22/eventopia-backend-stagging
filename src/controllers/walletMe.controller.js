/**
 * Contract 24 — GET /api/v1/wallet/me
 */

const { getWalletMeForUser } = require("../services/walletMe.service");

async function getWalletMe(req, res) {
  try {
    const userId = req.user?.id;
    if (userId == null) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Invalid or expired token",
      });
    }

    const result = await getWalletMeForUser(userId, req.userRoles || []);

    if (!result.ok && result.code === "BLOCKED") {
      return res.status(403).json({
        error: "UNAUTHORIZED_ROLE",
        message: "Kings Account and Finance use admin wallet endpoints",
      });
    }

    if (!result.ok && result.code === "NO_WALLET") {
      return res.status(404).json({
        error: "WALLET_NOT_FOUND",
        message: "Wallet not initialised for this user",
      });
    }

    return res.status(200).json(result.body);
  } catch (err) {
    console.error("getWalletMe error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Unable to load wallet",
    });
  }
}

module.exports = { getWalletMe };
