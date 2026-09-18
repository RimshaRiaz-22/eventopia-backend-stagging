const pool = require("../db");

/**
 * Require that the authenticated user (Network Manager) owns the territory licence.
 * Resolves licenceId from params and attaches licence + territory_id to req.
 */
async function requireLicenceAccess(req, res, next) {
  try {
    const licenceId = parseInt(req.params.licenceId, 10);
    if (isNaN(licenceId) || licenceId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid licence ID.",
        data: null,
      });
    }

    const result = await pool.query(
      `SELECT tl.id, tl.territory_id, tl.user_id, tl.licence_status,
              tli.region_name, tli.region_slug
       FROM territory_licences tl
       JOIN territory_licence_inventory tli ON tli.id = tl.territory_id
       WHERE tl.id = $1`,
      [licenceId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "Licence not found.",
        data: null,
      });
    }

    const licence = result.rows[0];
    if (licence.user_id !== req.user.id) {
      return res.status(403).json({
        error: true,
        message: "You do not have access to this licence.",
        data: null,
      });
    }

    req.licence = licence;
    req.licenceId = licenceId;
    req.territoryId = licence.territory_id;
    next();
  } catch (err) {
    console.error("Licence access middleware error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to verify licence access.",
      data: null,
    });
  }
}

module.exports = { requireLicenceAccess };
