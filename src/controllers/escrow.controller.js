

const escrowService = require('../services/escrow.service');
const { ensurePromoterProfile } = require('../services/escrowLiability.service');
const payoutService = require('../services/escrowPayout.service');

class EscrowController {

  /**
   * CONTRACT 15: GET /api/v1/escrow/coverage/:territory_id
   * Returns live coverage ratio for a territory
   * Auth: JWT required | Role: finance, kings_account
   * 
   * @param {object} req - Express request
   * @param {object} res - Express response
   */
  async getCoverageRatio(req, res) {
    try {
      const { territory_id } = req.params;

      // Validate territory_id is a valid integer
      if (!territory_id || isNaN(territory_id)) {
        return res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'territory_id must be a valid integer'
        });
      }

      // Call service
      const coverage = await escrowService.getCoverageRatio(parseInt(territory_id));
      
      return res.status(200).json(coverage);

    } catch (error) {
      console.error('[EscrowController] getCoverageRatio error:', error.message);

      if (error.message === 'TERRITORY_NOT_FOUND') {
        return res.status(404).json({
          error: 'TERRITORY_NOT_FOUND',
          message: 'Territory not found.'
        });
      }

      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'Unable to load coverage data. Please refresh.'
      });
    }
  }

  /**
   * CONTRACT 16: GET /api/v1/promoter/finance/escrow
   * Returns promoter's personal escrow view
   * Auth: JWT required | Role: promoter (with ownership check)
   * Query params: promoter_id (optional, for finance/admin to view other promoters)
   * 
   * @param {object} req - Express request
   * @param {object} res - Express response
   */
  async getPromoterEscrowView(req, res) {
    try {
      const db = require('../db');
      
      // Extract promoter_id from JWT token and potentially from query param
      let tokenPromoterId = req.user.promoter_id; // From JWT
      const queryPromoterId = req.query.promoter_id ? parseInt(req.query.promoter_id) : null;

      console.log(`[EscrowController] req.user:`, req.user);
      console.log(`[EscrowController] tokenPromoterId from JWT:`, tokenPromoterId);
      console.log(`[EscrowController] req.user.id:`, req.user.id);

      // Check if user has promoter role (from JWT token roles array)
      const isPromoter = req.userRoles && req.userRoles.includes('promoter');
      const isFinance = req.userRoles && req.userRoles.includes('finance');
      const isKingsAccount = req.userRoles && req.userRoles.includes('kings_account');

      // Determine which promoter_id to fetch
      let promoterId;

      if (isPromoter) {
        // If tokenPromoterId is not in JWT, look it up from user_id
        if (!tokenPromoterId) {
          console.log(`[EscrowController] Looking up promoter_profile for user_id: ${req.user.id}`);
          // Create the profile on first visit if this promoter never got one.
          tokenPromoterId = await ensurePromoterProfile(db, req.user.id);
          if (!tokenPromoterId) {
            return res.status(403).json({
              error: 'UNAUTHORIZED_ROLE',
              message: 'Promoter profile not found. Contact support.'
            });
          }
          console.log(`[EscrowController] Resolved promoter_id to: ${tokenPromoterId}`);
        }
        // Promoter: always use own ID from token, ignore query param (privacy)
        promoterId = tokenPromoterId;
        console.log(`[EscrowController] Final promoterId: ${promoterId}`);
      } else if (isFinance || isKingsAccount) {
        // Finance/CEO: can view any promoter
        promoterId = queryPromoterId || tokenPromoterId || null;
        if (!promoterId) {
          return res.status(400).json({
            error: 'INVALID_INPUT',
            message: 'Promoter ID required'
          });
        }
      } else {
        return res.status(403).json({
          error: 'UNAUTHORIZED_ROLE',
          message: 'Access denied. Promoter, Finance, or Kings Account role required.'
        });
      }

      // Call service
      const escrowView = await escrowService.getPromoterEscrowView(promoterId);
      
      return res.status(200).json(escrowView);

    } catch (error) {
      console.error('[EscrowController] getPromoterEscrowView error:', error.message);

      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'Unable to load escrow data. Please refresh.'
      });
    }
  }

  /**
   * CONTRACT 17: GET /api/v1/escrow/interest/:territory_id
   * Returns interest history for a territory
   * Auth: JWT required | Role: finance, kings_account
   * Query params: from / from_date, to / to_date (optional, YYYY-MM-DD), page, limit (max 100), sort (asc|desc by created_at)
   * 
   * @param {object} req - Express request
   * @param {object} res - Express response
   */
  async getInterestHistory(req, res) {
    try {
      const { territory_id } = req.params;
      // The web app sends from_date / to_date; from / to are also accepted.
      const from = req.query.from || req.query.from_date;
      const to = req.query.to || req.query.to_date;
      const { page, limit, sort } = req.query;

      // Validate territory_id is a valid integer
      if (!territory_id || isNaN(territory_id)) {
        return res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'territory_id must be a valid integer'
        });
      }

      // Validate date format if provided (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

      if (from && !dateRegex.test(from)) {
        return res.status(400).json({
          error: 'INVALID_DATE_FORMAT',
          message: 'from date must be in YYYY-MM-DD format'
        });
      }

      if (to && !dateRegex.test(to)) {
        return res.status(400).json({
          error: 'INVALID_DATE_FORMAT',
          message: 'to date must be in YYYY-MM-DD format'
        });
      }

      // Call service
      const interestHistory = await escrowService.getInterestHistory(
        parseInt(territory_id),
        from || null,
        to || null,
        { page, limit, sort }
      );
      
      return res.status(200).json(interestHistory);

    } catch (error) {
      console.error('[EscrowController] getInterestHistory error:', error.message);

      if (error.message === 'TERRITORY_NOT_FOUND') {
        return res.status(404).json({
          error: 'TERRITORY_NOT_FOUND',
          message: 'Territory not found.'
        });
      }

      if (error.message === 'INVALID_DATE_RANGE') {
        return res.status(400).json({
          error: 'INVALID_DATE_RANGE',
          message: 'from date must be before to date.'
        });
      }

      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'Unable to load interest data. Please retry.'
      });
    }
  }
}

/**
 * GET /api/v1/escrow/payouts?territory_id&status=eligible|paid|all&page&limit
 * King / finance: concluded events waiting for (or already given) a payout.
 */
EscrowController.prototype.listPayouts = async function (req, res) {
  try {
    const territoryId = req.query.territory_id ? parseInt(req.query.territory_id, 10) : null;
    if (req.query.territory_id && Number.isNaN(territoryId)) {
      return res.status(400).json({ error: 'INVALID_INPUT', code: 'INVALID_INPUT', message: 'territory_id must be a valid integer' });
    }
    const result = await payoutService.listPayouts({
      territoryId,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('[EscrowController] listPayouts error:', error.message);
    return res.status(500).json({ error: 'SERVER_ERROR', code: 'SERVER_ERROR', message: 'Unable to load payouts. Please retry.' });
  }
};

/**
 * POST /api/v1/escrow/payouts/:liability_id/approve   body: { notes?, override_reason? }
 */
EscrowController.prototype.approvePayout = async function (req, res) {
  try {
    const liabilityId = parseInt(req.params.liability_id, 10);
    if (Number.isNaN(liabilityId) || liabilityId <= 0) {
      return res.status(400).json({ error: 'INVALID_INPUT', code: 'INVALID_INPUT', message: 'liability_id must be a valid integer' });
    }
    const { notes, override_reason } = req.body || {};
    const result = await payoutService.approvePayout(liabilityId, req.user, { notes, override_reason });
    return res.status(200).json({ ...result, message: 'Payout approved and recorded.' });
  } catch (error) {
    if (error instanceof payoutService.PayoutError) {
      return res.status(error.status).json({ error: error.code, code: error.code, message: error.message, data: error.data });
    }
    console.error('[EscrowController] approvePayout error:', error.message);
    return res.status(500).json({ error: 'SERVER_ERROR', code: 'SERVER_ERROR', message: 'Unable to approve payout. Please retry.' });
  }
};

module.exports = new EscrowController();
