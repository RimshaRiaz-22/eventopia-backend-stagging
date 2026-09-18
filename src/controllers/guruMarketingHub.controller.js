const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");

/**
 * Get Marketing Hub Content Structure
 * GET /gurus/marketing-hub
 */
async function getMarketingHub(req, res) {
  try {
    const guruId = req.user.id;

    // Check if Guru is active
    const guruResult = await pool.query(
      `SELECT role, account_status FROM users WHERE id = $1`,
      [guruId]
    );

    if (guruResult.rowCount === 0 || guruResult.rows[0].role !== 'guru') {
      return fail(res, req, 403, "ACCESS_DENIED", "Only active Gurus can access Marketing Hub");
    }

    // Get guru's current level for conditional content
    const levelResult = await pool.query(
      `SELECT level FROM guru_levels WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [guruId]
    );

    const currentLevel = levelResult.rowCount > 0 ? parseInt(levelResult.rows[0].level) : 1;

    // Structure the marketing hub content
    const marketingHub = {
      sections: [
        {
          id: 'referral_toolkit',
          title: 'Referral Toolkit',
          description: 'Tools to recruit and manage your promoter network',
          icon: 'people-outline',
          available: true,
          subsections: [
            {
              id: 'referral_link',
              title: 'Your Referral Link',
              description: 'Share your unique link to recruit promoters'
            },
            {
              id: 'messaging',
              title: 'Referral Messaging',
              description: 'Pre-written scripts and talking points'
            },
            {
              id: 'explainers',
              title: 'Explainer Visuals',
              description: 'Videos and graphics explaining the promoter role'
            }
          ]
        },
        {
          id: 'content_submissions',
          title: 'Content Submissions',
          description: 'Upload and submit marketing assets for review',
          icon: 'document-outline',
          available: true,
          subsections: [
            {
              id: 'submit_content',
              title: 'Submit New Content',
              description: 'Upload images, videos, or copy'
            },
            {
              id: 'submission_status',
              title: 'Submission Status',
              description: 'Track your pending and approved submissions'
            },
            {
              id: 'approved_assets',
              title: 'Approved Assets',
              description: 'Download and use approved marketing materials'
            }
          ]
        },
        {
          id: 'leaderboard',
          title: 'Performance & Leaderboard',
          description: 'See your standing and compete with other Gurus',
          icon: 'podium-outline',
          available: true,
          subsections: [
            {
              id: 'leaderboard',
              title: 'Top Performers',
              description: 'Leaderboard of highest performing Gurus'
            },
            {
              id: 'level_progress',
              title: 'Your Level Progress',
              description: 'Track your progress towards next level'
            },
            {
              id: 'metrics',
              title: 'Your Metrics',
              description: 'Tickets sold, commissions, and performance data'
            }
          ]
        },
        {
          id: 'campaign_requests',
          title: 'Custom Campaign Requests',
          description: 'Request custom assets and strategy help (monetised)',
          icon: 'flash-outline',
          available: true,
          subsections: [
            {
              id: 'create_request',
              title: 'Create Request',
              description: 'Submit a custom campaign request'
            },
            {
              id: 'my_requests',
              title: 'My Requests',
              description: 'Track your campaign requests and credits used'
            }
          ]
        }
      ],
      specialFeatures: [
        {
          id: 'sprint_mode',
          title: 'Sprint Mode (Level 3 Push)',
          description: 'Accelerated progression when you reach Level 2',
          available: currentLevel >= 2,
          level_required: 2,
          details: {
            rolling_window: '90 days',
            ticket_target: 'Dynamic based on current performance',
            benefits: 'Fast-tracked to Level 3 with cash withdrawal privileges'
          }
        }
      ],
      currentLevel,
      nextLevelRequirements: {
        level: currentLevel + 1,
        description: currentLevel === 1 ? 'Earn through event ticket sales and referrals' :
                     currentLevel === 2 ? 'Enter Sprint Mode for Level 3 push' :
                     'Maximum Level reached'
      }
    };

    return ok(res, req, "Marketing Hub structure retrieved", marketingHub);
  } catch (err) {
    console.error('Get marketing hub error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve marketing hub");
  }
}

/**
 * Get Onboarding Checklist
 * GET /gurus/onboarding/checklist
 */
async function getOnboardingChecklist(req, res) {
  try {
    const guruId = req.user.id;

    // Get guru profile and application status
    const guruResult = await pool.query(
      `SELECT u.name, u.account_status, ga.account_status as app_status
       FROM users u
       LEFT JOIN guru_applications ga ON ga.user_id = u.id
       WHERE u.id = $1`,
      [guruId]
    );

    if (guruResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Guru not found");
    }

    const guru = guruResult.rows[0];

    // Check completion status for each item
    const referral = await pool.query(
      `SELECT referral_code FROM referral_codes WHERE user_id = $1 LIMIT 1`,
      [guruId]
    );

    const submissions = await pool.query(
      `SELECT COUNT(*) as count FROM guru_content_submissions WHERE guru_user_id = $1`,
      [guruId]
    );

    const promoters = await pool.query(
      `SELECT COUNT(*) as count FROM promoter_guru_links WHERE guru_user_id = $1`,
      [guruId]
    );

    const checklist = {
      completionPercentage: 0,
      items: [
        {
          id: 'referral_setup',
          title: 'Get your referral link or code',
          description: 'Access your unique referral link to recruit promoters',
          completed: referral.rowCount > 0,
          order: 1,
          actionUrl: '/marketing-hub/referral',
          estimatedTime: '2 minutes'
        },
        {
          id: 'review_hub',
          title: 'Review Marketing Hub sections and toolkits',
          description: 'Explore content submission, messaging, and explainer resources',
          completed: false, // Tracked by frontend view tracking
          order: 2,
          actionUrl: '/marketing-hub',
          estimatedTime: '10 minutes'
        },
        {
          id: 'review_performance',
          title: 'Review performance and level framework',
          description: 'Understand how you progress through levels and earn commissions',
          completed: false, // Tracked by frontend view tracking
          order: 3,
          actionUrl: '/dashboard/performance',
          estimatedTime: '5 minutes'
        },
        {
          id: 'start_recruitment',
          title: 'Start recruitment activity',
          description: 'Recruit your first promoter or submit marketing content',
          completed: promoters.rowCount > 0 || submissions.rowCount > 0,
          order: 4,
          actionUrl: '/marketing-hub/recruitment',
          estimatedTime: 'Your pace'
        }
      ]
    };

    // Calculate completion percentage
    const completedItems = checklist.items.filter(item => item.completed).length;
    checklist.completionPercentage = Math.round((completedItems / checklist.items.length) * 100);

    return ok(res, req, "Onboarding checklist retrieved", checklist);
  } catch (err) {
    console.error('Get onboarding checklist error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve checklist");
  }
}

/**
 * Submit Content for Marketing Hub Review
 * POST /gurus/marketing-hub/submissions
 */
async function submitContent(req, res) {
  try {
    const guruId = req.user.id;
    const { title, description, content_type, content_url, tags } = req.body;

    if (!title || !content_type) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Title and content_type are required");
    }

    if (!['image', 'video', 'copy', 'social_post'].includes(content_type)) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid content_type");
    }

    // Create submission
    const result = await pool.query(
      `INSERT INTO guru_content_submissions
       (guru_user_id, title, description, content_type, content_url, tags, status, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_review', NOW())
       RETURNING *`,
      [guruId, title, description || null, content_type, content_url || null, tags ? JSON.stringify(tags) : null]
    );

    const submission = result.rows[0];

    return ok(res, req, "Content submitted for review", {
      submissionId: submission.id,
      status: submission.status,
      submittedAt: submission.submitted_at,
      estimatedReviewTime: '2-3 business days',
      nextSteps: 'Your submission will be reviewed by our marketing team. You can track status below.'
    }, 201);
  } catch (err) {
    console.error('Submit content error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to submit content");
  }
}

/**
 * Get My Content Submissions
 * GET /gurus/marketing-hub/submissions
 */
async function getMySubmissions(req, res) {
  try {
    const guruId = req.user.id;
    const { status } = req.query;

    let query = `SELECT * FROM guru_content_submissions WHERE guru_user_id = $1`;
    const params = [guruId];

    if (status) {
      query += ` AND status = $2`;
      params.push(status);
    }

    query += ` ORDER BY submitted_at DESC`;

    const result = await pool.query(query, params);

    const submissions = result.rows.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description,
      contentType: s.content_type,
      contentUrl: s.content_url,
      status: s.status,
      submittedAt: s.submitted_at,
      reviewedAt: s.reviewed_at,
      reviewedBy: s.reviewed_by,
      rejectionReason: s.rejection_reason,
      sharedAt: s.shared_at,
      shared: !!s.shared_at,
      tags: s.tags ? JSON.parse(s.tags) : []
    }));

    const summary = {
      total: submissions.length,
      pending: submissions.filter(s => s.status === 'pending_review').length,
      approved: submissions.filter(s => s.status === 'approved').length,
      rejected: submissions.filter(s => s.status === 'rejected').length
    };

    return ok(res, req, "Submissions retrieved", {
      summary,
      submissions
    });
  } catch (err) {
    console.error('Get submissions error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve submissions");
  }
}

/**
 * Request Custom Campaign
 * POST /gurus/marketing-hub/campaign-requests
 */
async function requestCampaign(req, res) {
  try {
    const guruId = req.user.id;
    const { title, description, asset_type, target_audience, estimated_credits_needed } = req.body;

    if (!title || !asset_type) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Title and asset_type are required");
    }

    // Create campaign request
    const result = await pool.query(
      `INSERT INTO guru_campaign_requests
       (guru_user_id, title, description, asset_type, target_audience, estimated_credits_needed, status, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
       RETURNING *`,
      [guruId, title, description || null, asset_type, target_audience || null, estimated_credits_needed || 0]
    );

    const request = result.rows[0];

    return ok(res, req, "Campaign request submitted", {
      requestId: request.id,
      status: request.status,
      estimatedCreditsNeeded: request.estimated_credits_needed,
      requestedAt: request.requested_at
    }, 201);
  } catch (err) {
    console.error('Request campaign error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to request campaign");
  }
}

/**
 * Get My Campaign Requests
 * GET /gurus/marketing-hub/campaign-requests
 */
async function getMyCampaignRequests(req, res) {
  try {
    const guruId = req.user.id;

    const result = await pool.query(
      `SELECT * FROM guru_campaign_requests WHERE guru_user_id = $1 ORDER BY requested_at DESC`,
      [guruId]
    );

    const requests = result.rows.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      assetType: r.asset_type,
      targetAudience: r.target_audience,
      estimatedCreditsNeeded: r.estimated_credits_needed,
      status: r.status,
      requestedAt: r.requested_at,
      completedAt: r.completed_at,
      creditsUsed: r.credits_used || 0
    }));

    return ok(res, req, "Campaign requests retrieved", requests);
  } catch (err) {
    console.error('Get campaign requests error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve campaign requests");
  }
}

/**
 * Get Guru Leaderboard
 * GET /gurus/leaderboard
 */
async function getLeaderboard(req, res) {
  try {
    const { period = 'month', limit = 10 } = req.query;

    // Define date range
    let dateFilter = "DATE_TRUNC('month', e.completed_at) = DATE_TRUNC('month', NOW())";
    if (period === 'all_time') {
      dateFilter = "1=1";
    } else if (period === 'year') {
      dateFilter = "DATE_TRUNC('year', e.completed_at) = DATE_TRUNC('year', NOW())";
    }

    // Get top performing gurus
    const result = await pool.query(
      `SELECT
        u.id,
        u.name,
        u.avatar_url,
        COUNT(DISTINCT pgl.promoter_user_id) as promoters_count,
        SUM(CAST(o.total_amount AS INTEGER)) as gross_sales,
        COUNT(t.id) as tickets_sold,
        gl.level,
        RANK() OVER (ORDER BY COUNT(t.id) DESC) as rank
      FROM users u
      LEFT JOIN promoter_guru_links pgl ON pgl.guru_user_id = u.id
      LEFT JOIN users promoters ON promoters.id = pgl.promoter_user_id
      LEFT JOIN orders o ON o.user_id = promoters.id
      LEFT JOIN tickets t ON t.order_id = o.id
      LEFT JOIN events e ON e.id = t.event_id
      LEFT JOIN (
        SELECT user_id, MAX(CAST(level AS INTEGER)) as level
        FROM guru_levels
        GROUP BY user_id
      ) gl ON gl.user_id = u.id
      WHERE u.role = 'guru' AND ${dateFilter}
      GROUP BY u.id, u.name, u.avatar_url, gl.level
      ORDER BY tickets_sold DESC
      LIMIT $1`,
      [parseInt(limit)]
    );

    const leaderboard = result.rows.map((row, index) => ({
      rank: index + 1,
      guruId: row.id,
      name: row.name,
      avatarUrl: row.avatar_url,
      level: row.level || 1,
      promotersCount: parseInt(row.promoters_count) || 0,
      ticketsSold: parseInt(row.tickets_sold) || 0,
      grossSales: parseInt(row.gross_sales) || 0,
      commissionEarned: Math.floor((parseInt(row.gross_sales) || 0) * 0.08) // 8% commission example
    }));

    return ok(res, req, "Leaderboard retrieved", {
      period,
      leaderboard,
      generatedAt: new Date()
    });
  } catch (err) {
    console.error('Get leaderboard error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve leaderboard");
  }
}

/**
 * Get Guru Level Information
 * GET /gurus/levels/info
 */
async function getLevelInfo(req, res) {
  try {
    const guruId = req.user.id;

    // Get current guru level
    const levelResult = await pool.query(
      `SELECT level, achieved_at FROM guru_levels WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [guruId]
    );

    const currentLevel = levelResult.rowCount > 0 ? parseInt(levelResult.rows[0].level) : 1;

    // Get performance metrics
    const metricsResult = await pool.query(
      `SELECT
        COUNT(DISTINCT t.id) as tickets_sold,
        SUM(CAST(o.total_amount AS INTEGER)) as gross_sales,
        COUNT(DISTINCT pgl.promoter_user_id) as promoters_count
      FROM promoter_guru_links pgl
      LEFT JOIN users promoters ON promoters.id = pgl.promoter_user_id
      LEFT JOIN orders o ON o.user_id = promoters.id
      LEFT JOIN tickets t ON t.order_id = o.id
      WHERE pgl.guru_user_id = $1`,
      [guruId]
    );

    const metrics = metricsResult.rows[0] || {};

    const levelFramework = {
      currentLevel,
      levels: [
        {
          level: 1,
          title: 'Level 1: Base Guru',
          description: 'Entry-level guru with base licensing',
          licenseType: 'Base Licence',
          serviceFee: '£250 activation fee',
          features: [
            'Access to promoters',
            'Basic referral tools',
            'Marketing Hub access',
            'Commission tracking'
          ],
          requirements: 'Complete registration and activation fee',
          achieved: currentLevel >= 1,
          achievedAt: levelResult.rowCount > 0 && currentLevel >= 1 ? levelResult.rows[0].achieved_at : null
        },
        {
          level: 2,
          title: 'Level 2: Advanced Guru',
          description: 'Achieved through performance',
          licenseType: 'Base Licence (Enhanced)',
          serviceFee: 'Cleared from earned credit',
          features: [
            'All Level 1 features',
            'Priority promoter support',
            'Advanced analytics',
            'Custom campaign eligibility',
            'Sprint Mode access'
          ],
          requirements: 'Earn through event ticket sales and referrals',
          targetMetrics: {
            ticketsSold: 50,
            grossSales: 5000
          },
          currentMetrics: {
            ticketsSold: parseInt(metrics.tickets_sold) || 0,
            grossSales: parseInt(metrics.gross_sales) || 0
          },
          achieved: currentLevel >= 2,
          achievedAt: levelResult.rowCount > 0 && currentLevel >= 2 ? levelResult.rows[0].achieved_at : null,
          percentToNext: currentLevel < 2 ? Math.min(100, Math.round((parseInt(metrics.tickets_sold) || 0) / 50 * 100)) : 0
        },
        {
          level: 3,
          title: 'Level 3: Master Guru',
          description: 'Peak performance with all privileges',
          licenseType: 'Enhanced Licence ($)',
          serviceFee: 'Premium tier',
          features: [
            'All Level 2 features',
            'Cash withdrawal privileges',
            'Premium analytics dashboard',
            'Dedicated support',
            'Featured on platform',
            'Co-marketing opportunities'
          ],
          requirements: 'Push through Sprint Mode from Level 2 (90-day rolling window)',
          targetMetrics: {
            ticketsSold: 150,
            sprintWindowTarget: 'Dynamic based on performance'
          },
          currentMetrics: {
            ticketsSold: parseInt(metrics.tickets_sold) || 0,
            promotersCount: parseInt(metrics.promoters_count) || 0
          },
          achieved: currentLevel >= 3,
          achievedAt: levelResult.rowCount > 0 && currentLevel >= 3 ? levelResult.rows[0].achieved_at : null,
          sprintModeAvailable: currentLevel >= 2,
          percentToNext: currentLevel < 3 && currentLevel >= 2 ? Math.min(100, Math.round((parseInt(metrics.tickets_sold) || 0) / 150 * 100)) : 0
        }
      ]
    };

    return ok(res, req, "Level information retrieved", levelFramework);
  } catch (err) {
    console.error('Get level info error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve level information");
  }
}

/**
 * Get Sprint Mode Information (Level 2+ only)
 * GET /gurus/sprint-mode
 */
async function getSprintMode(req, res) {
  try {
    const guruId = req.user.id;

    // Check current level
    const levelResult = await pool.query(
      `SELECT level FROM guru_levels WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [guruId]
    );

    const currentLevel = levelResult.rowCount > 0 ? parseInt(levelResult.rows[0].level) : 1;

    if (currentLevel < 2) {
      return fail(res, req, 403, "LEVEL_REQUIREMENT", "Sprint Mode available only for Level 2+ Gurus");
    }

    // Get or create sprint mode record
    let sprintResult = await pool.query(
      `SELECT * FROM guru_sprint_mode WHERE guru_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [guruId]
    );

    let sprint = null;

    if (sprintResult.rowCount === 0) {
      // Create new sprint mode entry
      const createResult = await pool.query(
        `INSERT INTO guru_sprint_mode
         (guru_user_id, window_start, window_end, status, created_at)
         VALUES ($1, NOW(), NOW() + INTERVAL '90 days', 'active', NOW())
         RETURNING *`,
        [guruId]
      );
      sprint = createResult.rows[0];
    } else {
      sprint = sprintResult.rows[0];
    }

    // Get current performance during sprint window
    const performanceResult = await pool.query(
      `SELECT
        COUNT(DISTINCT t.id) as tickets_sold,
        SUM(CAST(o.total_amount AS INTEGER)) as gross_sales
      FROM promoter_guru_links pgl
      LEFT JOIN users promoters ON promoters.id = pgl.promoter_user_id
      LEFT JOIN orders o ON o.user_id = promoters.id AND o.created_at >= $1
      LEFT JOIN tickets t ON t.order_id = o.id
      WHERE pgl.guru_user_id = $2`,
      [sprint.window_start, guruId]
    );

    const performance = performanceResult.rows[0] || {};

    const sprintMode = {
      status: sprint.status,
      windowStart: sprint.window_start,
      windowEnd: sprint.window_end,
      daysRemaining: Math.ceil((new Date(sprint.window_end) - new Date()) / (1000 * 60 * 60 * 24)),
      ticketTarget: 'Dynamic based on current average',
      currentPerformance: {
        ticketsSold: parseInt(performance.tickets_sold) || 0,
        grossSales: parseInt(performance.gross_sales) || 0,
        percentOfTarget: currentLevel === 2 ? Math.round((parseInt(performance.tickets_sold) || 0) / 100 * 100) : 0
      },
      benefits: [
        'Fast-tracked progression to Level 3',
        'Unlock cash withdrawal privileges',
        'Premium analytics during sprint',
        'Dedicated sprint support'
      ],
      nextMilestone: {
        ticketsNeeded: Math.max(0, 100 - (parseInt(performance.tickets_sold) || 0)),
        daysRemaining: Math.ceil((new Date(sprint.window_end) - new Date()) / (1000 * 60 * 60 * 24))
      }
    };

    return ok(res, req, "Sprint mode information retrieved", sprintMode);
  } catch (err) {
    console.error('Get sprint mode error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve sprint mode information");
  }
}

module.exports = {
  getMarketingHub,
  getOnboardingChecklist,
  submitContent,
  getMySubmissions,
  requestCampaign,
  getMyCampaignRequests,
  getLeaderboard,
  getLevelInfo,
  getSprintMode
};
