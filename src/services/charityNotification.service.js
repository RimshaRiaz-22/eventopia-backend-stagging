const pool = require("../db");
const { sendEmail } = require('./email.service');
const {
  getCharityApplicationSubmittedTemplate,
  getCharityApplicationFeePaidTemplate,
  getCharityApplicationApprovedTemplate,
  getCharityApplicationRejectedTemplate,
  getCharityApplicationCompletedTemplate,
  getCharityApplicationRequiresReviewTemplate
} = require('../templates/emailTemplates');

/**
 * Charity Notification Service
 * Handles all email notifications for charity pot system
 */
class CharityNotificationService {
  /**
   * Notify promoter of application submission
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @returns {Promise<void>}
   */
  static async notifyApplicationSubmitted(application, promoter) {
    try {
      await sendEmail({
        to: promoter.email,
        subject: "Charity Application Submitted - Eventopia",
        html: getCharityApplicationSubmittedTemplate(application, promoter)
      });
    } catch (err) {
      console.error('Error sending application submitted email:', err);
    }
  }

  /**
   * Notify promoter of fee payment success
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @param {Object} payment - Payment record
   * @returns {Promise<void>}
   */
  static async notifyFeePaid(application, promoter, payment) {
    try {
      await sendEmail({
        to: promoter.email,
        subject: "Charity Application Fee Received - Eventopia",
        html: getCharityApplicationFeePaidTemplate(application, promoter, payment)
      });
    } catch (err) {
      console.error('Error sending fee paid email:', err);
    }
  }

  /**
   * Notify promoter of fee payment failure
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @param {string} failureReason - Failure reason
   * @returns {Promise<void>}
   */
  static async notifyFeeFailed(application, promoter, failureReason) {
    try {
      // Use fee paid template with failure indication
      await sendEmail({
        to: promoter.email,
        subject: "Charity Application Fee Payment Failed - Eventopia",
        html: getCharityApplicationFeePaidTemplate(application, promoter, null, failureReason)
      });
    } catch (err) {
      console.error('Error sending fee failed email:', err);
    }
  }

  /**
   * Notify promoter of application approval
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @param {Object} admin - Admin who approved
   * @returns {Promise<void>}
   */
  static async notifyApproved(application, promoter, admin) {
    try {
      await sendEmail({
        to: promoter.email,
        subject: "Your Charity Application Has Been Approved - Eventopia",
        html: getCharityApplicationApprovedTemplate(application, promoter, admin)
      });
    } catch (err) {
      console.error('Error sending approved email:', err);
    }
  }

  /**
   * Notify promoter of application rejection
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @param {Object} admin - Admin who rejected
   * @param {string} reason - Rejection reason
   * @returns {Promise<void>}
   */
  static async notifyRejected(application, promoter, admin, reason) {
    try {
      await sendEmail({
        to: promoter.email,
        subject: "Update on Your Charity Application - Eventopia",
        html: getCharityApplicationRejectedTemplate(application, promoter, admin, reason)
      });
    } catch (err) {
      console.error('Error sending rejected email:', err);
    }
  }

  /**
   * Notify promoter of application completion
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @param {Array} executions - Execution records
   * @returns {Promise<void>}
   */
  static async notifyCompleted(application, promoter, executions) {
    try {
      await sendEmail({
        to: promoter.email,
        subject: "Your Charity Application Has Been Completed - Eventopia",
        html: getCharityApplicationCompletedTemplate(application, promoter, executions)
      });
    } catch (err) {
      console.error('Error sending completed email:', err);
    }
  }

  /**
   * Notify admins of new application requiring review
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @returns {Promise<void>}
   */
  static async notifyAdminsOfNewApplication(application, promoter) {
    try {
      // Get all admin users
      const adminsResult = await pool.query(
        "SELECT id, email, name FROM users WHERE role = 'admin' AND account_status = 'active'"
      );

      // Get admin users list
      const adminUsers = adminsResult.rows;

      // Send to each admin
      for (const admin of adminUsers) {
        await sendEmail({
          to: admin.email,
          subject: "New Charity Application Requires Review - Eventopia",
          html: getCharityApplicationRequiresReviewTemplate(application, promoter, admin)
        });
      }
    } catch (err) {
      console.error('Error sending admin notification email:', err);
    }
  }

  /**
   * Notify admins of fee payment for an application
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @param {Object} payment - Payment record
   * @returns {Promise<void>}
   */
  static async notifyAdminsOfFeePayment(application, promoter, payment) {
    try {
      // Get all admin users
      const adminsResult = await pool.query(
        "SELECT id, email, name FROM users WHERE role = 'admin' AND account_status = 'active'"
      );

      const adminUsers = adminsResult.rows;

      // Send to each admin (simple notification without special template)
      for (const admin of adminUsers) {
        await sendEmail({
          to: admin.email,
          subject: "Charity Application Fee Paid - Eventopia",
          html: `
            <p>Dear ${admin.name},</p>
            <p>A charity application fee has been paid.</p>
            <p><strong>Application:</strong> ${application.charity_name}</p>
            <p><strong>Promoter:</strong> ${promoter.name} (${promoter.email})</p>
            <p><strong>Amount:</strong> £${(payment.amount / 100).toFixed(2)}</p>
            <p>The application is now ready for review in the admin dashboard.</p>
            <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/charity/applications/${application.id}">View Application</a></p>
          `
        });
      }
    } catch (err) {
      console.error('Error sending admin fee payment email:', err);
    }
  }

  /**
   * Send bulk notification to multiple recipients
   * @param {Array} recipients - Array of email addresses
   * @param {string} subject - Email subject
   * @param {string} html - Email HTML content
   * @returns {Promise<void>}
   */
  static async sendBulkNotification(recipients, subject, html) {
    try {
      for (const recipient of recipients) {
        await sendEmail({
          to: recipient,
          subject: subject,
          html: html
        });
      }
    } catch (err) {
      console.error('Error sending bulk notification:', err);
    }
  }

  /**
   * Notify promoter about application status change
   * @param {Object} application - Charity application
   * @param {Object} promoter - Promoter user
   * @param {string} previousStatus - Previous status
   * @returns {Promise<void>}
   */
  static async notifyStatusChange(application, promoter, previousStatus) {
    try {
      // Determine notification type based on status
      switch (application.status) {
        case 'APPROVED':
          await this.notifyApproved(application, promoter, null);
          break;
        case 'PARTIAL_APPROVED':
          await this.notifyApproved(application, promoter, null); // Reuse approved template
          break;
        case 'REJECTED':
          await this.notifyRejected(application, promoter, null, application.rejection_reason);
          break;
        case 'COMPLETED':
          // Get executions for completion notification
          const executionsResult = await pool.query(
            `SELECT * FROM charity_pot_executions
             WHERE application_id = $1 AND status = 'completed'
             ORDER BY created_at DESC`,
            [application.id]
          );
          await this.notifyCompleted(application, promoter, executionsResult.rows);
          break;
        default:
          // No specific notification for other status changes
          break;
      }
    } catch (err) {
      console.error('Error sending status change notification:', err);
    }
  }
}

module.exports = CharityNotificationService;
