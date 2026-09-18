const pool = require("../db");
const { revokeAllUserSessions } = require("../services/session.service");
const { ok, fail } = require("../utils/standardResponse");
const GuruService = require("../services/guru.service");
const ReferralService = require("../services/referral.service");
const { logEventChange, logCharityChange, logAdminAudit } = require("../middlewares/audit.middleware");
const { issueRewardsForEvent } = require("../services/reward.service");
const { sendRewardNotificationEmails } = require("../services/email.service");
const CharityService = require("../services/charity.service");
const CharityPaymentService = require("../services/charityPayment.service");
const CharityLedgerService = require("../services/charityLedger.service");
const CharityNotificationService = require("../services/charityNotification.service");
const PlatformLedgerService = require("../services/platformLedger.service");
const TerritoryApplicationService = require("../services/territoryApplication.service");
const TerritoryLicenceService = require("../services/territoryLicence.service");
const TerritoryLicenceInventoryService = require("../services/territoryLicenceInventory.service");
const { ensurePromoterCreditWallet } = require("../services/promoterCreditWallet.service");
const { ensureEscrowLiabilityForEvent } = require("../services/escrowLiability.service");
const {
  getReferralPoolAdminView,
  approveReferralPayout,
} = require("../services/promoterReferral.service");

/**
 * Approve Guru application
 * POST /admin/gurus/:applicationId/approve
 */
async function approveGuruApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { applicationId } = req.params;
    const adminId = req.user.id;

    // Get the application
    const appResult = await client.query(
      `
      SELECT ga.*, u.id as user_id, u.email, u.name
      FROM guru_applications ga
      JOIN users u ON u.id = ga.user_id
      WHERE ga.id = $1
      `,
      [applicationId]
    );

    if (appResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "Application not found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Check if already approved
    if (application.account_status === "approved") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Application is already approved.",
        data: null,
      });
    }

    // Activation fee gate: must have committed upfront or negative_balance
    const validActivationStatuses = ["committed_upfront", "committed_negative_balance"];
    if (!application.activation_fee_status || !validActivationStatuses.includes(application.activation_fee_status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Activation fee must be committed before approval. Applicant must choose upfront payment or negative balance.",
        data: null,
      });
    }

    // Get Network Manager details
    const nmResult = await client.query(
      `
      SELECT u.id, u.name, u.city
      FROM users u
      WHERE u.id = $1 AND u.role = 'network_manager'
      `,
      [application.network_manager_user_id]
    );

    if (nmResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Invalid Network Manager.",
        data: null,
      });
    }

    const networkManager = nmResult.rows[0];

    // Update application status
    await client.query(
      `
      UPDATE guru_applications
      SET account_status = 'approved',
          reviewed_by = $1,
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
      `,
      [adminId, applicationId]
    );

    // Wallet initialization: upfront = 0, negative_balance = -25000
    const walletBalance = application.activation_fee_status === "committed_upfront" ? 0 : -25000;
    await client.query(
      `INSERT INTO wallets (user_id, balance_amount, currency)
       VALUES ($1, $2, 'GBP')
       ON CONFLICT (user_id) DO UPDATE SET balance_amount = $2, updated_at = NOW()`,
      [application.user_id, walletBalance]
    );

    // Payment record for negative_balance path
    if (application.activation_fee_status === "committed_negative_balance") {
      await client.query(
        `INSERT INTO payment_transactions
         (user_id, entity_type, entity_id, amount, currency, direction, status, payment_method)
         VALUES ($1, 'guru_activation_fee', $2, 25000, 'GBP', 'debit', 'completed', 'negative_balance')`,
        [application.user_id, application.id]
      );
    }

    // Update user: signup_fee_paid only for upfront
    const signupFeePaid = application.activation_fee_status === "committed_upfront";
    const userResult = await client.query(
      `
      UPDATE users
      SET account_status = 'active',
          role = 'guru',
          guru_active = TRUE,
          guru_active_until = NOW() + INTERVAL '1 year',
          guru_activation_date = NOW(),
          signup_fee_paid = $2,
          roles_version = roles_version + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING roles_version
      `,
      [application.user_id, signupFeePaid]
    );

    const newRolesVersion = userResult.rows[0].roles_version;

    // Ensure guru profile exists with licence debt baseline for self-registration path.
    const guruProfileExists = await client.query(
      `SELECT user_id FROM guru_profiles WHERE user_id = $1 LIMIT 1`,
      [application.user_id]
    );
    if (guruProfileExists.rowCount === 0) {
      await client.query(
        `INSERT INTO guru_profiles (user_id, level, licence_balance, created_at)
         VALUES ($1, 1, -295, NOW())`,
        [application.user_id]
      );
    }

    // Set guru level L1 with service_fee_rate 20%
    const levelResult = await client.query(
      `SELECT rate_per_ticket, service_fee_rate FROM guru_commission_rates WHERE level = 1`
    );
    const ratePerTicket = levelResult.rowCount > 0 ? levelResult.rows[0].rate_per_ticket : 20;
    const serviceFeeRate = levelResult.rowCount > 0 ? levelResult.rows[0].service_fee_rate : 0.2;
    await client.query(
      `INSERT INTO guru_levels (guru_id, level, rate_per_ticket, service_fee_rate, created_by, reason)
       VALUES ($1, 1, $2, $3, $4, 'Default level on approval')`,
      [application.user_id, ratePerTicket, serviceFeeRate, adminId]
    );

    // Create or update guru_network_manager link
    await client.query(
      `
      INSERT INTO guru_network_manager (guru_user_id, network_manager_user_id, territory_name, assigned_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (guru_user_id)
      DO UPDATE SET
        network_manager_user_id = $2,
        territory_name = $3,
        assigned_at = NOW()
      `,
      [application.user_id, application.network_manager_user_id, application.territory_name]
    );

    await client.query("COMMIT");

    // Generate referral code (non-blocking)
    try {
      await ReferralService.createReferralCode(application.user_id);
    } catch (err) {
      // Referral code might already exist, continue
    }

    // Revoke all existing sessions for the user so they need to refresh
    // This forces them to get new token with updated roles
    try {
      await revokeAllUserSessions(application.user_id, "role_assigned");
    } catch (sessionError) {
      // Log but don't fail - session revocation is not critical
      console.error("Error revoking sessions:", sessionError);
    }

    return res.json({
      error: false,
      message: "Guru application approved successfully.",
      data: {
        application: {
          id: applicationId,
          accountStatus: "approved",
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
        user: {
          userId: application.user_id,
          email: application.email,
          name: application.name,
          role: "guru",
          accountStatus: "active",
          rolesVersion: newRolesVersion
        },
        networkManager: {
          id: networkManager.id,
          name: networkManager.name,
          territory: application.territory_name,
        }
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Approve Guru application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to approve Guru application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Approve Network Manager application
 * POST /admin/network-managers/:applicationId/approve
 */
async function approveNetworkManagerApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { applicationId } = req.params;
    const adminId = req.user.id;

    // Get the application
    const appResult = await client.query(
      `
      SELECT nma.*, u.id as user_id, u.email
      FROM network_manager_applications nma
      JOIN users u ON u.id = nma.user_id
      WHERE nma.id = $1
      `,
      [applicationId]
    );

    if (appResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "Application not found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Check if already approved
    if (application.account_status === "approved") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Application is already approved.",
        data: null,
      });
    }

    // Update application status
    await client.query(
      `
      UPDATE network_manager_applications
      SET account_status = 'approved',
          reviewed_by = $1,
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
      `,
      [adminId, applicationId]
    );

    // Update user account_status to active
    await client.query(
      `
      UPDATE users
      SET account_status = 'active',
          updated_at = NOW()
      WHERE id = $1
      `,
      [application.user_id]
    );

    // Assign Network Manager role (single-role system)
    const userResult = await client.query(
      `
      UPDATE users
      SET role = 'network_manager',
          roles_version = roles_version + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING roles_version
      `,
      [application.user_id]
    );

    const newRolesVersion = userResult.rows[0].roles_version;

    await client.query("COMMIT");

    // Revoke all existing sessions for the user so they need to refresh
    // This forces them to get new token with updated roles
    try {
      await revokeAllUserSessions(application.user_id, "role_assigned");
    } catch (sessionError) {
      // Log but don't fail - session revocation is not critical
      console.error("Error revoking sessions:", sessionError);
    }

    return res.json({
      error: false,
      message: "Network Manager application approved successfully.",
      data: {
        application: {
          id: application.id,
          userId: application.user_id,
          territoryName: application.territory_name,
          accountStatus: "approved",
          reviewedAt: new Date(),
        },
        user: {
          userId: application.user_id,
          email: application.email,
          accountStatus: "active",
          rolesVersion: newRolesVersion,
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Approve Network Manager application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to approve application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Reject Network Manager application
 * POST /admin/network-managers/:applicationId/reject
 */
async function rejectNetworkManagerApplication(req, res) {
  try {
    const { applicationId } = req.params;
    const { rejection_reason } = req.body || {};
    const appResult = await pool.query(
      "SELECT id, user_id FROM network_manager_applications WHERE id = $1",
      [applicationId]
    );
    if (appResult.rowCount === 0) {
      return res.status(404).json({ error: true, message: "Application not found.", data: null });
    }
    const app = appResult.rows[0];
    await pool.query(
      `UPDATE network_manager_applications
       SET account_status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), rejection_reason = $2, updated_at = NOW()
       WHERE id = $3`,
      [req.user.id, rejection_reason || null, applicationId]
    );
    return res.json({
      error: false,
      message: "Network Manager application rejected.",
      data: { applicationId: app.id, userId: app.user_id },
    });
  } catch (err) {
    console.error("Reject Network Manager application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to reject application.",
      data: null,
    });
  }
}

/**
 * Approve Promoter application
 * POST /admin/promoters/:applicationId/approve
 */
async function approvePromoterApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { applicationId } = req.params;
    const adminId = req.user.id;

    // Get the application
    const appResult = await client.query(
      `
      SELECT pa.*, u.id as user_id, u.email, u.name, u.avatar_url,
             pgl.guru_user_id, gnm.territory_name
      FROM promoter_applications pa
      JOIN users u ON u.id = pa.user_id
      LEFT JOIN promoter_guru_links pgl ON pgl.promoter_user_id = u.id
      LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = pgl.guru_user_id
      WHERE pa.id = $1
      `,
      [applicationId]
    );

    if (appResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "Application not found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Check if already approved
    if (application.account_status === "approved") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Application is already approved.",
        data: null,
      });
    }

    // Update application status
    await client.query(
      `
      UPDATE promoter_applications
      SET account_status = 'approved',
          reviewed_by = $1,
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
      `,
      [adminId, applicationId]
    );

    // Update user role to promoter and account_status to active
    const userResult = await client.query(
      `
      UPDATE users
      SET role = 'promoter',
          account_status = 'active',
          roles_version = roles_version + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING roles_version, name, email
      `,
      [application.user_id]
    );

    const newRolesVersion = userResult.rows[0].roles_version;

    // Activate promoter wallet
    // Check if wallet exists (it should from application creation)
    const walletResult = await client.query(
      `SELECT id FROM wallets WHERE user_id = $1`,
      [application.user_id]
    );

    if (walletResult.rowCount === 0) {
      // Create wallet if it doesn't exist
      await client.query(
        `INSERT INTO wallets (user_id, balance_amount, currency)
         VALUES ($1, 0, 'GBP')`,
        [application.user_id]
      );
    }

    await ensurePromoterCreditWallet(client, application.user_id);

    // Update invoice status if exists
    await client.query(
      `UPDATE invoices
       SET updated_at = NOW()
       WHERE related_entity_type = 'promoter_application'
         AND related_entity_id = $1`,
      [applicationId]
    );

    await client.query("COMMIT");

    // Revoke all existing sessions for the user so they need to refresh
    // This forces them to get new token with updated roles
    try {
      await revokeAllUserSessions(application.user_id, "promoter_approved");
    } catch (sessionError) {
      // Log but don't fail - session revocation is not critical
      console.error("Error revoking sessions:", sessionError);
    }

    return res.json({
      error: false,
      message: "Promoter application approved successfully.",
      data: {
        application: {
          id: application.id,
          userId: application.user_id,
          accountStatus: "approved",
          reviewedAt: new Date(),
          territoryName: application.territory_name,
        },
        user: {
          userId: application.user_id,
          name: userResult.rows[0].name,
          email: userResult.rows[0].email,
          role: "promoter",
          accountStatus: "active",
          rolesVersion: newRolesVersion,
        },
        guru: application.guru_user_id ? {
          id: application.guru_user_id,
        } : null,
        territory: application.territory_name ? {
          name: application.territory_name,
        } : null
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Approve Promoter application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to approve promoter application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Get event audit logs
 * GET /admin/events/audit-logs?eventId=&promoterId=&action=&page=&pageSize=
 */
async function getEventAuditLogs(req, res) {
  try {
    const { eventId, promoterId, action, page = "1", pageSize = "50" } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * pageSizeNum;

    const conditions = [];
    const params = [];
    let paramCount = 1;

    if (eventId) { conditions.push(`eal.event_id = $${paramCount++}`); params.push(parseInt(eventId, 10)); }
    if (promoterId) { conditions.push(`eal.promoter_id = $${paramCount++}`); params.push(parseInt(promoterId, 10)); }
    if (action) { conditions.push(`eal.action = $${paramCount++}`); params.push(action); }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countQuery = `SELECT COUNT(*) as total FROM event_audit_logs eal ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total, 10);

    const logsQuery = `
      SELECT eal.*, u.name as promoter_name, e.title as event_title
      FROM event_audit_logs eal
      LEFT JOIN users u ON u.id = eal.promoter_id
      LEFT JOIN events e ON e.id = eal.event_id
      ${whereClause}
      ORDER BY eal.created_at DESC
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    params.push(pageSizeNum, offset);
    const logsResult = await pool.query(logsQuery, params);

    return ok(res, req, { logs: logsResult.rows, pagination: { page: pageNum, pageSize: pageSizeNum, total } });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get event metrics dashboard
 * GET /admin/events/metrics
 */
async function getEventMetrics(req, res) {
  try {
    const statusMetrics = await pool.query(`
      SELECT status, COUNT(*) as count FROM events GROUP BY status ORDER BY count DESC
    `);

    const totalViews = await pool.query(`SELECT COUNT(*)::bigint as total_views FROM event_views`);

    const topPromoters = await pool.query(`
      SELECT u.id, u.name, COUNT(e.id) as events_count, SUM(e.tickets_sold) as total_tickets_sold
      FROM users u JOIN events e ON e.promoter_id = u.id
      WHERE u.role = 'promoter'
      GROUP BY u.id, u.name
      ORDER BY events_count DESC
      LIMIT 10
    `);

    const metrics = {
      byStatus: statusMetrics.rows,
      totals: {
        totalEvents: parseInt(statusMetrics.rows.reduce((sum, row) => sum + parseInt(row.count, 10), 0), 10),
        totalViews: parseInt(totalViews.rows[0].total_views || 0, 10),
      },
      topPromoters: topPromoters.rows,
      generatedAt: new Date().toISOString(),
    };

    return ok(res, req, metrics);
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Create Guru invite
 * POST /admin/gurus/create-invite
 */
async function createGuruInvite(req, res) {
  try {
    const { email, name, role, network_manager_user_id } = req.body;
    const adminId = req.user.id;

    if (!email || !name) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Email and name are required");
    }

    // Default to guru role if not specified
    const inviteRole = role || 'guru';

    // Validate role
    const allowedRoles = ['guru', 'promoter', 'network_manager'];
    if (!allowedRoles.includes(inviteRole)) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid role. Allowed roles: guru, promoter, network_manager");
    }

    // Generate invite token
    const inviteToken = require('crypto').randomBytes(32).toString('hex');

    // Create invite in guru_invites table
    const result = await pool.query(
      `INSERT INTO guru_invites
        (email, name, role, invite_token, network_manager_user_id, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [email, name, inviteRole, inviteToken, network_manager_user_id || null, adminId]
    );

    const inviteLink = `${process.env.FRONTEND_URL}/register?invite=${inviteToken}`;

    return ok(res, req, {
      inviteId: result.rows[0].id,
      inviteLink: inviteLink,
      inviteToken: inviteToken,
      email: email,
      name: name,
      role: inviteRole,
      status: 'invited',
      expiresAt: result.rows[0].expires_at
    });
  } catch (err) {
    console.error('Create Guru invite error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to create invite");
  }
}

/**
 * List all Gurus
 * GET /admin/gurus
 */
async function listGurus(req, res) {
  try {
    const { page = "1", pageSize = "50" } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * pageSizeNum;

    // Get total count
    const countResult = await pool.query(
      "SELECT COUNT(*) as total FROM users WHERE role = 'guru'"
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get Gurus with their level and activation status
    const result = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.name,
         u.guru_active,
         u.guru_active_until,
         u.guru_activation_date,
         u.created_at,
         gl.level,
         gl.rate_per_ticket,
         COUNT(DISTINCT pgl.promoter_user_id) as promoters_count
       FROM users u
       LEFT JOIN guru_levels gl ON gl.guru_id = u.id AND gl.effective_until IS NULL
       LEFT JOIN promoter_guru_links pgl ON pgl.guru_user_id = u.id
       WHERE u.role = 'guru'
       GROUP BY u.id, u.email, u.name, u.guru_active, u.guru_active_until, u.guru_activation_date, u.created_at, gl.level, gl.rate_per_ticket
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSizeNum, offset]
    );

    return ok(res, req, {
      gurus: result.rows,
      pagination: { page: pageNum, pageSize: pageSizeNum, total }
    });
  } catch (err) {
    console.error('List Gurus error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to list Gurus");
  }
}

/**
 * Get Guru details
 * GET /admin/gurus/:guruId
 */
async function getGuruDetails(req, res) {
  try {
    const { guruId } = req.params;

    // Get Guru basic info
    const guruResult = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.name,
         u.guru_active,
         u.guru_active_until,
         u.guru_activation_date,
         u.created_at,
         gl.level,
         gl.rate_per_ticket,
         gl.effective_from as level_effective_from
       FROM users u
       LEFT JOIN guru_levels gl ON gl.guru_id = u.id AND gl.effective_until IS NULL
       WHERE u.id = $1 AND u.role = 'guru'`,
      [guruId]
    );

    if (guruResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Guru not found");
    }

    // Get attached promoters
    const promotersResult = await pool.query(
      `SELECT
         pgl.promoter_user_id,
         u.name,
         u.email,
         pgl.created_at as attached_at,
         pgl.source
       FROM promoter_guru_links pgl
       JOIN users u ON u.id = pgl.promoter_user_id
       WHERE pgl.guru_user_id = $1
       ORDER BY pgl.created_at DESC`,
      [guruId]
    );

    // Get recent commissions
    const commissionsResult = await pool.query(
      `SELECT
         gc.*,
         u.name as promoter_name,
         e.title as event_title
       FROM guru_commissions gc
       JOIN users u ON u.id = gc.promoter_id
       LEFT JOIN events e ON e.id = gc.event_id
       WHERE gc.guru_id = $1
       ORDER BY gc.created_at DESC
       LIMIT 20`,
      [guruId]
    );

    return ok(res, req, {
      guru: guruResult.rows[0],
      promoters: promotersResult.rows,
      recentCommissions: commissionsResult.rows
    });
  } catch (err) {
    console.error('Get Guru details error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get Guru details");
  }
}

/**
 * Manually activate Guru
 * POST /admin/gurus/:guruId/activate
 */
async function activateGuru(req, res) {
  const { guruId } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check if Guru exists
    const userResult = await client.query(
      'SELECT * FROM users WHERE id = $1 AND role = $2',
      [guruId, 'guru']
    );

    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return fail(res, req, 404, "NOT_FOUND", "Guru not found");
    }

    // Activate Guru
    await client.query(
      `UPDATE users
       SET guru_active = TRUE,
           guru_active_until = NOW() + INTERVAL '1 year',
           guru_activation_date = NOW(),
           signup_fee_paid = TRUE,
           roles_version = roles_version + 1
       WHERE id = $1`,
      [guruId]
    );

    // Record signup fee
    await client.query(
      `INSERT INTO signup_fees (user_id, role_type, amount, status, paid_at)
       VALUES ($1, 'guru', 25000, 'paid', NOW())`,
      [guruId]
    );

    // Create wallet if doesn't exist
    await client.query(
      `INSERT INTO wallets (user_id, balance_amount)
       VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [guruId]
    );

    // Generate referral code if doesn't exist
    try {
      await ReferralService.createReferralCode(parseInt(guruId, 10));
    } catch (err) {
      // Referral code might already exist, continue
      console.warn('Referral code generation warning:', err.message);
    }

    // Set default level if none exists
    const levelCheck = await client.query(
      'SELECT id FROM guru_levels WHERE guru_id = $1 AND effective_until IS NULL',
      [guruId]
    );

    if (levelCheck.rowCount === 0) {
      await GuruService.setGuruLevel(parseInt(guruId, 10), 1, req.user.id, 'Manual activation');
    }

    // Log admin action
    await client.query(
      `INSERT INTO admin_guru_actions
        (admin_id, guru_id, action_type, new_value, reason)
       VALUES ($1, $2, 'manual_activation', 'Activated', 'Manual activation by admin')`,
      [req.user.id, guruId]
    );

    await client.query('COMMIT');

    return ok(res, req, {
      message: "Guru activated successfully",
      activationDate: new Date()
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Activate Guru error:', err);
    return fail(res, req, 500, "ACTIVATION_FAILED", "Failed to activate Guru");
  } finally {
    client.release();
  }
}

/**
 * Update Guru level
 * POST /admin/gurus/:guruId/level
 */
async function updateGuruLevel(req, res) {
  try {
    const { guruId } = req.params;
    const { level, reason } = req.body;

    if (!level || level < 1 || level > 3) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Level must be between 1 and 3");
    }

    const result = await GuruService.setGuruLevel(
      parseInt(guruId, 10),
      level,
      req.user.id,
      reason || 'Level update by admin'
    );

    return ok(res, req, {
      guruId: parseInt(guruId, 10),
      level: result.level,
      ratePerTicket: result.rate_per_ticket,
      effectiveFrom: result.effective_from
    });
  } catch (err) {
    console.error('Update Guru level error:', err);
    return fail(res, req, 500, "UPDATE_FAILED", "Failed to update Guru level");
  }
}

/**
 * Attach promoter to Guru
 * POST /admin/gurus/:guruId/promoters/:promoterId/attach
 */
async function attachPromoterToGuru(req, res) {
  try {
    const { guruId, promoterId } = req.params;

    const result = await GuruService.manuallyAttachPromoter(
      parseInt(guruId, 10),
      parseInt(promoterId, 10),
      req.user.id
    );

    return ok(res, req, {
      message: "Promoter attached to Guru successfully",
      link: result
    });
  } catch (err) {
    console.error('Attach promoter error:', err);
    return fail(res, req, 500, "ATTACH_FAILED", err.message);
  }
}

/**
 * Detach promoter from Guru
 * POST /admin/gurus/:guruId/promoters/:promoterId/detach
 */
async function detachPromoterFromGuru(req, res) {
  try {
    const { guruId, promoterId } = req.params;

    await GuruService.detachPromoter(
      parseInt(guruId, 10),
      parseInt(promoterId, 10),
      req.user.id
    );

    return ok(res, req, {
      message: "Promoter detached from Guru successfully"
    });
  } catch (err) {
    console.error('Detach promoter error:', err);
    return fail(res, req, 500, "DETACH_FAILED", err.message);
  }
}

/**
 * Complete event manually and trigger reward issuance
 * POST /admin/events/:eventId/complete
 */
async function completeEvent(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { eventId } = req.params;
    const adminId = req.user.id;

    // Get event
    const eventResult = await client.query(
      'SELECT * FROM events WHERE id = $1',
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = eventResult.rows[0];

    // Validate event can be completed
    if (event.status === 'cancelled') {
      await client.query('ROLLBACK');
      return fail(res, req, 400, "INVALID_STATE", "Cancelled events cannot be completed");
    }

    if (event.completion_status === 'completed') {
      await client.query('ROLLBACK');
      return fail(res, req, 400, "ALREADY_COMPLETED", "Event already completed");
    }

    // Update event with completion info
    await client.query(
      `UPDATE events
       SET completion_status = 'completed',
           completed_at = NOW(),
           completed_by = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [adminId, eventId]
    );

    await client.query('COMMIT');
    await logEventChange(req, 'admin_completed', parseInt(eventId, 10));

    // Issue rewards (separate transaction)
    let rewardsInfo = null;
    try {
      const rewards = await issueRewardsForEvent(eventId, adminId);
      rewardsInfo = {
        promoterReward: rewards.promoterReward,
        guruReward: rewards.guruReward,
        ticketsSold: rewards.ticketsSold
      };

      // Send notifications (async, don't wait)
      sendRewardNotificationEmails(eventId, rewards).catch(err =>
        console.error('Error sending reward emails:', err)
      );
    } catch (rewardErr) {
      // Event is completed, but rewards failed - don't fail the request
      console.error('Failed to issue rewards:', rewardErr);
      rewardsInfo = {
        error: rewardErr.message
      };
    }

    return ok(res, req, {
      id: parseInt(eventId, 10),
      completionStatus: 'completed',
      completedAt: new Date().toISOString(),
      completedBy: adminId,
      rewardsIssued: rewardsInfo
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Cancel an event (Admin only)
 * POST /admin/events/:eventId/cancel
 */
async function cancelEvent(req, res) {
  const client = await pool.connect();
  try {
    const { eventId } = req.params;
    const { reason } = req.body; // cancel_reason is optional but recommended
    const adminId = req.user.id;

    await client.query('BEGIN');

    // Get event
    const eventResult = await client.query(
      'SELECT * FROM events WHERE id = $1',
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = eventResult.rows[0];

    // Validate event can be cancelled
    if (event.status === 'cancelled') {
      await client.query('ROLLBACK');
      return fail(res, req, 400, "INVALID_STATE", "Event is already cancelled");
    }

    if (event.completion_status === 'completed') {
      await client.query('ROLLBACK');
      return fail(res, req, 400, "INVALID_STATE", "Completed events cannot be cancelled");
    }

    // Update event status to cancelled
    await client.query(
      `UPDATE events
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancel_reason = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [reason || null, eventId]
    );

    await client.query('COMMIT');
    await logEventChange(req, 'admin_cancelled', parseInt(eventId, 10), { cancelReason: reason });

    return ok(res, req, {
      id: parseInt(eventId, 10),
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelReason: reason,
      message: "Event cancelled successfully"
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Approve promoter cancellation request (King's Account / Admin)
 * POST /admin/kings-account/events/:eventId/cancel/approve
 */
async function approveCancellationRequest(req, res) {
  const client = await pool.connect();
  try {
    const { eventId } = req.params;
    const { reason } = req.body;

    await client.query("BEGIN");

    const eventResult = await client.query(
      `SELECT id, status, completion_status, cancel_reason
       FROM events
       WHERE id = $1`,
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = eventResult.rows[0];

    if (event.status === "cancelled") {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Event is already cancelled");
    }

    if (event.status !== "cancellation_requested") {
      await client.query("ROLLBACK");
      return fail(
        res,
        req,
        400,
        "INVALID_STATE",
        "Only cancellation requested events can be approved for cancellation"
      );
    }

    if (event.completion_status === "completed") {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Completed events cannot be cancelled");
    }

    await client.query(
      `UPDATE events
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancel_reason = COALESCE($1, cancel_reason),
           updated_at = NOW()
       WHERE id = $2`,
      [reason || null, eventId]
    );

    await client.query("COMMIT");
    await logEventChange(req, "kings_account_cancellation_approved", parseInt(eventId, 10), {
      cancelReason: reason || event.cancel_reason || null,
    });

    return ok(res, req, {
      id: parseInt(eventId, 10),
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelReason: reason || event.cancel_reason || null,
      message: "Cancellation request approved and event cancelled successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * List all Promoters
 * GET /admin/promoters
 */
async function listPromoters(req, res) {
  try {
    const { page = "1", pageSize = "50" } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * pageSizeNum;

    // Get total count
    const countResult = await pool.query(
      "SELECT COUNT(*) as total FROM users WHERE role = 'promoter'"
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get Promoters with their stats
    const result = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.name,
         u.avatar_url,
         u.account_status,
         u.created_at,
         COUNT(DISTINCT e.id) as events_count,
         COALESCE(SUM(e.tickets_sold), 0) as total_tickets_sold,
         COALESCE(SUM(CASE WHEN e.completion_status = 'completed' THEN 1 ELSE 0 END), 0) as completed_events_count,
         pgl.guru_user_id
       FROM users u
       LEFT JOIN events e ON e.promoter_id = u.id
       LEFT JOIN promoter_guru_links pgl ON pgl.promoter_user_id = u.id
       WHERE u.role = 'promoter'
       GROUP BY u.id, u.email, u.name, u.avatar_url, u.account_status, u.created_at, pgl.guru_user_id
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSizeNum, offset]
    );

    return ok(res, req, {
      promoters: result.rows,
      pagination: { page: pageNum, pageSize: pageSizeNum, total }
    });
  } catch (err) {
    console.error('List Promoters error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to list Promoters");
  }
}

/**
 * Get Promoter details
 * GET /admin/promoters/:promoterId
 */
async function getPromoter(req, res) {
  try {
    const { promoterId } = req.params;

    // Get Promoter basic info
    const promoterResult = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.name,
         u.avatar_url,
         u.account_status,
         u.created_at,
         pgl.guru_user_id,
         gnm.territory_name
       FROM users u
       LEFT JOIN promoter_guru_links pgl ON pgl.promoter_user_id = u.id
       LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = pgl.guru_user_id
       WHERE u.id = $1 AND u.role = 'promoter'`,
      [promoterId]
    );

    if (promoterResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Promoter not found");
    }

    const promoter = promoterResult.rows[0];

    // Get events
    const eventsResult = await pool.query(
      `SELECT
         id,
         title,
         status,
         completion_status,
         tickets_sold,
         start_at,
         end_at,
         created_at
       FROM events
       WHERE promoter_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [promoterId]
    );

    // Get guru info if linked
    let guruInfo = null;
    if (promoter.guru_user_id) {
      const guruResult = await pool.query(
        `SELECT u.id, u.name, u.email, gl.level
         FROM users u
         LEFT JOIN guru_levels gl ON gl.guru_id = u.id AND gl.effective_until IS NULL
         WHERE u.id = $1`,
        [promoter.guru_user_id]
      );
      if (guruResult.rowCount > 0) {
        guruInfo = {
          id: guruResult.rows[0].id,
          name: guruResult.rows[0].name,
          email: guruResult.rows[0].email,
          level: guruResult.rows[0].level,
          territory: promoter.territory_name
        };
      }
    }

    return ok(res, req, {
      promoter: {
        id: promoter.id,
        email: promoter.email,
        name: promoter.name,
        avatarUrl: promoter.avatar_url,
        accountStatus: promoter.account_status,
        createdAt: promoter.created_at
      },
      guru: guruInfo,
      recentEvents: eventsResult.rows
    });
  } catch (err) {
    console.error('Get Promoter details error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get Promoter details");
  }
}

/**
 * Approve event for buyer visibility
 * POST /admin/kings-account/events/:eventId/approve
 */
async function approvePendingEvent(req, res) {
  const client = await pool.connect();
  try {
    const { eventId } = req.params;

    await client.query("BEGIN");

    const eventResult = await client.query(
      `SELECT id, status FROM events WHERE id = $1`,
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = eventResult.rows[0];

    if (event.status === "active") {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Event is already active");
    }

    if (event.status !== "pending_approval") {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Only pending approval events can be activated");
    }

    await client.query(
      `UPDATE events
       SET status = 'active',
           published_at = COALESCE(published_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [eventId]
    );

    try {
      await ensureEscrowLiabilityForEvent(parseInt(eventId, 10), { client });
    } catch (liabilityErr) {
      console.warn("[approvePendingEvent] liability sync skipped:", liabilityErr.message);
    }

    await client.query("COMMIT");
    await logEventChange(req, "kings_account_approved", parseInt(eventId, 10));

    return ok(res, req, {
      id: parseInt(eventId, 10),
      status: "active",
      publishedAt: new Date().toISOString(),
      message: "Event approved successfully"
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * List events for King's Account review
 * GET /admin/kings-account/events/pending-approval?status=
 */
async function listPendingApprovalEvents(req, res) {
  try {
    const { page = "1", pageSize = "50", city, startDate, endDate, status } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * pageSizeNum;
    const conditions = [];
    const params = [];
    let paramCount = 1;

    if (status && status !== "all") {
      conditions.push(`e.status = $${paramCount++}`);
      params.push(status);
    }

    if (city) {
      conditions.push(`e.city_display = $${paramCount++}`);
      params.push(city);
    }

    if (startDate) {
      conditions.push(`e.start_at >= $${paramCount++}`);
      params.push(startDate);
    }

    if (endDate) {
      conditions.push(`e.end_at <= $${paramCount++}`);
      params.push(endDate);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM events e ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await pool.query(
      `SELECT
         e.id,
         e.title,
         e.description,
         e.status,
         e.visibility AS visibility_mode,
         e.format,
         e.access_mode,
         e.city_display AS city,
         e.venue_name,
         e.start_at,
         e.end_at,
         e.cover_image_url,
         e.created_at,
         e.updated_at,
         u.id as promoter_id,
         u.name as promoter_name,
         u.email as promoter_email
       FROM events e
       JOIN users u ON u.id = e.promoter_id
       ${whereClause}
       ORDER BY e.updated_at DESC, e.created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      [...params, pageSizeNum, offset]
    );

    return ok(res, req, {
      events: result.rows,
      pagination: { page: pageNum, pageSize: pageSizeNum, total }
    });
  } catch (err) {
    console.error("List pending approval Events error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to list pending approval Events");
  }
}

/**
 * List refund requests for King's Account/Admin queue
 * GET /admin/kings-account/refunds?status=&eventId=&page=&pageSize=
 */
async function listRefundRequests(req, res) {
  try {
    const { status = "submitted", eventId, page = "1", pageSize = "50" } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * pageSizeNum;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (status && status !== "all") {
      conditions.push(`rc.status = $${idx++}`);
      params.push(status);
    }

    if (eventId) {
      conditions.push(`rc.event_id = $${idx++}`);
      params.push(parseInt(eventId, 10));
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM refund_cases rc
       ${whereClause}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    const result = await pool.query(
      `SELECT
         rc.id,
         rc.order_item_id,
         rc.buyer_id,
         rc.event_id,
         rc.promoter_id,
         rc.reason_code,
         rc.status,
         rc.amount,
         rc.escrow_ring_fenced,
         rc.submitted_at,
         rc.reviewed_at,
         rc.approved_at,
         rc.executed_at,
         rc.admin_notes,
         b.name AS buyer_name,
         b.email AS buyer_email,
         e.title AS event_title,
         e.cancelled_at AS event_cancelled_at
       FROM refund_cases rc
       JOIN users b ON b.id = rc.buyer_id
       JOIN events e ON e.id = rc.event_id
       ${whereClause}
       ORDER BY rc.submitted_at DESC, rc.id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, pageSizeNum, offset]
    );

    const items = result.rows.map((row) => {
      const submittedAtMs = row.submitted_at ? new Date(row.submitted_at).getTime() : null;
      const underReviewTargetMs = submittedAtMs ? submittedAtMs + (24 * 60 * 60 * 1000) : null;
      const nowMs = Date.now();
      const slaStatus = underReviewTargetMs
        ? (nowMs > underReviewTargetMs ? "overdue" : "within_target")
        : "unknown";

      return {
        id: row.id,
        order_item_id: row.order_item_id,
        buyer: {
          id: row.buyer_id,
          name: row.buyer_name,
          email: row.buyer_email,
        },
        event: {
          id: row.event_id,
          title: row.event_title,
          cancelled_at: row.event_cancelled_at,
        },
        reason_code: row.reason_code,
        status: row.status,
        amount: Number(row.amount || 0) / 100,
        escrow_ring_fenced: row.escrow_ring_fenced,
        submitted_at: row.submitted_at,
        reviewed_at: row.reviewed_at,
        approved_at: row.approved_at,
        executed_at: row.executed_at,
        admin_notes: row.admin_notes,
        sla: {
          stage: "submitted_to_under_review",
          target_hours: 24,
          status: slaStatus,
          target_at: underReviewTargetMs ? new Date(underReviewTargetMs).toISOString() : null,
        },
      };
    });

    return ok(res, req, {
      items,
      pagination: {
        page: pageNum,
        pageSize: pageSizeNum,
        total,
        totalPages: Math.ceil(total / pageSizeNum),
      },
    });
  } catch (err) {
    console.error("List refund requests error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to list refund requests");
  }
}

/**
 * Approve buyer refund request (King's Account/Admin)
 * POST /admin/kings-account/refunds/:id/approve
 */
async function approveRefundRequest(req, res) {
  const client = await pool.connect();
  try {
    const refundCaseId = parseInt(req.params.id, 10);
    const { admin_notes } = req.body || {};

    if (Number.isNaN(refundCaseId) || refundCaseId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid refund case id");
    }

    await client.query("BEGIN");

    const caseResult = await client.query(
      `SELECT id, status, escrow_ring_fenced, amount, buyer_id, event_id
       FROM refund_cases
       WHERE id = $1
       FOR UPDATE`,
      [refundCaseId]
    );

    if (caseResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Refund case not found");
    }

    const refundCase = caseResult.rows[0];

    if (!["submitted", "under_review"].includes(refundCase.status)) {
      await client.query("ROLLBACK");
      return fail(
        res,
        req,
        400,
        "INVALID_STATE",
        `Refund case in '${refundCase.status}' state cannot be approved`
      );
    }

    if (!refundCase.escrow_ring_fenced) {
      await client.query("ROLLBACK");
      return fail(
        res,
        req,
        409,
        "ESCROW_NOT_RING_FENCED",
        "Refund case cannot be approved because escrow is not ring-fenced"
      );
    }

    await client.query(
      `UPDATE refund_cases
       SET status = 'approved',
           approved_at = NOW(),
           admin_notes = COALESCE($1, admin_notes)
       WHERE id = $2`,
      [admin_notes || null, refundCaseId]
    );

    await client.query(
      `INSERT INTO ledger_entries (
         entry_type, user_id, role, territory_id, amount, reference_id, reference_type, status
       )
       SELECT
         'REFUND_APPROVED',
         rc.buyer_id,
         'buyer',
         COALESCE(e.territory_id, 1),
         rc.amount,
         rc.id,
         'REFUND_CASE',
         'POSTED'
       FROM refund_cases rc
       JOIN events e ON e.id = rc.event_id
       WHERE rc.id = $1`,
      [refundCaseId]
    );

    await client.query("COMMIT");

    return ok(res, req, {
      id: refundCaseId,
      status: "approved",
      approved_at: new Date().toISOString(),
      admin_notes: admin_notes || null,
      message: "Refund request approved successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Approve refund request error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Reject buyer refund request (King's Account/Admin)
 * POST /admin/kings-account/refunds/:id/reject
 */
async function rejectRefundRequest(req, res) {
  const client = await pool.connect();
  try {
    const refundCaseId = parseInt(req.params.id, 10);
    const reason = String(req.body?.reason || "").trim();

    if (Number.isNaN(refundCaseId) || refundCaseId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid refund case id");
    }
    if (!reason) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Reject reason is required");
    }

    await client.query("BEGIN");

    const caseResult = await client.query(
      `SELECT id, status, escrow_ring_fenced, amount, buyer_id, event_id
       FROM refund_cases
       WHERE id = $1
       FOR UPDATE`,
      [refundCaseId]
    );

    if (caseResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Refund case not found");
    }

    const refundCase = caseResult.rows[0];
    if (!["submitted", "under_review", "approved"].includes(refundCase.status)) {
      await client.query("ROLLBACK");
      return fail(
        res,
        req,
        400,
        "INVALID_STATE",
        `Refund case in '${refundCase.status}' state cannot be rejected`
      );
    }

    // Release ring-fenced escrow (if previously reserved).
    if (refundCase.escrow_ring_fenced) {
      const escrowColumnsResult = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'escrow_accounts'`
      );
      const escrowColumns = new Set(escrowColumnsResult.rows.map((r) => r.column_name));
      const hasAccountType = escrowColumns.has("account_type");
      const hasBalance = escrowColumns.has("balance");
      const hasCurrentBalance = escrowColumns.has("current_balance");
      const hasPendingLiabilities = escrowColumns.has("pending_liabilities");

      const territoryResult = await client.query(
        `SELECT territory_id FROM events WHERE id = $1 LIMIT 1`,
        [refundCase.event_id]
      );
      const territoryId = territoryResult.rows[0]?.territory_id || 1;

      if (hasPendingLiabilities) {
        if (hasBalance) {
          await client.query(
            `UPDATE escrow_accounts
             SET pending_liabilities = GREATEST(COALESCE(pending_liabilities, 0) - $1, 0),
                 updated_at = NOW()
             WHERE territory_id = $2`,
            [refundCase.amount, territoryId]
          );
        } else if (hasCurrentBalance) {
          const amountInCurrency = Number(refundCase.amount || 0) / 100;
          if (hasAccountType) {
            await client.query(
              `UPDATE escrow_accounts
               SET pending_liabilities = GREATEST(COALESCE(pending_liabilities, 0) - $1, 0),
                   updated_at = NOW()
               WHERE territory_id = $2 AND account_type = 'escrow'`,
              [amountInCurrency, territoryId]
            );
          } else {
            await client.query(
              `UPDATE escrow_accounts
               SET pending_liabilities = GREATEST(COALESCE(pending_liabilities, 0) - $1, 0),
                   updated_at = NOW()
               WHERE territory_id = $2`,
              [amountInCurrency, territoryId]
            );
          }
        }
      }

      await client.query(
        `INSERT INTO ledger_entries (
           entry_type, user_id, role, territory_id, amount, reference_id, reference_type, status
         )
         SELECT
           'RING_FENCE_RELEASED',
           rc.buyer_id,
           'buyer',
           COALESCE(e.territory_id, 1),
           rc.amount,
           rc.id,
           'REFUND_CASE',
           'POSTED'
         FROM refund_cases rc
         JOIN events e ON e.id = rc.event_id
         WHERE rc.id = $1`,
        [refundCaseId]
      );
    }

    await client.query(
      `UPDATE refund_cases
       SET status = 'rejected',
           reviewed_at = NOW(),
           admin_notes = $1,
           escrow_ring_fenced = FALSE
       WHERE id = $2`,
      [reason, refundCaseId]
    );

    await client.query("COMMIT");
    return ok(res, req, {
      id: refundCaseId,
      status: "rejected",
      rejected_reason: reason,
      reviewed_at: new Date().toISOString(),
      message: "Refund request rejected successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Reject refund request error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * List all Events
 * GET /admin/events
 */
async function listEvents(req, res) {
  try {
    const { page = "1", pageSize = "50", status, completionStatus } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * pageSizeNum;

    const conditions = [];
    const params = [];
    let paramCount = 1;

    if (status) {
      conditions.push(`e.status = $${paramCount++}`);
      params.push(status);
    }

    if (completionStatus) {
      conditions.push(`e.completion_status = $${paramCount++}`);
      params.push(completionStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM events e ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Get Events with promoter info
    const result = await pool.query(
      `SELECT
         e.id,
         e.title,
         e.status,
         e.completion_status,
         e.tickets_sold,
         e.start_at,
         e.end_at,
         e.completed_at,
         e.completed_by,
         e.created_at,
         u.id as promoter_id,
         u.name as promoter_name,
         u.email as promoter_email
       FROM events e
       JOIN users u ON u.id = e.promoter_id
       ${whereClause}
       ORDER BY e.created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      [...params, pageSizeNum, offset]
    );

    return ok(res, req, {
      events: result.rows,
      pagination: { page: pageNum, pageSize: pageSizeNum, total }
    });
  } catch (err) {
    console.error('List Events error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to list Events");
  }
}

/**
 * Get Event details
 * GET /admin/events/:eventId
 */
async function getEvent(req, res) {
  try {
    const { eventId } = req.params;

    // Get Event details
    const eventResult = await pool.query(
      `SELECT
         e.*,
         u.name as promoter_name,
         u.email as promoter_email,
         u.id as promoter_id
       FROM events e
       JOIN users u ON u.id = e.promoter_id
       WHERE e.id = $1`,
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = eventResult.rows[0];

    // Get category (directly from events.category_id)
    const categoryResult = await pool.query(
      `SELECT c.id, c.name
       FROM categories c
       WHERE c.id = $1`,
      [event.category_id]
    );

    // Get tags
    const tagsResult = await pool.query(
      `SELECT t.id, t.name
       FROM tags t
       JOIN event_tags et ON et.tag_id = t.id
       WHERE et.event_id = $1`,
      [eventId]
    );

    // Get vouchers issued
    const vouchersResult = await pool.query(
      `SELECT
         rv.id,
         rv.owner_type,
         rv.owner_id,
         rv.amount,
         rv.currency,
         rv.status,
         rv.issued_at,
         rv.expires_at,
         rv.source,
         owner.name as owner_name,
         owner.email as owner_email
       FROM reward_vouchers rv
       JOIN users owner ON owner.id = rv.owner_id
       WHERE rv.event_id = $1
       ORDER BY rv.owner_type, rv.issued_at DESC`,
      [eventId]
    );

    return ok(res, req, {
      event: {
        ...event,
        promoter: {
          id: event.promoter_id,
          name: event.promoter_name,
          email: event.promoter_email
        },
        categories: categoryResult.rows,
        tags: tagsResult.rows,
        vouchers: vouchersResult.rows
      }
    });
  } catch (err) {
    console.error('Get Event details error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get Event details");
  }
}

/**
 * List charity applications for admin
 * GET /api/admin/charity/applications
 */
async function listCharityApplications(req, res) {
  try {
    const {
      status,
      promoter_id,
      date_from,
      date_to,
      page = "1",
      pageSize = "50"
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * pageSizeNum;

    const filters = {
      status,
      promoter_id,
      date_from,
      date_to,
      limit: pageSizeNum,
      offset
    };

    const applications = await CharityService.listApplicationsForAdmin(filters);

    return ok(res, req, {
      applications,
      pagination: { page: pageNum, pageSize: pageSizeNum, total: applications.length }
    });
  } catch (err) {
    console.error('List charity applications error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to list charity applications");
  }
}

/**
 * Get charity application details for admin
 * GET /api/admin/charity/applications/:id
 */
async function getCharityApplication(req, res) {
  try {
    const applicationId = parseInt(req.params.id);

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const application = await CharityService.getApplicationForAdmin(applicationId);

    if (!application) {
      return fail(res, req, 404, "NOT_FOUND", "Charity application not found");
    }

    // Get related data
    const payments = await CharityPaymentService.getPaymentsForApplication(applicationId);
    const executions = await CharityService.getExecutions(applicationId);
    const decisions = await pool.query(
      `SELECT
         cad.*,
         u.name as admin_name
       FROM charity_application_decisions cad
       JOIN users u ON u.id = cad.decided_by
       WHERE cad.application_id = $1
       ORDER BY cad.decided_at DESC`,
      [applicationId]
    );

    return ok(res, req, {
      application,
      payments: payments,
      decisions: decisions.rows,
      executions: executions
    });
  } catch (err) {
    console.error('Get charity application error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get charity application");
  }
}

/**
 * Approve charity application
 * POST /api/admin/charity/applications/:id/approve
 */
async function approveCharityApplication(req, res) {
  try {
    const applicationId = parseInt(req.params.id);
    const adminId = req.user.id;

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const { decision_amount, admin_notes } = req.body;

    if (!decision_amount || decision_amount <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Decision amount must be greater than 0");
    }

    const application = await CharityService.approveApplication(applicationId, adminId, decision_amount, admin_notes);

    // Log audit event
    await logCharityChange(req, 'charity_decision_made', applicationId, {
      fieldName: 'status',
      oldValue: 'UNDER_REVIEW',
      newValue: 'APPROVED',
      metadata: { decision_amount: decision_amount }
    });

    // Get full application with promoter info
    const fullApplication = await CharityService.getApplicationForAdmin(applicationId);

    // Get promoter info
    const promoterResult = await pool.query(
      'SELECT email, name FROM users WHERE id = $1',
      [fullApplication.promoter_id]
    );
    const promoter = promoterResult.rows[0];

    // Notify promoter
    await CharityNotificationService.notifyApproved(fullApplication, promoter, req.user);

    return ok(res, req, { application });
  } catch (err) {
    console.error('Approve charity application error:', err);
    if (err.message === 'Application not found') {
      return fail(res, req, 404, "NOT_FOUND", err.message);
    }
    if (err.message.includes('Cannot transition')) {
      return fail(res, req, 400, "INVALID_STATE", err.message);
    }
    if (err.message.includes('exceed')) {
      return fail(res, req, 400, "VALIDATION_ERROR", err.message);
    }
    if (err.message.includes('Insufficient')) {
      return fail(res, req, 400, "INSUFFICIENT_FUNDS", err.message);
    }
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Partially approve charity application
 * POST /api/admin/charity/applications/:id/partial-approve
 */
async function partialApproveCharityApplication(req, res) {
  try {
    const applicationId = parseInt(req.params.id);
    const adminId = req.user.id;

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const { decision_amount, admin_notes } = req.body;

    if (!decision_amount || decision_amount <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Decision amount must be greater than 0");
    }

    const application = await CharityService.partialApproveApplication(applicationId, adminId, decision_amount, admin_notes);

    // Get full application with promoter info
    const fullApplication = await CharityService.getApplicationForAdmin(applicationId);

    // Get promoter info
    const promoterResult = await pool.query(
      'SELECT email, name FROM users WHERE id = $1',
      [fullApplication.promoter_id]
    );
    const promoter = promoterResult.rows[0];

    // Notify promoter
    await CharityNotificationService.notifyApproved(fullApplication, promoter, req.user);

    return ok(res, req, { application });
  } catch (err) {
    console.error('Partial approve charity application error:', err);
    if (err.message === 'Application not found') {
      return fail(res, req, 404, "NOT_FOUND", err.message);
    }
    if (err.message.includes('Cannot transition')) {
      return fail(res, req, 400, "INVALID_STATE", err.message);
    }
    if (err.message.includes('exceed')) {
      return fail(res, req, 400, "VALIDATION_ERROR", err.message);
    }
    if (err.message.includes('Insufficient')) {
      return fail(res, req, 400, "INSUFFICIENT_FUNDS", err.message);
    }
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Reject charity application
 * POST /api/admin/charity/applications/:id/reject
 */
async function rejectCharityApplication(req, res) {
  try {
    const applicationId = parseInt(req.params.id);
    const adminId = req.user.id;

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const { rejection_reason, admin_notes } = req.body;

    if (!rejection_reason) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Rejection reason is required");
    }

    const application = await CharityService.rejectApplication(applicationId, adminId, rejection_reason, admin_notes);

    // Get full application with promoter info
    const fullApplication = await CharityService.getApplicationForAdmin(applicationId);

    // Get promoter info
    const promoterResult = await pool.query(
      'SELECT email, name FROM users WHERE id = $1',
      [fullApplication.promoter_id]
    );
    const promoter = promoterResult.rows[0];

    // Notify promoter
    await CharityNotificationService.notifyRejected(fullApplication, promoter, req.user, rejection_reason);

    return ok(res, req, { application });
  } catch (err) {
    console.error('Reject charity application error:', err);
    if (err.message === 'Application not found') {
      return fail(res, req, 404, "NOT_FOUND", err.message);
    }
    if (err.message.includes('Cannot transition')) {
      return fail(res, req, 400, "INVALID_STATE", err.message);
    }
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Execute charity payout
 * POST /api/admin/charity/applications/:id/execute
 */
async function executeCharityPayout(req, res) {
  const client = await pool.connect();
  try {
    const applicationId = parseInt(req.params.id);
    const adminId = req.user.id;

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const {
      recipient_type,
      recipient_name,
      recipient_details,
      amount,
      execution_reference
    } = req.body;

    if (!recipient_type || !recipient_name || !amount) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Missing required fields");
    }

    if (amount <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Amount must be greater than 0");
    }

    // Validate recipient type
    const validRecipientTypes = ['venue', 'supplier', 'marketing_platform'];
    if (!validRecipientTypes.includes(recipient_type)) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid recipient type");
    }

    await client.query('BEGIN');

    // Get application
    const applicationResult = await client.query(
      'SELECT * FROM charity_applications WHERE id = $1',
      [applicationId]
    );

    if (applicationResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return fail(res, req, 404, "NOT_FOUND", "Application not found");
    }

    const application = applicationResult.rows[0];

    if (application.status !== 'APPROVED' && application.status !== 'PARTIAL_APPROVED') {
      await client.query('ROLLBACK');
      return fail(res, req, 400, "INVALID_STATE", "Application must be approved to execute payout");
    }

    if (!application.decision_amount || amount > application.decision_amount) {
      await client.query('ROLLBACK');
      return fail(res, req, 400, "VALIDATION_ERROR", "Execution amount cannot exceed approved amount");
    }

    // Check if execution would exceed approved amount
    const existingExecutionsResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total_executed
       FROM charity_pot_executions
       WHERE application_id = $1 AND status != 'cancelled'`,
      [applicationId]
    );

    const totalExecuted = parseInt(existingExecutionsResult.rows[0].total_executed || 0);
    if (totalExecuted + amount > application.decision_amount) {
      await client.query('ROLLBACK');
      return fail(res, req, 400, "VALIDATION_ERROR", "Execution amount would exceed approved amount");
    }

    // Create execution record
    const executionResult = await client.query(
      `INSERT INTO charity_pot_executions
        (application_id, execution_type, amount, recipient_type, recipient_name, recipient_details,
         status, execution_reference, created_by)
       VALUES ($1, 'payout', $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING *`,
      [
        applicationId,
        amount,
        recipient_type,
        recipient_name,
        recipient_details ? JSON.stringify(recipient_details) : null,
        execution_reference || null,
        adminId
      ]
    );

    const execution = executionResult.rows[0];

    // Log audit event
    await logCharityChange(req, 'charity_execution_created', applicationId, {
      fieldName: 'status',
      oldValue: null,
      newValue: 'pending',
      metadata: {
        execution_id: execution.id,
        recipient_type: recipient_type,
        recipient_name: recipient_name,
        amount: amount
      }
    });

    await client.query('COMMIT');

    return ok(res, req, { execution }, 201);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Execute charity payout error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Get charity pot ledger
 * GET /api/admin/charity/ledger
 */
async function getCharityLedger(req, res) {
  try {
    const {
      application_id,
      transaction_type,
      reference_type,
      date_from,
      date_to,
      page = "1",
      pageSize = "100"
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 100));
    const offset = (pageNum - 1) * pageSizeNum;

    const filters = {
      application_id,
      transaction_type,
      reference_type,
      date_from,
      date_to,
      limit: pageSizeNum,
      offset
    };

    const entries = await CharityLedgerService.getEntries(filters);
    const summary = await CharityLedgerService.getSummary(date_from, date_to);

    return ok(res, req, {
      entries,
      summary,
      pagination: { page: pageNum, pageSize: pageSizeNum, total: entries.length }
    });
  } catch (err) {
    console.error('Get charity ledger error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get charity ledger");
  }
}

/**
 * Get charity pot balance
 * GET /api/admin/charity/balance
 */
async function getCharityBalance(req, res) {
  try {
    const balance = await CharityLedgerService.getBalance();

    return ok(res, req, {
      balance,
      balance_formatted: `£${(balance / 100).toFixed(2)}`,
      currency: 'GBP'
    });
  } catch (err) {
    console.error('Get charity balance error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get charity balance");
  }
}

/**
 * Mark execution as completed (admin only)
 * PATCH /api/admin/charity/executions/:id
 */
async function markCharityExecutionCompleted(req, res) {
  try {
    const executionId = parseInt(req.params.id);
    const adminId = req.user.id;

    if (isNaN(executionId) || executionId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid execution ID");
    }

    const { provider_reference } = req.body;

    const execution = await CharityService.markExecutionCompleted(executionId, adminId, provider_reference);

    // Log audit event
    await logCharityChange(req, 'charity_execution_paid', execution.application_id, {
      fieldName: 'status',
      oldValue: 'pending',
      newValue: 'completed',
      metadata: {
        execution_id: execution.id,
        amount: execution.amount,
        provider_reference: provider_reference
      }
    });

    // Get application for notifications
    const application = await CharityService.getApplicationForAdmin(execution.application_id);
    const promoterResult = await pool.query(
      'SELECT email, name FROM users WHERE id = $1',
      [application.promoter_id]
    );
    const promoter = promoterResult.rows[0];

    // Notify promoter
    await CharityNotificationService.notifyCompleted(application, promoter, [execution]);

    return ok(res, req, { execution });
  } catch (err) {
    console.error('Mark execution completed error:', err);
    if (err.message === 'Execution not found') {
      return fail(res, req, 404, "NOT_FOUND", err.message);
    }
    if (err.message.includes('already')) {
      return fail(res, req, 400, "ALREADY_COMPLETED", err.message);
    }
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Complete charity application (admin only)
 * POST /api/admin/charity/applications/:id/complete
 */
async function completeCharityApplication(req, res) {
  try {
    const applicationId = parseInt(req.params.id);
    const adminId = req.user.id;

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const application = await CharityService.markAsCompleted(applicationId);

    // Get promoter info
    const promoterResult = await pool.query(
      'SELECT email, name FROM users WHERE id = $1',
      [application.promoter_id]
    );
    const promoter = promoterResult.rows[0];

    // Get all executions
    const executions = await CharityService.getExecutions(applicationId);

    // Notify promoter
    await CharityNotificationService.notifyCompleted(application, promoter, executions);

    return ok(res, req, { application });
  } catch (err) {
    console.error('Complete charity application error:', err);
    if (err.message === 'Application not found') {
      return fail(res, req, 404, "NOT_FOUND", err.message);
    }
    if (err.message.includes('All executions must be completed')) {
      return fail(res, req, 400, "INCOMPLETE_EXECUTIONS", err.message);
    }
    if (err.message.includes('Cannot transition')) {
      return fail(res, req, 400, "INVALID_STATE", err.message);
    }
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

// add comment//
// ---------- King's Account (Phase 10) ----------

async function getKingsAccountOverview(req, res) {
  try {
    await logAdminAudit(req, "kings_account_viewed", "overview", null);

    const ledgerTotals = await PlatformLedgerService.getOverviewTotals();
    const charityBalance = await CharityLedgerService.getBalance();
    const guruRewardPoolResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM reward_vouchers WHERE owner_type = 'guru' AND status = 'active'`
    );
    const guruRewardPoolBalance = parseInt(guruRewardPoolResult.rows[0]?.total, 10) || 0;

    const obligationsPromoter = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM ledger_allocations WHERE allocation_type = 'promoter_commission'`
    );
    const obligationsNm = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM ledger_allocations WHERE allocation_type = 'network_manager_cash'`
    );
    const promoterPayableTotal = parseInt(obligationsPromoter.rows[0]?.total, 10) || 0;
    const networkManagerPayableTotal = parseInt(obligationsNm.rows[0]?.total, 10) || 0;

    const signupPromoter = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM signup_fees WHERE role_type = 'promoter'`
    );
    const signupGuru = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM signup_fees WHERE role_type = 'guru'`
    );
    const promoterActivationFeesTotal = parseInt(signupPromoter.rows[0]?.total, 10) || 0;
    const guruActivationFeesTotal = parseInt(signupGuru.rows[0]?.total, 10) || 0;

    return ok(res, req, {
      total_gross_payments: ledgerTotals.totalGrossPayments,
      total_booking_fees_collected: ledgerTotals.totalBookingFees,
      total_platform_profit: ledgerTotals.totalPlatformProfit,
      pot_balances: {
        charity_pot_balance: charityBalance,
        guru_reward_pool_balance: guruRewardPoolBalance,
      },
      obligations_totals: {
        promoter_payable_total: promoterPayableTotal,
        network_manager_payable_total: networkManagerPayableTotal,
      },
      signup_fee_totals: {
        promoter_activation_fees_total: promoterActivationFeesTotal,
        guru_activation_fees_total: guruActivationFeesTotal,
      },
    });
  } catch (err) {
    console.error("Kings account overview error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load King's Account overview");
  }
}

async function getLedger(req, res) {
  try {
    const { date_from, date_to, entity_type, entry_type, promoter, event, page = "1", pageSize = "100" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 100));
    const offset = (pageNum - 1) * pageSizeNum;
    const entries = await PlatformLedgerService.getEntries({
      date_from: date_from || undefined,
      date_to: date_to || undefined,
      entity_type: entity_type || undefined,
      entry_type: entry_type || undefined,
      promoter_id: promoter ? parseInt(promoter, 10) : undefined,
      event_id: event ? parseInt(event, 10) : undefined,
      limit: pageSizeNum,
      offset,
    });
    return ok(res, req, { entries, pagination: { page: pageNum, pageSize: pageSizeNum } });
  } catch (err) {
    console.error("Admin ledger error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load ledger");
  }
}

async function getObligations(req, res) {
  try {
    const { type, status } = req.query;
    const params = [];
    const allocFilter =
      type === "promoter"
        ? "AND la.allocation_type = 'promoter_commission'"
        : type === "network_manager"
          ? "AND la.allocation_type = 'network_manager_cash'"
          : "";
    const result = await pool.query(
      `SELECT la.beneficiary_type, la.beneficiary_id, u.name AS beneficiary_name,
              SUM(la.amount)::bigint AS amount_owed, MAX(la.created_at) AS last_updated
       FROM ledger_allocations la
       LEFT JOIN users u ON u.id = la.beneficiary_id
       WHERE la.allocation_type IN ('promoter_commission', 'network_manager_cash')
       ${allocFilter}
       GROUP BY la.beneficiary_type, la.beneficiary_id, u.name`,
      params
    );
    let rows = result.rows.map((r) => ({
      beneficiary: r.beneficiary_name || `ID ${r.beneficiary_id}`,
      beneficiary_type: r.beneficiary_type,
      beneficiary_id: r.beneficiary_id,
      amount_owed: parseInt(r.amount_owed, 10),
      status: "open",
      last_updated: r.last_updated,
    }));
    if (type === "promoter") rows = rows.filter((r) => r.beneficiary_type === "promoter");
    if (type === "network_manager") rows = rows.filter((r) => r.beneficiary_type === "network_manager");
    return ok(res, req, { obligations: rows });
  } catch (err) {
    console.error("Admin obligations error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load obligations");
  }
}

async function getSignupFees(req, res) {
  try {
    const { role, date_from, date_to } = req.query;
    const params = [];
    let where = "1=1";
    if (role === "promoter" || role === "guru") {
      params.push(role);
      where += ` AND sf.role_type = $${params.length}`;
    }
    if (date_from) {
      params.push(date_from);
      where += ` AND sf.paid_at >= $${params.length}`;
    }
    if (date_to) {
      params.push(date_to);
      where += ` AND sf.paid_at <= $${params.length}`;
    }
    const result = await pool.query(
      `SELECT sf.id, sf.user_id, u.name, u.email, sf.role_type, sf.amount, sf.paid_at
       FROM signup_fees sf
       JOIN users u ON u.id = sf.user_id
       WHERE ${where}
       ORDER BY sf.paid_at DESC`,
      params
    );
    const items = result.rows.map((r) => ({
      user: r.name || r.email,
      user_id: r.user_id,
      amount: r.amount,
      paid_date: r.paid_at,
      role: r.role_type,
    }));
    return ok(res, req, { signup_fees: items });
  } catch (err) {
    console.error("Admin signup fees error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load signup fees");
  }
}

function escapeCsvCell(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function exportLedgerCsv(req, res) {
  try {
    const entries = await PlatformLedgerService.getEntries({ limit: 10000, offset: 0 });
    const header = "id,created_at,entity_type,entity_id,entry_type,amount,currency,description,order_id,event_id,promoter_id\n";
    const rows = entries.map((e) =>
      [e.id, e.created_at, e.entity_type, e.entity_id, e.entry_type, e.amount, e.currency, escapeCsvCell(e.description), e.order_id, e.event_id, e.promoter_id].join(",")
    );
    await logAdminAudit(req, "ledger_exported", "ledger.csv", { row_count: rows.length });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="ledger.csv"');
    return res.send(header + rows.join("\n"));
  } catch (err) {
    console.error("Export ledger CSV error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Export failed");
  }
}

async function exportObligationsCsv(req, res) {
  try {
    const result = await pool.query(
      `SELECT la.beneficiary_type, la.beneficiary_id, u.name, SUM(la.amount)::bigint AS amount_owed, MAX(la.created_at) AS last_updated
       FROM ledger_allocations la
       LEFT JOIN users u ON u.id = la.beneficiary_id
       WHERE la.allocation_type IN ('promoter_commission', 'network_manager_cash')
       GROUP BY la.beneficiary_type, la.beneficiary_id, u.name`
    );
    const header = "beneficiary_type,beneficiary_id,beneficiary_name,amount_owed,last_updated\n";
    const rows = result.rows.map((r) =>
      [r.beneficiary_type, r.beneficiary_id, escapeCsvCell(r.name), r.amount_owed, r.last_updated].join(",")
    );
    await logAdminAudit(req, "obligations_exported", "obligations.csv", { row_count: rows.length });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="obligations.csv"');
    return res.send(header + rows.join("\n"));
  } catch (err) {
    console.error("Export obligations CSV error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Export failed");
  }
}

async function exportPotsCsv(req, res) {
  try {
    const charityBalance = await CharityLedgerService.getBalance();
    const guruPool = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM reward_vouchers WHERE owner_type = 'guru' AND status = 'active'`
    );
    const rows = [
      ["pot", "balance_pence", "currency"].join(","),
      ["charity_pot", charityBalance, "GBP"].join(","),
      ["guru_reward_pool", guruPool.rows[0]?.total || 0, "GBP"].join(","),
    ];
    await logAdminAudit(req, "pots_exported", "pots.csv", null);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="pots.csv"');
    return res.send(rows.join("\n"));
  } catch (err) {
    console.error("Export pots CSV error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Export failed");
  }
}

async function exportSignupFeesCsv(req, res) {
  try {
    const result = await pool.query(
      `SELECT sf.user_id, u.name, u.email, sf.role_type, sf.amount, sf.paid_at FROM signup_fees sf JOIN users u ON u.id = sf.user_id ORDER BY sf.paid_at DESC`
    );
    const header = "user_id,user_name,email,role_type,amount,paid_at\n";
    const rows = result.rows.map((r) =>
      [r.user_id, escapeCsvCell(r.name), escapeCsvCell(r.email), r.role_type, r.amount, r.paid_at].join(",")
    );
    await logAdminAudit(req, "signup_fees_exported", "signup-fees.csv", { row_count: rows.length });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="signup-fees.csv"');
    return res.send(header + rows.join("\n"));
  } catch (err) {
    console.error("Export signup fees CSV error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Export failed");
  }
}

/**
 * GET /admin/territories - list all territories from territory_licence_inventory
 * Query: country, status (all|ACTIVE|LOCKED), search
 */
async function listTerritories(req, res) {
  try {
    const { country, status, search } = req.query;
    const territories = await TerritoryLicenceInventoryService.getTerritoriesWithAvailability({
      country: country || undefined,
      status: status || "all",
      search: search || "",
    });
    return res.json({
      error: false,
      message: "Territories retrieved.",
      data: { territories },
    });
  } catch (err) {
    console.error("List territories error:", err);
    return res.status(500).json({ error: true, message: "Unable to retrieve territories.", data: null });
  }
}

/**
 * GET /admin/territories/:id - get a single territory by id
 */
async function getTerritory(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: true, message: "Invalid territory ID.", data: null });
    }
    const territory = await TerritoryLicenceInventoryService.getTerritoryById(id);
    if (!territory) {
      return res.status(404).json({ error: true, message: "Territory not found.", data: null });
    }
    return res.json({
      error: false,
      message: "Territory retrieved.",
      data: { territory },
    });
  } catch (err) {
    console.error("Get territory error:", err);
    return res.status(500).json({ error: true, message: "Unable to retrieve territory.", data: null });
  }
}

/**
 * POST /admin/territories - create a new territory in territory_licence_inventory
 */
async function createTerritory(req, res) {
  try {
    const created = await TerritoryLicenceInventoryService.createTerritory(req.body);
    if (created && created.error) {
      return res.status(400).json({ error: true, message: created.error, data: null });
    }
    if (!created) {
      return res.status(409).json({ error: true, message: "A territory with this region_slug already exists.", data: null });
    }
    return res.status(201).json({
      error: false,
      message: "Territory created.",
      data: { territory: created },
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: true, message: "A territory with this region_slug already exists.", data: null });
    }
    console.error("Create territory error:", err);
    return res.status(500).json({ error: true, message: "Unable to create territory.", data: null });
  }
}

/**
 * GET /admin/territories/:id/licences - list licence holders for a territory
 */
async function getTerritoryLicences(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: true, message: "Invalid territory ID.", data: null });
    }
    const result = await pool.query(
      `SELECT tl.id, tl.user_id, tl.licence_status, tl.payment_mode, tl.contract_start_date, tl.contract_end_date, tl.licence_balance_remaining,
              tl.level_status, tl.service_fee_rate_current,
              u.email, u.name
       FROM territory_licences tl
       JOIN users u ON u.id = tl.user_id
       WHERE tl.territory_id = $1
       ORDER BY tl.created_at DESC`,
      [id]
    );
    return res.json({
      error: false,
      message: "Licences retrieved.",
      data: { licences: result.rows },
    });
  } catch (err) {
    console.error("Get territory licences error:", err);
    return res.status(500).json({ error: true, message: "Unable to retrieve licences.", data: null });
  }
}

/**
 * GET /admin/territory-applications?status=
 */
async function listTerritoryApplications(req, res) {
  try {
    const { status } = req.query;
    const list = await TerritoryApplicationService.listForAdmin({ status: status || undefined });
    return res.json({
      error: false,
      message: "Territory applications retrieved.",
      data: { applications: list },
    });
  } catch (err) {
    console.error("List territory applications error:", err);
    return res.status(500).json({ error: true, message: "Unable to retrieve applications.", data: null });
  }
}

/**
 * POST /admin/territory-applications/:id/approve
 */
async function approveTerritoryApplication(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: true, message: "Invalid application ID.", data: null });
    }
    const app = await TerritoryApplicationService.approve(id, req.user.id);
    if (!app) {
      return res.status(404).json({ error: true, message: "Application not found or not in reviewable state.", data: null });
    }
    return res.json({
      error: false,
      message: "Territory application approved.",
      data: { application: app },
    });
  } catch (err) {
    console.error("Approve territory application error:", err);
    return res.status(500).json({ error: true, message: "Unable to approve.", data: null });
  }
}

/**
 * POST /admin/territory-applications/:id/reject
 */
async function rejectTerritoryApplication(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: true, message: "Invalid application ID.", data: null });
    }
    const { reason } = req.body || {};
    const app = await TerritoryApplicationService.reject(id, req.user.id, reason);
    if (!app) {
      return res.status(404).json({ error: true, message: "Application not found.", data: null });
    }
    return res.json({
      error: false,
      message: "Territory application rejected.",
      data: { application: app },
    });
  } catch (err) {
    console.error("Reject territory application error:", err);
    return res.status(500).json({ error: true, message: "Unable to reject.", data: null });
  }
}

/**
 * PATCH /admin/territories/:id - update territory_licence_inventory
 */
async function updateTerritory(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: true, message: "Invalid territory ID.", data: null });
    }
    const { max_slots, status, available_from } = req.body || {};
    const updates = [];
    const params = [];
    let n = 1;
    if (max_slots !== undefined) {
      updates.push(`max_slots = $${n++}`);
      params.push(max_slots);
    }
    if (status !== undefined) {
      updates.push(`status = $${n++}`);
      params.push(status);
    }
    if (available_from !== undefined) {
      updates.push(`available_from = $${n++}`);
      params.push(available_from === null || available_from === "" ? null : new Date(available_from));
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: true, message: "No fields to update.", data: null });
    }
    updates.push("updated_at = NOW()");
    params.push(id);
    await pool.query(
      `UPDATE territory_licence_inventory SET ${updates.join(", ")} WHERE id = $${n}`,
      params
    );
    const row = await pool.query("SELECT * FROM territory_licence_inventory WHERE id = $1", [id]);
    return res.json({
      error: false,
      message: "Territory updated.",
      data: { territory: row.rows[0] },
    });
  } catch (err) {
    console.error("Update territory error:", err);
    return res.status(500).json({ error: true, message: "Unable to update territory.", data: null });
  }
}

/**
 * POST /admin/territory-licences/:id/suspend
 */
async function suspendTerritoryLicence(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: true, message: "Invalid licence ID.", data: null });
    }
    const updated = await TerritoryLicenceService.suspendLicence(id);
    if (!updated) {
      return res.status(404).json({ error: true, message: "Licence not found.", data: null });
    }
    return res.json({
      error: false,
      message: "Licence suspended.",
      data: { licenceId: id },
    });
  } catch (err) {
    console.error("Suspend territory licence error:", err);
    return res.status(500).json({ error: true, message: "Unable to suspend.", data: null });
  }
}

/**
 * GET /admin/referral-pool
 */
async function getReferralPool(req, res) {
  try {
    const data = await getReferralPoolAdminView();
    return res.json({
      error: false,
      message: "Referral pool retrieved successfully.",
      data,
    });
  } catch (err) {
    console.error("Get referral pool error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to fetch referral pool.",
      data: null,
    });
  }
}

/**
 * POST /admin/referrals/:id/approve-payout
 */
async function approveReferralPayoutByAdmin(req, res) {
  try {
    const referralId = parseInt(req.params.id, 10);
    if (isNaN(referralId) || referralId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid referral ID.",
        data: null,
      });
    }
    const data = await approveReferralPayout(referralId, req.user.id);
    return res.json({
      error: false,
      message: "Referral payout approved successfully.",
      data,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      error: true,
      message: err.message || "Unable to approve referral payout.",
      data: null,
    });
  }
}

module.exports = {
  approveGuruApplication,
  approveNetworkManagerApplication,
  approvePromoterApplication,
  rejectNetworkManagerApplication,
  getEventAuditLogs,
  getEventMetrics,
  createGuruInvite,
  listGurus,
  getGuruDetails,
  activateGuru,
  updateGuruLevel,
  attachPromoterToGuru,
  detachPromoterFromGuru,
  completeEvent,
  cancelEvent,
  approveCancellationRequest,
  listPromoters,
  getPromoter,
  approvePendingEvent,
  listPendingApprovalEvents,
  listRefundRequests,
  approveRefundRequest,
  rejectRefundRequest,
  listEvents,
  getEvent,
  listCharityApplications,
  getCharityApplication,
  approveCharityApplication,
  partialApproveCharityApplication,
  rejectCharityApplication,
  executeCharityPayout,
  markCharityExecutionCompleted,
  completeCharityApplication,
  getCharityLedger,
  getCharityBalance,
  getKingsAccountOverview,
  getLedger,
  getObligations,
  getSignupFees,
  exportLedgerCsv,
  exportObligationsCsv,
  exportPotsCsv,
  exportSignupFeesCsv,
  listTerritories,
  getTerritory,
  createTerritory,
  getTerritoryLicences,
  listTerritoryApplications,
  approveTerritoryApplication,
  rejectTerritoryApplication,
  updateTerritory,
  suspendTerritoryLicence,
  getReferralPool,
  approveReferralPayoutByAdmin,
};
