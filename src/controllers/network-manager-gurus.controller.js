const pool = require("../db");
const GuruService = require("../services/guru.service");
const GuruMetricsService = require("../services/guruMetrics.service");
const NetworkScopeService = require("../services/networkScope.service");
const NetworkManagerAuditService = require("../services/networkManagerAudit.service");

/**
 * My Gurus - Licence-scoped guru list and actions
 * GET /api/network-managers/licences/:licenceId/gurus
 */
async function listGurus(req, res) {
  try {
    const { licenceId } = req;
    const licence = req.licence;
    const nmId = licence.user_id;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();
    const levelFilter = req.query.level; // L1, L2, L3
    const statusFilter = req.query.status; // active, inactive, at_risk
    // dateRange: MTD, last90, quarter, YTD - reserved for future filter
    const sort = req.query.sort || "ticket_volume"; // ticket_volume, refund_rate, risk_score, newest

    const params = [licenceId, nmId];
    const conditions = [
      `(gnm.network_licence_id = $1 OR (gnm.network_licence_id IS NULL AND gnm.network_manager_user_id = $2))`,
    ];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.id::text = $${params.length})`
      );
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM guru_network_manager gnm
       JOIN users u ON u.id = gnm.guru_user_id
       WHERE ${conditions.join(" AND ")}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total, 10) || 0;

    const guruIdsResult = await pool.query(
      `SELECT gnm.guru_user_id
       FROM guru_network_manager gnm
       JOIN users u ON u.id = gnm.guru_user_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY gnm.assigned_at DESC`,
      params
    );
    const guruIds = guruIdsResult.rows.map((r) => r.guru_user_id);

    if (guruIds.length === 0) {
      const recruitedCount = total;
      const l3Progress = 0;
      return res.json({
        error: false,
        message: "Gurus retrieved.",
        data: {
          kpi: {
            total_gurus: 0,
            active_gurus: 0,
            gurus_l1: 0,
            gurus_l2: 0,
            gurus_l3: 0,
            territory_settled_tickets_month: 0,
            territory_settled_tickets_quarter: 0,
            territory_refund_rate_quarter_percent: 0,
            l3_gurus_progress: `${l3Progress}/16`,
            recruited_guru_count: recruitedCount,
            eligible_for_replacement: recruitedCount >= 25,
          },
          gurus: [],
          pagination: { page, limit, total, totalPages: 0 },
        },
      });
    }

    const rollups = {};
    for (const gid of guruIds) {
      const r = await GuruMetricsService.getRollupForGuru(gid, licenceId);
      if (r) rollups[gid] = r;
    }

    const levelsResult = await pool.query(
      `SELECT gl.guru_id, gl.level
       FROM guru_levels gl
       WHERE gl.guru_id = ANY($1::bigint[]) AND gl.effective_until IS NULL`,
      [guruIds]
    );
    const levelByGuru = {};
    levelsResult.rows.forEach((r) => {
      levelByGuru[r.guru_id] = `L${r.level}`;
    });

    const usersResult = await pool.query(
      `SELECT id, name, email, guru_active, created_at
       FROM users WHERE id = ANY($1::bigint[])`,
      [guruIds]
    );
    const userByGuru = {};
    usersResult.rows.forEach((r) => {
      userByGuru[r.id] = r;
    });

    const gnmResult = await pool.query(
      `SELECT guru_user_id, assigned_at FROM guru_network_manager WHERE guru_user_id = ANY($1::bigint[])`,
      [guruIds]
    );
    const assignedAtByGuru = {};
    gnmResult.rows.forEach((r) => {
      assignedAtByGuru[r.guru_user_id] = r.assigned_at;
    });

    let gurus = guruIds.map((gid) => {
      const u = userByGuru[gid];
      const rollup = rollups[gid];
      const level = levelByGuru[gid] || "L1";
      const isActive = u?.guru_active ?? false;
      const riskLevel = rollup?.risk_level || "low";
      let status = isActive ? "active" : "inactive";
      if (isActive && riskLevel === "high") status = "at_risk";

      return {
        guru_user_id: gid,
        name: u?.name || "",
        email: u?.email || "",
        joined_at: assignedAtByGuru[gid]?.toISOString() || null,
        level,
        settled_tickets_mtd: rollup?.settled_tickets_mtd || 0,
        settled_tickets_90d: rollup?.settled_tickets_90d || 0,
        settled_tickets_quarter: rollup?.settled_tickets_quarter || 0,
        settled_tickets_ytd: rollup?.settled_tickets_ytd || 0,
        refunds_quarter: rollup?.refunds_quarter || 0,
        refund_rate_quarter_percent: parseFloat(rollup?.refund_rate_quarter_percent || 0),
        risk_score: rollup?.risk_score || 0,
        risk_level: riskLevel,
        risk_reasons: rollup?.risk_reasons || [],
        active_promoters_count: rollup?.active_promoters_count || 0,
        last_settlement_at: rollup?.last_settlement_at?.toISOString() || null,
        is_active: isActive,
        status,
      };
    });

    if (levelFilter) {
      const lv = levelFilter.toUpperCase();
      if (["L1", "L2", "L3"].includes(lv)) {
        gurus = gurus.filter((g) => g.level === lv);
      }
    }
    if (statusFilter) {
      const st = statusFilter.toLowerCase();
      if (["active", "inactive", "at_risk"].includes(st)) {
        gurus = gurus.filter((g) => g.status === st);
      }
    }

    const sortFns = {
      ticket_volume: (a, b) => (b.settled_tickets_quarter || 0) - (a.settled_tickets_quarter || 0),
      refund_rate: (a, b) =>
        (b.refund_rate_quarter_percent || 0) - (a.refund_rate_quarter_percent || 0),
      risk_score: (a, b) => (b.risk_score || 0) - (a.risk_score || 0),
      newest: (a, b) => new Date(b.joined_at || 0) - new Date(a.joined_at || 0),
    };
    gurus.sort(sortFns[sort] || sortFns.ticket_volume);

    const paginated = gurus.slice(offset, offset + limit);

    const activeCount = gurus.filter((g) => g.is_active).length;
    const l1Count = gurus.filter((g) => g.level === "L1").length;
    const l2Count = gurus.filter((g) => g.level === "L2").length;
    const l3Count = gurus.filter((g) => g.level === "L3").length;
    const territorySettledMonth = gurus.reduce((s, g) => s + (g.settled_tickets_mtd || 0), 0);
    const territorySettledQuarter = gurus.reduce((s, g) => s + (g.settled_tickets_quarter || 0), 0);
    const territoryRefundsQuarter = gurus.reduce((s, g) => s + (g.refunds_quarter || 0), 0);
    const totalSettledForRate =
      territorySettledQuarter + territoryRefundsQuarter || 1;
    const territoryRefundRateQuarter =
      (territoryRefundsQuarter / totalSettledForRate) * 100;

    return res.json({
      error: false,
      message: "Gurus retrieved.",
      data: {
        kpi: {
          total_gurus: gurus.length,
          active_gurus: activeCount,
          gurus_l1: l1Count,
          gurus_l2: l2Count,
          gurus_l3: l3Count,
          territory_settled_tickets_month: territorySettledMonth,
          territory_settled_tickets_quarter: territorySettledQuarter,
          territory_refund_rate_quarter_percent: territoryRefundRateQuarter,
          l3_gurus_progress: `${l3Count}/16`,
          recruited_guru_count: gurus.length,
          eligible_for_replacement: gurus.length >= 25,
        },
        gurus: paginated,
        pagination: {
          page,
          limit,
          total: gurus.length,
          totalPages: Math.ceil(gurus.length / limit),
        },
      },
    });
  } catch (err) {
    console.error("List gurus error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve gurus.",
      data: null,
    });
  }
}

/**
 * GET /api/network-managers/licences/:licenceId/gurus/:guruId
 */
async function getGuruDetail(req, res) {
  try {
    const guruId = parseInt(req.params.guruId, 10);
    if (isNaN(guruId) || guruId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid guru ID.",
        data: null,
      });
    }

    const inScope = await pool.query(
      `SELECT 1 FROM guru_network_manager gnm
       WHERE gnm.guru_user_id = $1
         AND (gnm.network_licence_id = $2 OR (gnm.network_licence_id IS NULL AND gnm.network_manager_user_id = $3))`,
      [guruId, req.licenceId, req.licence.user_id]
    );
    if (inScope.rowCount === 0) {
      return res.status(403).json({
        error: true,
        message: "You do not have access to this guru.",
        data: null,
      });
    }

    const userResult = await pool.query(
      `SELECT id, name, email, guru_active, avatar_url, created_at
       FROM users WHERE id = $1`,
      [guruId]
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "Guru not found.",
        data: null,
      });
    }
    const user = userResult.rows[0];

    const levelInfo = await GuruService.getCurrentLevel(guruId);
    const level = levelInfo?.level ? `L${levelInfo.level}` : "L1";
    const serviceFeeRate = levelInfo?.service_fee_rate ?? 0.2;

    const rollup = await GuruMetricsService.getRollupForGuru(guruId, req.licenceId);
    const status = user.guru_active
      ? (rollup?.risk_level === "high" ? "at_risk" : "active")
      : "inactive";

    const promotersResult = await pool.query(
      `SELECT pgl.promoter_user_id, u.name
       FROM promoter_guru_links pgl
       JOIN users u ON u.id = pgl.promoter_user_id
       WHERE pgl.guru_user_id = $1`,
      [guruId]
    );

    const SettledTicketService = require("../services/settledTicket.service");
    const promoterMetrics = await Promise.all(
      promotersResult.rows.map(async (p) => {
        const settled = await SettledTicketService.countSettledTicketsForPromoterInGuruNetwork(
          p.promoter_user_id,
          guruId
        );
        const refunds = await SettledTicketService.countRefundedTicketsForPromoterInGuruNetwork(
          p.promoter_user_id,
          guruId
        );
        const refRate =
          settled + refunds > 0 ? (refunds / (settled + refunds)) * 100 : 0;
        return {
          promoter_id: p.promoter_user_id,
          name: p.name,
          settled_tickets_quarter: settled,
          refund_rate_quarter_percent: refRate,
        };
      })
    );

    const eventsResult = await pool.query(
      `SELECT e.id, e.title, e.start_at, e.completion_status, e.settlement_status
       FROM events e
       WHERE e.guru_id = $1
       ORDER BY e.start_at DESC
       LIMIT 50`,
      [guruId]
    );

    const notesResult = await pool.query(
      `SELECT id, note_text, category, created_by, created_at
       FROM guru_notes
       WHERE guru_id = $1 AND (network_licence_id = $2 OR network_licence_id IS NULL)
       ORDER BY created_at DESC
       LIMIT 50`,
      [guruId, req.licenceId]
    );

    const flagsResult = await pool.query(
      `SELECT id, reason, category, created_by, created_at, resolved_at
       FROM guru_flags
       WHERE guru_id = $1 AND (network_licence_id = $2 OR network_licence_id IS NULL)
       ORDER BY created_at DESC
       LIMIT 50`,
      [guruId, req.licenceId]
    );

    return res.json({
      error: false,
      message: "Guru detail retrieved.",
      data: {
        guru: {
          guru_user_id: guruId,
          name: user.name,
          email: user.email,
          avatar_url: user.avatar_url,
          level,
          service_fee_rate: parseFloat(serviceFeeRate),
          status,
          is_active: user.guru_active,
          joined_at: user.created_at?.toISOString?.() || null,
        },
        metrics: {
          settled_tickets_mtd: rollup?.settled_tickets_mtd || 0,
          settled_tickets_90d: rollup?.settled_tickets_90d || 0,
          settled_tickets_ytd: rollup?.settled_tickets_ytd || 0,
          refunds_quarter: rollup?.refunds_quarter || 0,
          refund_rate_quarter_percent: parseFloat(rollup?.refund_rate_quarter_percent || 0),
          risk_level: rollup?.risk_level || "low",
          risk_reasons: rollup?.risk_reasons || [],
          active_promoters_count: rollup?.active_promoters_count || 0,
        },
        promoters: promoterMetrics,
        events: eventsResult.rows.map((e) => ({
          id: e.id,
          title: e.title,
          start_at: e.start_at?.toISOString?.() || null,
          status:
            e.completion_status === "completed"
              ? "settled"
              : e.completion_status === "pending"
              ? "pending_settlement"
              : "concluded",
        })),
        notes: notesResult.rows,
        flags: flagsResult.rows,
      },
    });
  } catch (err) {
    console.error("Guru detail error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve guru detail.",
      data: null,
    });
  }
}

/**
 * POST /api/network-managers/licences/:licenceId/gurus/:guruId/notes
 */
async function addNote(req, res) {
  try {
    const guruId = parseInt(req.params.guruId, 10);
    if (isNaN(guruId) || guruId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid guru ID.",
        data: null,
      });
    }

    const inScope = await NetworkScopeService.isGuruInScope(req.licence.user_id, guruId);
    if (!inScope) {
      return res.status(403).json({
        error: true,
        message: "You do not have access to this guru.",
        data: null,
      });
    }

    const { note_text, category, attachments } = req.body || {};
    if (!note_text || typeof note_text !== "string") {
      return res.status(400).json({
        error: true,
        message: "note_text is required.",
        data: null,
      });
    }
    const validCategories = ["Performance", "Refund risk", "Compliance", "Support"];
    const cat = validCategories.includes(category) ? category : "Support";

    const result = await pool.query(
      `INSERT INTO guru_notes (guru_id, network_licence_id, note_text, category, attachments, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, note_text, category, created_by, created_at`,
      [guruId, req.licenceId, note_text.trim(), cat, JSON.stringify(attachments || []), req.user.id]
    );

    await NetworkManagerAuditService.logAction({
      actorUserId: req.user.id,
      action: "guru_note_add",
      resource: "guru_note",
      resourceId: result.rows[0].id,
      afterSnapshot: { guru_id: guruId, note_text: note_text.trim(), category: cat },
      ip: req.ip || req.headers?.["x-forwarded-for"] || req.connection?.remoteAddress,
      userAgent: req.headers?.["user-agent"],
    });

    return res.status(201).json({
      error: false,
      message: "Note added.",
      data: { note: result.rows[0] },
    });
  } catch (err) {
    console.error("Add note error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to add note.",
      data: null,
    });
  }
}

/**
 * POST /api/network-managers/licences/:licenceId/gurus/:guruId/flags
 */
async function addFlag(req, res) {
  try {
    const guruId = parseInt(req.params.guruId, 10);
    if (isNaN(guruId) || guruId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid guru ID.",
        data: null,
      });
    }

    const inScope = await NetworkScopeService.isGuruInScope(req.licence.user_id, guruId);
    if (!inScope) {
      return res.status(403).json({
        error: true,
        message: "You do not have access to this guru.",
        data: null,
      });
    }

    const { reason, category } = req.body || {};
    if (!reason || typeof reason !== "string") {
      return res.status(400).json({
        error: true,
        message: "reason is required.",
        data: null,
      });
    }
    const validCategories = ["Performance", "Refund risk", "Compliance", "Support"];
    const cat = validCategories.includes(category) ? category : null;

    const result = await pool.query(
      `INSERT INTO guru_flags (guru_id, network_licence_id, reason, category, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, reason, category, created_by, created_at`,
      [guruId, req.licenceId, reason.trim(), cat, req.user.id]
    );

    await NetworkManagerAuditService.logAction({
      actorUserId: req.user.id,
      action: "guru_flag_add",
      resource: "guru_flag",
      resourceId: result.rows[0].id,
      afterSnapshot: { guru_id: guruId, reason: reason.trim(), category: cat },
      ip: req.ip || req.headers?.["x-forwarded-for"] || req.connection?.remoteAddress,
      userAgent: req.headers?.["user-agent"],
    });

    return res.status(201).json({
      error: false,
      message: "Flag added.",
      data: { flag: result.rows[0] },
    });
  } catch (err) {
    console.error("Add flag error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to add flag.",
      data: null,
    });
  }
}

/**
 * POST /api/network-managers/licences/:licenceId/gurus/:guruId/replacement-requests
 */
async function createReplacementRequest(req, res) {
  try {
    const guruId = parseInt(req.params.guruId, 10);
    if (isNaN(guruId) || guruId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid guru ID.",
        data: null,
      });
    }

    const recruitedResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM guru_network_manager gnm
       WHERE (gnm.network_licence_id = $1 OR (gnm.network_licence_id IS NULL AND gnm.network_manager_user_id = $2))`,
      [req.licenceId, req.licence.user_id]
    );
    const recruitedCount = recruitedResult.rows[0]?.cnt || 0;
    if (recruitedCount < 25) {
      return res.status(403).json({
        error: true,
        message: "Replacement requests are only available once you have recruited 25 or more gurus.",
        data: { recruited_guru_count: recruitedCount, eligible_for_replacement: false },
      });
    }

    const inScope = await NetworkScopeService.isGuruInScope(req.licence.user_id, guruId);
    if (!inScope) {
      return res.status(403).json({
        error: true,
        message: "You do not have access to this guru.",
        data: null,
      });
    }

    const { reason, evidence_notes, attachments } = req.body || {};
    if (!reason || typeof reason !== "string") {
      return res.status(400).json({
        error: true,
        message: "reason is required.",
        data: null,
      });
    }

    const result = await pool.query(
      `INSERT INTO guru_replacement_requests
         (guru_id, network_licence_id, requested_by, reason, evidence_notes, attachments, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id, guru_id, status, reason, created_at`,
      [
        guruId,
        req.licenceId,
        req.user.id,
        reason.trim(),
        evidence_notes || null,
        JSON.stringify(attachments || []),
      ]
    );

    await NetworkManagerAuditService.logAction({
      actorUserId: req.user.id,
      action: "replacement_request_create",
      resource: "guru_replacement_request",
      resourceId: result.rows[0].id,
      afterSnapshot: { guru_id: guruId, reason: reason.trim(), status: "pending" },
      ip: req.ip || req.headers?.["x-forwarded-for"] || req.connection?.remoteAddress,
      userAgent: req.headers?.["user-agent"],
    });

    return res.status(201).json({
      error: false,
      message: "Replacement request submitted.",
      data: { replacement_request: result.rows[0] },
    });
  } catch (err) {
    console.error("Create replacement request error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to create replacement request.",
      data: null,
    });
  }
}

/**
 * GET /api/network-managers/licences/:licenceId/replacement-requests
 */
async function listReplacementRequests(req, res) {
  try {
    const result = await pool.query(
      `SELECT grr.id, grr.guru_id, grr.reason, grr.status, grr.created_at, grr.reviewed_at, grr.admin_notes,
              u.name as guru_name
       FROM guru_replacement_requests grr
       JOIN users u ON u.id = grr.guru_id
       WHERE grr.network_licence_id = $1 OR (grr.network_licence_id IS NULL AND grr.requested_by = $2)
       ORDER BY grr.created_at DESC`,
      [req.licenceId, req.licence.user_id]
    );

    return res.json({
      error: false,
      message: "Replacement requests retrieved.",
      data: { replacement_requests: result.rows },
    });
  } catch (err) {
    console.error("List replacement requests error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve replacement requests.",
      data: null,
    });
  }
}

module.exports = {
  listGurus,
  getGuruDetail,
  addNote,
  addFlag,
  createReplacementRequest,
  listReplacementRequests,
};
