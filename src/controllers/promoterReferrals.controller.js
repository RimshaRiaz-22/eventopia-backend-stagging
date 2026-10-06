const {
  ensureShareableReferralLinkForPromoter,
  getPromoterReferrals,
} = require("../services/promoterReferral.service");

async function createReferralLink(req, res) {
  try {
    // GET endpoint must be idempotent for dashboard refresh/login flows.
    // Reuse an existing unused link when available; only create if none exists.
    const data = await ensureShareableReferralLinkForPromoter(req.user.id);
    return res.status(200).json({
      error: false,
      message: "Referral link retrieved successfully.",
      data,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      error: true,
      message: err.message || "Failed to generate referral link.",
      data: null,
    });
  }
}

async function listPromoterReferrals(req, res) {
  try {
    const page = parseInt(req.query.page, 10);
    const limit = parseInt(req.query.limit, 10);
    const search = typeof req.query.search === "string" ? req.query.search : "";

    const data = await getPromoterReferrals(req.user.id, {
      page: Number.isNaN(page) ? 1 : page,
      limit: Number.isNaN(limit) ? 10 : limit,
      search,
    });
    return res.status(200).json({
      error: false,
      message: "Referrals retrieved successfully.",
      data,
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Failed to fetch referrals.",
      data: null,
    });
  }
}

module.exports = {
  createReferralLink,
  listPromoterReferrals,
};
