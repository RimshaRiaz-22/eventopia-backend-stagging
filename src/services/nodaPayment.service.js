const crypto = require('crypto');

/**
 * Noda Payment Service
 * Handles open banking payment integration (simulated)
 * Note: This is a simulated implementation for testing purposes
 * Replace with actual Noda API integration in production
 */
class NodaPaymentService {
  /**
   * Payment statuses
   */
  static STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
  };

  /**
   * Create a payment intent
   * @param {Object} params - Payment parameters
   * @param {number} params.amount - Amount in pence
   * @param {string} params.currency - Currency (default: GBP)
   * @param {string} params.applicationId - Charity application ID
   * @param {string} params.idempotencyKey - Idempotency key
   * @returns {Promise<Object>} Payment intent
   */
  static async createPaymentIntent({ amount, currency = 'GBP', applicationId, idempotencyKey }) {
    // In production, this would call Noda API
    // For now, generate a simulated payment intent

    const paymentIntentId = 'pi_' + crypto.randomBytes(16).toString('hex');

    return {
      id: paymentIntentId,
      amount: amount,
      currency: currency,
      status: this.STATUS.PENDING,
      metadata: {
        application_id: applicationId,
        type: 'charity_application_fee'
      },
      created_at: new Date(),
      // Simulated redirect URL for open banking
      redirect_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/promoter/charity/apply/result?status=success`,
      // Simulated return URL
      return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/promoter/charity/apply/result`
    };
  }

  /**
   * Get payment intent by ID
   * @param {string} paymentIntentId - Payment intent ID
   * @returns {Promise<Object>} Payment intent
   */
  static async getPaymentIntent(paymentIntentId) {
    // In production, this would call Noda API
    // For now, simulate a successful payment after a delay
    return {
      id: paymentIntentId,
      status: this.STATUS.SUCCEEDED, // Always succeeded in simulation
      amount: 0, // Will be filled by caller
      currency: 'GBP',
      paid_at: new Date(),
      metadata: {
        type: 'charity_application_fee'
      }
    };
  }

  /**
   * Confirm payment (simulated)
   * @param {string} paymentIntentId - Payment intent ID
   * @returns {Promise<Object>} Payment confirmation
   */
  static async confirmPayment(paymentIntentId) {
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      id: paymentIntentId,
      status: this.STATUS.SUCCEEDED,
      paid_at: new Date(),
      metadata: {
        payment_method: 'open_banking',
        provider: 'noda'
      }
    };
  }

  /**
   * Cancel payment
   * @param {string} paymentIntentId - Payment intent ID
   * @returns {Promise<Object>} Cancelled payment
   */
  static async cancelPayment(paymentIntentId) {
    return {
      id: paymentIntentId,
      status: this.STATUS.CANCELLED,
      cancelled_at: new Date()
    };
  }

  /**
   * Verify webhook signature
   * @param {string} payload - Raw payload
   * @param {string} signature - Webhook signature
   * @returns {boolean} Whether signature is valid
   */
  static verifyWebhookSignature(payload, signature) {
    // In production, verify with Noda webhook secret
    // const secret = process.env.NODA_WEBHOOK_SECRET;
    // const computedSignature = crypto
    //   .createHmac('sha256', secret)
    //   .update(payload)
    //   .digest('hex');
    // return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature));

    // For now, return true (always accept in simulation)
    return true;
  }

  /**
   * Parse webhook event
   * @param {Object} payload - Webhook payload
   * @returns {Object} Parsed event
   */
  static parseWebhookEvent(payload) {
    // In production, parse actual Noda webhook
    return {
      id: payload.id || 'evt_' + crypto.randomBytes(16).toString('hex'),
      type: payload.type || 'payment_intent.succeeded',
      data: payload.data || payload,
      created: new Date()
    };
  }

  /**
   * Create refund (if needed)
   * @param {string} paymentIntentId - Original payment intent ID
   * @param {number} amount - Refund amount in pence
   * @param {string} reason - Refund reason
   * @returns {Promise<Object>} Refund object
   */
  static async createRefund(paymentIntentId, amount, reason) {
    const refundId = 'rf_' + crypto.randomBytes(16).toString('hex');

    return {
      id: refundId,
      payment_intent_id: paymentIntentId,
      amount: amount,
      reason: reason,
      status: 'succeeded',
      created_at: new Date()
    };
  }

  /**
   * Get payment methods available
   * @returns {Promise<Array>} Available payment methods
   */
  static async getPaymentMethods() {
    return [
      {
        type: 'open_banking',
        name: 'Pay via your bank',
        description: 'Fast and secure payment through your banking app',
        available: true
      }
    ];
  }

  /**
   * Calculate payment fee (if applicable)
   * @param {number} amount - Payment amount in pence
   * @returns {Promise<number>} Fee amount in pence
   */
  static async calculateFee(amount) {
    // No fee for application fee in this simulation
    return 0;
  }

  /**
   * Validate payment amount
   * @param {number} amount - Amount in pence
   * @returns {boolean} Whether amount is valid
   */
  static isValidAmount(amount) {
    return amount > 0 && amount <= 100000000; // Max £1,000,000
  }

  /**
   * Format amount for display
   * @param {number} amount - Amount in pence
   * @returns {string} Formatted amount
   */
  static formatAmount(amount) {
    const pounds = (amount / 100).toFixed(2);
    return `£${pounds}`;
  }

  /**
   * Parse amount from string
   * @param {string} amountStr - Amount string (e.g., "50.00")
   * @returns {number} Amount in pence
   */
  static parseAmount(amountStr) {
    const amount = parseFloat(amountStr);
    return Math.round(amount * 100);
  }

  /**
   * Generate idempotency key
   * @param {string} prefix - Key prefix
   * @returns {string} Idempotency key
   */
  static generateIdempotencyKey(prefix = 'charity_app_fee') {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    return `${prefix}_${timestamp}_${random}`;
  }

  /**
   * Validate idempotency key
   * @param {string} key - Idempotency key
   * @returns {boolean} Whether key is valid
   */
  static isValidIdempotencyKey(key) {
    return key && key.length > 0 && key.length <= 255;
  }

  /**
   * Get payment status display name
   * @param {string} status - Payment status
   * @returns {string} Display name
   */
  static getStatusDisplayName(status) {
    const statusMap = {
      pending: 'Pending',
      processing: 'Processing',
      succeeded: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled'
    };

    return statusMap[status] || status;
  }
}

module.exports = NodaPaymentService;
