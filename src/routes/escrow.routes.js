

const express = require('express');
const escrowController = require('../controllers/escrow.controller');
const { requireAuth, requireRole } = require('../middlewares/auth.middleware');

const router = express.Router();


router.get(
  '/coverage/:territory_id',
  requireAuth,
  requireRole('finance', 'kings_account'),
  escrowController.getCoverageRatio.bind(escrowController)
);

router.get(
  '/promoter/finance/escrow',
  requireAuth,
  requireRole('promoter', 'finance', 'kings_account'),
  escrowController.getPromoterEscrowView.bind(escrowController)
);


router.get( '/interest/:territory_id', requireAuth, requireRole('finance', 'kings_account'),
  escrowController.getInterestHistory.bind(escrowController)
);

module.exports = router;
