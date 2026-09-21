const express = require('express');
const router = express.Router();
const ticketAccessController = require('../controllers/ticketAccess.controller');
const { requireAuth } = require('../middlewares/auth.middleware');

// All routes require authentication
router.use(requireAuth);

// Get ticket access state
router.get('/tickets/:ticketId/access', ticketAccessController.getTicketAccessState);

// Create access session
router.post('/tickets/:ticketId/access-session', ticketAccessController.createAccessSession);

// Resolve access token (redirect)
router.get('/access/:token', ticketAccessController.resolveAccessToken);

module.exports = router;
