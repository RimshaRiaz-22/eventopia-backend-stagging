const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");
const GURU_LICENCE_TOTAL = 295;

/**
 * Get Guru License Information
 * GET /gurus/license/info
 * 
 * Returns:
 * - Base licence model
 * - Service fee rules for Level 1
 * - Level 3 enhanced licence info
 * - Contract terms (12 months from activation)
 */
async function getLicenseInfo(req, res) {
  try {
    const guruId = req.user.id;
// guru
    // Get guru application and level
    const appResult = await pool.query(
      `SELECT ga.*, gl.level, gl.achieved_at
       FROM guru_applications ga
       LEFT JOIN guru_levels gl ON gl.user_id = $1
       WHERE ga.user_id = $1
       ORDER BY gl.achieved_at DESC NULLS LAST
       LIMIT 1`,
      [guruId]
    );

    if (appResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Guru application not found");
    }

    const app = appResult.rows[0];
    const currentLevel = app.level ? parseInt(app.level) : 1;
    const activationDate = app.achieved_at || new Date();

    // Calculate contract end date (12 months from activation)
    const contractStartDate = new Date(activationDate);
    const contractEndDate = new Date(contractStartDate);
    contractEndDate.setFullYear(contractEndDate.getFullYear() + 1);

    const licenseInfo = {
      baseLicense: {
        model: 'Base Guru Licence',
        description: 'Foundation level access to the Eventopia Guru platform',
        serviceFeeName: 'Guru Activation Fee',
        serviceFee: {
          amount: 25000, // In pence
          currency: 'GBP',
          displayAmount: '£250'
        },
        paymentOptions: [
          {
            option: 'upfront',
            label: 'Pay Upfront',
            description: 'Pay the full fee immediately to activate',
            reference: 'commit_activation_fee with choice: upfront'
          },
          {
            option: 'negative_balance',
            label: 'From Earnings',
            description: 'Pay from earned commissions (earnings credit)',
            reference: 'commit_activation_fee with choice: negative_balance'
          }
        ],
        levelsCovered: [1]
      },
      level1Details: {
        tier: 'Level 1: Base Guru',
        description: 'Entry-level guru with base licensing',
        features: [
          'Access to recruit promoters',
          'Basic referral tools and tracking',
          'Marketing Hub with content submissions',
          'Performance dashboard',
          'Commission tracking',
          'Referral rewards'
        ],
        serviceFeeCleared: 'Fee is cleared from earned credit as you generate commission',
        clearingMechanism: 'Commission earned through ticket sales and referrals reduces your activation fee balance',
        ticketCommissionRate: '8% of ticket sales',
        cashWithdrawal: false,
        cashWithdrawalExplainer: 'Not available at Level 1. Unlock at Level 3'
      },
      level3EnhancedLicense: {
        tier: 'Level 3: Master Guru',
        description: 'Premium licence with cash withdrawal privileges',
        licenseType: 'Enhanced Licence',
        licenseFeatures: [
          'All Level 2 features',
          '🔓 CASH WITHDRAWAL PRIVILEGES (Locked at Levels 1-2)',
          'Premium analytics dashboard',
          'Co-marketing opportunities',
          'Featured on platform',
          'Dedicated premium support'
        ],
        cashWithdrawalPrivileges: {
          unlocked: true,
          description: 'Withdraw commissions directly to your bank account',
          minimumWithdrawal: 5000, // In pence
          withdrawalFee: '2.5%',
          processingTime: '2-3 business days'
        },
        requirements: {
          progression: 'Earned through performance, not a simple paid upgrade',
          method: 'Complete Sprint Mode push from Level 2',
          method2: 'Demonstrated consistent performance and network growth',
          estimatedTime: '90-day rolling window during Sprint Mode'
        }
      },
      contractTerms: {
        contractPeriod: '12 months from activation',
        startDate: contractStartDate.toISOString().split('T')[0],
        endDate: contractEndDate.toISOString().split('T')[0],
        autoRenewal: true,
        autoRenewalNotice: '30 days before contract end',
        terminationAllowed: true,
        terminationNotice: '30 days',
        status: app.account_status === 'approved' ? 'active' : 'pending_activation'
      },
      currentStatus: {
        level: currentLevel,
        activationStatus: app.account_status,
        activationFeeStatus: app.activation_fee_status,
        activationFeeBalance: app.activation_fee_balance ? {
          amount: parseInt(app.activation_fee_balance),
          currency: 'GBP',
          displayAmount: '£' + (parseInt(app.activation_fee_balance) / 100).toFixed(2)
        } : null
      },
      keyTakeaways: [
        'The base licence is cleared from earned credit as you complete tasks',
        'Level 3 requires performance achievement, not payment',
        'Cash withdrawal privileges are only available at Level 3',
        'Your contract is valid for 12 months from activation',
        'Level 1 focus: Build your promoter network and earn commissions'
      ]
    };

    return ok(res, req, licenseInfo);
  } catch (err) {
    console.error('Get license info error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve license information");
  }
}

/**
 * Get Guru licence clearance progress (current -295 implementation).
 * GET /gurus/license/balance
 *
 * Data source:
 * - Total licence fee: fixed 295
 * - Cleared amount: guru CREDIT_ALLOCATION earnings from promoter ticket sales
 * - Remaining balance: total - cleared (never below 0)
 */
async function getLicenseBalance(req, res) {
  try {
    const guruId = req.user.id;

    let profileResult = await pool.query(
      `SELECT licence_balance, level FROM guru_profiles WHERE user_id = $1 LIMIT 1`,
      [guruId]
    );

    // Backfill for existing gurus created before guru_profiles baseline was enforced.
    if (profileResult.rowCount === 0) {
      await pool.query(
        `INSERT INTO guru_profiles (user_id, level, licence_balance, created_at)
         VALUES ($1, 1, -295, NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [guruId]
      );
      profileResult = await pool.query(
        `SELECT licence_balance, level FROM guru_profiles WHERE user_id = $1 LIMIT 1`,
        [guruId]
      );
    }

    if (profileResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Guru licence profile could not be initialized");
    }

    const earnedResult = await pool.query(
      `SELECT
         COALESCE(SUM(amount), 0)::bigint AS total_pence,
         COALESCE(SUM(CASE
           WHEN COALESCE(UPPER(metadata_json->>'status'), 'PROJECTED') = 'CONFIRMED'
           THEN amount ELSE 0 END), 0)::bigint AS confirmed_pence,
         COALESCE(SUM(CASE
           WHEN COALESCE(UPPER(metadata_json->>'status'), 'PROJECTED') = 'PROJECTED'
           THEN amount ELSE 0 END), 0)::bigint AS projected_pence
       FROM credit_ledger
       WHERE user_id = $1
         AND role = 'guru'
         AND entry_type = 'CREDIT_ALLOCATION'
         AND COALESCE((metadata_json->>'void')::boolean, false) IS NOT TRUE
         AND COALESCE((metadata_json->>'ledger_void')::boolean, false) IS NOT TRUE`,
      [guruId]
    );

    const totalEarnedFromPromoters = Number(earnedResult.rows[0]?.total_pence || 0) / 100;
    const confirmedEarnedFromPromoters = Number(earnedResult.rows[0]?.confirmed_pence || 0) / 100;
    const projectedEarnedFromPromoters = Number(earnedResult.rows[0]?.projected_pence || 0) / 100;

    const clearedFee = Math.min(GURU_LICENCE_TOTAL, totalEarnedFromPromoters);
    const balanceOwed = Math.max(0, GURU_LICENCE_TOTAL - clearedFee);
    const isCleared = balanceOwed <= 0;

    return ok(res, req, {
      currency: "EUR",
      totalFee: Number(GURU_LICENCE_TOTAL.toFixed(2)),
      clearedFee: Number(clearedFee.toFixed(2)),
      balanceOwed: Number(balanceOwed.toFixed(2)),
      isCleared,
      source: {
        earningsType: "credit_ledger.CREDIT_ALLOCATION (role=guru)",
        totalEarnedFromPromoters: Number(totalEarnedFromPromoters.toFixed(2)),
        confirmedEarnedFromPromoters: Number(confirmedEarnedFromPromoters.toFixed(2)),
        projectedEarnedFromPromoters: Number(projectedEarnedFromPromoters.toFixed(2)),
      },
      profileSnapshot: {
        level: Number(profileResult.rows[0].level || 1),
        licenceBalanceField: profileResult.rows[0].licence_balance != null
          ? Number(profileResult.rows[0].licence_balance)
          : null,
      },
    });
  } catch (err) {
    console.error("Get guru licence balance error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve guru licence balance");
  }
}

module.exports = {
  getLicenseInfo,
  getLicenseBalance,
};
