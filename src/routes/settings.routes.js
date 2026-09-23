/**
 * Settings route definitions.
 * Handles profile updates, email verification, password changes, and King's Account settings.
 */

const express = require("express");
const router = express.Router();
const {
	getProfile,
	updateProfile,
	verifyEmail,
	getKingsAccountProfile,
	updateKingsAccountProfile,
	changeKingsAccountPassword,
	requestKingsPasswordChangeOtp,
	getKingsTwofaDevices,
	deleteKingsTwofaDevice,
} = require("../controllers/settings.controller");
const { changePasswordV1 } = require("../controllers/auth.controller");
const { requireAuth, requireKingsAccount } = require("../middlewares/auth.middleware");

/**
 * Gets the current user's profile.
 */
router.get("/profile", requireAuth, getProfile);

/**
 * Updates personal profile details for the current user.
 */
router.put("/profile", requireAuth, updateProfile);

/**
 * Verifies an email change with the submitted OTP.
 */
router.post("/verify-email", requireAuth, verifyEmail);

/**
 * Changes the current user's password.
 */
router.post("/auth/change-password", requireAuth, changePasswordV1);

/**
 * Gets the King's Account profile.
 */
router.get("/kings_account/profile", requireAuth, requireKingsAccount, getKingsAccountProfile);

/**
 * Updates the King's Account profile.
 */
router.put("/kings_account/profile", requireAuth, requireKingsAccount, updateKingsAccountProfile);

/**
 * Changes the King's Account password.
 */
router.post("/kings_account/change-password", requireAuth, requireKingsAccount, changeKingsAccountPassword);

/**
 * Requests an OTP for King's Account password changes.
 */
router.post("/kings_account/change-password/request-otp", requireAuth, requireKingsAccount, requestKingsPasswordChangeOtp);

/**
 * Gets registered King's Account 2FA devices.
 */
router.get("/kings_account/2fa/devices", requireAuth, requireKingsAccount, getKingsTwofaDevices);

/**
 * Deletes a King's Account 2FA device.
 */
router.delete("/kings_account/2fa/devices/:id", requireAuth, requireKingsAccount, deleteKingsTwofaDevice);

module.exports = router;