/**
 * Authentication route definitions.
 * Handles public auth flows, OTP verification, OAuth, invite registration, protected account routes, and checkout.
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
  refreshToken,
  getMe,
  setActiveRole,
  logout,
  logoutAll,
  setupAccount,
  updateProfile,
  verifyOtpEmail,
  oauthRegister,
  guruCheckout,
  resendOtp,
 kingsSendOtp,
kingsVerifyOtp,
kingsRegister,
  oauthCallback,
  guruRegisterViaInvite,
  createGuruInvite,
  resendGuruInvite,
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
router.post("/refresh", refreshToken);

router.post("/otp/verify", verifyOtpEmail);
router.post('/otp/resend', resendOtp)

router.post("/oauth/register", oauthRegister);
router.post("/oauth/callback", oauthCallback);

router.post("/guru/register", guruRegisterViaInvite);

router.get("/referrals/validate/:token", validateReferralToken);
router.post("/promoter/register", promoterRegisterViaReferral);

router.post("/gurus/promoter/referral-invites", requireAuth, createPromoterReferralInvite);

router.post("/promoter/referral-invites/resend", resendPromoterReferralInvite);

router.get("/me", requireAuth, getMe);
router.post("/me/active-role", requireAuth, setActiveRole);
router.post("/logout", requireAuth, logout);
router.post("/logout-all", requireAuth, logoutAll);
router.post("/setup", requireAuth, setupAccount);
router.patch("/me", requireAuth, updateProfile);

router.post("/network-managers/guru/invites", requireAuth, createGuruInvite);

router.post("/guru/invites/resend", resendGuruInvite);

router.post("/king/register", kingsRegister);
router.post("/king/otp/send", kingsSendOtp);
router.post("/king/otp/verify", kingsVerifyOtp);

router.post("/guru/checkout", requireAuth, guruCheckout);

module.exports = router;