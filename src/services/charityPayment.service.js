const pool = require("../db");
const NodaPaymentService = require("./nodaPayment.service");
const CharityService = require("./charity.service");
const CharityLedgerService = require("./charityLedger.service");

/**
 * Charity Payment Service
 * Handles payment processing for charity application fees
 */
class CharityPaymentService {
  /**
   * Create payment intent for charity application fee
   * @param {number} applicationId - Charity application ID
   * @param {number} promoterId - Promoter user ID
   * @param {string} idempotencyKey - Idempotency key
   * @returns {Promise<Object>} Payment intent and redirect URL
   */
  static async createPaymentIntent(applicationId, promoterId, idempotencyKey) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get application and verify it can accept payment
      const application = await CharityService.getApplication(applicationId, promoterId);
      if (!application) {
        throw new Error('Application not found');
      }

      if (application.status !== 'SUBMITTED') {
        throw new Error('Application must be in SUBMITTED status to pay fee');
      }

      // Check if payment already exists and succeeded
      const existingPaymentResult = await client.query(
        `SELECT * FROM charity_application_payments
         WHERE application_id = $1 AND status = 'succeeded'`,
        [applicationId]
      );

      if (existingPaymentResult.rowCount > 0) {
        throw new Error('Fee already paid for this application');
      }

      // Check for pending payment with same idempotency key
      if (idempotencyKey) {
        const idempotentPayment = await client.query(
          `SELECT * FROM charity_application_payments
           WHERE idempotency_key = $1`,
          [idempotencyKey]
        );

        if (idempotentPayment.rowCount > 0) {
          // Return existing payment
          await client.query('COMMIT');
          return {
            payment: idempotentPayment.rows[0],
            redirect_url: null // Payment already completed
          };
        }
      }

      // Create payment record
      const paymentResult = await client.query(
        `INSERT INTO charity_application_payments
          (application_id, amount, currency, payment_provider, payment_method, status, idempotency_key)
         VALUES ($1, $2, 'GBP', 'noda', 'open_banking', 'pending', $3)
         RETURNING *`,
        [applicationId, application.application_fee_amount, idempotencyKey]
      );

      const payment = paymentResult.rows[0];

      // Create payment intent with Noda
      const paymentIntent = await NodaPaymentService.createPaymentIntent({
        amount: application.application_fee_amount,
        currency: 'GBP',
        applicationId: applicationId,
        idempotencyKey: idempotencyKey
      });

      // Update payment record with payment intent ID
      await client.query(
        `UPDATE charity_application_payments
         SET payment_intent_id = $1
         WHERE id = $2`,
        [paymentIntent.id, payment.id]
      );

      await client.query('COMMIT');

      return {
        payment_id: payment.id,
        payment_intent_id: paymentIntent.id,
        amount: payment.amount,
        currency: payment.currency,
        redirect_url: paymentIntent.redirect_url
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Confirm payment success (called by webhook or callback)
   * @param {string} paymentIntentId - Noda payment intent ID
   * @param {Object} providerData - Provider data
   * @returns {Promise<Object>} Updated payment and application
   */
  static async confirmPayment(paymentIntentId, providerData = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get payment record
      const paymentResult = await client.query(
        `SELECT * FROM charity_application_payments
         WHERE payment_intent_id = $1`,
        [paymentIntentId]
      );

      if (paymentResult.rowCount === 0) {
        throw new Error('Payment not found');
      }

      const payment = paymentResult.rows[0];

      // Check if already processed
      if (payment.status === 'succeeded') {
        await client.query('COMMIT');
        return { payment, application: null, duplicate: true };
      }

      // Update payment status
      const updatedPaymentResult = await client.query(
        `UPDATE charity_application_payments
         SET status = 'succeeded',
             provider_data = $1,
             paid_at = NOW(),
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify(providerData), payment.id]
      );

      const updatedPayment = updatedPaymentResult.rows[0];

      // Get application
      const application = await CharityService.getApplicationForAdmin(payment.application_id);
      if (!application) {
        throw new Error('Application not found');
      }

      // Update application status - move to UNDER_REVIEW after fee is paid
      const updatedApplicationResult = await client.query(
        `UPDATE charity_applications
         SET status = 'UNDER_REVIEW',
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [payment.application_id]
      );

      const updatedApplication = updatedApplicationResult.rows[0];

      // Record ledger entry for the fee
      await CharityLedgerService.recordApplicationFee(
        payment.application_id,
        payment.id,
        payment.amount,
        null // System-generated
      );

      await client.query('COMMIT');

      return {
        payment: updatedPayment,
        application: updatedApplication,
        duplicate: false
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Mark payment as failed
   * @param {string} paymentIntentId - Noda payment intent ID
   * @param {string} failureReason - Reason for failure
   * @returns {Promise<Object>} Updated payment
   */
  static async markPaymentFailed(paymentIntentId, failureReason) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get payment record
      const paymentResult = await client.query(
        `SELECT * FROM charity_application_payments
         WHERE payment_intent_id = $1`,
        [paymentIntentId]
      );

      if (paymentResult.rowCount === 0) {
        throw new Error('Payment not found');
      }

      const payment = paymentResult.rows[0];

      // Update payment status
      const updatedPaymentResult = await client.query(
        `UPDATE charity_application_payments
         SET status = 'failed',
             provider_data = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify({ failure_reason: failureReason }), payment.id]
      );

      // Update application status back to SUBMITTED
      await client.query(
        `UPDATE charity_applications
         SET status = 'SUBMITTED',
             updated_at = NOW()
         WHERE id = $1`,
        [payment.application_id]
      );

      await client.query('COMMIT');

      return updatedPaymentResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get payment by ID
   * @param {number} paymentId - Payment ID
   * @returns {Promise<Object>} Payment
   */
  static async getPayment(paymentId) {
    const result = await pool.query(
      `SELECT
         cap.*,
         ca.charity_name,
         ca.promoter_id
       FROM charity_application_payments cap
       JOIN charity_applications ca ON ca.id = cap.application_id
       WHERE cap.id = $1`,
      [paymentId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get payments for application
   * @param {number} applicationId - Application ID
   * @returns {Promise<Array>} Payments
   */
  static async getPaymentsForApplication(applicationId) {
    const result = await pool.query(
      `SELECT *
       FROM charity_application_payments
       WHERE application_id = $1
       ORDER BY created_at DESC`,
      [applicationId]
    );

    return result.rows;
  }

  /**
   * Cancel payment
   * @param {number} paymentId - Payment ID
   * @returns {Promise<Object>} Cancelled payment
   */
  static async cancelPayment(paymentId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get payment
      const paymentResult = await client.query(
        'SELECT * FROM charity_application_payments WHERE id = $1',
        [paymentId]
      );

      if (paymentResult.rowCount === 0) {
        throw new Error('Payment not found');
      }

      const payment = paymentResult.rows[0];

      if (payment.status === 'succeeded') {
        throw new Error('Cannot cancel a successful payment');
      }

      // Update payment status
      const result = await client.query(
        `UPDATE charity_application_payments
         SET status = 'cancelled',
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [paymentId]
      );

      // Update application status back to SUBMITTED
      await client.query(
        `UPDATE charity_applications
         SET status = 'SUBMITTED',
             updated_at = NOW()
         WHERE id = $1`,
        [payment.application_id]
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
   * Process webhook event
   * @param {Object} event - Webhook event
   * @returns {Promise<Object>} Processing result
   */
  static async processWebhookEvent(event) {
    // Verify webhook signature would be done here in production
    // const signature = req.headers['noda-signature'];
    // if (!NodaPaymentService.verifyWebhookSignature(req.body, signature)) {
    //   throw new Error('Invalid webhook signature');
    // }

    const parsedEvent = NodaPaymentService.parseWebhookEvent(event);

    if (parsedEvent.type === 'payment_intent.succeeded') {
      const paymentIntentId = parsedEvent.data.id;
      return await this.confirmPayment(paymentIntentId, parsedEvent.data);
    }

    if (parsedEvent.type === 'payment_intent.payment_failed') {
      const paymentIntentId = parsedEvent.data.id;
      const failureReason = parsedEvent.data.failure_reason || 'Unknown';
      return await this.markPaymentFailed(paymentIntentId, failureReason);
    }

    return { event_type: parsedEvent.type, processed: false };
  }

  /**
   * Validate idempotency key
   * @param {string} idempotencyKey - Idempotency key
   * @returns {boolean} Whether key is valid
   */
  static isValidIdempotencyKey(idempotencyKey) {
    return NodaPaymentService.isValidIdempotencyKey(idempotencyKey);
  }

  /**
   * Generate idempotency key
   * @returns {string} Idempotency key
   */
  static generateIdempotencyKey() {
    return NodaPaymentService.generateIdempotencyKey('charity_fee');
  }
}

module.exports = CharityPaymentService;
