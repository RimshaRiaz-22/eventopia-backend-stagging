const { getUserRewardBalance } = require('../services/rewards.service');
const { ok, fail } = require('../utils/standardResponse');
const { createRedemptionRequest } = require('../services/rewards.service');
const { getUserRedemptions } = require('../services/rewards.service');
const { approveRedemptionRequest, rejectRedemptionRequest, completeRedemptionRequest } = require('../services/rewards.service');

const pool = require('../db');


const ensureRewardAccess = async (req) => {
  const userId = req.user.id;

  const result = await pool.query(
    `SELECT role FROM users WHERE id = $1`,
    [userId]
  );

  const role = result.rows[0]?.role;

  if (!['promoter', 'guru'].includes(role)) {
    throw {
      status: 403,
      code: 'REWARD_ACCESS_DENIED',
      message: 'Only promoters and gurus can access reward shop'
    };
  }

  return role;
};

// ==========================================
// GET /api/rewards/balance
// ==========================================
const getBalance = async (req, res) => {
  try {
    await ensureRewardAccess(req);

    const userId = req.user.id;
    const balance = await getUserRewardBalance(userId);

    return ok(res, req, balance, 200);

  } catch (error) {
    return fail(
      res,
      req,
      error.status || 500,
      error.code || 'REWARD_BALANCE_ERROR',
      error.message || 'Failed to fetch reward balance'
    );
  }
};

const createRedemption = async (req, res) => {
  try {
    const role = await ensureRewardAccess(req);

    const { requested_amount, request_note } = req.body;

    const redemption = await createRedemptionRequest(
      { id: req.user.id, role },
      requested_amount,
      request_note
    );

    return ok(res, req, redemption, 201);

  } catch (error) {
    return fail(
      res,
      req,
      error.status || 500,
      error.code || 'REWARD_REDEMPTION_ERROR',
      error.message || 'Failed to create redemption request'
    );
  }
};


const getRedemptions = async (req, res) => {
  try {
    const userId = req.user.id;

    const redemptions = await getUserRedemptions(userId);

    return ok(res, req, redemptions, 200);

  } catch (error) {
    console.error('Error fetching redemption requests:', error);

    return fail(
      res,
      req,
      500,
      'REWARD_REDEMPTION_LIST_ERROR',
      'Failed to fetch redemption requests'
    );
  }
};



const approveRedemption = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id; // Admin user ID
    const { admin_note } = req.body; // Admin note

    const redemption = await approveRedemptionRequest(id, adminId, admin_note);

    return ok(res, req, redemption, 200);
  } catch (error) {
    return fail(
      res,
      req,
      error.status || 500,
      error.code || 'REWARD_APPROVE_ERROR',
      error.message || 'Failed to approve redemption request'
    );
  }
};

// ==========================================
// Admin Reject Redemption Request
// ==========================================
const rejectRedemption = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const { admin_note } = req.body; // Admin note

    const redemption = await rejectRedemptionRequest(id, adminId, admin_note);

    return ok(res, req, redemption, 200);
  } catch (error) {
    return fail(
      res,
      req,
      error.status || 500,
      error.code || 'REWARD_REJECT_ERROR',
      error.message || 'Failed to reject redemption request'
    );
  }
};

// ==========================================
// Admin Complete Redemption Request
// ==========================================
const completeRedemption = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const { admin_note } = req.body; // Admin note

    const redemption = await completeRedemptionRequest(id, adminId, admin_note);

    return ok(res, req, redemption, 200);
  } catch (error) {
    return fail(
      res,
      req,
      error.status || 500,
      error.code || 'REWARD_COMPLETE_ERROR',
      error.message || 'Failed to complete redemption request'
    );
  }
};

module.exports = {
  getBalance,
  createRedemption,
  getRedemptions,
  approveRedemption,
  rejectRedemption,
  completeRedemption
};
