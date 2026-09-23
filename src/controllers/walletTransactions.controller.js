/**
 * Contract 25 — GET /api/v1/wallet/transactions
 */

const { getWalletTransactions } = require("../services/walletTransactions.service");

async function getWalletTransactionsHandler(req, res) {
  try {
    const userId = req.user?.id;
    if (userId == null) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Invalid or expired token",
      });
    }

    const result = await getWalletTransactions(userId, req.userRoles || [], req.query || {});

    if (!result.ok && result.code === "BLOCKED") {
      return res.status(403).json({
        error: "UNAUTHORIZED_ROLE",
        message: "Kings Account and Finance use admin wallet endpoints",
      });
    }

    if (!result.ok && result.code === "NO_WALLET") {
      return res.status(403).json({
        error: "UNAUTHORIZED_ROLE",
        message: "No wallet for this role",
      });
    }

    if (!result.ok && result.code === "INVALID_PAGE") {
      return res.status(400).json({
        error: "INVALID_PAGE",
        message: "Page must be a positive integer",
      });
    }

    if (!result.ok && result.code === "INVALID_DATE_RANGE") {
      return res.status(400).json({
        error: "INVALID_DATE_RANGE",
        message: "from must be before to",
      });
    }

    return res.status(200).json(result.body);
  } catch (err) {
    console.error("getWalletTransactions error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Unable to load transactions",
    });
  }
}

module.exports = { getWalletTransactionsHandler };
