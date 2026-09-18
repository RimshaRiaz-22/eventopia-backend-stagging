const pool = require("../db");
const bcrypt = require("bcryptjs");
const { ensurePromoterCreditWallet } = require("../services/promoterCreditWallet.service");
const { getWalletMeForUser } = require("../services/walletMe.service");
const { ensureShareableReferralLinkForPromoter } = require("../services/promoterReferral.service");

/**
 * Setup Promoter Account (complete profile)
 * PUT /promoters/setup-account
 */
async function setupAccount(req, res) {
  try {
    const userId = req.user.id;
    const { name, password, avatar_url } = req.body;

    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        error: true,
        message: "Full name is required",
        data: null,
      });
    }

    if (password && password.length < 8) {
      return res.status(400).json({
        error: true,
        message: "Password must be at least 8 characters long",
        data: null,
      });
    }

    // Check if user has promoter role
    if (req.user.role !== 'promoter') {
      return res.status(403).json({
        error: true,
        message: "This endpoint is only for Promoter users",
        data: null,
      });
    }

    // Prepare update fields
    const updateFields = ["name = $1", "updated_at = NOW()"];
    const updateValues = [name.trim()];
    let paramCount = 1;

    if (password) {
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      paramCount++;
      updateFields.push(`password_hash = $${paramCount}`);
      updateValues.push(passwordHash);
    }

    if (avatar_url) {
      paramCount++;
      updateFields.push(`avatar_url = $${paramCount}`);
      updateValues.push(avatar_url);
    }

    // Update user
    updateValues.push(userId);
    const result = await pool.query(
      `UPDATE users SET ${updateFields.join(", ")} WHERE id = $${paramCount + 1} RETURNING id, email, name, role, account_status`,
      updateValues
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
      message: "Promoter account setup completed successfully",
      data: {
        user: result.rows[0],
        setupRequired: false,
      },
    });
  } catch (err) {
    console.error("Setup promoter account error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to setup account at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * Create Promoter Application
 * POST /promoters/applications
 */
async function createApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      agreed_to_terms,
      agreed_to_promoter_agreement,
      agreed_to_activation_fee_terms,
      guru_user_id,
      avatar_url,
      full_name,
    } = req.body;
    const userId = req.user.id;

    // Validation
    if (!agreed_to_terms || !agreed_to_promoter_agreement || !agreed_to_activation_fee_terms) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "You must agree to the terms, promoter agreement, and activation fee terms.",
        data: null,
      });
    }

    // Check if user already has an application
    const existingApp = await client.query(
      "SELECT id, account_status FROM promoter_applications WHERE user_id = $1",
      [userId]
    );

    if (existingApp.rowCount > 0) {
      const existingAppStatus = existingApp.rows[0].account_status;
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: true,
        message: "You already have a promoter application. Please check your application status.",
        data: {
          applicationId: existingApp.rows[0].id,
          accountStatus: existingAppStatus
        },
      });
    }

    // Check if user is already an approved promoter (shouldn't happen, but safety check)
    const userCheck = await client.query(
      "SELECT role, account_status FROM users WHERE id = $1",
      [userId]
    );

    if (userCheck.rows[0]?.role === 'promoter' && userCheck.rows[0]?.account_status === 'active') {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "You are already an approved promoter.",
        data: null,
      });
    }

    // Get user's referral attribution (from guru_referral_code during registration)
    const attributionResult = await client.query(
      `SELECT guru_id FROM user_attributions WHERE user_id = $1 AND guru_id IS NOT NULL`,
      [userId]
    );

    let finalGuruId = guru_user_id;

    // If user has referral attribution, use that guru and lock it
    if (attributionResult.rowCount > 0) {
      finalGuruId = attributionResult.rows[0].guru_id;
      // Ensure guru_user_id from body matches the referred guru, or ignore body if referral exists
      if (guru_user_id && String(guru_user_id) !== String(finalGuruId)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: true,
          message: "You were referred by a specific Guru. Your Guru selection cannot be changed.",
          data: null,
        });
      }
    } else {
      // No referral - guru_user_id is required
      if (!guru_user_id) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: true,
          message: "Please select a Guru to proceed with your application.",
          data: null,
        });
      }
    }

    // Verify the Guru exists and has active role
    const guruResult = await client.query(
      `SELECT id, name, role, account_status
       FROM users
       WHERE id = $1 AND role = 'guru'`,
      [finalGuruId]
    );

    if (guruResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Invalid Guru selection. Please choose a valid Guru.",
        data: null,
      });
    }

    const guru = guruResult.rows[0];

    if (guru.account_status !== 'active') {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "The selected Guru is not active. Please choose another Guru.",
        data: null,
      });
    }

    // Create Guru-Promoter link (just like Guru creates link with Network Manager)
    // Only allow creating the link if user doesn't have one yet (first-time application)
    const existingLink = await client.query(
      `SELECT * FROM promoter_guru_links WHERE promoter_user_id = $1`,
      [userId]
    );

    if (existingLink.rowCount > 0) {
      const existingGuruId = existingLink.rows[0]?.guru_user_id;
      if (String(existingGuruId) !== String(finalGuruId)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: true,
          message: "A Guru relationship already exists for your account. Please contact support to make changes.",
          data: null,
        });
      }

      // Referral flow may pre-create promoter_guru_links; keep it and normalize metadata.
      await client.query(
        `UPDATE promoter_guru_links
         SET changed_at = NOW(),
             source = COALESCE(source, 'application')
         WHERE promoter_user_id = $1`,
        [userId]
      );
    } else {
      await client.query(
        `
        INSERT INTO promoter_guru_links (promoter_user_id, guru_user_id, source)
        VALUES ($1, $2, 'application')
        `,
        [userId, finalGuruId]
      );
    }

    // Get territory from Guru's Network Manager
    const territoryResult = await client.query(
      `SELECT gnm.territory_name
       FROM guru_network_manager gnm
       WHERE gnm.guru_user_id = $1`,
      [finalGuruId]
    );

    let territoryName = null;
    if (territoryResult.rowCount > 0) {
      territoryName = territoryResult.rows[0].territory_name;
    }

    // Update user's profile fields captured during application
    if (full_name && String(full_name).trim()) {
      await client.query(
        "UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2",
        [String(full_name).trim(), userId]
      );
    }
    if (avatar_url) {
      await client.query(
        "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
        [avatar_url, userId]
      );
    }

    // Create promoter application
    const appResult = await client.query(
      `
      INSERT INTO promoter_applications
        (user_id, guru_user_id, territory_name, avatar_url, agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms, account_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *
      `,
      [userId, finalGuruId, territoryName, avatar_url || null, agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms]
    );

    // Update user's account_status to pending_approval
    await client.query(
      `UPDATE users SET account_status = 'pending_approval', updated_at = NOW() WHERE id = $1`,
      [userId]
    );

    // Create promoter wallet
    await client.query(
      `INSERT INTO wallets (user_id, balance_amount, currency)
       VALUES ($1, 0, 'GBP')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    if (userCheck.rows[0]?.role === "promoter") {
      await ensurePromoterCreditWallet(client, userId);
    }

    // Create activation fee invoice
    const invoiceResult = await client.query(
      `INSERT INTO invoices (user_id, description, amount, currency, status, invoice_type, related_entity_type, related_entity_id)
       VALUES ($1, $2, $3, 'GBP', 'pending', 'fee', 'promoter_application', $4)
       RETURNING id`,
      [userId, 'Promoter activation fee', 8500, appResult.rows[0].id] // 85 GBP = 8500 pence
    );

    await client.query("COMMIT");

    const application = appResult.rows[0];

    return res.status(201).json({
      error: false,
      message: "Your promoter application has been submitted successfully. Please wait for approval.",
      data: {
        application: {
          id: application.id,
          accountStatus: application.account_status,
          guruId: finalGuruId,
          territoryName: territoryName,
          activationFee: 85,
          activationFeeInPence: 8500,
          invoiceId: invoiceResult.rows[0].id,
          currency: 'GBP'
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create promoter application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to submit promoter application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Get My Promoter Application
 * GET /promoters/applications/me
 */
async function getMyApplication(req, res) {
  try {
    const userId = req.user.id;

    // Get promoter application with Guru info
    const result = await pool.query(
      `SELECT pa.*, u.email, u.name, u.account_status as user_account_status,
              g.name as guru_name, gnm.territory_name as guru_territory
       FROM promoter_applications pa
       JOIN users u ON u.id = pa.user_id
       LEFT JOIN users g ON g.id = pa.guru_user_id
       LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = pa.guru_user_id
       WHERE pa.user_id = $1`,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "No promoter application found.",
        data: null,
      });
    }

    const application = result.rows[0];

    return res.json({
      error: false,
      message: "Promoter application retrieved successfully.",
      data: {
        application: {
          id: application.id,
          accountStatus: application.account_status,
          agreedToTerms: application.agreed_to_terms,
          agreedToPromoterAgreement: application.agreed_to_promoter_agreement,
          createdAt: application.created_at,
          reviewedAt: application.reviewed_at,
          rejectionReason: application.rejection_reason,
          guru: application.guru_user_id ? {
            id: application.guru_user_id,
            name: application.guru_name
          } : null,
          territoryName: application.guru_territory
        },
      },
    });
  } catch (err) {
    console.error("Get promoter application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve promoter application at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * Get My Promoter Profile (approved promoters or pending application)
 * GET /promoters/me
 */
async function getMyProfile(req, res) {
  try {
    const userId = req.user.id;

    // Check if user has a promoter application or is an approved promoter
    const userResult = await pool.query(
      `SELECT u.*, pa.id as application_id, pa.account_status as application_status,
              pgl.guru_user_id, gnm.territory_name,
              g.id as guru_id, g.name as guru_name, g.email as guru_email
       FROM users u
       LEFT JOIN promoter_applications pa ON pa.user_id = u.id
       LEFT JOIN promoter_guru_links pgl ON pgl.promoter_user_id = u.id
       LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = pgl.guru_user_id
       LEFT JOIN users g ON g.id = pgl.guru_user_id
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    const user = userResult.rows[0];

    // Check if user has promoter role OR has a pending promoter application
    const isApprovedPromoter = user.role === 'promoter' && user.account_status === 'active';
    const hasPendingApplication = user.application_id && user.application_status === 'pending';

    if (!isApprovedPromoter && !hasPendingApplication) {
      return res.status(403).json({
        error: true,
        message: "Promoter profile not found or account not approved.",
        data: null,
      });
    }

    const promoter = user;

    let credit = null;
    let referral = null;
    if (isApprovedPromoter) {
      const wr = await getWalletMeForUser(userId, ["promoter"]);
      if (wr.ok) {
        const b = wr.body.balances;
        credit = {
          projectedGbp: b.projected,
          confirmedGbp: b.confirmed,
          availableGbp: b.confirmed,
          netWithdrawableGbp: b.net_withdrawable,
          unlockStatus: wr.body.unlock_status,
        };
      } else {
        credit = {
          projectedGbp: 0,
          confirmedGbp: 0,
          availableGbp: 0,
          netWithdrawableGbp: 0,
          unlockStatus: null,
          walletUnavailable: true,
          reason: wr.code === "NO_WALLET" ? "no_credit_wallet" : "wallet_access_blocked",
        };
      }

      try {
        referral = await ensureShareableReferralLinkForPromoter(userId);
      } catch (e) {
        referral = null;
      }
    }

    return res.json({
      error: false,
      message: "Promoter profile retrieved successfully.",
      data: {
        profile: {
          userId: promoter.user_no ?? promoter.id,
          name: promoter.name,
          email: promoter.email,
          avatarUrl: promoter.avatar_url,
          role: promoter.role || 'buyer', // May be 'buyer' if pending
          accountStatus: promoter.account_status || (hasPendingApplication ? 'pending_approval' : 'active'),
          territory: {
            name: promoter.territory_name
          },
          guru: promoter.guru_id ? {
            id: promoter.guru_id,
            name: promoter.guru_name,
            email: promoter.guru_email
          } : null,
          application: hasPendingApplication ? {
            id: promoter.application_id,
            status: promoter.application_status
          } : null,
          credit,
          referral,
        },
      },
    });
  } catch (err) {
    console.error("Get promoter profile error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve promoter profile at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * Pay Activation Fee
 * POST /promoters/applications/:id/payments
 */
async function payActivationFee(req, res) {
  try {
    const { id: applicationId } = req.params;
    const userId = req.user.id;
    const { paymentMethod = 'card' } = req.body; // Default to card payment

    // Get application
    const appResult = await pool.query(
      `SELECT * FROM promoter_applications WHERE id = $1 AND user_id = $2`,
      [applicationId, userId]
    );

    if (appResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "Promoter application not found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Check if application is approved
    if (application.account_status !== 'approved') {
      return res.status(400).json({
        error: true,
        message: "Application must be approved before paying activation fee.",
        data: null,
      });
    }

    // Get the activation fee invoice
    const invoiceResult = await pool.query(
      `SELECT * FROM invoices
       WHERE related_entity_type = 'promoter_application'
         AND related_entity_id = $1
         AND invoice_type = 'fee'`,
      [applicationId]
    );

    if (invoiceResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "Activation fee invoice not found.",
        data: null,
      });
    }

    const invoice = invoiceResult.rows[0];

    // Check if already paid
    if (invoice.status === 'paid') {
      return res.status(400).json({
        error: true,
        message: "Activation fee has already been paid.",
        data: null,
      });
    }

    // Update invoice status to paid
    await pool.query(
      `UPDATE invoices
       SET status = 'paid', paid_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [invoice.id]
    );

    return res.json({
      error: false,
      message: "Activation fee paid successfully.",
      data: {
        applicationId: applicationId,
        invoiceId: invoice.id,
        paymentStatus: "paid",
        amount: invoice.amount,
        currency: invoice.currency,
        paidAt: new Date().toISOString(),
        paymentMethod: paymentMethod
      },
    });
  } catch (err) {
    console.error("Pay activation fee error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to process activation fee payment at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * Edit Promoter Application (before approval)
 * PATCH /promoters/applications/me
 */
async function editApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userId = req.user.id;
    const { agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms, avatar_url } = req.body;

    // Get existing application
    const appResult = await client.query(
      `SELECT * FROM promoter_applications WHERE user_id = $1`,
      [userId]
    );

    if (appResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "No promoter application found.",
        data: null,
      });
    }

    const application = appResult.rows[0];

    // Check if application is still pending (can only edit if pending)
    if (application.account_status !== 'pending') {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Application cannot be edited after review has started.",
        data: null,
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    if (agreed_to_terms !== undefined) {
      updateFields.push(`agreed_to_terms = $${paramCount++}`);
      updateValues.push(agreed_to_terms);
    }

    if (agreed_to_promoter_agreement !== undefined) {
      updateFields.push(`agreed_to_promoter_agreement = $${paramCount++}`);
      updateValues.push(agreed_to_promoter_agreement);
    }

    if (agreed_to_activation_fee_terms !== undefined) {
      updateFields.push(`agreed_to_activation_fee_terms = $${paramCount++}`);
      updateValues.push(agreed_to_activation_fee_terms);
    }

    if (avatar_url !== undefined) {
      updateFields.push(`avatar_url = $${paramCount++}`);
      updateValues.push(avatar_url);
      // Also update user's avatar
      await client.query(
        "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
        [avatar_url, userId]
      );
    }

    if (updateFields.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "No fields to update.",
        data: null,
      });
    }

    updateFields.push(`updated_at = NOW()`);
    updateValues.push(application.id);

    // Update application
    const result = await client.query(
      `UPDATE promoter_applications
       SET ${updateFields.join(', ')}
       WHERE id = $${paramCount + 1}
       RETURNING *`,
      updateValues
    );

    await client.query("COMMIT");

    const updatedApp = result.rows[0];

    return res.json({
      error: false,
      message: "Promoter application updated successfully.",
      data: {
        application: {
          id: updatedApp.id,
          accountStatus: updatedApp.account_status,
          agreedToTerms: updatedApp.agreed_to_terms,
          agreedToPromoterAgreement: updatedApp.agreed_to_promoter_agreement,
          agreedToActivationFeeTerms: updatedApp.agreed_to_activation_fee_terms,
          avatarUrl: updatedApp.avatar_url,
          updatedAt: updatedApp.updated_at
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Edit promoter application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to update promoter application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

module.exports = {
  setupAccount,
  createApplication,
  getMyApplication,
  getMyProfile,
  payActivationFee,
  editApplication,
};
