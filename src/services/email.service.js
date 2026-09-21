const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const { 
  getOtpTemplate, 
  getOtpSubject, 
  getPasswordResetTemplate,
  getGuruInviteTemplate,
  getGuruInviteResendTemplate,
  getPromoterReferralInviteTemplate,
  getPromoterReferralInviteResendTemplate
} = require("../templates/emailTemplates");
const pool = require("../db");

function createTransporter() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Development: Log emails to console
  return nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true,
  });
}

const transporter = createTransporter();

/**
 * Send an email
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content
 */
async function sendEmail({ to, subject, html, text }) {
  try {
    const mailOptions = {
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ""),
    };

    const info = await transporter.sendMail(mailOptions);

    // If using stream transport (development), log the email
    if (info.message) {
      console.log("\n========== EMAIL SENT (DEV MODE) ==========");
      console.log("To:", to);
      console.log("Subject:", subject);
      console.log("==========================================\n");
      console.log(info.message.toString());
      console.log("\n==========================================\n");
    } else {
      console.log("Email sent: %s", info.messageId);
    }

    return info;
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

/**
 * Send OTP email
 * @param {string} email - Recipient email
 * @param {string} otp - OTP code
 * @param {string} purpose - Purpose of OTP (signup, login, password_reset)
 * @param {number} expiresIn - Expiration time in seconds
 */
async function sendOtpEmail(email, otp, purpose = "signup", expiresIn = 600) {
  const subject = getOtpSubject(purpose);
  const html = getOtpTemplate(otp, purpose, expiresIn);

  return sendEmail({
    to: email,
    subject,
    html,
  });
}

/**
 * Send password reset email
 * @param {string} email - Recipient email
 * @param {string} resetToken - Password reset token
 * @param {string} userName - User's name
 */
async function sendPasswordResetEmail(email, resetToken, userName) {
  const subject = "Password Reset - Eventopia";
  const html = getPasswordResetTemplate(resetToken, userName);

  return sendEmail({
    to: email,
    subject,
    html,
  });
}

/**
 * Send reward voucher issued email
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.userName - User's name
 * @param {string} options.eventTitle - Event title
 * @param {number} options.amountPence - Voucher amount in pence
 * @param {string} options.voucherType - Type of voucher (promoter/guru)
 * @param {Date} options.expiresAt - Expiry date
 */
async function sendRewardVoucherEmail({ to, userName, eventTitle, amountPence, voucherType, expiresAt }) {
  const amountPounds = (amountPence / 100).toFixed(2);
  const expiresAtFormatted = new Date(expiresAt).toLocaleDateString('en-GB');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #4F46E5; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background: #f9f9f9; }
        .voucher-details { background: white; padding: 15px; margin: 20px 0; border-left: 4px solid #4F46E5; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎉 Congratulations!</h1>
        </div>
        <div class="content">
          <p>Hi ${userName},</p>
          <p>You've received a <strong>£${amountPounds}</strong> loyalty reward voucher!</p>

          <div class="voucher-details">
            <h3>Voucher Details</h3>
            <ul>
              <li><strong>Event:</strong> ${eventTitle}</li>
              <li><strong>Amount:</strong> £${amountPounds}</li>
              <li><strong>Type:</strong> ${voucherType} Reward</li>
              <li><strong>Expires:</strong> ${expiresAtFormatted}</li>
            </ul>
          </div>

          <p>You can redeem this voucher against future event bookings in your account.</p>
          <p>Thank you for being part of Eventopia!</p>
        </div>
        <div class="footer">
          <p>Eventopia - Your Event Management Platform</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to,
    subject: `You've earned a £${amountPounds} reward voucher!`,
    html,
  });
}

/**
 * Send multiple reward notification emails for an event
 * @param {number} eventId - Event ID
 * @param {Object} rewards - Rewards object
 */
async function sendRewardNotificationEmails(eventId, rewards) {
  try {
    // Get event title
    const eventResult = await pool.query('SELECT title FROM events WHERE id = $1', [eventId]);
    const eventTitle = eventResult.rows[0]?.title || 'Your Event';

    // Send promoter email
    if (rewards.promoterReward > 0) {
      const promoterResult = await pool.query(
        'SELECT email, name FROM users WHERE id = $1',
        [rewards.promoterId]
      );

      if (promoterResult.rowCount > 0) {
        const promoter = promoterResult.rows[0];
        const expiresAt = rewards.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // Default to 12 months

        await sendRewardVoucherEmail({
          to: promoter.email,
          userName: promoter.name || 'Promoter',
          eventTitle: eventTitle,
          amountPence: rewards.promoterReward,
          voucherType: 'Promoter',
          expiresAt: expiresAt
        });
      }
    }

    // Send guru email
    if (rewards.guruReward > 0 && rewards.guruId) {
      const guruResult = await pool.query(
        'SELECT email, name FROM users WHERE id = $1',
        [rewards.guruId]
      );

      if (guruResult.rowCount > 0) {
        const guru = guruResult.rows[0];
        const expiresAt = rewards.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // Default to 12 months

        await sendRewardVoucherEmail({
          to: guru.email,
          userName: guru.name || 'Guru',
          eventTitle: eventTitle,
          amountPence: rewards.guruReward,
          voucherType: 'Guru',
          expiresAt: expiresAt
        });
      }
    }
  } catch (err) {
    console.error('Error sending reward notification emails:', err);
    // Don't throw - email failure shouldn't break the flow
  }
}

/**
 * Send voucher expiry reminder email
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.userName - User's name
 * @param {string} options.eventTitle - Event title
 * @param {number} options.amountPence - Voucher amount in pence
 * @param {Date} options.expiresAt - Expiry date
 */
async function sendVoucherExpiryReminderEmail({ to, userName, eventTitle, amountPence, expiresAt }) {
  const amountPounds = (amountPence / 100).toFixed(2);
  const expiresAtFormatted = new Date(expiresAt).toLocaleDateString('en-GB');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #F59E0B; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background: #f9f9f9; }
        .voucher-details { background: white; padding: 15px; margin: 20px 0; border-left: 4px solid #F59E0B; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; }
        .warning { color: #F59E0B; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>⏰ Voucher Expiring Soon!</h1>
        </div>
        <div class="content">
          <p>Hi ${userName},</p>
          <p class="warning">Your <strong>£${amountPounds}</strong> reward voucher is about to expire!</p>

          <div class="voucher-details">
            <h3>Voucher Details</h3>
            <ul>
              <li><strong>Event:</strong> ${eventTitle}</li>
              <li><strong>Amount:</strong> £${amountPounds}</li>
              <li><strong>Expires:</strong> ${expiresAtFormatted}</li>
            </ul>
          </div>

          <p>Don't miss out! Use your voucher against future event bookings in your account before it expires.</p>
          <p>Thank you for being part of Eventopia!</p>
        </div>
        <div class="footer">
          <p>Eventopia - Your Event Management Platform</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to,
    subject: `Your £${amountPounds} voucher expires on ${expiresAtFormatted}`,
    html,
  });
}

/**
 * Send email verification email (for profile email change)
 * @param {string} email - Recipient email (NEW email address)
 * @param {string} verificationToken - Email verification token
 * @param {string} userName - User's name
 */
async function sendEmailVerificationEmail(email, verificationToken, userName = "User") {
  const verificationLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/verify-email?token=${verificationToken}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
        .content { padding: 20px; background: #f9f9f9; border-radius: 0 0 5px 5px; }
        .button { display: inline-block; padding: 12px 30px; background: #4F46E5; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; }
        .warning { background: #fff3cd; color: #856404; padding: 10px; border-radius: 5px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Verify Your Email Address</h1>
        </div>
        <div class="content">
          <p>Hi ${userName},</p>
          <p>You recently changed your email address on your Eventopia account. To complete this change, please verify your new email address by clicking the button below:</p>
          
          <p style="text-align: center;">
            <a href="${verificationLink}" class="button">Verify Email Address</a>
          </p>
          
          <p>Or copy and paste this link in your browser:</p>
          <p style="word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 5px;">
            ${verificationLink}
          </p>
          
          <div class="warning">
            <strong>⚠️ Important:</strong> This link will expire in 24 hours. If you don't verify this email, your email change will not be applied.
          </div>
          
          <p>If you didn't request this change, please ignore this email or contact our support team.</p>
          <p>Best regards,<br>Eventopia Team</p>
        </div>
        <div class="footer">
          <p>© 2026 Eventopia. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to: email,
    subject: "Verify Your New Email Address - Eventopia",
    html,
  });
}

/**
 * Send Guru Invitation Email
 * @param {Object} options - Email options
 * @param {string} options.email - Recipient email
 * @param {string} options.registrationUrl - Registration URL
 * @param {number} options.expiresInMinutes - Expiration time in minutes
 * @returns {Promise}
 */
async function sendGuruInviteEmail({ email, registrationUrl, expiresInMinutes = 15 }) {
  const html = getGuruInviteTemplate({ registrationUrl, expiresInMinutes });

  return sendEmail({
    to: email,
    subject: `Welcome to Eventopia - Guru Invitation (Expires in ${expiresInMinutes} minutes)`,
    html,
  });
}

/**
 * Send Guru Invitation Resend Email
 * @param {Object} options - Email options
 * @param {string} options.email - Recipient email
 * @param {string} options.registrationUrl - Registration URL
 * @param {number} options.expiresInMinutes - Expiration time in minutes
 * @returns {Promise}
 */
async function sendGuruInviteResendEmail({ email, registrationUrl, expiresInMinutes = 15 }) {
  const html = getGuruInviteResendTemplate({ registrationUrl, expiresInMinutes });

  return sendEmail({
    to: email,
    subject: `🎉 New Guru Invitation Link - Complete Registration (Expires in ${expiresInMinutes} minutes)`,
    html,
  });
}

/**
 * Send Promoter Referral Invitation Email
 * @param {Object} options - Email options
 * @param {string} options.email - Recipient email
 * @param {string} options.guruName - Guru's name
 * @param {string} options.registrationUrl - Registration URL
 * @param {number} options.expiresInMinutes - Expiration time in minutes
 * @returns {Promise}
 */
async function sendPromoterReferralInviteEmail({ email, guruName, registrationUrl, expiresInMinutes = 15 }) {
  const html = getPromoterReferralInviteTemplate({ guruName, registrationUrl, expiresInMinutes });

  return sendEmail({
    to: email,
    subject: `🎯 Promoter Invitation from ${guruName} (Expires in ${expiresInMinutes} minutes)`,
    html,
  });
}

/**
 * Send Promoter Referral Invitation Resend Email
 * @param {Object} options - Email options
 * @param {string} options.email - Recipient email
 * @param {string} options.guruName - Guru's name
 * @param {string} options.registrationUrl - Registration URL
 * @param {number} options.expiresInMinutes - Expiration time in minutes
 * @returns {Promise}
 */
async function sendPromoterReferralInviteResendEmail({ email, guruName, registrationUrl, expiresInMinutes = 15 }) {
  const html = getPromoterReferralInviteResendTemplate({ guruName, registrationUrl, expiresInMinutes });

  return sendEmail({
    to: email,
    subject: `🎯 New Promoter Invitation from ${guruName} (Expires in ${expiresInMinutes} minutes)`,
    html,
  });
}

module.exports = {
  sendEmail,
  sendOtpEmail,
  sendPasswordResetEmail,
  sendRewardVoucherEmail,
  sendRewardNotificationEmails,
  sendVoucherExpiryReminderEmail,
  sendEmailVerificationEmail,
  sendGuruInviteEmail,
  sendGuruInviteResendEmail,
  sendPromoterReferralInviteEmail,
  sendPromoterReferralInviteResendEmail,
};
