const { sendEmail } = require("./email.service");
const {
  getPromoterReferralInviteTemplate,
  getPromoterReferralInviteResendTemplate,
} = require("../templates/emailTemplates");

/**
 * Send Promoter Referral Invitation Email
 * @param {Object} options
 * @param {string} options.email - Recipient email
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Expiration time
 * @returns {Promise<void>}
 */
async function sendPromoterReferralInviteEmail({ email, registrationUrl, expiresInMinutes = 15 }) {
  const html = getPromoterReferralInviteTemplate({ registrationUrl, expiresInMinutes });

  await sendEmail({
    to: email,
    subject: `🎯 Promoter Invitation from Eventopia (Expires in ${expiresInMinutes} minutes)`,
    html,
  });

  console.log(`[PROMOTER REFERRAL] Email sent successfully to ${email} | Expires in ${expiresInMinutes} min`);
}

/**
 * Send Promoter Referral Invitation Resend Email
 * @param {Object} options
 * @param {string} options.email - Recipient email
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Expiration time
 * @returns {Promise<void>}
 */
async function sendPromoterReferralInviteResendEmail({ email, registrationUrl, expiresInMinutes = 15 }) {
  const html = getPromoterReferralInviteResendTemplate({ registrationUrl, expiresInMinutes });

  await sendEmail({
    to: email,
    subject: `🎯 New Promoter Invitation from Eventopia (Expires in ${expiresInMinutes} minutes)`,
    html,
  });

  console.log(`[PROMOTER REFERRAL RESEND] ✅ Email sent to ${email}`);
}

module.exports = {
  sendPromoterReferralInviteEmail,
  sendPromoterReferralInviteResendEmail,
};
