const pool = require("../db");
const { revokeAllUserSessions } = require("../services/session.service");
const NetworkManagerApplicationService = require("../services/networkManagerApplication.service");
const GuruService = require("../services/guru.service");
const ReferralService = require("../services/referral.service");
const TerritoryLicenceService = require("../services/territoryLicence.service");

/**
 * Submit Network Manager Application without full authentication
 * Used when user registers but can't login yet (has NULL role)
 * Also works for authenticated Network Manager applicants
 * POST /network-managers/applications/submit
 */
async function submitApplicationWithoutAuth(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // If user is authenticated, use their data; otherwise get from body (top-level or applicant_profile)
    const userId = req.user?.id;
    const {
      territory_name,
      territory_id,
      reservation_id,
      applicant_profile,
      docs,
      avatarUrl,
    } = req.body;

    const emailFromBody = req.body.email || (applicant_profile && applicant_profile.email);
    const email = userId ? req.user.email : emailFromBody;
    const nameFromBody = req.body.name || (applicant_profile && applicant_profile.name);

    // Validation
    if (!email && !userId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Email is required (send in body or in applicant_profile.email).",
        data: null,
      });
    }

    const useNewFlow =
      territory_id !== undefined && territory_id !== null && String(territory_id).trim() !== "";
    if (!useNewFlow && !territory_name) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Territory name or territory_id is required.",
        data: null,
      });
    }

    // Find user by email (or use authenticated user)
    let user;
    if (userId) {
      const userResult = await client.query(
        "SELECT * FROM users WHERE id = $1",
        [userId]
      );

      if (userResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: true,
          message: "User not found.",
          data: null,
        });
      }

      user = userResult.rows[0];
    } else {
      const userResult = await client.query(
        "SELECT * FROM users WHERE email = $1",
        [email.toLowerCase()]
      );

      if (userResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: true,
          message: "User not found. Please register first.",
          data: null,
        });
      }

      user = userResult.rows[0];
    }

    // Allow only users who are in the NM applicant flow: role null (just registered) or network_manager_applicant
    const isApplicant = user.role === null || user.role === undefined || user.role === "network_manager_applicant";
    if (!isApplicant) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "This endpoint is only for Network Manager applicants. Use the account you used when registering as a Network Manager (account with no role yet).",
        data: null,
      });
    }

    // Name is required: user must have it or provide it in this request
    const hasValidExistingName = user.name && typeof user.name === "string" && user.name.trim().length >= 2;
    const providedName = nameFromBody && typeof nameFromBody === "string" ? nameFromBody.trim() : null;
    const effectiveName = hasValidExistingName ? user.name.trim() : (providedName && providedName.length >= 2 ? providedName : null);

    if (!effectiveName || effectiveName.length < 2) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Name is required for Network Manager registration and must be at least 2 characters long.",
        data: { name: nameFromBody || null },
      });
    }

    // Update user name if they provided it and they didn't already have a valid one
    if (!hasValidExistingName && effectiveName) {
      await client.query(
        "UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2",
        [effectiveName, user.id]
      );
      user.name = effectiveName;
    }

    if (useNewFlow) {
      try {
        const { application: applicationRow, isNew } = await NetworkManagerApplicationService.submitApplication(
          client,
          {
            userId: user.id,
            territory_id: territory_id ? parseInt(territory_id, 10) : null,
            reservation_id: reservation_id ? parseInt(reservation_id, 10) : null,
            territory_name: territory_name || null,
            applicant_profile: applicant_profile || null,
            docs: docs || null,
            avatar_url: avatarUrl,
          }
        );
        var application = applicationRow;
        if (avatarUrl) {
          await client.query(
            "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
            [avatarUrl, user.id]
          );
        }
        if (isNew) {
          await client.query(
            "INSERT INTO wallets (user_id, balance_amount, currency) VALUES ($1, 0, 'GBP') ON CONFLICT (user_id) DO NOTHING",
            [user.id]
          );
          await client.query(
            `INSERT INTO invoices (user_id, description, amount, currency, status, invoice_type, related_entity_type, related_entity_id)
             VALUES ($1, 'Territory fee', 250000, 'GBP', 'pending', 'fee', 'network_manager_application', $2)`,
            [user.id, application.id]
          );
        }
        await client.query(
          "UPDATE users SET account_status = 'pending', updated_at = NOW() WHERE id = $1",
          [user.id]
        );
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.message === "TERRITORY_NOT_FOUND") {
          return res.status(404).json({ error: true, message: "Territory not found.", data: null });
        }
        if (err.message === "RESERVATION_INVALID") {
          return res.status(400).json({ error: true, message: "Reservation expired or invalid.", data: null });
        }
        if (err.message === "RESERVATION_TERRITORY_MISMATCH") {
          return res.status(400).json({ error: true, message: "Reservation does not match territory.", data: null });
        }
        if (err.message === "APPLICATION_ALREADY_SUBMITTED") {
          return res.status(409).json({
            error: true,
            message: "You already have a Network Manager application. Please check your application status.",
            data: null,
          });
        }
        if (err.message === "ALREADY_LICENSED_FOR_TERRITORY") {
          return res.status(400).json({
            error: true,
            message: "You already hold an active licence for this territory. Cannot submit another application.",
            data: null,
          });
        }
        throw err;
      }
    } else {
      const existingApp = await client.query(
        "SELECT id FROM network_manager_applications WHERE user_id = $1",
        [user.id]
      );
      if (existingApp.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: true,
          message: "You already have a Network Manager application. Please check your application status.",
          data: null,
        });
      }
      if (avatarUrl) {
        await client.query(
          "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
          [avatarUrl, user.id]
        );
      }
      const appResult = await client.query(
        `INSERT INTO network_manager_applications
           (user_id, territory_name, avatar_url, account_status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING *`,
        [user.id, territory_name, avatarUrl || null]
      );
      var application = appResult.rows[0];

      await client.query(
        "INSERT INTO wallets (user_id, balance_amount, currency) VALUES ($1, 0, 'GBP') ON CONFLICT (user_id) DO NOTHING",
        [user.id]
      );
      await client.query(
        `INSERT INTO invoices (user_id, description, amount, currency, status, invoice_type, related_entity_type, related_entity_id)
         VALUES ($1, 'Territory fee', 250000, 'GBP', 'pending', 'fee', 'network_manager_application', $2)`,
        [user.id, application.id]
      );
      await client.query(
        "UPDATE users SET account_status = 'pending', updated_at = NOW() WHERE id = $1",
        [user.id]
      );
    }

    await client.query("COMMIT");

    return res.status(201).json({
      error: false,
      message: "Network Manager application submitted successfully. It is pending approval. You will be able to login after admin approval.",
      data: {
        application: {
          id: application.id,
          territoryId: application.territory_id || null,
          reservationId: application.reservation_id || null,
          territoryName: application.territory_name,
          avatarUrl: application.avatar_url,
          accountStatus: application.account_status,
          createdAt: application.created_at,
        },
        invoice: {
          description: "Territory fee",
          amount: 2500,
          currency: "GBP",
          status: "pending",
        },
        user: {
          email: user.email,
          name: user.name,
        },
        nextStep: "Please wait for admin approval. You will be notified when your application is approved and you can login.",
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Submit Network Manager application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to submit application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

function mapUserForResponse(user) {
  const { id, user_no, ...rest } = user;

  return {
    userId: user_no ?? id, // ✅ public small id (falls back if null)
    ...Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [
        key.replace(/_/g, "-"),
        value,
      ])
    ),
    "user-no": user_no, // optional: keep it if frontend already uses it
  };
}


async function setupAccount(req, res) {
  try {
    const { fullName } = req.body;

    if (
      !fullName ||
      typeof fullName !== "string" ||
      fullName.trim().length === 0
    ) {
      return res.status(400).json({
        error: true,
        message: "Full name is required to complete account setup.",
        data: { fullName: fullName || null },
      });
    }

    const trimmedName = fullName.trim();

    if (trimmedName.length < 2) {
      return res.status(400).json({
        error: true,
        message: "Full name must be at least 2 characters long.",
        data: { fullName: trimmedName },
      });
    }

    // Check if account is already set up
    if (req.user.name) {
      return res.status(400).json({
        error: true,
        message: "Your account has already been set up.",
        data: { fullName: req.user.name },
      });
    }

    // Update user's name
    const userResult = await pool.query(
      `
      UPDATE users
      SET name = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [trimmedName, req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    const updatedUser = userResult.rows[0];

    return res.json({
      error: false,
      message: "Your account has been set up successfully.",
      data: {
        user: {
          ...mapUserForResponse(updatedUser),
          role: updatedUser.role,
        },
        setupCompleted: true,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message:
        "Unable to complete account setup at the moment. Please try again later.",
      data: null,
    });
  }
}


/**
 * Create Network Manager application
 * POST /network-managers/applications
 */
async function createApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { territory_name, avatarUrl, name } = req.body;
    const userId = req.user.id;

    // Name is required
    const hasValidExistingName = req.user.name && typeof req.user.name === "string" && req.user.name.trim().length >= 2;
    const providedName = name && typeof name === "string" ? name.trim() : null;
    const effectiveName = hasValidExistingName ? req.user.name.trim() : (providedName && providedName.length >= 2 ? providedName : null);

    if (!effectiveName || effectiveName.length < 2) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Name is required for Network Manager registration and must be at least 2 characters long.",
        data: { name: name || null },
      });
    }

    // Update user name if they provided it and didn't already have a valid one
    if (!hasValidExistingName && effectiveName) {
      await client.query(
        "UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2",
        [effectiveName, userId]
      );
    }

    // Validation
    if (!territory_name) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Territory name is required.",
        data: null,
      });
    }

    // Verify territory exists using GeoNames (optional validation)
    // Since territories are fetched from GeoNames, we accept any valid territory name
    // You can add additional validation here if needed
    if (!territory_name || territory_name.trim().length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Territory name is required.",
        data: null,
      });
    }

    // Check if user already has an application
    const existingApp = await client.query(
      "SELECT id FROM network_manager_applications WHERE user_id = $1",
      [userId]
    );

    if (existingApp.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: true,
        message: "You already have a Network Manager application. Please check your application status.",
        data: null,
      });
    }

    // Update user's avatar if provided
    if (avatarUrl) {
      await client.query(
        "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
        [avatarUrl, userId]
      );
    }

    // Create Network Manager application
    const appResult = await client.query(
      `
      INSERT INTO network_manager_applications 
        (user_id, territory_name, avatar_url, account_status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING *
      `,
      [userId, territory_name, avatarUrl || null]
    );

    const application = appResult.rows[0];

    // Create wallet for this user if it doesn't exist
    await client.query(
      `
      INSERT INTO wallets (user_id, balance_amount, currency)
      VALUES ($1, 0, 'GBP')
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId]
    );

    // Create opening invoice/ledger entry
    const invoiceAmount = 250000; // 2500 GBP in pence
    await client.query(
      `
      INSERT INTO invoices 
        (user_id, description, amount, currency, status, invoice_type, related_entity_type, related_entity_id)
      VALUES ($1, 'Territory fee', $2, 'GBP', 'pending', 'fee', 'network_manager_application', $3)
      `,
      [userId, invoiceAmount, application.id]
    );

    // Update user account_status to pending (if not already)
    await client.query(
      "UPDATE users SET account_status = 'pending', updated_at = NOW() WHERE id = $1",
      [userId]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      error: false,
      message: "Network Manager application submitted successfully. It is pending approval.",
      data: {
        application: {
          id: application.id,
          territoryName: application.territory_name,
          avatarUrl: application.avatar_url,
          accountStatus: application.account_status,
          createdAt: application.created_at,
        },
        invoice: {
          description: "Territory fee",
          amount: 2500,
          currency: "GBP",
          status: "pending",
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create Network Manager application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to submit application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * Update Network Manager application (for editing)
 * PATCH /network-managers/applications/me
 */
async function updateMyApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { territory_name, avatarUrl } = req.body;
    const userId = req.user.id;

    // Check if user has an application
    const existingApp = await client.query(
      "SELECT * FROM network_manager_applications WHERE user_id = $1",
      [userId]
    );

    if (existingApp.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: true,
        message: "No Network Manager application found. Please create one first.",
        data: null,
      });
    }

    const application = existingApp.rows[0];

    // Check if application is in a state that allows editing
    if (application.account_status === 'approved') {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Application has already been approved and cannot be edited.",
        data: null,
      });
    }

    if (application.account_status === 'rejected') {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Application has been rejected. Please contact support.",
        data: null,
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    if (territory_name !== undefined) {
      if (!territory_name || territory_name.trim().length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: true,
          message: "Territory name cannot be empty.",
          data: null,
        });
      }
      updateFields.push(`territory_name = $${paramCount++}`);
      updateValues.push(territory_name.trim());
    }

    if (avatarUrl !== undefined) {
      updateFields.push(`avatar_url = $${paramCount++}`);
      updateValues.push(avatarUrl);
    }

    updateFields.push(`updated_at = NOW()`);
    updateValues.push(application.id);

    // If territory changed, we might need to reset the application to pending
    if (territory_name !== undefined && territory_name !== application.territory_name) {
      updateFields.push(`account_status = 'pending'`);
      updateFields.push(`reviewed_at = NULL`);
      updateFields.push(`rejection_reason = NULL`);
    }

    // Update application
    const updatedResult = await client.query(
      `
      UPDATE network_manager_applications
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
      `,
      updateValues
    );

    const updatedApplication = updatedResult.rows[0];

    // Update user's avatar if provided
    if (avatarUrl !== undefined) {
      await client.query(
        "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
        [avatarUrl, userId]
      );
    }

    await client.query("COMMIT");

    return res.json({
      error: false,
      message: "Application updated successfully.",
      data: {
        application: {
          id: updatedApplication.id,
          territoryName: updatedApplication.territory_name,
          avatarUrl: updatedApplication.avatar_url,
          accountStatus: updatedApplication.account_status,
          createdAt: updatedApplication.created_at,
          updatedAt: updatedApplication.updated_at,
          reviewedAt: updatedApplication.reviewed_at,
          rejectionReason: updatedApplication.rejection_reason,
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update Network Manager application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to update application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

function mapApplicationToResponse(application) {
  const statusDisplay =
    application.account_status === "pending"
      ? application.reviewed_by
        ? "Under Review"
        : "Submitted"
      : application.account_status === "approved"
        ? "Approved"
        : application.account_status === "rejected"
          ? "Rejected"
          : application.account_status;
  return {
    id: application.id,
    territoryId: application.territory_id || null,
    reservationId: application.reservation_id || null,
    territoryName: application.territory_name,
    territoryDisplay: application.territory_region_name
      ? { name: application.territory_region_name, country: application.territory_country }
      : null,
    avatarUrl: application.avatar_url,
    accountStatus: application.account_status,
    statusDisplay,
    createdAt: application.created_at,
    reviewedAt: application.reviewed_at,
    rejectionReason: application.rejection_reason,
  };
}

/**
 * Get user's Network Manager application(s) - supports multiple (territory expansion)
 * GET /network-managers/applications/me
 */
async function getMyApplication(req, res) {
  try {
    const userId = req.user.id;
    const applications = await NetworkManagerApplicationService.getMyApplications(userId);

    const userResult = await pool.query(
      "SELECT email, name, account_status, email_status FROM users WHERE id = $1",
      [userId]
    );
    const userRow = userResult.rows[0] || {};

    const applicationsData = applications.map(mapApplicationToResponse);
    const primary = applications[0] || null;
    const primaryInvoice = primary
      ? await pool.query(
          `SELECT id, description, amount, currency, status, created_at
           FROM invoices WHERE user_id = $1 AND related_entity_type = 'network_manager_application' AND related_entity_id = $2
           ORDER BY created_at DESC LIMIT 1`,
          [userId, primary.id]
        )
      : { rows: [] };
    const inv = primaryInvoice.rows[0];

    return res.json({
      error: false,
      message: "Application(s) retrieved successfully.",
      data: {
        applications: applicationsData,
        application: applicationsData[0] || null,
        user: {
          email: userRow.email,
          name: userRow.name,
          accountStatus: userRow.account_status,
          emailStatus: userRow.email_status,
        },
        invoice: inv
          ? {
              id: inv.id,
              description: inv.description,
              amount: inv.amount / 100,
              currency: inv.currency,
              status: inv.status,
              createdAt: inv.created_at,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("Get Network Manager application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve application at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * List Guru applications for this Network Manager
 * GET /network-managers/gurus/applications
 * Query: status (optional), page (default 1), limit (default 20, max 100)
 */
async function listGuruApplications(req, res) {
  try {
    const networkManagerId = req.user.id;
    const { status, page: pageParam, limit: limitParam } = req.query;

    const page = Math.max(1, parseInt(pageParam, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitParam, 10) || 20));
    const offset = (page - 1) * limit;

    const baseWhere = `ga.network_manager_user_id = $1`;
    const statusCondition = status ? ` AND ga.account_status = $2` : "";
    const countValues = status ? [networkManagerId, status] : [networkManagerId];
    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM guru_applications ga
      JOIN users u ON u.id = ga.user_id
      WHERE ${baseWhere}${statusCondition}
    `;
    const countResult = await pool.query(countQuery, countValues);
    const total = countResult.rows[0].total;

    let query = `
      SELECT ga.id, ga.account_status, ga.created_at, ga.reviewed_at, ga.rejection_reason,
             ga.network_manager_user_id, ga.avatar_url,
             u.id as user_id, u.email, u.name, u.created_at as user_created_at,
             gnm.territory_name
      FROM guru_applications ga
      JOIN users u ON u.id = ga.user_id
      LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = ga.user_id
      WHERE ${baseWhere}${statusCondition}
      ORDER BY ga.created_at DESC
      LIMIT $${countValues.length + 1} OFFSET $${countValues.length + 2}
    `;
    const values = [...countValues, limit, offset];

    const result = await pool.query(query, values);

    const applications = result.rows.map(app => ({
      id: app.id,
      accountStatus: app.account_status,
      createdAt: app.created_at,
      reviewedAt: app.reviewed_at,
      rejectionReason: app.rejection_reason,
      avatarUrl: app.avatar_url,
      user: {
        id: app.user_id,
        email: app.email,
        name: app.name,
        createdAt: app.user_created_at,
      },
      territoryName: app.territory_name,
    }));

    return res.json({
      error: false,
      message: "Guru applications retrieved successfully.",
      data: {
        applications,
        count: applications.length,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    });
  } catch (err) {
    console.error("List Guru applications error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve Guru applications at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * List all Gurus for this Network Manager
 * GET /network-managers/gurus
 */
async function listGurus(req, res) {
  try {
    const networkManagerId = req.user.id;

    const result = await pool.query(
      `
      SELECT gnm.guru_user_id, gnm.territory_name, gnm.assigned_at,
             u.id, u.email, u.name, u.avatar_url, u.account_status
      FROM guru_network_manager gnm
      JOIN users u ON u.id = gnm.guru_user_id
      WHERE gnm.network_manager_user_id = $1
      ORDER BY gnm.assigned_at DESC
      `,
      [networkManagerId]
    );

    const gurus = result.rows.map(guru => ({
      userId: guru.user_id,
      email: guru.email,
      name: guru.name,
      avatarUrl: guru.avatar_url,
      accountStatus: guru.account_status,
      territory: {
        name: guru.territory_name,
      },
      assignedAt: guru.assigned_at,
    }));

    return res.json({
      error: false,
      message: "Gurus retrieved successfully.",
      data: {
        gurus,
        count: gurus.length,
      },
    });
  } catch (err) {
    console.error("List Gurus error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve Gurus at the moment. Please try again later.",
      data: null,
    });
  }
}

/**
 * Approve Guru application
 * POST /network-managers/gurus/:applicationId/approve
 */
async function approveGuruApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { applicationId } = req.params;
    const networkManagerId = req.user.id;

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

    // Verify the application belongs to this Network Manager
    if (application.network_manager_user_id !== networkManagerId) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: true,
        message: "You are not authorized to approve this application.",
        data: null,
      });
    }

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

    // Get this Network Manager's territory and first active licence
    const nmResult = await client.query(
      `
      SELECT u.id, u.name, u.city, gnm.territory_id,
             (SELECT tl.id FROM territory_licences tl
              WHERE tl.user_id = u.id AND tl.licence_status IN ('ACTIVE', 'CLEARED')
              ORDER BY tl.id LIMIT 1) AS network_licence_id
      FROM users u
      LEFT JOIN guru_network_manager gnm ON gnm.network_manager_user_id = u.id
      WHERE u.id = $1 AND u.role = 'network_manager'
      `,
      [networkManagerId]
    );

    if (nmResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({
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
      [networkManagerId, applicationId]
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
      [application.user_id, ratePerTicket, serviceFeeRate, networkManagerId]
    );

    // Create or update Guru-Network Manager relationship
    await client.query(
      `
      INSERT INTO guru_network_manager (guru_user_id, network_manager_user_id, territory_id, territory_name, network_licence_id, assigned_at, assigned_by)
      VALUES ($1, $2, $3, $4, $5, NOW(), $6)
      ON CONFLICT (guru_user_id)
      DO UPDATE SET
        network_manager_user_id = $2,
        territory_id = $3,
        territory_name = $4,
        network_licence_id = COALESCE($5, guru_network_manager.network_licence_id),
        assigned_at = NOW(),
        assigned_by = $6
      `,
      [application.user_id, networkManagerId, networkManager.territory_id || null, application.territory_name || null, networkManager.network_licence_id || null, networkManagerId]
    );

    await client.query("COMMIT");

    // Generate referral code (non-blocking)
    try {
      await ReferralService.createReferralCode(application.user_id);
    } catch (err) {
      // Referral code might already exist, continue
    }

    // Revoke all existing sessions for the user
    try {
      await revokeAllUserSessions(application.user_id, "role_assigned");
    } catch (sessionError) {
      console.error("Error revoking sessions:", sessionError);
    }

    return res.json({
      error: false,
      message: "Guru application approved successfully.",
      data: {
        application: {
          id: application.id,
          userId: application.user_id,
          accountStatus: "approved",
          reviewedAt: new Date(),
        },
        user: {
          userId: application.user_id,
          email: application.email,
          name: application.name,
          accountStatus: "active",
          role: "guru",
          rolesVersion: newRolesVersion,
        },
        networkManager: {
          id: networkManagerId,
          name: networkManager.name,
          territoryId: networkManager.territory_id,
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Approve Guru application error:", err);
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
 * Reject Guru application
 * POST /network-managers/gurus/:applicationId/reject
 */
async function rejectGuruApplication(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { applicationId } = req.params;
    const { rejection_reason } = req.body;
    const networkManagerId = req.user.id;

    if (!rejection_reason || rejection_reason.trim().length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Rejection reason is required.",
        data: null,
      });
    }

    // Get the application
    const appResult = await client.query(
      `
      SELECT ga.*, u.id as user_id, u.email
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

    // Verify the application belongs to this Network Manager
    if (application.network_manager_user_id !== networkManagerId) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: true,
        message: "You are not authorized to reject this application.",
        data: null,
      });
    }

    // Check if already approved
    if (application.account_status === "approved") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: true,
        message: "Cannot reject an already approved application.",
        data: null,
      });
    }

    // Update application status
    await client.query(
      `
      UPDATE guru_applications
      SET account_status = 'rejected',
          reviewed_by = $1,
          reviewed_at = NOW(),
          rejection_reason = $2,
          updated_at = NOW()
      WHERE id = $3
      `,
      [networkManagerId, rejection_reason.trim(), applicationId]
    );

    await client.query("COMMIT");

    return res.json({
      error: false,
      message: "Guru application rejected successfully.",
      data: {
        application: {
          id: application.id,
          userId: application.user_id,
          accountStatus: "rejected",
          rejectionReason: rejection_reason.trim(),
          reviewedAt: new Date(),
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Reject Guru application error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to reject application at the moment. Please try again later.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * List available Network Managers for Guru selection
 * Public endpoint - no authentication required
 * GET /api/network-managers/available
 */
async function listAvailableNetworkManagers(req, res) {
  try {
    // Get all active Network Managers
    const result = await pool.query(
      `
      SELECT
        u.id,
        u.name,
        u.email,
        u.avatar_url,
        u.city as territory_name,
        nm.territory_name as application_territory_name
      FROM users u
      LEFT JOIN network_manager_applications nm ON nm.user_id = u.id
      WHERE u.role = 'network_manager'
        AND u.account_status = 'active'
      ORDER BY u.name ASC
      `
    );

    const networkManagers = result.rows.map(nm => ({
      id: nm.id,
      name: nm.name || nm.email,
      avatarUrl: nm.avatar_url,
      territory: nm.application_territory_name || nm.territory_name
    }));

    return res.json({
      error: false,
      message: "Network Managers retrieved successfully.",
      data: {
        networkManagers,
        count: networkManagers.length
      }
    });
  } catch (err) {
    console.error("List available Network Managers error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve Network Managers at the moment.",
      data: null
    });
  }
}

/**
 * POST /api/network-managers/licences/:licenceId/pay (simulated payment)
 * Body: payment_provider (e.g. SIMULATED), payment_reference optional
 */
async function payLicence(req, res) {
  try {
    const licenceId = parseInt(req.params.licenceId, 10);
    if (isNaN(licenceId) || licenceId <= 0) {
      return res.status(400).json({ error: true, message: "Invalid licence ID.", data: null });
    }
    const { payment_reference } = req.body || {};
    const result = await TerritoryLicenceService.recordLicencePayment(
      licenceId,
      req.user.id,
      payment_reference || "SIMULATED"
    );
    return res.json({
      error: false,
      message: "Payment recorded. Licence balance cleared.",
      data: { amount_paid_pence: result.amount },
    });
  } catch (err) {
    if (err.message === "LICENCE_NOT_FOUND") {
      return res.status(404).json({ error: true, message: "Licence not found.", data: null });
    }
    if (err.message === "LICENCE_ALREADY_PAID") {
      return res.status(400).json({ error: true, message: "Licence is already paid.", data: null });
    }
    console.error("Pay licence error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to record payment.",
      data: null,
    });
  }
}

module.exports = {
  createApplication,
  getMyApplication,
  updateMyApplication,
  submitApplicationWithoutAuth,
  setupAccount,
  listGurus,
  listGuruApplications,
  approveGuruApplication,
  rejectGuruApplication,
  listAvailableNetworkManagers,
  payLicence,
};
