const { fail } = require("../utils/standardResponse");
const GuruService = require("../services/guru.service");

/**
 * Check if user has Guru role
 */
async function requireGuru(req, res, next) {
  if (!req.user) {
    return fail(res, req, 401, "UNAUTHORIZED", "Authentication required");
  }

  if (req.user.role !== 'guru') {
    return fail(res, req, 403, "GURU_ROLE_REQUIRED", "Guru role required");
  }

  next();
}

/**
 * Check if Guru account is active
 * This middleware should be used after requireGuru
 */
async function requireActiveGuru(req, res, next) {
  if (!req.user) {
    return fail(res, req, 401, "UNAUTHORIZED", "Authentication required");
  }

  if (req.user.role !== 'guru') {
    return fail(res, req, 403, "GURU_ROLE_REQUIRED", "Guru role required");
  }

  try {
    const isActive = await GuruService.isGuruActive(req.user.id);

    if (!isActive) {
      return fail(res, req, 403, "GURU_NOT_ACTIVE", "Active Guru account required. Please complete activation.");
    }

    next();
  } catch (err) {
    console.error('Check Guru active error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to verify Guru status");
  }
}

/**
 * Check if Guru owns a promoter
 * This middleware verifies that the specified promoter is attached to the Guru
 */
async function requirePromoterOwnership(req, res, next) {
  if (!req.user) {
    return fail(res, req, 401, "UNAUTHORIZED", "Authentication required");
  }

  if (req.user.role !== 'guru') {
    return fail(res, req, 403, "GURU_ROLE_REQUIRED", "Guru role required");
  }

  const { promoterId } = req.params;
  const promoterIdNum = parseInt(promoterId, 10);

  if (isNaN(promoterIdNum) || promoterIdNum <= 0) {
    return fail(res, req, 404, "INVALID_PROMOTER", "Invalid promoter ID");
  }

  try {
    const promoter = await GuruService.getPromoterPerformance(req.user.id, promoterIdNum, null, null);

    // If we get here, the promoter is owned by this Guru
    req.promoter = promoter.promoter;
    next();
  } catch (err) {
    if (err.message === 'Promoter is not attached to this Guru') {
      return fail(res, req, 403, "NOT_AUTHORIZED", "You can only access your attached promoters");
    }
    console.error('Check promoter ownership error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to verify promoter ownership");
  }
}

module.exports = {
  requireGuru,
  requireActiveGuru,
  requirePromoterOwnership
};
