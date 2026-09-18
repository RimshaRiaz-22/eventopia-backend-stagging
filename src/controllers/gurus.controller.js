const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");
const GuruService = require("../services/guru.service");

function penceToGbpSafe(pence) {
  return Number(((Number(pence) || 0) / 100).toFixed(2));
}

function quarterWindowUtcBounds() {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1, 0, 0, 0, 0));
  return { startsAt: startsAt.toISOString(), endsAt: now.toISOString() };
}

/**
 * Maps DB row from GuruService.getAttachedPromoters to guru dashboard / Figma-friendly payload.
 */
function mapAttachedPromoterRow(p) {
  const ticketsSold = Number(p.tickets_sold || 0);
  const settledQuarter = Number(p.sprint_settled_tickets_quarter || 0);
  const refundsQuarter = Number(p.refunds_count_quarter || 0);
  const denom = settledQuarter + refundsQuarter;
  const refundRatePercentQuarter = denom > 0 ? Number(((100 * refundsQuarter) / denom).toFixed(2)) : 0;

  const linkSrc = String(p.link_source || "").toLowerCase();
  const fromReferralLink = linkSrc === "referral_link" || linkSrc.includes("referral");
  const signedUpViaReferral = Boolean(p.signed_up_via_referral);
  const isReferralModeActive = fromReferralLink || signedUpViaReferral;

  const ledgerConfirmedGbp = penceToGbpSafe(p.guru_credit_confirmed_pence);
  const ledgerProjectedGbp = penceToGbpSafe(p.guru_credit_projected_pence);
  const commissionsGbp = penceToGbpSafe(p.commission_total_pence);

  const figmaCreditNowGbp = ledgerConfirmedGbp;
  const normalCandidate =
    commissionsGbp > 0 ? commissionsGbp : Number((ledgerConfirmedGbp + ledgerProjectedGbp).toFixed(2));
  const figmaCreditNormalGbp = Number(Math.max(normalCandidate, figmaCreditNowGbp).toFixed(2));

  return {
    promoterId: p.id,
    userNo: p.user_no ?? null,
    name: p.name,
    email: p.email,
    avatarUrl: p.avatar_url ?? null,
    accountStatus: p.account_status ?? null,
    link: {
      source: p.link_source,
      attachedAt: p.attached_at,
    },
    referral: {
      currentMode: isReferralModeActive ? "referral" : "normal",
      isReferralModeActive,
      signedUpViaReferral,
      fromReferralLink,
      referralWindowExpiresAt: null,
    },
    credits: {
      currency: "GBP",
      guruCreditLedgerConfirmedGbp: ledgerConfirmedGbp,
      guruCreditLedgerProjectedGbp: ledgerProjectedGbp,
      guruCommissionsRecordedTotalGbp: commissionsGbp
      
    },
    stats: {
      ticketsSold,
      grossSalesPence: Number(p.gross_sales_pence || 0),
      grossSalesGbp: penceToGbpSafe(p.gross_sales_pence),
      sprintContributionSettledTicketsThisUtcQuarter: settledQuarter,
      refundsCountThisUtcQuarter: refundsQuarter,
      refundRatePercentThisUtcQuarter: refundRatePercentQuarter,
      eventsCount: Number(p.events_count || 0),
    },
    ticketsSold,
    grossSales: Number(p.gross_sales_pence || 0),
    joinedAt: p.attached_at,
  };
}

function mapPendingPromoterInviteRow(invite) {
  const displayName = String(invite.name || "").trim() || "Invited promoter";

  return {
    promoterId: invite.id,
    userNo: null,
    name: displayName,
    email: invite.email,
    avatarUrl: null,
    accountStatus: "pending",
    isInviteOnly: true,
    invite: {
      id: invite.id,
      expiresAt: invite.expires_at,
      status: "pending_registration",
    },
    link: {
      source: "invite_referral",
      attachedAt: invite.created_at,
    },
    referral: {
      currentMode: "normal",
      isReferralModeActive: false,
      signedUpViaReferral: false,
      fromReferralLink: false,
      referralWindowExpiresAt: invite.expires_at,
    },
    credits: {
      currency: "GBP",
      guruCreditLedgerConfirmedGbp: 0,
      guruCreditLedgerProjectedGbp: 0,
      guruCommissionsRecordedTotalGbp: 0,
    },
    stats: {
      ticketsSold: 0,
      grossSalesPence: 0,
      grossSalesGbp: 0,
      sprintContributionSettledTicketsThisUtcQuarter: 0,
      refundsCountThisUtcQuarter: 0,
      refundRatePercentThisUtcQuarter: 0,
      eventsCount: 0,
    },
    ticketsSold: 0,
    grossSales: 0,
    joinedAt: invite.created_at,
  };
}
const ReferralService = require("../services/referral.service");
const CommissionService = require("../services/commission.service");
const { ensurePromoterCreditWallet } = require("../services/promoterCreditWallet.service");

/**
 * Create Guru Application
 * POST /gurus/applications
 */
async function createApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      network_manager_user_id,
      avatar_url,
      contract_name,
      agreed_to_terms,
      agreed_to_guru_agreement,
    } = req.body;
    const userId = req.user.id;

    // Validation
    if (!network_manager_user_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Network Manager selection is required.",
        data: null,
      });
    }

    if (!agreed_to_terms || !agreed_to_guru_agreement) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "You must agree to both the terms and Guru agreement.",
        data: null,
      });
    }

    // Verify the user exists and has network_manager role, and get their territory
    const nmResult = await client.query(
      `
      SELECT id, name, role, city
      FROM users
      WHERE id = $1 AND role = 'network_manager'
      `,
      [network_manager_user_id]
    );

    if (nmResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Invalid Network Manager selection.",
        data: null,
      });
    }

    // Check if user already has a Guru application
    const existingApp = await client.query(
      "SELECT id FROM guru_applications WHERE user_id = $1",
      [userId]
    );

    if (existingApp.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: true,
        message: "You already have a Guru application. Please check your application status.",
        data: null,
      });
    }

    // Update user's avatar if provided
    if (avatar_url) {
      await client.query(
        "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
        [avatar_url, userId]
      );
    }

    // Create Guru application with territory from Network Manager
    const appResult = await client.query(
      `
      INSERT INTO guru_applications
        (user_id, network_manager_user_id, territory_name, avatar_url, contract_name, agreed_to_terms, agreed_to_guru_agreement, account_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *
      `,
      [
        userId,
        network_manager_user_id,
        nmResult.rows[0].city,
        avatar_url || null,
        contract_name || null,
        agreed_to_terms,
        agreed_to_guru_agreement,
      ]
    );

    // Set user account_status to PENDING
    await client.query(
      `
      UPDATE users
      SET account_status = 'pending',
          updated_at = NOW()
      WHERE id = $1
      `,
      [userId]
    );

    await client.query("COMMIT");

    const application = appResult.rows[0];

    return res.status(201).json({
      error: false,
      message: "Your Guru application has been submitted successfully. Please wait for approval.",
      data: {
        application: {
          id: application.id,
          networkManagerId: network_manager_user_id,
          networkManagerName: nmResult.rows[0].name,
          territoryName: nmResult.rows[0].city,
          contractName: application.contract_name,
          accountStatus: application.account_status,
          createdAt: application.created_at,
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create Guru application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to submit Guru application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Update My Guru Application
 * PATCH /gurus/applications/me
 */
async function updateMyApplication(req, res) {
  try {
    const { avatar_url, contract_name, agreed_to_terms, agreed_to_guru_agreement } = req.body;
    const userId = req.user.id;

    // Get the user's application
    const appResult = await pool.query(
      `
      SELECT id, account_status
      FROM guru_applications
      WHERE user_id = $1
      `,
      [userId]
    );

    if (appResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "No Guru application found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Can only update if still pending
    if (application.account_status !== 'pending') {
      return res.status(409).json({
        error: true,
        message: "Application can only be updated while pending approval.",
        data: null,
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    if (avatar_url !== undefined) {
      updateFields.push(`avatar_url = $${paramCount++}`);
      updateValues.push(avatar_url);
    }

    if (contract_name !== undefined) {
      updateFields.push(`contract_name = $${paramCount++}`);
      updateValues.push(contract_name);
    }

    if (agreed_to_terms !== undefined) {
      updateFields.push(`agreed_to_terms = $${paramCount++}`);
      updateValues.push(agreed_to_terms);
    }

    if (agreed_to_guru_agreement !== undefined) {
      updateFields.push(`agreed_to_guru_agreement = $${paramCount++}`);
      updateValues.push(agreed_to_guru_agreement);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        error: true,
        message: "At least one field must be provided for update.",
        data: null,
      });
    }

    updateFields.push(`updated_at = NOW()`);
    updateValues.push(userId);

    // Update application
    const result = await pool.query(
      `
      UPDATE guru_applications
      SET ${updateFields.join(', ')}
      WHERE user_id = $${paramCount}
      RETURNING *
      `,
      updateValues
    );

    return res.json({
      error: false,
      message: "Guru application updated successfully.",
      data: {
        application: result.rows[0],
      },
    });
  } catch (err) {
    console.error("Update Guru application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to update Guru application at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * Get My Guru Application
 * GET /gurus/applications/me
 */
async function getMyApplication(req, res) {
  try {
    const userId = req.user.id;

    // Get Guru application
    const appResult = await pool.query(
      `
      SELECT ga.id, ga.account_status, ga.created_at, ga.reviewed_at, ga.rejection_reason,
             ga.network_manager_user_id, ga.avatar_url, ga.contract_name,
             ga.activation_fee_status, ga.activation_fee_balance, ga.activation_fee_payment_method,
             ga.verification_status,
             u.name as network_manager_name, u.city as network_manager_territory
      FROM guru_applications ga
      LEFT JOIN users u ON u.id = ga.network_manager_user_id
      WHERE ga.user_id = $1
      `,
      [userId]
    );

    if (appResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "No Guru application found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Derive nextStep for client flow
    let nextStep = "pending";
    if (application.account_status === "approved") {
      nextStep = "approved";
    } else if (application.activation_fee_status === "committed_upfront" || application.activation_fee_status === "committed_negative_balance") {
      nextStep = "pending_approval";
    } else if (!application.activation_fee_status) {
      nextStep = "activation_fee_commit";
    }

    return res.json({
      error: false,
      message: "Guru application retrieved successfully.",
      data: {
        application: {
          id: application.id,
          accountStatus: application.account_status,
          createdAt: application.created_at,
          reviewedAt: application.reviewed_at,
          rejectionReason: application.rejection_reason,
          avatarUrl: application.avatar_url,
          contractName: application.contract_name,
          activationFeeStatus: application.activation_fee_status,
          activationFeeBalance: application.activation_fee_balance != null ? Number(application.activation_fee_balance) : null,
          activationFeePaymentMethod: application.activation_fee_payment_method,
          verificationStatus: application.verification_status,
          nextStep,
          networkManager: {
            id: application.network_manager_user_id,
            name: application.network_manager_name,
          },
          territoryName: application.network_manager_territory,
        },
      },
    });
  } catch (err) {
    console.error("Get Guru application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve Guru application at the moment. Please try again later.",
      data: null,
    });
  }
}

const GURU_ACTIVATION_FEE_PENCE = 25000; // £250

/**
 * Commit Activation Fee (Step 4 of Guru Registration)
 * POST /gurus/activation-fee/commit
 * User chooses: upfront (simulated payment) or negative_balance
 */
async function commitActivationFee(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { choice } = req.body;
    const userId = req.user.id;

    if (!choice || !["upfront", "negative_balance"].includes(choice)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "choice is required and must be 'upfront' or 'negative_balance'.",
        data: null,
      });
    }

    // Get pending guru application
    const appResult = await client.query(
      `SELECT id, account_status, activation_fee_status
       FROM guru_applications WHERE user_id = $1`,
      [userId]
    );

    if (appResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "No Guru application found.",
        data: null,
      });
    }

    const application = appResult.rows[0];
    if (application.account_status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Activation fee can only be committed for pending applications.",
        data: null,
      });
    }
    if (application.activation_fee_status) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: true,
        message: "Activation fee has already been committed.",
        data: null,
      });
    }

    const now = new Date();

    if (choice === "upfront") {
      // Simulate payment
      await client.query(
        `INSERT INTO payment_transactions
         (user_id, entity_type, entity_id, amount, currency, direction, status, payment_method)
         VALUES ($1, 'guru_activation_fee', $2, $3, 'GBP', 'debit', 'completed', 'simulated')`,
        [userId, application.id, GURU_ACTIVATION_FEE_PENCE]
      );
      await client.query(
        `INSERT INTO signup_fees (user_id, role_type, amount, status, payment_method, paid_at)
         VALUES ($1, 'guru', $2, 'paid', 'simulated', $3)`,
        [userId, GURU_ACTIVATION_FEE_PENCE, now]
      );
      await client.query(
        `UPDATE guru_applications SET
           activation_fee_status = 'committed_upfront',
           activation_fee_balance = 0,
           activation_fee_payment_method = 'simulated',
           activation_fee_committed_at = $2
         WHERE id = $1`,
        [application.id, now]
      );
    } else {
      // negative_balance
      await client.query(
        `UPDATE guru_applications SET
           activation_fee_status = 'committed_negative_balance',
           activation_fee_balance = $2,
           activation_fee_payment_method = 'negative_balance',
           activation_fee_committed_at = $3
         WHERE id = $1`,
        [application.id, GURU_ACTIVATION_FEE_PENCE, now]
      );
    }

    await client.query("COMMIT");

    return res.status(200).json({
      error: false,
      message: "Activation fee commitment recorded successfully.",
      data: {
        activationFeeStatus: choice === "upfront" ? "committed_upfront" : "committed_negative_balance",
        activationFeeBalance: choice === "upfront" ? 0 : GURU_ACTIVATION_FEE_PENCE,
        amount: GURU_ACTIVATION_FEE_PENCE,
        currency: "GBP",
        nextStep: "pending_approval",
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Commit activation fee error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to commit activation fee at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Get My Guru Profile (approved Gurus only)
 * GET /gurus/me
 */
async function getMyProfile(req, res) {
  try {
    const userId = req.user.id;

    // Check if user is an approved Guru or has a pending Guru application
    const userResult = await pool.query(
      `
      SELECT u.*, gnm.territory_name, gp.licence_balance,
             nm.id as nm_id, nm.name as nm_name, nm.email as nm_email, nm.avatar_url as nm_avatar_url,
             ga.account_status as guru_application_status
      FROM users u
      LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = u.id
      LEFT JOIN guru_profiles gp ON gp.user_id = u.id
      LEFT JOIN users nm ON nm.id = gnm.network_manager_user_id
      LEFT JOIN guru_applications ga ON ga.user_id = u.id
      WHERE u.id = $1 AND (
        (u.role = 'guru' AND u.account_status = 'active')
        OR (ga.account_status = 'pending')
      )
      `,
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(403).json({
        error: true,
        message: "Guru profile not found or account not approved.",
        data: null,
      });
    }

    const guru = userResult.rows[0];
    const isPending = guru.guru_application_status === 'pending';

    return res.json({
      error: false,
      message: "Guru profile retrieved successfully.",
      data: {
        profile: {
          userId: guru.user_no ?? guru.id,
          name: guru.name,
          email: guru.email,
          avatarUrl: guru.avatar_url,
          role: guru.role,
          accountStatus: guru.account_status,
          licenceBalance: guru.licence_balance != null ? Number(guru.licence_balance) : null,
          pending: isPending,
          territory: {
            name: guru.territory_name,
          },
          networkManager: guru.nm_id ? {
            id: guru.nm_id,
            name: guru.nm_name,
            email: guru.nm_email,
            avatarUrl: guru.nm_avatar_url,
            territory: guru.territory_name,
          } : null,
        },
      },
    });
  } catch (err) {
    console.error("Get Guru profile error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve Guru profile at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * Setup Guru Account (add full name)
 * PUT /gurus/setup-account
 */
async function setupAccount(req, res) {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        error: true,
        message: "Full name is required",
        data: null,
      });
    }

    // Check if user has guru role
    if (req.user.role !== 'guru') {
      return res.status(403).json({
        error: true,
        message: "This endpoint is only for Guru users",
        data: null,
      });
    }

    // Complete setup for invited gurus:
    // - store full name
    // - mark guru as publicly active for discovery APIs
    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           guru_active = TRUE,
           guru_active_until = COALESCE(guru_active_until, NOW() + INTERVAL '1 year'),
           guru_activation_date = COALESCE(guru_activation_date, NOW()),
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, name, role, account_status, guru_active, guru_active_until, guru_activation_date`,
      [name.trim(), userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found",
        data: null,
      });
    }

    return res.json({
      error: false,
      message: "Guru account setup completed successfully",
      data: {
        user: result.rows[0],
        setupRequired: false,
      },
    });
  } catch (err) {
    console.error("Setup Guru account error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to setup account at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * List Promoter Applications (for assigned Guru only)
 * GET /gurus/promoters/applications
 */
async function listPromoterApplications(req, res) {
  try {
    const guruId = req.user.id;

    // Get all promoter applications for this Guru
    const result = await pool.query(
      `SELECT pa.*, u.name as promoter_name, u.email as promoter_email
       FROM promoter_applications pa
       JOIN users u ON u.id = pa.user_id
       WHERE pa.guru_user_id = $1 AND pa.account_status = 'pending'
       ORDER BY pa.created_at DESC`,
      [guruId]
    );

    const applications = result.rows;

    return res.json({
      error: false,
      message: "Promoter applications retrieved successfully.",
      data: {
        applications: applications.map(app => ({
          id: app.id,
          promoterName: app.promoter_name,
          promoterEmail: app.promoter_email,
          agreedToTerms: app.agreed_to_terms,
          agreedToPromoterAgreement: app.agreed_to_promoter_agreement,
          territoryName: app.territory_name,
          createdAt: app.created_at,
        })),
        count: applications.length,
      },
    });
  } catch (err) {
    console.error("List promoter applications error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve promoter applications at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * Approve Promoter Application
 * POST /gurus/promoters/:applicationId/approve
 */
async function approvePromoterApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { applicationId } = req.params;
    const guruId = req.user.id;

    // Get application
    const appResult = await client.query(
      `SELECT pa.*, u.id as user_id, u.email, u.name
       FROM promoter_applications pa
       JOIN users u ON u.id = pa.user_id
       WHERE pa.id = $1`,
      [applicationId]
    );

    if (appResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "Promoter application not found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Verify Guru owns this promoter (via promoter_guru_links)
    const linkResult = await client.query(
      `SELECT guru_user_id FROM promoter_guru_links WHERE promoter_user_id = $1`,
      [application.user_id]
    );

    if (linkResult.rowCount === 0 || linkResult.rows[0].guru_user_id !== guruId) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: true,
        message: "You are not authorized to approve this promoter.",
        data: null,
      });
    }

    // Update application status
    await client.query(
      `UPDATE promoter_applications
       SET account_status = 'approved', reviewed_by = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [guruId, applicationId]
    );

    // Update user role and account status
    const userResult = await client.query(
      `UPDATE users
       SET role = 'promoter', account_status = 'active', roles_version = roles_version + 1
       WHERE id = $1
       RETURNING roles_version`,
      [application.user_id]
    );

    await ensurePromoterCreditWallet(client, application.user_id);

    await client.query("COMMIT");

    return res.json({
      error: false,
      message: "Promoter application approved successfully.",
      data: {
        application: { id: applicationId, accountStatus: 'approved' },
        user: {
          userId: application.user_id,
          email: application.email,
          name: application.name,
          role: 'promoter',
          accountStatus: 'active',
          rolesVersion: userResult.rows[0].roles_version
        }
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Approve promoter application error:", err);
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
 * Activate promoter directly from dashboard list by promoterId.
 * POST /gurus/dashboard/promoters/:promoterId/activate
 */
async function activatePendingPromoter(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const guruId = req.user.id;
    const requestedPromoterId = parseInt(req.params.promoterId, 10);
    if (!Number.isFinite(requestedPromoterId) || requestedPromoterId <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Invalid promoter ID.",
        data: null,
      });
    }

    let resolvedPromoterId = requestedPromoterId;
    let inviteOnlyActivation = false;

    // Invite rows in dashboard use invite.id, so first resolve invite -> pending user.
    const inviteResult = await client.query(
      `SELECT email
       FROM promoter_referral_invites
       WHERE id = $1 AND guru_user_id = $2 AND used_at IS NULL
       LIMIT 1`,
      [requestedPromoterId, guruId]
    );

    let userResult;
    if (inviteResult.rowCount > 0) {
      const pendingUserByInvite = await client.query(
        `SELECT id, user_no, email, name, role, account_status
         FROM users
         WHERE email = $1
         ORDER BY created_at ASC
         LIMIT 1`,
        [inviteResult.rows[0].email]
      );
      if (pendingUserByInvite.rowCount > 0) {
        userResult = pendingUserByInvite;
        resolvedPromoterId = pendingUserByInvite.rows[0].id;
        inviteOnlyActivation = true;
      } else {
        userResult = { rowCount: 0, rows: [] };
      }
    } else {
      userResult = await client.query(
        `SELECT id, user_no, email, name, role, account_status
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [resolvedPromoterId]
      );
    }
    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "Promoter user not found.",
        data: null,
      });
    }
    const promoter = userResult.rows[0];

    const linkResult = await client.query(
      `SELECT guru_user_id, source FROM promoter_guru_links WHERE promoter_user_id = $1 LIMIT 1`,
      [resolvedPromoterId]
    );
    if (linkResult.rowCount === 0 || Number(linkResult.rows[0].guru_user_id) !== Number(guruId)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: true,
        message: "You are not authorized to activate this promoter.",
        data: null,
      });
    }

    const appResult = await client.query(
      `SELECT id, account_status
       FROM promoter_applications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [resolvedPromoterId]
    );

    const isInviteLinked = String(linkResult.rows[0]?.source || "").toLowerCase() === "invite_referral";

    if (appResult.rowCount === 0) {
      if (!inviteOnlyActivation && !isInviteLinked) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: true,
          message: "No promoter application found for this user.",
          data: null,
        });
      }
    }

    const application = appResult.rows[0] || null;
    if (application && application.account_status === "rejected") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Rejected application cannot be activated.",
        data: null,
      });
    }

    if (String(promoter.account_status || "").toLowerCase() === "active") {
      await ensurePromoterCreditWallet(client, resolvedPromoterId);
      await client.query(
        `UPDATE promoter_referral_invites
         SET used_at = NOW(), updated_at = NOW()
         WHERE guru_user_id = $1 AND email = $2 AND used_at IS NULL`,
        [guruId, promoter.email]
      );
      await client.query("COMMIT");
      return res.json({
        error: false,
        message: "Promoter is already active.",
        data: {
          application: application ? { id: application.id, accountStatus: "approved" } : null,
          user: {
            userId: promoter.user_no ?? promoter.id,
            email: promoter.email,
            name: promoter.name,
            role: "promoter",
            accountStatus: "active",
          },
        },
      });
    }

    if (application) {
      await client.query(
        `UPDATE promoter_applications
         SET account_status = 'approved', reviewed_by = $1, reviewed_at = NOW()
         WHERE id = $2`,
        [guruId, application.id]
      );
    }

    const promoted = await client.query(
      `UPDATE users
       SET role = 'promoter', account_status = 'active', roles_version = roles_version + 1
       WHERE id = $1
       RETURNING user_no, email, name, roles_version`,
      [resolvedPromoterId]
    );

    await ensurePromoterCreditWallet(client, resolvedPromoterId);
    await client.query(
      `UPDATE promoter_referral_invites
       SET used_at = NOW(), updated_at = NOW()
       WHERE guru_user_id = $1 AND email = $2 AND used_at IS NULL`,
      [guruId, promoted.rows[0].email]
    );

    await client.query("COMMIT");
    return res.json({
      error: false,
      message: "Promoter activated successfully.",
      data: {
        application: application ? { id: application.id, accountStatus: "approved" } : null,
        user: {
          userId: promoted.rows[0].user_no ?? resolvedPromoterId,
          email: promoted.rows[0].email,
          name: promoted.rows[0].name,
          role: "promoter",
          accountStatus: "active",
          rolesVersion: promoted.rows[0].roles_version,
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Activate promoter error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to activate promoter at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Reject Promoter Application
 * POST /gurus/promoters/:applicationId/reject
 */
async function rejectPromoterApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { applicationId } = req.params;
    const { rejection_reason } = req.body;
    const guruId = req.user.id;

    // Get application
    const appResult = await client.query(
      `SELECT pa.*, u.id as user_id, u.email, u.name
       FROM promoter_applications pa
       JOIN users u ON u.id = pa.user_id
       WHERE pa.id = $1`,
      [applicationId]
    );

    if (appResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "Promoter application not found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Verify Guru owns this promoter (via promoter_guru_links)
    const linkResult = await client.query(
      `SELECT guru_user_id FROM promoter_guru_links WHERE promoter_user_id = $1`,
      [application.user_id]
    );

    if (linkResult.rowCount === 0 || linkResult.rows[0].guru_user_id !== guruId) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: true,
        message: "You are not authorized to reject this promoter.",
        data: null,
      });
    }

    // Update application status
    await client.query(
      `UPDATE promoter_applications
       SET account_status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), rejection_reason = $2
       WHERE id = $3`,
      [guruId, rejection_reason || null, applicationId]
    );

    await client.query("COMMIT");

    return res.json({
      error: false,
      message: "Promoter application rejected.",
      data: {
        application: {
          id: applicationId,
          accountStatus: 'rejected',
          rejectionReason: rejection_reason
        }
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Reject promoter application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to reject promoter application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Get Dashboard Summary for Guru
 * GET /guru/dashboard/summary
 */
async function getDashboardSummary(req, res) {
  try {
    const guruId = req.user.id;
    const { dateFrom, dateTo } = req.query;

    // Check if Guru is active
    const isActive = await GuruService.isGuruActive(guruId);

    if (!isActive) {
      return fail(res, req, 403, "GURU_NOT_ACTIVE", "Guru account not active. Please complete activation.");
    }

    // Get summary and current guru level
    const [summary, levelRecord] = await Promise.all([
      GuruService.getDashboardSummary(guruId, dateFrom, dateTo),
      GuruService.getCurrentLevel(guruId),
    ]);

    const guruLevel = levelRecord?.level != null ? parseInt(levelRecord.level, 10) : 1;

    return ok(res, req, {
      guruActive: true,
      guruLevel,
      promotersCount: summary.promotersCount,
      ticketsSoldTotal: summary.ticketsSoldTotal,
      grossSales: summary.grossSales,
      commissionsEarned: summary.commissionsEarned,
      pendingCommissions: summary.pendingCommissions
    });
  } catch (err) {
    console.error('Get dashboard summary error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get dashboard summary");
  }
}

/**
 * Get Referral Info
 * GET /guru/dashboard/referral
 */
async function getReferralInfo(req, res) {
  try {
    const guruId = req.user.id;

    // Get or create referral code
    let referral = await ReferralService.getReferralInfo(guruId);

    if (!referral) {
      referral = await ReferralService.createReferralCode(guruId);
    }

    const base = String(process.env.FRONTEND_URL || "").replace(/\/+$/, "");
    const code = encodeURIComponent(referral.referral_code);
    const referralLink = base
      ? `${base}/register?referral_token=${code}`
      : `register?referral_token=${code}`;

    return ok(res, req, {
      referralCode: referral.referral_code,
      referral_token: referral.referral_code,
      referralLink,
      createdAt: referral.created_at,
    });
  } catch (err) {
    console.error('Get referral info error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get referral info");
  }
}

/**
 * Invite Promoters — get or create guru referral link + network stats (Figma invite screen).
 * POST or GET /gurus/promoters/invite/referral-link
 */
async function getInvitePromotersReferralLink(req, res) {
  try {
    const guruId = req.user.id;

    let referral = await ReferralService.getReferralInfo(guruId);
    if (!referral) {
      referral = await ReferralService.createReferralCode(guruId);
    }

    const baseUrl = String(process.env.FRONTEND_URL || "").replace(/\/+$/, "");
    const codeEnc = encodeURIComponent(referral.referral_code);
    const referralLink = baseUrl
      ? `${baseUrl}/register?referral_token=${codeEnc}`
      : `register?referral_token=${codeEnc}`;

    const networkStats = await GuruService.getInvitePromotersNetworkStats(guruId);
    const earnedGbp = (Number(networkStats.earnedPence) / 100).toFixed(2);

    return ok(res, req, {
      referralCode: referral.referral_code,
      referral_token: referral.referral_code,
      referralLink,
      createdAt: referral.created_at,
      networkStats: {
        promotersJoined: networkStats.promotersJoined,
        ticketsSold: networkStats.ticketsSold,
        earned: {
          amount: earnedGbp,
          currency: "GBP",
        },
      },
      meta: {
        statsLabel: "Live Stats",
        footnote: "Promoters who sign up with this link join your network.",
      },
    });
  } catch (err) {
    console.error("Invite promoters referral link error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load invite referral link");
  }
}

/**
 * Get Referral Statistics
 * GET /guru/referral/stats
 */
async function getReferralStats(req, res) {
  try {
    const guruId = req.user.id;
    const { dateFrom, dateTo } = req.query;

    const stats = await ReferralService.getReferralStats(guruId, dateFrom, dateTo);

    return ok(res, req, stats);
  } catch (err) {
    console.error('Get referral stats error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get referral stats");
  }
}

/**
 * Get Attached Promoters
 * GET /guru/dashboard/promoters
 */
async function getAttachedPromoters(req, res) {
  try {
    const guruId = req.user.id;
    const { dateFrom, dateTo, page = "1", limit = "20", search = "" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const normalizedSearch = String(search || "").trim().toLowerCase();

    const [promoters, pendingInvites] = await Promise.all([
      GuruService.getAttachedPromoters(guruId, dateFrom, dateTo),
      GuruService.getPendingPromoterInvites(guruId, dateFrom, dateTo),
    ]);
    const mergedPromoters = [
      ...promoters.map(mapAttachedPromoterRow),
      ...pendingInvites.map(mapPendingPromoterInviteRow),
    ];

    const filteredPromoters = normalizedSearch
      ? mergedPromoters.filter((p) =>
        String(p.name || "").toLowerCase().includes(normalizedSearch)
      )
      : mergedPromoters;

    const sortedPromoters = filteredPromoters.sort((a, b) => {
      const aTs = new Date(a.joinedAt || 0).getTime() || 0;
      const bTs = new Date(b.joinedAt || 0).getTime() || 0;
      return bTs - aTs;
    });
    const total = sortedPromoters.length;
    const start = (pageNum - 1) * limitNum;
    const pagedPromoters = sortedPromoters.slice(start, start + limitNum);

    return ok(res, req, {
      quarterWindowUtc: quarterWindowUtcBounds(),
      search: String(search || "").trim(),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
      promoters: pagedPromoters,
    });
  } catch (err) {
    console.error('Get attached promoters error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get attached promoters");
  }
}

/**
 * Promoters who joined via this Guru's public referral code (register?referral_token=CODE from guru_referrals),
 * not the full network (excludes application-only and promoter-to-promoter token signups).
 * GET /gurus/dashboard/promoters/referral-signups — must stay above /dashboard/promoters/:promoterId
 */
async function getGuruReferralSignupsPromoters(req, res) {
  try {
    const guruId = req.user.id;
    const { dateFrom, dateTo, page = "1", limit = "20", search = "" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const { rows: promoters, total } = await GuruService.getAttachedPromoters(guruId, dateFrom, dateTo, {
      onlyGuruPublicReferralSignups: true,
      searchByName: search,
      page: pageNum,
      limit: limitNum,
      includePagination: true,
    });

    return ok(res, req, {
      quarterWindowUtc: quarterWindowUtcBounds(),
      filter: "guru_public_referral_link",
      search: String(search || "").trim(),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
      promoters: promoters.map(mapAttachedPromoterRow),
    });
  } catch (err) {
    console.error("Get guru referral signups promoters error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get referral signup promoters");
  }
}

/**
 * Get Promoter Performance
 * GET /guru/dashboard/promoters/:promoterId
 */
async function getPromoterPerformance(req, res) {
  try {
    const { promoterId } = req.params;
    const guruId = req.user.id;
    const { dateFrom, dateTo } = req.query;

    const performance = await GuruService.getPromoterPerformance(guruId, parseInt(promoterId, 10), dateFrom, dateTo);

    return ok(res, req, {
      promoter: {
        id: performance.promoter.id,
        name: performance.promoter.name,
        email: performance.promoter.email
      },
      events: performance.events.map(e => ({
        id: e.id,
        title: e.title,
        startAt: e.start_at,
        status: e.status,
        ticketsSold: parseInt(e.tickets_sold || 0),
        grossSales: parseInt(e.gross_sales || 0)
      }))
    });
  } catch (err) {
    console.error('Get promoter performance error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to get promoter performance");
  }
}

/**
 * Promoter detail header + summary cards (Figma promoter details screen).
 * GET /api/gurus/dashboard/promoters/:promoterId/details
 */
async function getPromoterDetails(req, res) {
  try {
    const guruId = req.user.id;
    const promoterId = parseInt(req.params.promoterId, 10);
    const data = await GuruService.getPromoterDetailsForGuru(guruId, promoterId);
    const p = data.profile;

    return ok(res, req, {
      profile: {
        promoterId: p.id,
        userNo: p.user_no ?? null,
        name: p.name,
        email: p.email,
        avatarUrl: p.avatar_url ?? null,
        accountStatus: p.account_status ?? null,
        roleLabel: p.role === "promoter" ? "Event Promoter" : p.role || "Promoter",
        districtOrCity: p.city ?? null,
        guruTerritoryName: p.guru_territory_name ?? null,
        subtitleLine: [p.role === "promoter" ? "Event Promoter" : p.role, p.city || p.guru_territory_name]
          .filter(Boolean)
          .join(" • "),
      },
      link: data.link,
      summaryCards: data.summary,
      meta: data.meta,
    });
  } catch (err) {
    if (err.message === "Promoter is not attached to this Guru") {
      return fail(res, req, 403, "NOT_AUTHORIZED", err.message);
    }
    console.error("Get promoter details error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load promoter details");
  }
}

/**
 * Charts tab — time series. Query: granularity=daily|weekly|monthly
 * GET /api/gurus/dashboard/promoters/:promoterId/charts
 */
async function getPromoterCharts(req, res) {
  try {
    const guruId = req.user.id;
    const promoterId = parseInt(req.params.promoterId, 10);
    const { granularity, date, weekStart, weekEnd, month, year } = req.query;
    const data = await GuruService.getPromoterChartsForGuru(guruId, promoterId, granularity, {
      date,
      weekStart,
      weekEnd,
      month,
      year,
    });
    return ok(res, req, data);
  } catch (err) {
    if (err.code === "INVALID_GRANULARITY") {
      return fail(res, req, 400, "INVALID_GRANULARITY", "granularity must be daily, weekly, or monthly");
    }
    if (err.code === "INVALID_DATE_PARAMS") {
      return fail(
        res,
        req,
        400,
        "INVALID_DATE_PARAMS",
        "For daily pass date=YYYY-MM-DD; for weekly pass weekStart=YYYY-MM-DD (optional weekEnd); for monthly pass month=1-12 and year=YYYY"
      );
    }
    if (err.message === "Promoter is not attached to this Guru") {
      return fail(res, req, 403, "NOT_AUTHORIZED", err.message);
    }
    console.error("Get promoter charts error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load promoter charts");
  }
}

/**
 * Stats tab. Query: period=daily|weekly|monthly (selects aggregation window).
 * GET /api/gurus/dashboard/promoters/:promoterId/stats
 */
async function getPromoterStats(req, res) {
  try {
    const guruId = req.user.id;
    const promoterId = parseInt(req.params.promoterId, 10);
    const { period, date, weekStart, weekEnd, month, year } = req.query;
    const data = await GuruService.getPromoterStatsForGuru(guruId, promoterId, period, {
      date,
      weekStart,
      weekEnd,
      month,
      year,
    });
    return ok(res, req, data);
  } catch (err) {
    if (err.code === "INVALID_PERIOD") {
      return fail(res, req, 400, "INVALID_PERIOD", "period must be daily, weekly, or monthly");
    }
    if (err.code === "INVALID_DATE_PARAMS") {
      return fail(
        res,
        req,
        400,
        "INVALID_DATE_PARAMS",
        "For daily pass date=YYYY-MM-DD; for weekly pass weekStart=YYYY-MM-DD (optional weekEnd); for monthly pass month=1-12 and year=YYYY"
      );
    }
    if (err.message === "Promoter is not attached to this Guru") {
      return fail(res, req, 403, "NOT_AUTHORIZED", err.message);
    }
    console.error("Get promoter stats error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load promoter stats");
  }
}

/**
 * History tab. Query: granularity=daily|weekly|monthly&limit=14
 * GET /api/gurus/dashboard/promoters/:promoterId/history
 */
async function getPromoterHistory(req, res) {
  try {
    const guruId = req.user.id;
    const promoterId = parseInt(req.params.promoterId, 10);
    const { granularity, limit, date, weekStart, weekEnd, month, year } = req.query;
    const data = await GuruService.getPromoterHistoryForGuru(guruId, promoterId, granularity, limit, {
      date,
      weekStart,
      weekEnd,
      month,
      year,
    });
    return ok(res, req, data);
  } catch (err) {
    if (err.code === "INVALID_GRANULARITY") {
      return fail(res, req, 400, "INVALID_GRANULARITY", "granularity must be daily, weekly, or monthly");
    }
    if (err.code === "INVALID_DATE_PARAMS") {
      return fail(
        res,
        req,
        400,
        "INVALID_DATE_PARAMS",
        "For daily pass date=YYYY-MM-DD; for weekly pass weekStart=YYYY-MM-DD (optional weekEnd); for monthly pass month=1-12 and year=YYYY"
      );
    }
    if (err.message === "Promoter is not attached to this Guru") {
      return fail(res, req, 403, "NOT_AUTHORIZED", err.message);
    }
    console.error("Get promoter history error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load promoter history");
  }
}

/**
 * Export Promoters CSV
 * GET /guru/exports/promoters.csv
 */
async function exportPromotersCsv(req, res) {
  try {
    const guruId = req.user.id;
    const { dateFrom, dateTo } = req.query;

    const promoters = await GuruService.getAttachedPromoters(guruId, dateFrom, dateTo);

    // Generate CSV
    const csv = [
      [
        'Promoter Name',
        'Email',
        'Tickets Sold',
        'Gross Sales (GBP)',
        'Sprint Settled Tickets (UTC quarter)',
        'Refunds (UTC quarter)',
        'Refund rate % (quarter)',
        'Guru credit confirmed (GBP)',
        'Guru credit projected (GBP)',
        'Commissions recorded (GBP)',
        'Joined At',
      ].join(','),
      ...promoters.map((p) => {
        const row = mapAttachedPromoterRow(p);
        return [
          row.name,
          row.email,
          row.stats.ticketsSold,
          row.stats.grossSalesGbp.toFixed(2),
          row.stats.sprintContributionSettledTicketsThisUtcQuarter,
          row.stats.refundsCountThisUtcQuarter,
          row.stats.refundRatePercentThisUtcQuarter,
          row.credits.guruCreditLedgerConfirmedGbp.toFixed(2),
          row.credits.guruCreditLedgerProjectedGbp.toFixed(2),
          row.credits.guruCommissionsRecordedTotalGbp.toFixed(2),
          new Date(row.joinedAt).toISOString(),
        ].join(',');
      }),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="guru-promoters-${Date.now()}.csv"`);

    return res.send(csv);
  } catch (err) {
    console.error('Export promoters CSV error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to export promoters");
  }
}

/**
 * Export Performance CSV
 * GET /guru/exports/performance.csv
 */
async function exportPerformanceCsv(req, res) {
  try {
    const guruId = req.user.id;
    const { dateFrom, dateTo } = req.query;

    // Get all promoters
    const promoters = await GuruService.getAttachedPromoters(guruId, dateFrom, dateTo);

    // Generate CSV
    const csv = [
      [
        'Promoter Name',
        'Email',
        'Tickets Sold',
        'Gross Sales (GBP)',
        'Sprint Settled Tickets (UTC quarter)',
        'Refunds (UTC quarter)',
        'Refund rate % (quarter)',
        'Guru credit confirmed (GBP)',
        'Guru credit projected (GBP)',
        'Commissions recorded (GBP)',
        'Joined At',
      ].join(','),
      ...promoters.map((p) => {
        const row = mapAttachedPromoterRow(p);
        return [
          row.name,
          row.email,
          row.stats.ticketsSold,
          row.stats.grossSalesGbp.toFixed(2),
          row.stats.sprintContributionSettledTicketsThisUtcQuarter,
          row.stats.refundsCountThisUtcQuarter,
          row.stats.refundRatePercentThisUtcQuarter,
          row.credits.guruCreditLedgerConfirmedGbp.toFixed(2),
          row.credits.guruCreditLedgerProjectedGbp.toFixed(2),
          row.credits.guruCommissionsRecordedTotalGbp.toFixed(2),
          new Date(row.joinedAt).toISOString(),
        ].join(',');
      }),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="guru-performance-${Date.now()}.csv"`);

    return res.send(csv);
  } catch (err) {
    console.error('Export performance CSV error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to export performance");
  }
}

/**
 * Get all reward vouchers for authenticated guru
 * GET /api/gurus/rewards
 */
async function getMyRewards(req, res) {
  try {
    const result = await pool.query(
      `SELECT rv.*, e.title as event_title, e.completed_at
       FROM reward_vouchers rv
       JOIN events e ON e.id = rv.event_id
       WHERE rv.owner_type = 'guru'
       AND rv.owner_id = $1
       ORDER BY rv.issued_at DESC`,
      [req.user.id]
    );

    return ok(res, req, {
      message: "Guru rewards retrieved",
      vouchers: result.rows,
    });
  } catch (err) {
    console.error('Get guru rewards error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve rewards");
  }
}

/**
 * List available Gurus for Promoter selection
 * Public endpoint - no authentication required
 * GET /api/gurus/available
 * GET /api/gurus/available?territory={territory_name}
 */
async function listAvailableGurus(req, res) {
  try {
    const { territory } = req.query;

    let query = `
      SELECT
        u.id,
        u.name,
        u.email,
        u.avatar_url,
        gnm.territory_name,
        gl.level as guru_level,
        gr.referral_code
      FROM users u
      JOIN guru_network_manager gnm ON gnm.guru_user_id = u.id
      LEFT JOIN guru_levels gl ON gl.guru_id = u.id AND gl.effective_until IS NULL
      LEFT JOIN guru_referrals gr ON gr.guru_id = u.id
      WHERE u.role = 'guru'
        AND u.account_status = 'active'
        AND u.guru_active = TRUE
    `;

    const queryParams = [];

    if (territory) {
      query += ` AND gnm.territory_name ILIKE $1`;
      queryParams.push(`%${territory}%`);
    }

    query += ` ORDER BY gl.level DESC, u.name ASC`;

    const result = await pool.query(query, queryParams);

    const gurus = result.rows.map(guru => ({
      id: guru.id,
      name: guru.name || guru.email,
      avatarUrl: guru.avatar_url,
      territory: guru.territory_name,
      level: guru.guru_level || 1,
      referralCode: guru.referral_code
    }));

    return res.json({
      error: false,
      message: "Gurus retrieved successfully.",
      data: {
        gurus,
        count: gurus.length
      }
    });
  } catch (err) {
    console.error("List available Gurus error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve Gurus at the moment.",
      data: null
    });
  }
}

module.exports = {
  createApplication,
  getMyApplication,
  updateMyApplication,
  commitActivationFee,
  getMyProfile,
  setupAccount,
  listPromoterApplications,
  approvePromoterApplication,
  activatePendingPromoter,
  rejectPromoterApplication,
  getDashboardSummary,
  getReferralInfo,
  getInvitePromotersReferralLink,
  getReferralStats,
  getAttachedPromoters,
  getGuruReferralSignupsPromoters,
  getPromoterPerformance,
  getPromoterDetails,
  getPromoterCharts,
  getPromoterStats,
  getPromoterHistory,
  exportPromotersCsv,
  exportPerformanceCsv,
  getMyRewards,
  listAvailableGurus,
};
