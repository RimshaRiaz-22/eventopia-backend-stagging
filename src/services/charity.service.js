const pool = require("../db");
const CharityLedgerService = require("./charityLedger.service");
const { logCharityChange } = require("../middlewares/audit.middleware");

/**
 * Charity Service
 * Handles charity application logic, status transitions, and validation
 */
class CharityService {
  /**
   * Valid status transitions
   */
  static VALID_TRANSITIONS = {
    DRAFT: ['SUBMITTED', 'cancelled'],
    SUBMITTED: ['UNDER_REVIEW', 'cancelled'],
    UNDER_REVIEW: ['APPROVED', 'PARTIAL_APPROVED', 'REJECTED', 'cancelled'],
    APPROVED: ['COMPLETED', 'cancelled'],
    PARTIAL_APPROVED: ['COMPLETED', 'cancelled'],
    REJECTED: ['cancelled'],
    COMPLETED: [],
    cancelled: []
  };

  /**
   * Application fee amount in pence
   */
  static APPLICATION_FEE = parseInt(process.env.CHARITY_APPLICATION_FEE_AMOUNT || '5000'); // Default 50 GBP

  /**
   * Create a new charity application
   * @param {Object} applicationData - Application data
   * @param {number} promoterId - Promoter user ID
   * @returns {Promise<Object>} Created application
   */
  static async createApplication(applicationData, promoterId) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO charity_applications
          (promoter_id, event_id, charity_name, charity_number, charity_description,
           charity_website, charitable_objectives, beneficiary_details, requested_amount,
           application_fee_amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'DRAFT')
         RETURNING *`,
        [
          promoterId,
          applicationData.event_id || null,
          applicationData.charity_name,
          applicationData.charity_number,
          applicationData.charity_description,
          applicationData.charity_website || null,
          applicationData.charitable_objectives,
          applicationData.beneficiary_details || null,
          applicationData.requested_amount,
          this.APPLICATION_FEE
        ]
      );

      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Get charity application by ID
   * @param {number} applicationId - Application ID
   * @param {number} promoterId - Promoter user ID (for access check)
   * @returns {Promise<Object>} Application
   */
  static async getApplication(applicationId, promoterId) {
    const result = await pool.query(
      `SELECT
         ca.*,
         u.name as promoter_name,
         u.email as promoter_email,
         e.title as event_title
       FROM charity_applications ca
       JOIN users u ON u.id = ca.promoter_id
       LEFT JOIN events e ON e.id = ca.event_id
       WHERE ca.id = $1 AND ca.promoter_id = $2`,
      [applicationId, promoterId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get charity application for admin (no promoter check)
   * @param {number} applicationId - Application ID
   * @returns {Promise<Object>} Application
   */
  static async getApplicationForAdmin(applicationId) {
    const result = await pool.query(
      `SELECT
         ca.*,
         u.name as promoter_name,
         u.email as promoter_email,
         e.title as event_title
       FROM charity_applications ca
       JOIN users u ON u.id = ca.promoter_id
       LEFT JOIN events e ON e.id = ca.event_id
       WHERE ca.id = $1`,
      [applicationId]
    );

    return result.rows[0] || null;
  }

  /**
   * List charity applications for a promoter
   * @param {number} promoterId - Promoter user ID
   * @param {Object} filters - Filter options
   * @returns {Promise<Array>} Applications list
   */
  static async listApplications(promoterId, filters = {}) {
    const params = [promoterId];
    let whereClause = 'WHERE ca.promoter_id = $1';

    if (filters.status) {
      params.push(filters.status);
      whereClause += ` AND ca.status = $${params.length}`;
    }

    if (filters.event_id) {
      params.push(filters.event_id);
      whereClause += ` AND ca.event_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         ca.*,
         e.title as event_title
       FROM charity_applications ca
       LEFT JOIN events e ON e.id = ca.event_id
       ${whereClause}
       ORDER BY ca.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit || 20, filters.offset || 0]
    );

    return result.rows;
  }

  /**
   * Update a draft application
   * @param {number} applicationId - Application ID
   * @param {number} promoterId - Promoter user ID
   * @param {Object} updateData - Data to update
   * @returns {Promise<Object>} Updated application
   */
  static async updateDraftApplication(applicationId, promoterId, updateData) {
    const client = await pool.connect();
    try {
      // Check if application exists and is in DRAFT status
      const checkResult = await client.query(
        'SELECT status FROM charity_applications WHERE id = $1 AND promoter_id = $2',
        [applicationId, promoterId]
      );

      if (checkResult.rowCount === 0) {
        throw new Error('Application not found');
      }

      if (checkResult.rows[0].status !== 'DRAFT') {
        throw new Error('Only DRAFT applications can be updated');
      }

      const result = await client.query(
        `UPDATE charity_applications
         SET charity_name = $1,
             charity_number = $2,
             charity_description = $3,
             charity_website = $4,
             charitable_objectives = $5,
             beneficiary_details = $6,
             requested_amount = $7,
             updated_at = NOW()
         WHERE id = $8 AND promoter_id = $9
         RETURNING *`,
        [
          updateData.charity_name,
          updateData.charity_number,
          updateData.charity_description,
          updateData.charity_website || null,
          updateData.charitable_objectives,
          updateData.beneficiary_details || null,
          updateData.requested_amount,
          applicationId,
          promoterId
        ]
      );

      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Submit an application for review
   * @param {number} applicationId - Application ID
   * @param {number} promoterId - Promoter user ID
   * @returns {Promise<Object>} Updated application
   */
  static async submitApplication(applicationId, promoterId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if application exists and is in DRAFT status
      const checkResult = await client.query(
        'SELECT status FROM charity_applications WHERE id = $1 AND promoter_id = $2',
        [applicationId, promoterId]
      );

      if (checkResult.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Application not found');
      }

      if (checkResult.rows[0].status !== 'DRAFT') {
        await client.query('ROLLBACK');
        throw new Error('Only DRAFT applications can be submitted');
      }

      const result = await client.query(
        `UPDATE charity_applications
         SET status = 'SUBMITTED',
             submitted_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND promoter_id = $2
         RETURNING *`,
        [applicationId, promoterId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Validate status transition
   * @param {string} currentStatus - Current status
   * @param {string} newStatus - Desired new status
   * @returns {boolean} Whether transition is valid
   */
  static isValidTransition(currentStatus, newStatus) {
    const allowed = this.VALID_TRANSITIONS[currentStatus] || [];
    return allowed.includes(newStatus);
  }

  /**
   * Check if application can transition to new status
   * @param {number} applicationId - Application ID
   * @param {string} newStatus - Desired new status
   * @returns {Promise<boolean>} Whether transition is valid
   */
  static async canTransition(applicationId, newStatus) {
    const result = await pool.query(
      'SELECT status FROM charity_applications WHERE id = $1',
      [applicationId]
    );

    if (result.rowCount === 0) {
      return false;
    }

    const currentStatus = result.rows[0].status;
    return this.isValidTransition(currentStatus, newStatus);
  }

  /**
   * Get charity pot balance from ledger
   * @returns {Promise<number>} Balance in pence
   */
  static async getCharityPotBalance() {
    const result = await pool.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN transaction_type = 'credit' THEN amount
           WHEN transaction_type = 'debit' THEN -amount
           ELSE 0
         END
       ), 0) as balance
       FROM charity_pot_ledger
       WHERE account = 'Charity_Pot_Payable'`
    );

    return parseInt(result.rows[0].balance || 0);
  }

  /**
   * List applications for admin with filters
   * @param {Object} filters - Filter options
   * @returns {Promise<Array>} Applications list
   */
  static async listApplicationsForAdmin(filters = {}) {
    const params = [];
    let whereClause = 'WHERE 1=1';

    if (filters.status) {
      params.push(filters.status);
      whereClause += ` AND ca.status = $${params.length}`;
    }

    if (filters.promoter_id) {
      params.push(filters.promoter_id);
      whereClause += ` AND ca.promoter_id = $${params.length}`;
    }

    if (filters.date_from) {
      params.push(filters.date_from);
      whereClause += ` AND ca.created_at >= $${params.length}`;
    }

    if (filters.date_to) {
      params.push(filters.date_to);
      whereClause += ` AND ca.created_at <= $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         ca.*,
         u.name as promoter_name,
         u.email as promoter_email,
         e.title as event_title
       FROM charity_applications ca
       JOIN users u ON u.id = ca.promoter_id
       LEFT JOIN events e ON e.id = ca.event_id
       ${whereClause}
       ORDER BY ca.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit || 50, filters.offset || 0]
    );

    return result.rows;
  }

  /**
   * Approve a charity application
   * @param {number} applicationId - Application ID
   * @param {number} adminId - Admin user ID
   * @param {number} decisionAmount - Approved amount in pence
   * @param {string} adminNotes - Admin notes
   * @returns {Promise<Object>} Updated application
   */
  static async approveApplication(applicationId, adminId, decisionAmount, adminNotes) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get application
      const appResult = await client.query(
        'SELECT * FROM charity_applications WHERE id = $1',
        [applicationId]
      );

      if (appResult.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Application not found');
      }

      const application = appResult.rows[0];

      // Validate transition
      if (!this.isValidTransition(application.status, 'APPROVED')) {
        await client.query('ROLLBACK');
        throw new Error(`Cannot transition from ${application.status} to APPROVED`);
      }

      // Validate amount
      if (decisionAmount > application.requested_amount) {
        await client.query('ROLLBACK');
        throw new Error('Decision amount cannot exceed requested amount');
      }

      // Check charity pot balance (optional - can be checked at execution time instead)
      const currentBalance = await this.getCharityPotBalance();
      if (decisionAmount > currentBalance) {
        await client.query('ROLLBACK');
        throw new Error(`Insufficient charity pot balance. Available: ${currentBalance}, Requested: ${decisionAmount}`);
      }

      // Record decision
      await client.query(
        `INSERT INTO charity_application_decisions
          (application_id, decision, decision_amount, admin_notes, decided_by)
         VALUES ($1, 'approved', $2, $3, $4)`,
        [applicationId, decisionAmount, adminNotes, adminId]
      );

      // Update application
      const result = await client.query(
        `UPDATE charity_applications
         SET status = 'APPROVED',
             decision_amount = $1,
             admin_notes = $2,
             reviewed_by = $3,
             reviewed_at = NOW(),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [decisionAmount, adminNotes, adminId, applicationId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Partially approve a charity application
   * @param {number} applicationId - Application ID
   * @param {number} adminId - Admin user ID
   * @param {number} decisionAmount - Partial amount in pence
   * @param {string} adminNotes - Admin notes
   * @returns {Promise<Object>} Updated application
   */
  static async partialApproveApplication(applicationId, adminId, decisionAmount, adminNotes) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get application
      const appResult = await client.query(
        'SELECT * FROM charity_applications WHERE id = $1',
        [applicationId]
      );

      if (appResult.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Application not found');
      }

      const application = appResult.rows[0];

      // Validate transition
      if (!this.isValidTransition(application.status, 'PARTIAL_APPROVED')) {
        await client.query('ROLLBACK');
        throw new Error(`Cannot transition from ${application.status} to PARTIAL_APPROVED`);
      }

      // Validate amount
      if (decisionAmount > application.requested_amount) {
        await client.query('ROLLBACK');
        throw new Error('Decision amount cannot exceed requested amount');
      }

      if (decisionAmount === application.requested_amount) {
        await client.query('ROLLBACK');
        throw new Error('Use approve instead of partial_approve for full amount');
      }

      // Check charity pot balance
      const currentBalance = await this.getCharityPotBalance();
      if (decisionAmount > currentBalance) {
        await client.query('ROLLBACK');
        throw new Error(`Insufficient charity pot balance. Available: ${currentBalance}, Requested: ${decisionAmount}`);
      }

      // Record decision
      await client.query(
        `INSERT INTO charity_application_decisions
          (application_id, decision, decision_amount, admin_notes, decided_by)
         VALUES ($1, 'partial_approved', $2, $3, $4)`,
        [applicationId, decisionAmount, adminNotes, adminId]
      );

      // Update application
      const result = await client.query(
        `UPDATE charity_applications
         SET status = 'PARTIAL_APPROVED',
             decision_amount = $1,
             admin_notes = $2,
             reviewed_by = $3,
             reviewed_at = NOW(),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [decisionAmount, adminNotes, adminId, applicationId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reject a charity application
   * @param {number} applicationId - Application ID
   * @param {number} adminId - Admin user ID
   * @param {string} rejectionReason - Reason for rejection
   * @param {string} adminNotes - Admin notes
   * @returns {Promise<Object>} Updated application
   */
  static async rejectApplication(applicationId, adminId, rejectionReason, adminNotes) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get application
      const appResult = await client.query(
        'SELECT * FROM charity_applications WHERE id = $1',
        [applicationId]
      );

      if (appResult.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Application not found');
      }

      const application = appResult.rows[0];

      // Validate transition
      if (!this.isValidTransition(application.status, 'REJECTED')) {
        await client.query('ROLLBACK');
        throw new Error(`Cannot transition from ${application.status} to REJECTED`);
      }

      // Record decision
      await client.query(
        `INSERT INTO charity_application_decisions
          (application_id, decision, rejection_reason, admin_notes, decided_by)
         VALUES ($1, 'rejected', $2, $3, $4)`,
        [applicationId, rejectionReason, adminNotes, adminId]
      );

      // Update application
      const result = await client.query(
        `UPDATE charity_applications
         SET status = 'REJECTED',
             rejection_reason = $1,
             admin_notes = $2,
             reviewed_by = $3,
             reviewed_at = NOW(),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [rejectionReason, adminNotes, adminId, applicationId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Mark application as completed (after all executions are done)
   * @param {number} applicationId - Application ID
   * @returns {Promise<Object>} Updated application
   */
  static async markAsCompleted(applicationId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if application exists and is approved
      const appResult = await client.query(
        'SELECT status FROM charity_applications WHERE id = $1',
        [applicationId]
      );

      if (appResult.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Application not found');
      }

      const application = appResult.rows[0];

      if (application.status !== 'APPROVED' && application.status !== 'PARTIAL_APPROVED') {
        await client.query('ROLLBACK');
        throw new Error('Only APPROVED or PARTIAL_APPROVED applications can be completed');
      }

      // Check if all executions are completed
      const executionsResult = await client.query(
        `SELECT status
         FROM charity_pot_executions
         WHERE application_id = $1 AND status != 'cancelled'`,
        [applicationId]
      );

      for (const execution of executionsResult.rows) {
        if (execution.status !== 'completed') {
          await client.query('ROLLBACK');
          throw new Error('All executions must be completed before marking application as completed');
        }
      }

      // Update application
      const result = await client.query(
        `UPDATE charity_applications
         SET status = 'COMPLETED',
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [applicationId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get executions for an application
   * @param {number} applicationId - Application ID
   * @returns {Promise<Array>} Executions list
   */
  static async getExecutions(applicationId) {
    const result = await pool.query(
      `SELECT *
       FROM charity_pot_executions
       WHERE application_id = $1
       ORDER BY created_at DESC`,
      [applicationId]
    );

    return result.rows;
  }

  /**
   * Mark execution as completed (writes ledger entry)
   * @param {number} executionId - Execution ID
   * @param {number} adminId - Admin user ID
   * @param {string} providerReference - Provider reference
   * @returns {Promise<Object>} Updated execution
   */
  static async markExecutionCompleted(executionId, adminId, providerReference) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get execution
      const execResult = await client.query(
        'SELECT * FROM charity_pot_executions WHERE id = $1',
        [executionId]
      );

      if (execResult.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Execution not found');
      }

      const execution = execResult.rows[0];

      // Check if already completed
      if (execution.status === 'completed') {
        await client.query('ROLLBACK');
        throw new Error('Execution is already completed');
      }

      // Check if pending
      if (execution.status !== 'pending') {
        await client.query('ROLLBACK');
        throw new Error('Only pending executions can be marked as completed');
      }

      // Update execution status
      const updateResult = await client.query(
        `UPDATE charity_pot_executions
         SET status = 'completed',
             execution_reference = $1,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [providerReference || null, executionId]
      );

      const updatedExecution = updateResult.rows[0];

      // Write ledger entry (this is the key spec requirement - ledger entry ONLY when completed)
      await CharityLedgerService.recordExecutionPayout(
        execution.application_id,
        execution.id,
        execution.amount,
        execution.recipient_name,
        execution.recipient_type,
        adminId
      );

      await client.query('COMMIT');
      return updatedExecution;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Complete charity application (after all executions are done)
   * @param {number} applicationId - Application ID
   * @returns {Promise<Object>} Updated application
   */
  static async completeCharityApplication(applicationId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get application
      const appResult = await client.query(
        'SELECT status FROM charity_applications WHERE id = $1',
        [applicationId]
      );

      if (appResult.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Application not found');
      }

      const application = appResult.rows[0];

      // Check if all executions are completed
      const executionsResult = await client.query(
        `SELECT status
         FROM charity_pot_executions
         WHERE application_id = $1 AND status != 'cancelled'`,
        [applicationId]
      );

      for (const execution of executionsResult.rows) {
        if (execution.status !== 'completed') {
          await client.query('ROLLBACK');
          throw new Error('All executions must be completed before marking application as completed');
        }
      }

      // Update application with completed_at
      const result = await client.query(
        `UPDATE charity_applications
         SET status = 'COMPLETED',
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [applicationId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = CharityService;
