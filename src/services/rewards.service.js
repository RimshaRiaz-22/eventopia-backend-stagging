const pool = require('../db');

// ==========================================
// Get User Reward Balance
// ==========================================
const getUserRewardBalance = async (userId) => {
  // 1️⃣ Get earned total from ACTIVE reward vouchers
  const earnedResult = await pool.query(
    `
    SELECT COALESCE(SUM(amount), 0) AS earned_total
    FROM reward_vouchers
    WHERE owner_id = $1
      AND status = 'active'
    `,
    [userId]
  );

  const earned_total = parseInt(earnedResult.rows[0].earned_total);

  // 2️⃣ Get spent total from approved/completed redemptions
  const spentResult = await pool.query(
    `
    SELECT COALESCE(SUM(requested_amount), 0) AS spent_total
    FROM reward_redemption_requests
    WHERE requester_id = $1
      AND status IN ('approved', 'completed')
    `,
    [userId]
  );

  const spent_total = parseInt(spentResult.rows[0].spent_total);

  // 3️⃣ Calculate available balance
  const available_balance = earned_total - spent_total;



  
  return {
    earned_total,
    spent_total,
    available_balance
  };
};



// ==========================================
// Create Redemption Request
// ==========================================
const createRedemptionRequest = async (user, requested_amount, request_note) => {
  const { id: userId, role } = user;

  // 1️⃣ Validate role
  if (!['promoter', 'guru'].includes(role)) {
    throw {
      status: 403,
      code: 'REWARD_ACCESS_DENIED',
      message: 'Only promoters and gurus can create redemption requests'
    };
  }

  // 2️⃣ Validate amount
  if (!requested_amount || requested_amount <= 0) {
    throw {
      status: 400,
      code: 'INVALID_AMOUNT',
      message: 'Requested amount must be greater than zero'
    };
  }

  // 3️⃣ Get latest balance
  const balance = await getUserRewardBalance(userId);

  if (requested_amount > balance.available_balance) {
    throw {
      status: 400,
      code: 'INSUFFICIENT_BALANCE',
      message: 'Requested amount exceeds available balance'
    };
  }

  // 4️⃣ Insert pending request
  const result = await pool.query(
    `
    INSERT INTO reward_redemption_requests
    (requester_type, requester_id, requested_amount, request_note, status)
    VALUES ($1, $2, $3, $4, 'pending')
    RETURNING *
    `,
    [role, userId, requested_amount, request_note]
  );

  return result.rows[0];
};




const getUserRedemptions = async (userId) => {
  const result = await pool.query(
    `
    SELECT id, requested_amount, status, request_note, admin_note, created_at, updated_at
    FROM reward_redemption_requests
    WHERE requester_id = $1
    ORDER BY created_at DESC
    `,
    [userId]
  );

  return result.rows;
};


// ==========================================
const approveRedemptionRequest = async (requestId, adminId, adminNote = null) => {
  const result = await pool.query(
    `
    SELECT requester_id, requested_amount
    FROM reward_redemption_requests
    WHERE id = $1 AND status = 'pending'
    `,
    [requestId]
  );

  const redemption = result.rows[0];

  if (!redemption) {
    throw {
      status: 404,
      code: 'REWARD_REDEMPTION_NOT_FOUND',
      message: 'Redemption request not found or not pending'
    };
  }

  const balance = await getUserRewardBalance(redemption.requester_id);

  if (redemption.requested_amount > balance.available_balance) {
    throw {
      status: 400,
      code: 'INSUFFICIENT_BALANCE',
      message: 'Requested amount exceeds available balance'
    };
  }

  // Update redemption status to approved
  const approvalResult = await pool.query(
    `
    UPDATE reward_redemption_requests
    SET status = 'approved', approved_at = NOW(), decided_by_admin_id = $2, admin_note = $3
    WHERE id = $1
    RETURNING *
    `,
    [requestId, adminId, adminNote]
  );

  return approvalResult.rows[0];
};

// ==========================================
// Admin Reject Redemption Request
// ==========================================
const rejectRedemptionRequest = async (requestId, adminId, adminNote = null) => {
  const result = await pool.query(
    `
    UPDATE reward_redemption_requests
    SET status = 'rejected', approved_at = NOW(), decided_by_admin_id = $2, admin_note = $3
    WHERE id = $1 AND status = 'pending'
    RETURNING *
    `,
    [requestId, adminId, adminNote]
  );

  if (result.rowCount === 0) {
    throw {
      status: 404,
      code: 'REWARD_REDEMPTION_NOT_FOUND',
      message: 'Redemption request not found or not pending'
    };
  }

  return result.rows[0];
};

// ==========================================
// Admin Complete Redemption Request
// ==========================================
const completeRedemptionRequest = async (requestId, adminId, adminNote = null) => {
  const result = await pool.query(
    `
    UPDATE reward_redemption_requests
    SET status = 'completed', completed_at = NOW(), decided_by_admin_id = $2, admin_note = $3
    WHERE id = $1 AND status = 'approved'
    RETURNING *
    `,
    [requestId, adminId, adminNote]
  );

  if (result.rowCount === 0) {
    throw {
      status: 404,
      code: 'REWARD_REDEMPTION_NOT_FOUND',
      message: 'Redemption request not found or not approved'
    };
  }

  return result.rows[0];
};
module.exports = {
  getUserRewardBalance,
    createRedemptionRequest,
    getUserRedemptions ,
    approveRedemptionRequest,
    rejectRedemptionRequest,
    completeRedemptionRequest
};

