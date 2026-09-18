const pool = require("../db");
const NetworkScopeService = require("../services/networkScope.service");
const PlatformLedgerService = require("../services/platformLedger.service");

/**
 * GET /api/network-managers/dashboard/summary
 * Network Manager only; scope enforced by req.user.id as network_manager_id.
 */
async function getDashboardSummary(req, res) {
  try {
    const networkManagerId = req.user.id;
    const counts = await NetworkScopeService.getSummaryCounts(networkManagerId);
    const commission_total = await PlatformLedgerService.getNetworkManagerCommissionTotal(
      networkManagerId
    );
    return res.status(200).json({
      error: false,
      data: {
        gurus_count: counts.gurus_count,
        promoters_count: counts.promoters_count,
        tickets_sold_total: counts.tickets_sold_total,
        commission_total,
        active_gurus_count: counts.active_gurus_count ?? 0,
      },
    });
  } catch (err) {
    console.error("Network dashboard summary error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to load dashboard summary.",
      data: null,
    });
  }
}

/**
 * GET /api/network-managers/dashboard/gurus
 * List gurus in scope; per guru: guru_id, name, promoters_count, tickets_sold, commission_total, status, joined_at.
 * status: 'active' when users.guru_active is true, else 'inactive'.
 */
async function getDashboardGurus(req, res) {
  try {
    const networkManagerId = req.user.id;
    const guruIds = await NetworkScopeService.getGuruIdsForNetworkManager(networkManagerId);
    if (guruIds.length === 0) {
      return res.status(200).json({ error: false, data: { gurus: [] } });
    }

    const commissionByGuru = await PlatformLedgerService.getGuruCommissionTotalsByGuru(guruIds);

    const result = await pool.query(
      `SELECT
         gnm.guru_user_id AS guru_id,
         u.name,
         COALESCE(u.guru_active, FALSE) AS guru_active,
         gnm.assigned_at AS joined_at,
         (SELECT COUNT(DISTINCT pgl.promoter_user_id)::int
          FROM promoter_guru_links pgl
          WHERE pgl.guru_user_id = gnm.guru_user_id) AS promoters_count,
         (SELECT COALESCE(SUM(e.tickets_sold), 0)::bigint
          FROM events e
          WHERE e.guru_id = gnm.guru_user_id AND e.network_manager_id = $1) AS tickets_sold
       FROM guru_network_manager gnm
       JOIN users u ON u.id = gnm.guru_user_id
       WHERE gnm.network_manager_user_id = $1
       ORDER BY u.name`,
      [networkManagerId]
    );

    const gurus = result.rows.map((row) => {
      const ticketsSold = parseInt(row.tickets_sold, 10) || 0;
      const commissionTotal = commissionByGuru[row.guru_id] || 0;
      const status = row.guru_active ? "active" : "inactive";
      return {
        guru_id: row.guru_id,
        name: row.name || "",
        promoters_count: row.promoters_count || 0,
        tickets_sold: ticketsSold,
        commission_total: commissionTotal,
        status,
        joined_at: row.joined_at ? row.joined_at.toISOString() : null,
      };
    });

    return res.status(200).json({ error: false, data: { gurus } });
  } catch (err) {
    console.error("Network dashboard gurus list error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to load gurus.",
      data: null,
    });
  }
}

/**
 * GET /api/network-managers/dashboard/gurus/:guruId/promoters
 * Scope check: guru must belong to this NM. Return promoters under that guru.
 */
async function getDashboardGuruPromoters(req, res) {
  try {
    const networkManagerId = req.user.id;
    const guruId = parseInt(req.params.guruId, 10);
    if (isNaN(guruId) || guruId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid guru ID.",
        data: null,
      });
    }

    const inScope = await NetworkScopeService.isGuruInScope(networkManagerId, guruId);
    if (!inScope) {
      return res.status(403).json({
        error: true,
        message: "You do not have access to this guru.",
        data: null,
      });
    }

    const result = await pool.query(
      `SELECT
         pgl.promoter_user_id AS promoter_id,
         u.name,
         (SELECT COALESCE(SUM(e.tickets_sold), 0)::bigint
          FROM events e
          WHERE e.promoter_id = pgl.promoter_user_id AND e.guru_id = $1) AS tickets_sold,
         (SELECT COALESCE(SUM(o.total_amount), 0)::bigint
          FROM orders o
          JOIN events e ON e.id = o.event_id AND e.promoter_id = pgl.promoter_user_id AND e.guru_id = $1
          WHERE o.status = 'confirmed') AS gross_sales_basic,
         (SELECT COALESCE(SUM(gc.total_commission), 0)::bigint
          FROM guru_commissions gc
          WHERE gc.promoter_id = pgl.promoter_user_id AND gc.guru_id = $1) AS commission_contribution
       FROM promoter_guru_links pgl
       JOIN users u ON u.id = pgl.promoter_user_id
       WHERE pgl.guru_user_id = $1
       ORDER BY u.name`,
      [guruId]
    );

    const promoters = result.rows.map((row) => ({
      promoter_id: row.promoter_id,
      name: row.name || "",
      tickets_sold: parseInt(row.tickets_sold, 10) || 0,
      gross_sales_basic: parseInt(row.gross_sales_basic, 10) || 0,
      commission_contribution: parseInt(row.commission_contribution, 10) || 0,
    }));

    return res.status(200).json({ error: false, data: { promoters } });
  } catch (err) {
    console.error("Network dashboard guru promoters error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to load promoters.",
      data: null,
    });
  }
}

function escapeCsvCell(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function exportGurusCsv(req, res) {
  try {
    const networkManagerId = req.user.id;
    const guruIds = await NetworkScopeService.getGuruIdsForNetworkManager(networkManagerId);
    const commissionByGuru =
      guruIds.length > 0
        ? await PlatformLedgerService.getGuruCommissionTotalsByGuru(guruIds)
        : {};

    const result =
      guruIds.length > 0
        ? await pool.query(
            `SELECT gnm.guru_user_id AS guru_id, u.name, COALESCE(u.guru_active, FALSE) AS guru_active, gnm.assigned_at AS joined_at,
              (SELECT COUNT(DISTINCT pgl.promoter_user_id)::int FROM promoter_guru_links pgl WHERE pgl.guru_user_id = gnm.guru_user_id) AS promoters_count,
              (SELECT COALESCE(SUM(e.tickets_sold), 0)::bigint FROM events e WHERE e.guru_id = gnm.guru_user_id AND e.network_manager_id = $1) AS tickets_sold
             FROM guru_network_manager gnm
             JOIN users u ON u.id = gnm.guru_user_id
             WHERE gnm.network_manager_user_id = $1
             ORDER BY u.name`,
            [networkManagerId]
          )
        : { rows: [] };

    const header = "guru_id,name,status,promoters_count,tickets_sold,commission_total,joined_at\n";
    const rows = result.rows.map((r) => {
      const status = r.guru_active ? "active" : "inactive";
      const ticketsSold = parseInt(r.tickets_sold, 10) || 0;
      const commission = commissionByGuru[r.guru_id] || 0;
      const joinedAt = r.joined_at ? r.joined_at.toISOString() : "";
      return `${r.guru_id},${escapeCsvCell(r.name)},${status},${r.promoters_count || 0},${ticketsSold},${commission},${joinedAt}`;
    });
    const csv = header + rows.join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="gurus.csv"');
    return res.send(csv);
  } catch (err) {
    console.error("Export gurus CSV error:", err);
    return res.status(500).json({
      error: true,
      message: "Export failed.",
      data: null,
    });
  }
}

async function exportPromotersCsv(req, res) {
  try {
    const networkManagerId = req.user.id;
    const guruIds = await NetworkScopeService.getGuruIdsForNetworkManager(networkManagerId);
    if (guruIds.length === 0) {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="promoters.csv"');
      return res.send("promoter_id,guru_id,name,tickets_sold,gross_sales_basic,commission_contribution\n");
    }

    const placeholders = guruIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query(
      `SELECT pgl.promoter_user_id AS promoter_id, pgl.guru_user_id AS guru_id, u.name,
        (SELECT COALESCE(SUM(e.tickets_sold), 0)::bigint FROM events e WHERE e.promoter_id = pgl.promoter_user_id AND e.guru_id = pgl.guru_user_id) AS tickets_sold,
        (SELECT COALESCE(SUM(o.total_amount), 0)::bigint FROM orders o JOIN events e ON e.id = o.event_id AND e.promoter_id = pgl.promoter_user_id AND e.guru_id = pgl.guru_user_id WHERE o.status = 'confirmed') AS gross_sales_basic,
        (SELECT COALESCE(SUM(gc.total_commission), 0)::bigint FROM guru_commissions gc WHERE gc.promoter_id = pgl.promoter_user_id AND gc.guru_id = pgl.guru_user_id) AS commission_contribution
       FROM promoter_guru_links pgl
       JOIN users u ON u.id = pgl.promoter_user_id
       WHERE pgl.guru_user_id IN (${placeholders})
       ORDER BY pgl.guru_user_id, u.name`,
      guruIds
    );

    const header =
      "promoter_id,guru_id,name,tickets_sold,gross_sales_basic,commission_contribution\n";
    const rows = result.rows.map((r) =>
      [
        r.promoter_id,
        r.guru_id,
        escapeCsvCell(r.name),
        r.tickets_sold || 0,
        r.gross_sales_basic || 0,
        r.commission_contribution || 0,
      ].join(",")
    );
    const csv = header + rows.join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="promoters.csv"');
    return res.send(csv);
  } catch (err) {
    console.error("Export promoters CSV error:", err);
    return res.status(500).json({
      error: true,
      message: "Export failed.",
      data: null,
    });
  }
}

async function exportCommissionsCsv(req, res) {
  try {
    const networkManagerId = req.user.id;
    const guruIds = await NetworkScopeService.getGuruIdsForNetworkManager(networkManagerId);
    if (guruIds.length === 0) {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="commissions.csv"');
      return res.send(
        "allocation_type,beneficiary_id,beneficiary_type,amount,created_at\n"
      );
    }

    const result = await pool.query(
      `SELECT la.allocation_type, la.beneficiary_id, la.beneficiary_type, la.amount, la.created_at
       FROM ledger_allocations la
       WHERE la.allocation_type IN ('guru_commission', 'network_manager_cash')
         AND (
           (la.beneficiary_type = 'network_manager' AND la.beneficiary_id = $1)
           OR (la.beneficiary_type = 'guru' AND la.beneficiary_id = ANY($2::bigint[]))
         )
       ORDER BY la.created_at DESC`,
      [networkManagerId, guruIds]
    );

    const header = "allocation_type,beneficiary_id,beneficiary_type,amount,created_at\n";
    const rows = result.rows.map((r) =>
      [
        escapeCsvCell(r.allocation_type),
        r.beneficiary_id,
        r.beneficiary_type,
        r.amount,
        r.created_at,
      ].join(",")
    );
    const csv = header + rows.join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="commissions.csv"');
    return res.send(csv);
  } catch (err) {
    console.error("Export commissions CSV error:", err);
    return res.status(500).json({
      error: true,
      message: "Export failed.",
      data: null,
    });
  }
}

module.exports = {
  getDashboardSummary,
  getDashboardGurus,
  getDashboardGuruPromoters,
  exportGurusCsv,
  exportPromotersCsv,
  exportCommissionsCsv,
};
