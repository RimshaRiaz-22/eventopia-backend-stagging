/**
 * Email Templates for Eventopia
 * Contains all HTML email templates used throughout the application
 */

/**
 * Get OTP email subject based on purpose
 * @param {string} purpose - Purpose of OTP (signup, login, password_reset)
 * @returns {string} - Email subject line
 */
function getOtpSubject(purpose) {
  switch (purpose) {
    case "signup":
      return "Verify Your Email - Eventopia Account Registration";
    case "login":
      return "Your Login Verification Code - Eventopia";
    case "password_reset":
      return "Password Reset Code - Eventopia";
    default:
      return "Your Verification Code - Eventopia";
  }
}

/**
 * Get purpose text for OTP email
 * @param {string} purpose - Purpose of OTP
 * @returns {string} - Purpose text
 */
function getPurposeText(purpose) {
  switch (purpose) {
    case "signup":
      return "Verify Your Email Address";
    case "login":
      return "Login Verification";
    case "password_reset":
      return "Reset Your Password";
    default:
      return "Email Verification";
  }
}

/**
 * Generate OTP email HTML template
 * @param {string} otp - OTP code
 * @param {string} purpose - Purpose of OTP
 * @param {number} expiresIn - Expiration time in seconds
 * @returns {string} - HTML content
 */
function getOtpTemplate(otp, purpose, expiresIn) {
  const minutes = Math.floor(expiresIn / 60);
  const purposeText = getPurposeText(purpose);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Verification - Eventopia</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #f4f4f4;
      color: #333;
      line-height: 1.6;
    }

    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px 20px;
      text-align: center;
    }

    .header h1 {
      font-size: 32px;
      margin-bottom: 10px;
    }

    .header p {
      font-size: 16px;
      opacity: 0.9;
    }

    .content {
      padding: 40px 30px;
    }

    .content h2 {
      color: #667eea;
      margin-bottom: 20px;
      font-size: 24px;
    }

    .otp-box {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 10px;
      padding: 30px;
      text-align: center;
      margin: 30px 0;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
    }

    .otp-box h3 {
      color: white;
      font-size: 18px;
      margin-bottom: 15px;
      font-weight: normal;
    }

    .otp-code {
      font-size: 48px;
      font-weight: bold;
      color: white;
      letter-spacing: 10px;
      font-family: 'Courier New', monospace;
    }

    .info-box {
      background-color: #f8f9fa;
      border-left: 4px solid #667eea;
      padding: 20px;
      margin: 25px 0;
      border-radius: 4px;
    }

    .info-box p {
      margin-bottom: 10px;
    }

    .info-box p:last-child {
      margin-bottom: 0;
    }

    .info-box strong {
      color: #667eea;
    }

    .warning {
      background-color: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 15px;
      margin: 25px 0;
      border-radius: 4px;
    }

    .warning p {
      color: #856404;
      margin: 0;
      font-size: 14px;
    }

    .footer {
      background-color: #f8f9fa;
      padding: 30px;
      text-align: center;
      border-top: 1px solid #e0e0e0;
    }

    .footer p {
      color: #666;
      font-size: 14px;
      margin-bottom: 10px;
    }

    .footer a {
      color: #667eea;
      text-decoration: none;
    }

    .footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎉 Eventopia</h1>
      <p>Your Event Management Platform</p>
    </div>

    <div class="content">
      <h2>${purposeText}</h2>

      <p>Thank you for using Eventopia! Please use the verification code below to complete your ${purpose.replace("_", " ")}:</p>

      <div class="otp-box">
        <h3>Your Verification Code</h3>
        <div class="otp-code">${otp}</div>
      </div>

      <div class="info-box">
        <p><strong>Expires in:</strong> ${minutes} minutes</p>
        <p><strong>For security reasons:</strong> This code can only be used once and will expire after ${minutes} minutes.</p>
      </div>

      <div class="warning">
        <p><strong>⚠️ Important:</strong> If you didn't request this code, please ignore this email. Your account will remain secure.</p>
      </div>
    </div>

    <div class="footer">
      <p>© 2024 Eventopia. All rights reserved.</p>
      <p>
        <a href="#">Privacy Policy</a> |
        <a href="#">Terms of Service</a> |
        <a href="#">Support</a>
      </p>
      <p style="margin-top: 15px; font-size: 12px;">
        This is an automated message, please do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Charity Application Submitted Template
 * @param {Object} application - Charity application
 * @param {Object} promoter - Promoter user
 * @returns {string} - HTML content
 */
function getCharityApplicationSubmittedTemplate(application, promoter) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Application Submitted - Eventopia</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4; color: #333; line-height: 1.6; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; }
    .header h1 { font-size: 32px; margin-bottom: 10px; }
    .header p { font-size: 16px; opacity: 0.9; }
    .content { padding: 40px 30px; }
    .info-box { background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #667eea; }
    .next-steps { margin: 20px 0; }
    .next-steps ul { margin-left: 20px; margin-top: 10px; }
    .next-steps li { margin: 8px 0; }
    .button { display: inline-block; padding: 12px 30px; background-color: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { background-color: #f8f9fa; padding: 30px; text-align: center; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Charity Application Submitted</h1>
      <p>Thank you for your application</p>
    </div>
    <div class="content">
      <p>Dear ${promoter.name},</p>
      <p style="margin-top: 20px;">Thank you for submitting your charity application. We have received your request for charity support.</p>

      <div class="info-box">
        <h3 style="margin-bottom: 10px;">Application Details</h3>
        <p><strong>Charity:</strong> ${application.charity_name}</p>
        <p><strong>Charity Number:</strong> ${application.charity_number}</p>
        <p><strong>Requested Amount:</strong> £${(application.requested_amount / 100).toFixed(2)}</p>
        <p><strong>Status:</strong> Under Review</p>
      </div>

      <div class="next-steps">
        <h3>Next Steps</h3>
        <ul>
          <li>Your application will be reviewed by our admin team</li>
          <li>You will receive an email notification once a decision has been made</li>
          <li>Review process typically takes 3-5 business days</li>
        </ul>
      </div>

      <p>If you have any questions, please don't hesitate to contact our support team.</p>

      <p style="margin-top: 20px;">Best regards,<br>Eventopia Team</p>
    </div>
    <div class="footer">
      <p>© 2024 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Charity Application Fee Paid Template
 * @param {Object} application - Charity application
 * @param {Object} promoter - Promoter user
 * @param {Object} payment - Payment record
 * @param {string} failureReason - Failure reason (optional)
 * @returns {string} - HTML content
 */
function getCharityApplicationFeePaidTemplate(application, promoter, payment, failureReason) {
  const isFailure = !!failureReason;
  const status = isFailure ? 'Failed' : 'Completed';
  const color = isFailure ? '#dc3545' : '#28a745';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Application Fee - Eventopia</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4; color: #333; line-height: 1.6; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    .header { background: ${isFailure ? 'linear-gradient(135deg, #dc3545 0%, #c82333 100%)' : 'linear-gradient(135deg, #28a745 0%, #218838 100%)'}; color: white; padding: 40px 20px; text-align: center; }
    .header h1 { font-size: 32px; margin-bottom: 10px; }
    .header p { font-size: 16px; opacity: 0.9; }
    .content { padding: 40px 30px; }
    .info-box { background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid ${color}; }
    .status { color: ${color}; font-weight: bold; }
    .footer { background-color: #f8f9fa; padding: 30px; text-align: center; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Application Fee ${status}</h1>
      <p>${isFailure ? 'Payment was not completed' : 'Payment successful'}</p>
    </div>
    <div class="content">
      <p>Dear ${promoter.name},</p>
      <p style="margin-top: 20px;">${isFailure ? 'Unfortunately, your charity application fee payment could not be completed.' : 'Your charity application fee has been successfully received.'}</p>

      <div class="info-box">
        <h3 style="margin-bottom: 10px;">Payment Details</h3>
        <p><strong>Application:</strong> ${application.charity_name}</p>
        <p><strong>Amount:</strong> £${(application.application_fee_amount / 100).toFixed(2)}</p>
        <p><strong>Status:</strong> <span class="status">${status}</span></p>
        ${isFailure ? `<p><strong>Reason:</strong> ${failureReason}</p>` : ''}
      </div>

      ${isFailure ? `
        <p>You can retry the payment by logging into your account and navigating to your charity applications.</p>
      ` : `
        <p>Your application is now under review and will be processed by our admin team. You will receive a notification once a decision has been made.</p>
      `}

      <p style="margin-top: 20px;">Best regards,<br>Eventopia Team</p>
    </div>
    <div class="footer">
      <p>© 2024 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Charity Application Approved Template
 * @param {Object} application - Charity application
 * @param {Object} promoter - Promoter user
 * @param {Object} admin - Admin who approved
 * @returns {string} - HTML content
 */
function getCharityApplicationApprovedTemplate(application, promoter, admin) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Application Approved - Eventopia</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4; color: #333; line-height: 1.6; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    .header { background: linear-gradient(135deg, #28a745 0%, #218838 100%); color: white; padding: 40px 20px; text-align: center; }
    .header h1 { font-size: 32px; margin-bottom: 10px; }
    .content { padding: 40px 30px; }
    .info-box { background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #28a745; }
    .button { display: inline-block; padding: 12px 30px; background-color: #28a745; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { background-color: #f8f9fa; padding: 30px; text-align: center; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Application Approved!</h1>
      <p>Your charity application has been approved</p>
    </div>
    <div class="content">
      <p>Dear ${promoter.name},</p>
      <p style="margin-top: 20px;">Great news! Your charity application has been approved by our admin team.</p>

      <div class="info-box">
        <h3 style="margin-bottom: 10px;">Approval Details</h3>
        <p><strong>Charity:</strong> ${application.charity_name}</p>
        <p><strong>Approved Amount:</strong> £${(application.decision_amount / 100).toFixed(2)}</p>
        <p><strong>Requested Amount:</strong> £${(application.requested_amount / 100).toFixed(2)}</p>
        ${application.admin_notes ? `<p><strong>Admin Notes:</strong> ${application.admin_notes}</p>` : ''}
      </div>

      <p>Our team will now arrange for the approved funds to be distributed to the specified recipients. You will receive a final notification once the execution is complete.</p>

      <p style="margin-top: 20px;">Thank you for your application and for making a positive impact!</p>

      <p style="margin-top: 20px;">Best regards,<br>Eventopia Team</p>
    </div>
    <div class="footer">
      <p>© 2024 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Charity Application Rejected Template
 * @param {Object} application - Charity application
 * @param {Object} promoter - Promoter user
 * @param {Object} admin - Admin who rejected
 * @param {string} reason - Rejection reason
 * @returns {string} - HTML content
 */
function getCharityApplicationRejectedTemplate(application, promoter, admin, reason) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Application Update - Eventopia</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4; color: #333; line-height: 1.6; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    .header { background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); color: white; padding: 40px 20px; text-align: center; }
    .header h1 { font-size: 32px; margin-bottom: 10px; }
    .content { padding: 40px 30px; }
    .info-box { background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #dc3545; }
    .footer { background-color: #f8f9fa; padding: 30px; text-align: center; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Application Update</h1>
      <p>Your charity application status</p>
    </div>
    <div class="content">
      <p>Dear ${promoter.name},</p>
      <p style="margin-top: 20px;">Thank you for your charity application. After careful review, we regret to inform you that your application was not approved at this time.</p>

      <div class="info-box">
        <h3 style="margin-bottom: 10px;">Application Details</h3>
        <p><strong>Charity:</strong> ${application.charity_name}</p>
        <p><strong>Requested Amount:</strong> £${(application.requested_amount / 100).toFixed(2)}</p>
        <p><strong>Status:</strong> Rejected</p>
        ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
        ${application.admin_notes ? `<p><strong>Additional Notes:</strong> ${application.admin_notes}</p>` : ''}
      </div>

      <p>This decision was not made lightly, and we encourage you to apply again in the future with additional information if available.</p>

      <p style="margin-top: 20px;">If you have any questions or would like to discuss this decision, please contact our support team.</p>

      <p style="margin-top: 20px;">Best regards,<br>Eventopia Team</p>
    </div>
    <div class="footer">
      <p>© 2024 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Charity Application Completed Template
 * @param {Object} application - Charity application
 * @param {Object} promoter - Promoter user
 * @param {Array} executions - Execution records
 * @returns {string} - HTML content
 */
function getCharityApplicationCompletedTemplate(application, promoter, executions) {
  const executionsHtml = executions.map(exec => `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #ddd;">${exec.recipient_type.replace('_', ' ')}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ddd;">${exec.recipient_name}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ddd;">£${(exec.amount / 100).toFixed(2)}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Application Completed - Eventopia</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4; color: #333; line-height: 1.6; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    .header { background: linear-gradient(135deg, #28a745 0%, #218838 100%); color: white; padding: 40px 20px; text-align: center; }
    .header h1 { font-size: 32px; margin-bottom: 10px; }
    .content { padding: 40px 30px; }
    .info-box { background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #28a745; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .footer { background-color: #f8f9fa; padding: 30px; text-align: center; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Application Completed!</h1>
      <p>Your charity application has been fully executed</p>
    </div>
    <div class="content">
      <p>Dear ${promoter.name},</p>
      <p style="margin-top: 20px;">We're pleased to inform you that your charity application has been fully completed and all funds have been distributed to the specified recipients.</p>

      <div class="info-box">
        <h3 style="margin-bottom: 10px;">Application Summary</h3>
        <p><strong>Charity:</strong> ${application.charity_name}</p>
        <p><strong>Approved Amount:</strong> £${(application.decision_amount / 100).toFixed(2)}</p>
        <p><strong>Total Distributed:</strong> £${executions.reduce((sum, e) => sum + parseInt(e.amount), 0) / 100}</p>
      </div>

      <h3>Distribution Details</h3>
      <table>
        <thead>
          <tr style="background-color: #f8f9fa;">
            <th style="padding: 10px; text-align: left;">Recipient Type</th>
            <th style="padding: 10px; text-align: left;">Recipient Name</th>
            <th style="padding: 10px; text-align: left;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${executionsHtml}
        </tbody>
      </table>

      <p>Thank you for your application and for making a positive impact in your community!</p>

      <p style="margin-top: 20px;">Best regards,<br>Eventopia Team</p>
    </div>
    <div class="footer">
      <p>© 2024 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Password Reset Email Template
 * @param {string} resetToken - Password reset token
 * @param {string} userName - User's name
 * @returns {string} - HTML content
 */
function getPasswordResetTemplate(resetToken, userName) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Reset - Eventopia</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #f4f4f4;
      color: #333;
      line-height: 1.6;
    }

    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px 20px;
      text-align: center;
    }

    .header h1 {
      font-size: 32px;
      margin-bottom: 10px;
    }

    .header p {
      font-size: 16px;
      opacity: 0.9;
    }

    .content {
      padding: 40px 30px;
    }

    .content h2 {
      color: #667eea;
      margin-bottom: 20px;
      font-size: 24px;
    }

    .reset-box {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 10px;
      padding: 30px;
      text-align: center;
      margin: 30px 0;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
    }

    .reset-box h3 {
      color: white;
      font-size: 18px;
      margin-bottom: 15px;
      font-weight: normal;
    }

    .reset-link {
      background-color: white;
      color: #667eea;
      padding: 15px 30px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: bold;
      font-size: 16px;
      display: inline-block;
      margin: 20px 0;
      word-break: break-all;
    }

    .reset-link:hover {
      background-color: #f0f0f0;
    }

    .token-box {
      background-color: #f8f9fa;
      border: 2px dashed #667eea;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      text-align: center;
    }

    .token-code {
      font-size: 24px;
      font-weight: bold;
      color: #667eea;
      letter-spacing: 5px;
      font-family: 'Courier New', monospace;
      word-break: break-all;
    }

    .info-box {
      background-color: #f8f9fa;
      border-left: 4px solid #667eea;
      padding: 20px;
      margin: 25px 0;
      border-radius: 4px;
    }

    .info-box p {
      margin-bottom: 10px;
    }

    .info-box p:last-child {
      margin-bottom: 0;
    }

    .info-box strong {
      color: #667eea;
    }

    .warning {
      background-color: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 15px;
      margin: 25px 0;
      border-radius: 4px;
    }

    .warning p {
      color: #856404;
      margin: 0;
      font-size: 14px;
    }

    .footer {
      background-color: #f8f9fa;
      padding: 30px;
      text-align: center;
      border-top: 1px solid #e0e0e0;
    }

    .footer p {
      color: #666;
      font-size: 14px;
      margin-bottom: 10px;
    }

    .footer a {
      color: #667eea;
      text-decoration: none;
    }

    .footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎉 Eventopia</h1>
      <p>Your Event Management Platform</p>
    </div>

    <div class="content">
      <h2>Password Reset Request</h2>

      <p>Hi ${userName || 'there'},</p>

      <p style="margin-top: 20px;">We received a request to reset your password for your Eventopia account. If you made this request, click the button below to create a new password:</p>

      <div class="reset-box">
        <h3>Reset Your Password</h3>
        <a href="${resetLink}" class="reset-link">Reset Password</a>
        <p style="color: white; font-size: 14px; margin-top: 15px;">This link will expire in 1 hour</p>
      </div>

      <div class="token-box">
        <p style="margin-bottom: 10px; font-weight: bold;">Or copy and paste this token:</p>
        <div class="token-code">${resetToken}</div>
      </div>

      <div class="info-box">
        <p><strong>For security reasons:</strong></p>
        <p>• This link will expire in 1 hour</p>
        <p>• This link can only be used once</p>
        <p>• If you didn't request this reset, please ignore this email</p>
      </div>

      <div class="warning">
        <p><strong>⚠️ Important:</strong> If you didn't request a password reset, your account remains secure. No changes have been made yet.</p>
      </div>
    </div>

    <div class="footer">
      <p>© 2024 Eventopia. All rights reserved.</p>
      <p>
        <a href="#">Privacy Policy</a> |
        <a href="#">Terms of Service</a> |
        <a href="#">Support</a>
      </p>
      <p style="margin-top: 15px; font-size: 12px;">
        This is an automated message, please do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Charity Application Requires Review Template (Admin Notification)
 * @param {Object} application - Charity application
 * @param {Object} promoter - Promoter user
 * @param {Object} admin - Admin user
 * @returns {string} - HTML content
 */
function getCharityApplicationRequiresReviewTemplate(application, promoter, admin) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Charity Application - Eventopia</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4; color: #333; line-height: 1.6; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; }
    .header h1 { font-size: 32px; margin-bottom: 10px; }
    .content { padding: 40px 30px; }
    .info-box { background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #667eea; }
    .button { display: inline-block; padding: 12px 30px; background-color: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { background-color: #f8f9fa; padding: 30px; text-align: center; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>New Charity Application</h1>
      <p>Requires your review</p>
    </div>
    <div class="content">
      <p>Dear ${admin.name},</p>
      <p style="margin-top: 20px;">A new charity application has been submitted and requires your review.</p>

      <div class="info-box">
        <h3 style="margin-bottom: 10px;">Application Details</h3>
        <p><strong>Promoter:</strong> ${promoter.name} (${promoter.email})</p>
        <p><strong>Charity:</strong> ${application.charity_name}</p>
        <p><strong>Charity Number:</strong> ${application.charity_number}</p>
        <p><strong>Requested Amount:</strong> £${(application.requested_amount / 100).toFixed(2)}</p>
      </div>

      <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/charity/applications/${application.id}" class="button">Review Application</a>

      <p>Please log in to the admin dashboard to review and make a decision on this application.</p>

      <p style="margin-top: 20px;">Best regards,<br>Eventopia System</p>
    </div>
    <div class="footer">
      <p>© 2024 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Guru Invite Template
 * @param {Object} options - Template options
 * @param {string} options.email - Guru email
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Minutes until expiry
 * @returns {string} - HTML content
 */
function getGuruInviteTemplate({ registrationUrl, expiresInMinutes = 15 }) {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f5f5f5; margin: 0; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { color: #333; margin-bottom: 30px; }
    .header h2 { color: #007bff; margin: 0 0 10px 0; }
    .message { color: #666; line-height: 1.8; margin-bottom: 30px; font-size: 14px; }
    .button-container { text-align: center; margin: 40px 0; }
    .button { background-color: #007bff; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px; }
    .button:hover { background-color: #0056b3; transition: background-color 0.3s; }
    .expiry-warning { background-color: #fff3cd; padding: 12px 15px; border-radius: 4px; color: #856404; margin: 25px 0; font-size: 13px; border-left: 4px solid #ffc107; }
    .footer { border-top: 1px solid #eee; padding-top: 20px; color: #999; font-size: 12px; text-align: center; }
    .link-alternative { color: #999; font-size: 12px; margin-top: 20px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>Welcome to Eventopia! 🎉</h2>
      <p style="margin: 0; color: #666;">You've been invited to become a Guru</p>
    </div>
    
    <div class="message">
      <p>Hello,</p>
      <p>You have been invited to join <strong>Eventopia</strong> as a <strong>Guru partner</strong>. Gurus are key partners who recruit and manage promoters, help coordinate events, and earn commissions.</p>
      <p>To accept this invitation and complete your registration, please click the button below:</p>
    </div>

    <div class="button-container">
      <a href="${registrationUrl}" class="button">✓ Verify Invite & Register</a>
    </div>

    <div class="expiry-warning">
      <strong>⏰ Urgent:</strong> This invitation link expires in <strong>${expiresInMinutes} minutes</strong>. Complete your registration immediately!
    </div>

    <div class="message">
      <p><strong>Having trouble?</strong> Copy and paste this link in your browser:</p>
      <div class="link-alternative">
        ${registrationUrl}
      </div>
    </div>

    <div class="message">
      <p>If you didn't request this invitation or have any questions, please reply to this email.</p>
      <p>Best regards,<br><strong>The Eventopia Team</strong></p>
    </div>

    <div class="footer">
      <p>This is an automated message from Eventopia. Please do not reply directly to this email.</p>
      <p>&copy; 2026 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Guru Invite Resend Template
 * @param {Object} options - Template options
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Minutes until expiry
 * @returns {string} - HTML content
 */
function getGuruInviteResendTemplate({ registrationUrl, expiresInMinutes = 15 }) {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f5f5f5; margin: 0; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { color: #333; margin-bottom: 30px; }
    .header h2 { color: #28a745; margin: 0 0 10px 0; }
    .message { color: #666; line-height: 1.8; margin-bottom: 30px; font-size: 14px; }
    .button-container { text-align: center; margin: 40px 0; }
    .button { background-color: #28a745; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px; }
    .button:hover { background-color: #218838; transition: background-color 0.3s; }
    .expiry-warning { background-color: #fff3cd; padding: 12px 15px; border-radius: 4px; color: #856404; margin: 25px 0; font-size: 13px; border-left: 4px solid #ffc107; }
    .footer { border-top: 1px solid #eee; padding-top: 20px; color: #999; font-size: 12px; text-align: center; }
    .link-alternative { color: #999; font-size: 12px; margin-top: 20px; word-break: break-all; }
    .old-link-note { background-color: #f8d7da; padding: 12px 15px; border-radius: 4px; color: #721c24; margin: 20px 0; font-size: 13px; border-left: 4px solid #dc3545; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>✅ New Eventopia Guru Invitation</h2>
      <p style="margin: 0; color: #666;">Your previous invitation has expired. Here's a fresh one!</p>
    </div>
    
    <div class="message">
      <p>Hello,</p>
      <p>Your previous invitation to join <strong>Eventopia</strong> as a <strong>Guru partner</strong> has expired, but we've sent you a brand new one!</p>
      <p>To complete your registration, please click the button below:</p>
    </div>

    <div class="button-container">
      <a href="${registrationUrl}" class="button">✓ Verify Invite & Register Now</a>
    </div>

    <div class="expiry-warning">
      <strong>⏰ Important:</strong> This invitation link expires in <strong>${expiresInMinutes} minutes</strong>. Don't wait—complete your registration now!
    </div>

    <div class="old-link-note">
      <strong>📌 Note:</strong> Your old invitation link is no longer valid. Please use this new link instead.
    </div>

    <div class="message">
      <p><strong>Copy-paste link (if button doesn't work):</strong></p>
      <div class="link-alternative">
        ${registrationUrl}
      </div>
    </div>

    <div class="message">
      <p>If you didn't request this resend or have any questions, please reply to this email.</p>
      <p>Best regards,<br><strong>The Eventopia Team</strong></p>
    </div>

    <div class="footer">
      <p>&copy; 2026 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Promoter Referral Invite Template
 * @param {Object} options - Template options
 * @param {string} options.guruName - Guru name
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Minutes until expiry
 * @returns {string} - HTML content
 */
function getPromoterReferralInviteTemplate({ guruName = 'Your Guru', registrationUrl, expiresInMinutes = 15 }) {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f5f5f5; margin: 0; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { color: #333; margin-bottom: 30px; }
    .header h2 { color: #007bff; margin: 0 0 10px 0; }
    .message { color: #666; line-height: 1.8; margin-bottom: 30px; font-size: 14px; }
    .button-container { text-align: center; margin: 40px 0; }
    .button { background-color: #007bff; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px; }
    .button:hover { background-color: #0056b3; transition: background-color 0.3s; }
    .expiry-warning { background-color: #fff3cd; padding: 12px 15px; border-radius: 4px; color: #856404; margin: 25px 0; font-size: 13px; border-left: 4px solid #ffc107; }
    .footer { border-top: 1px solid #eee; padding-top: 20px; color: #999; font-size: 12px; text-align: center; }
    .link-alternative { color: #999; font-size: 12px; margin-top: 20px; word-break: break-all; }
    .guru-note { background-color: #e7f3ff; padding: 15px; border-radius: 4px; margin: 20px 0; border-left: 4px solid #007bff; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>🎯 Join Eventopia as a Promoter!</h2>
      <p style="margin: 0; color: #666;">You've been invited by <strong>${guruName}</strong></p>
    </div>
    
    <div class="guru-note">
      <p style="margin: 0;"><strong>${guruName}</strong> has invited you to become a Promoter on Eventopia. As a Promoter, you'll help promote events and earn commissions!</p>
    </div>

    <div class="message">
      <p>Hello,</p>
      <p>You have been invited to join <strong>Eventopia</strong> as a <strong>Promoter partner</strong>. Working with <strong>${guruName}</strong>, you'll promote events, track ticket sales, and unlock rewards.</p>
      <p>To accept this invitation and complete your registration, please click the button below:</p>
    </div>

    <div class="button-container">
      <a href="${registrationUrl}" class="button">✓ Accept Invitation & Register</a>
    </div>

    <div class="expiry-warning">
      <strong>⏰ Urgent:</strong> This invitation link expires in <strong>${expiresInMinutes} minutes</strong>. Complete your registration immediately!
    </div>

    <div class="message">
      <p><strong>Having trouble?</strong> Copy and paste this link in your browser:</p>
      <div class="link-alternative">
        ${registrationUrl}
      </div>
    </div>

    <div class="message">
      <p>If you didn't request this invitation or have any questions, please reply to this email.</p>
      <p>Best regards,<br><strong>The Eventopia Team</strong></p>
    </div>

    <div class="footer">
      <p>This is an automated message from Eventopia. Please do not reply directly to this email.</p>
      <p>&copy; 2026 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Promoter Referral Invite Resend Template
 * @param {Object} options - Template options
 * @param {string} options.guruName - Guru name
 * @param {string} options.registrationUrl - Registration link
 * @param {number} options.expiresInMinutes - Minutes until expiry
 * @returns {string} - HTML content
 */
function getPromoterReferralInviteResendTemplate({ guruName = 'Your Guru', registrationUrl, expiresInMinutes = 15 }) {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f5f5f5; margin: 0; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { color: #333; margin-bottom: 30px; }
    .header h2 { color: #28a745; margin: 0 0 10px 0; }
    .message { color: #666; line-height: 1.8; margin-bottom: 30px; font-size: 14px; }
    .button-container { text-align: center; margin: 40px 0; }
    .button { background-color: #28a745; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px; }
    .button:hover { background-color: #218838; transition: background-color 0.3s; }
    .expiry-warning { background-color: #fff3cd; padding: 12px 15px; border-radius: 4px; color: #856404; margin: 25px 0; font-size: 13px; border-left: 4px solid #ffc107; }
    .footer { border-top: 1px solid #eee; padding-top: 20px; color: #999; font-size: 12px; text-align: center; }
    .link-alternative { color: #999; font-size: 12px; margin-top: 20px; word-break: break-all; }
    .old-link-note { background-color: #f8d7da; padding: 12px 15px; border-radius: 4px; color: #721c24; margin: 20px 0; font-size: 13px; border-left: 4px solid #dc3545; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>✅ New Promoter Referral Invitation</h2>
      <p style="margin: 0; color: #666;">From <strong>${guruName}</strong> - Your link is refreshed!</p>
    </div>
    
    <div class="message">
      <p>Hello,</p>
      <p>Your previous referral invitation to join <strong>Eventopia</strong> as a <strong>Promoter</strong> with <strong>${guruName}</strong> has expired. Here's a brand new one!</p>
      <p>To complete your registration, please click the button below:</p>
    </div>

    <div class="button-container">
      <a href="${registrationUrl}" class="button">✓ Accept Invitation & Register Now</a>
    </div>

    <div class="expiry-warning">
      <strong>⏰ Important:</strong> This invitation link expires in <strong>${expiresInMinutes} minutes</strong>. Complete your registration right away!
    </div>

    <div class="old-link-note">
      <strong>📌 Note:</strong> Your old invitation link is no longer valid. Please use this new link instead.
    </div>

    <div class="message">
      <p><strong>Copy-paste link (if button doesn't work):</strong></p>
      <div class="link-alternative">
        ${registrationUrl}
      </div>
    </div>

    <div class="message">
      <p>Questions? Ask ${guruName} or reply to this email.</p>
      <p>Best regards,<br><strong>The Eventopia Team</strong></p>
    </div>

    <div class="footer">
      <p>&copy; 2026 Eventopia. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}


module.exports = {
  getOtpTemplate,
  getOtpSubject,
  getPurposeText,
  getPasswordResetTemplate,
  getCharityApplicationSubmittedTemplate,
  getCharityApplicationFeePaidTemplate,
  getCharityApplicationApprovedTemplate,
  getCharityApplicationRejectedTemplate,
  getCharityApplicationCompletedTemplate,
  getCharityApplicationRequiresReviewTemplate,
  getGuruInviteTemplate,
  getGuruInviteResendTemplate,
  getPromoterReferralInviteTemplate,
  getPromoterReferralInviteResendTemplate,
};
