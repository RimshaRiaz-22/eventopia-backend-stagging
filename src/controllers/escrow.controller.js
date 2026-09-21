

const escrowService = require('../services/escrow.service');

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
          const profileResult = await db.query(
            'SELECT id FROM promoter_profiles WHERE user_id = $1',
            [req.user.id]
          );
          console.log(`[EscrowController] Profile lookup result:`, profileResult.rows);
          if (profileResult.rows.length === 0) {
            return res.status(403).json({
              error: 'UNAUTHORIZED_ROLE',
              message: 'Promoter profile not found. Contact support.'
            });
          }
          tokenPromoterId = profileResult.rows[0].id;
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
   * Query params: from (optional), to (optional) - both YYYY-MM-DD format
   * 
   * @param {object} req - Express request
   * @param {object} res - Express response
   */
  async getInterestHistory(req, res) {
    try {
      const { territory_id } = req.params;
      const { from, to } = req.query;

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
        to || null
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

module.exports = new EscrowController();
