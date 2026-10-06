const pool = require("../db");
const bcrypt = require("bcryptjs");
const { revokeAllUserSessions } = require("../services/session.service");

/**
 * Get all users with pagination
 */
exports.getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT id, email, name, city, avatar_url, status, role, account_status, email_status, created_at, updated_at
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query("SELECT COUNT(*) FROM users");
    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      error: false,
      message: "Resources retrieved successfully",
      data: {
        users: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages,
        },
      },
    });
  } catch (err) {
    console.error("Get all users error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve users at the moment.",
      data: null,
    });
  }
};

/**
 * Get user by ID
 */
exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "SELECT id, email, name, city, avatar_url, status, role, account_status, email_status, created_at, updated_at FROM users WHERE id = $1",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    return res.status(200).json({
      error: false,
      message: "Resource retrieved successfully",
      data: {
        user: result.rows[0],
      },
    });
  } catch (err) {
    console.error("Get user by ID error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve user at the moment.",
      data: null,
    });
  }
};

/**
 * Update user
 */
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, city, avatar_url, status, role } = req.body;

    const result = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           city = COALESCE($2, city),
           avatar_url = COALESCE($3, avatar_url),
           status = COALESCE($4, status),
           role = COALESCE($5, role),
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, email, name, city, avatar_url, status, role, account_status, email_status, created_at, updated_at`,
      [name, city, avatar_url, status, role, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    return res.status(200).json({
      error: false,
      message: "Resource updated successfully",
      data: {
        user: result.rows[0],
      },
    });
  } catch (err) {
    console.error("Update user error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to update user at the moment.",
      data: null,
    });
  }
};

/**
 * Delete user (soft delete)
 */
exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "UPDATE users SET status = 'deleted', updated_at = NOW() WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    return res.status(200).json({
      error: false,
      message: "Resource deleted successfully",
      data: null,
    });
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to delete user at the moment.",
      data: null,
    });
  }
};

/**
 * Change password for authenticated user
 */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: true,
        message: "Current password and new password are required.",
        data: null,
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: true,
        message: "Password must be at least 8 characters long.",
        data: null,
      });
    }

    // Get user with password hash
    const userResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    const user = userResult.rows[0];

    // Check if user has a password (OAuth users might not have password)
    if (!user.password_hash) {
      return res.status(400).json({
        error: true,
        message: "Cannot change password. Account uses OAuth authentication.",
        data: null,
      });
    }

    // Verify current password
    const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({
        error: true,
        message: "Current password is incorrect.",
        data: null,
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await pool.query(
      `
      UPDATE users
      SET password_hash = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [passwordHash, req.user.id]
    );

    // Revoke all existing sessions for security (except current one)
    await revokeAllUserSessions(req.user.id, "password_change");

    return res.status(200).json({
      error: false,
      message: "Password changed successfully.",
      data: {
        success: true,
      },
    });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to change password at the moment.",
      data: null,
    });
  }
};

