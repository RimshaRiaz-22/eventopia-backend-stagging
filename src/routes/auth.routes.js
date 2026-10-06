/**
 * Authentication route definitions.
 * Handles public auth flows, OTP verification, OAuth, King-invited promoter registration and protected account routes.
 */

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  register,
  login,
  verifyEmail,
  forgotPassword,
  resetPassword,
  getMe,
  setActiveRole,
  logout,
  logoutAll,
  setupAccount,
  updateProfile,
  verifyOtpEmail,
  oauthRegister,
  resendOtp,
  kingsSendOtp,
  kingsVerifyOtp,
  kingsRegister,
  oauthCallback,
  promoterRegisterViaReferral,
  validateReferralToken,
  createPromoterReferralInvite,
  resendPromoterReferralInvite,
} = require("../controllers/auth.controller");

router.post("/register", register);
router.post("/login", login);
router.post("/verify-email", verifyEmail);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

router.post("/otp/verify", verifyOtpEmail);
router.post('/otp/resend', resendOtp)

router.post("/oauth/register", oauthRegister);
router.post("/oauth/callback", oauthCallback);

// Promoter invited by the King: validate token, then register (no approval needed)
router.get("/referrals/validate/:token", validateReferralToken);
router.post("/promoter/register", promoterRegisterViaReferral);

// King invites a promoter (King's Account / founder / admin only, enforced in the controller)
router.post("/promoters/invites", requireAuth, createPromoterReferralInvite);
router.post("/promoters/invites/resend", resendPromoterReferralInvite);

router.get("/me", requireAuth, getMe);
router.post("/me/active-role", requireAuth, setActiveRole);
router.post("/logout", requireAuth, logout);
router.post("/logout-all", requireAuth, logoutAll);
router.post("/setup", requireAuth, setupAccount);
router.patch("/me", requireAuth, updateProfile);

router.post("/king/register", kingsRegister);
router.post("/king/otp/send", kingsSendOtp);
router.post("/king/otp/verify", kingsVerifyOtp);

module.exports = router;
