const pool = require("../db");
const { startJob, markJobSuccess, markJobFailed } = require("./jobMonitoring.service");
const {
  LICENCE_STATUS,
  PAYMENT_MODE,
  SERVICE_FEE_RATE_UNCLEARED,
  SERVICE_FEE_RATE_CLEARED,
} = require("../config/networkManagerTerritory.config");

/**
 * Stub: Calculate service fee for a given month for Network Manager licences with CLEAR_FROM_EARNINGS.
 * In production, gross_credit would come from credit_ledger CREDIT_EARNED for concluded events.
 * This stub uses 0 gross_credit per licence; it only creates the job structure and statement rows with 0.
 * @param {string} month - YYYY-MM
 */
async function runServiceFeeForMonth(month) {
  const client = await pool.connect();
  let runId = null;
  try {
    runId = await startJob("calcServiceFee", { month });

    const licenceResult = await client.query(
      `SELECT id, user_id, territory_id, licence_balance_remaining, payment_mode
       FROM territory_licences
       WHERE licence_status = $1 AND payment_mode = $2`,
      [LICENCE_STATUS.ACTIVE, PAYMENT_MODE.CLEAR_FROM_EARNINGS]
    );

    for (const lic of licenceResult.rows) {
      const grossCredit = 0;
      const rate = lic.licence_balance_remaining > 0 ? SERVICE_FEE_RATE_UNCLEARED : SERVICE_FEE_RATE_CLEARED;
      const serviceFeeAmount = Math.floor(grossCredit * rate);
      const netCredit = grossCredit - serviceFeeAmount;

      await client.query(
        `INSERT INTO service_fee_statements
           (user_id, role, territory_id, network_licence_id, statement_month, gross_credit, service_fee_rate, service_fee_amount, net_credit)
         VALUES ($1, 'network_manager', $2, $3, $4, $5, $6, $7, $8)`,
        [lic.user_id, lic.territory_id, lic.id, month, grossCredit, rate, serviceFeeAmount, netCredit]
      );

      if (serviceFeeAmount > 0) {
        await client.query(
          `INSERT INTO credit_ledger (user_id, role, territory_id, network_licence_id, entry_type, amount, metadata_json)
           VALUES ($1, 'network_manager', $2, $3, 'SERVICE_FEE_DEDUCTED', $4, $5)`,
          [
            lic.user_id,
            lic.territory_id,
            lic.id,
            -serviceFeeAmount,
            JSON.stringify({ month, rate, gross_credit: grossCredit }),
          ]
        );
      }
    }

    await markJobSuccess(runId);
    return { processed: licenceResult.rowCount };
  } catch (err) {
    console.error("Service fee job error:", err);
    if (runId) {
      await markJobFailed(runId, err.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runServiceFeeForMonth,
};
