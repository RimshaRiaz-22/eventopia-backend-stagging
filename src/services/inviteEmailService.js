const { sendEmail } = require("./email.service");
const {
  getGuruInviteTemplate,
  getGuruInviteResendTemplate,
  getPromoterReferralInviteTemplate,
  getPromoterReferralInviteResendTemplate,
} = require("../templates/emailTemplates");

/**
 * Send Guru Invitation Email
 * @param {Object} options
 * @param {string} options.email - Recipient email
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Expiration time
 * @returns {Promise<void>}
 */
async function sendGuruInviteEmail({ email, registrationUrl, expiresInMinutes = 15 }) {
  const html = getGuruInviteTemplate({ registrationUrl, expiresInMinutes });

  await sendEmail({
    to: email,
    subject: `Welcome to Eventopia - Guru Invitation (Expires in ${expiresInMinutes} minutes)`,
    html,
  });

  console.log(`[GURU INVITE] Email sent successfully to ${email} with ${expiresInMinutes} minute expiry`);
}

/**
 * Send Guru Invitation Resend Email
 * @param {Object} options
 * @param {string} options.email - Recipient email
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Expiration time
 * @returns {Promise<void>}
 */
async function sendGuruInviteResendEmail({ email, registrationUrl, expiresInMinutes = 15 }) {
  const html = getGuruInviteResendTemplate({ registrationUrl, expiresInMinutes });

  await sendEmail({
    to: email,
    subject: `🎉 New Guru Invitation Link - Complete Registration (Expires in ${expiresInMinutes} minutes)`,
    html,
  });

  console.log(`[GURU INVITE RESEND] ✅ Email sent to ${email} | Token expires in ${expiresInMinutes} min`);
}

/**
 * Send Promoter Referral Invitation Email
 * @param {Object} options
 * @param {string} options.email - Recipient email
 * @param {string} options.guruName - Guru's name
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Expiration time
 * @returns {Promise<void>}
 */
async function sendPromoterReferralInviteEmail({ email, guruName, registrationUrl, expiresInMinutes = 15 }) {
  const html = getPromoterReferralInviteTemplate({ guruName, registrationUrl, expiresInMinutes });

  await sendEmail({
    to: email,
    subject: `🎯 Promoter Invitation from ${guruName} (Expires in ${expiresInMinutes} minutes)`,
    html,
  });

  console.log(`[PROMOTER REFERRAL] Email sent successfully to ${email} | Guru: ${guruName} | Expires in ${expiresInMinutes} min`);
}

/**
 * Send Promoter Referral Invitation Resend Email
 * @param {Object} options
 * @param {string} options.email - Recipient email
 * @param {string} options.guruName - Guru's name
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Expiration time
 * @returns {Promise<void>}
 */
async function sendPromoterReferralInviteResendEmail({ email, guruName, registrationUrl, expiresInMinutes = 15 }) {
  const html = getPromoterReferralInviteResendTemplate({ guruName, registrationUrl, expiresInMinutes });

  await sendEmail({
    to: email,
    subject: `🎯 New Promoter Invitation from ${guruName} (Expires in ${expiresInMinutes} minutes)`,
    html,
  });

  console.log(`[PROMOTER REFERRAL RESEND] ✅ Email sent to ${email} | Guru: ${guruName}`);
}

module.exports = {
  sendGuruInviteEmail,
  sendGuruInviteResendEmail,
  sendPromoterReferralInviteEmail,
  sendPromoterReferralInviteResendEmail,
};
