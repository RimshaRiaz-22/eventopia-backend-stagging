/**
 * Guru Risk Score Service
 * Explainable risk scoring based on refund rates and trends.
 * - High: quarter_refund_rate > 8% (Level 2 threshold)
 * - Medium: rising trend (refund rate increasing vs prior period)
 * - Low: otherwise
 */

const REFUND_RATE_HIGH_THRESHOLD = 8; // percent
const RISK_LEVEL_HIGH = "high";
const RISK_LEVEL_MEDIUM = "medium";
const RISK_LEVEL_LOW = "low";

const REASON_QUARTER_REFUND_RATE_HIGH = "quarter_refund_rate_high";
const REASON_REFUND_RATE_RISING = "refund_rate_rising";

/**
 * Compute risk score for a guru
 * @param {Object} params
 * @param {number} params.quarterRefundRate - Current quarter refund rate (percent)
 * @param {number|null} params.priorQuarterRefundRate - Prior quarter refund rate (percent)
 * @returns {{ risk_score: number, risk_level: string, risk_reasons: string[] }}
 */
function compute(params) {
  const { quarterRefundRate = 0, priorQuarterRefundRate = null } = params;
  const risk_reasons = [];

  if (quarterRefundRate > REFUND_RATE_HIGH_THRESHOLD) {
    risk_reasons.push(REASON_QUARTER_REFUND_RATE_HIGH);
  }

  if (
    priorQuarterRefundRate != null &&
    quarterRefundRate > priorQuarterRefundRate &&
    quarterRefundRate >= 1
  ) {
    risk_reasons.push(REASON_REFUND_RATE_RISING);
  }

  let risk_level = RISK_LEVEL_LOW;
  let risk_score = 0;

  if (risk_reasons.includes(REASON_QUARTER_REFUND_RATE_HIGH)) {
    risk_level = RISK_LEVEL_HIGH;
    risk_score = Math.min(100, 50 + Math.round(quarterRefundRate));
  } else if (risk_reasons.includes(REASON_REFUND_RATE_RISING)) {
    risk_level = RISK_LEVEL_MEDIUM;
    risk_score = 30 + Math.min(20, Math.round(quarterRefundRate));
  } else {
    risk_score = Math.min(25, Math.round(quarterRefundRate * 2));
  }

  return {
    risk_score,
    risk_level,
    risk_reasons,
  };
}

module.exports = {
  REFUND_RATE_HIGH_THRESHOLD,
  compute,
};
