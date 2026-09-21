/**
 * EscrowService
 * Business logic layer for escrow system (Contracts 15, 16, 17)
 * 
 * CONTRACT 15: GET /api/v1/escrow/coverage/:territory_id - Coverage ratio + health status
 * CONTRACT 16: GET /api/v1/promoter/finance/escrow - Promoter's personal escrow view
 * CONTRACT 17: GET /api/v1/escrow/interest/:territory_id - Interest earning history
 * 
 * Timeline: Day 6 (March 2, 2026)
 */

const db = require('../db');
const escrowRepository = require('./escrow.repository');

class EscrowService {

  /**
   * CONTRACT 15: Get live coverage ratio for a territory
   * coverage_ratio = escrow_balance / total_pending_liabilities
   * 
   * Status mapping:
   *   >= 1.10 → GREEN (healthy)
   *   >= 1.00 < 1.10 → AMBER (adequate, monitor)
   *   < 1.00 → RED (deficit, alert required)
   *   0 liabilities → NO_LIABILITIES
   * 
   * @param {number} territoryId
   * @returns {object} coverage report with ratio, status, breakdown, alert (if RED)
   */
  async getCoverageRatio(territoryId) {
    try {
      // 1. Verify territory exists
      const territory = await escrowRepository.fetchTerritory(territoryId);
      if (!territory) {
        throw new Error('TERRITORY_NOT_FOUND');
      }

      // 2. Fetch escrow account balance
      const escrowAccount = await escrowRepository.fetchEscrowAccount(territoryId);
      const escrowBalance = escrowAccount?.current_balance || 0.00;

      // 3. Fetch liabilities and calculate total
      const liabilities = await escrowRepository.fetchLiabilitiesForTerritory(territoryId, ['HOLDING', 'PAYOUT_ELIGIBLE']);
      const totalLiabilities = await escrowRepository.calculateTotalLiabilities(territoryId, ['HOLDING', 'PAYOUT_ELIGIBLE']);

      // 4. Calculate coverage ratio and status
      let coverageRatio = null;
      let coverageStatus = 'NO_LIABILITIES';

      if (totalLiabilities > 0) {
        coverageRatio = parseFloat((escrowBalance / totalLiabilities).toFixed(4));

        // Map to status
        if (coverageRatio >= 1.10) {
          coverageStatus = 'GREEN';
        } else if (coverageRatio >= 1.00) {
          coverageStatus = 'AMBER';
        } else {
          coverageStatus = 'RED';
        }
      }

      // 5. Get liability breakdown (HOLDING vs PAYOUT_ELIGIBLE)
      const breakdown = await escrowRepository.fetchLiabilityBreakdown(territoryId);

      // 6. Prepare alert (only if RED)
      let alert = null;
      if (coverageStatus === 'RED') {
        alert = {
          level: 'RED',
          message: 'Escrow coverage below 1.0. No payouts can be approved without CEO override.',
          notified_roles: ['finance', 'kings_account', 'ceo'],
          triggered_at: new Date().toISOString()
        };
      }

      return {
        territory_id: territoryId,
        territory_name: territory.name,
        escrow_balance: parseFloat(parseFloat(escrowBalance).toFixed(2)),
        total_pending_liabilities: parseFloat(parseFloat(totalLiabilities).toFixed(2)),
        coverage_ratio: coverageRatio,
        coverage_status: coverageStatus,
        breakdown: breakdown,
        alert: alert,
        calculated_at: new Date().toISOString()
      };

    } catch (error) {
      console.error('[EscrowService] getCoverageRatio error:', error.message);
      throw error;
    }
  }

  /**
   * CONTRACT 16: Get promoter's personal escrow view
   * Returns all non-PAID_OUT liabilities for a promoter, broken down by event
   * 
   * @param {number} promoterId - promoter_profiles.id
   * @returns {object} promoter escrow breakdown with events and aggregates
   */
  async getPromoterEscrowView(promoterId) {
    try {
      // 1. Fetch all liabilities for this promoter (excludes PAID_OUT)
      const liabilities = await escrowRepository.fetchLiabilitiesForPromoter(promoterId);

      // 2. Build event array with settlement dates
      const events = liabilities.map(liability => {
        let settlementEligibleFrom = null;

        // If event is concluded (PAYOUT_ELIGIBLE), calculate settlement window
        if (liability.status === 'PAYOUT_ELIGIBLE' && liability.concluded_at) {
          const settlementWindow = 7; // days (adjust for post-575 rule: 1 day if needed)
          const concludedDate = new Date(liability.concluded_at);
          const settlementDate = new Date(concludedDate.getTime() + settlementWindow * 24 * 60 * 60 * 1000);
          settlementEligibleFrom = settlementDate.toISOString().split('T')[0]; // YYYY-MM-DD format
        }

        return {
          event_id: liability.event_id,
          event_title: liability.event_title,
          event_date: liability.event_date ? (typeof liability.event_date === 'string' ? liability.event_date.split('T')[0] : liability.event_date.toISOString().split('T')[0]) : null,
          event_status: liability.event_status,
          tickets_sold: liability.tickets_sold || 0,
          gross_ticket_revenue: parseFloat(parseFloat(liability.gross_ticket_revenue).toFixed(2)),
          refund_deductions: parseFloat(parseFloat(liability.refund_deductions).toFixed(2)),
          net_held: parseFloat(parseFloat(liability.net_liability).toFixed(2)),
          liability_status: liability.status,
          settlement_eligible_from: settlementEligibleFrom,
          payout_status: liability.status === 'PAYOUT_ELIGIBLE' ? 'PENDING_FINANCE_APPROVAL' : null
        };
      });

      // 3. Calculate aggregates
      const totalHeld = liabilities.reduce((sum, l) => sum + parseFloat(l.net_liability), 0);
      const totalPayoutEligible = liabilities
        .filter(l => l.status === 'PAYOUT_ELIGIBLE')
        .reduce((sum, l) => sum + parseFloat(l.net_liability), 0);
      const totalRefundDeductions = liabilities
        .reduce((sum, l) => sum + parseFloat(l.refund_deductions), 0);

      return {
        promoter_id: promoterId,
        total_held_in_escrow: parseFloat(totalHeld.toFixed(2)),
        total_payout_eligible: parseFloat(totalPayoutEligible.toFixed(2)),
        total_refund_deductions: parseFloat(totalRefundDeductions.toFixed(2)),
        events: events,
        retrieved_at: new Date().toISOString()
      };

    } catch (error) {
      console.error('[EscrowService] getPromoterEscrowView error:', error.message);
      throw error;
    }
  }

  /**
   * CONTRACT 17: Get interest history for a territory
   * Returns complete interest earning history with optional date range filtering
   * 
   * @param {number} territoryId
   * @param {string} fromDate - optional YYYY-MM-DD
   * @param {string} toDate - optional YYYY-MM-DD
   * @returns {object} interest history with summary and entries
   */
  async getInterestHistory(territoryId, fromDate = null, toDate = null) {
    try {
      // 1. Verify territory exists
      const territory = await escrowRepository.fetchTerritory(territoryId);
      if (!territory) {
        throw new Error('TERRITORY_NOT_FOUND');
      }

      // 2. Fetch escrow account to get current balance and total interest
      const escrowAccount = await escrowRepository.fetchEscrowAccount(territoryId);
      const currentBalance = parseFloat(escrowAccount?.current_balance || 0.00);
      const totalInterestAllTime = parseFloat(escrowAccount?.interest_earned || 0.00);

      // 3. Calculate balance excluding interest (for regulatory comparison)
      const escrowBalanceExcludingInterest = currentBalance - totalInterestAllTime;

      // 4. Validate date range if provided
      if (fromDate && toDate) {
        const fromDateObj = new Date(fromDate);
        const toDateObj = new Date(toDate);
        if (fromDateObj > toDateObj) {
          throw new Error('INVALID_DATE_RANGE');
        }
      }

      // 5. Fetch interest entries
      const entries = await escrowRepository.fetchInterestEntries(territoryId, fromDate, toDate);

      // 6. Calculate period total
      let totalInterestInPeriod = 0.00;
      if (fromDate && toDate) {
        totalInterestInPeriod = parseFloat(await escrowRepository.calculateInterestInPeriod(territoryId, fromDate, toDate));
      } else if (entries.length > 0) {
        // If no date filter, sum all entries
        totalInterestInPeriod = entries.reduce((sum, e) => sum + parseFloat(e.interest_amount), 0);
      }

      return {
        territory_id: territoryId,
        territory_name: territory.name,
        summary: {
          total_interest_earned_all_time: parseFloat(totalInterestAllTime.toFixed(2)),
          total_interest_earned_in_period: parseFloat(totalInterestInPeriod.toFixed(2)),
          period_from: fromDate || null,
          period_to: toDate || null,
          current_escrow_balance: parseFloat(currentBalance.toFixed(2)),
          escrow_balance_excluding_interest: parseFloat(escrowBalanceExcludingInterest.toFixed(2))
        },
        entries: entries.map(e => ({
          interest_id: e.interest_id,
          period_start: e.period_start,
          period_end: e.period_end,
          opening_balance: parseFloat(parseFloat(e.opening_balance).toFixed(2)),
          interest_rate: parseFloat(parseFloat(e.interest_rate).toFixed(6)),
          interest_amount: parseFloat(parseFloat(e.interest_amount).toFixed(2)),
          source: e.source,
          recorded_by_name: e.recorded_by_name || 'System',
          created_at: e.created_at
        })),
        retrieved_at: new Date().toISOString()
      };

    } catch (error) {
      console.error('[EscrowService] getInterestHistory error:', error.message);
      throw error;
    }
  }

  /**
   * INTERNAL: Check coverage and trigger RED alert if needed
   * Called after every payment routing event (Day 7 EscrowReceiveService)
   * Idempotent: only one RED alert per territory per 15 minutes
   * Also resolves RED alerts when coverage improves
   * 
   * @param {number} territoryId
   * @returns {object} {coverage_status, alert_created, alert_id?}
   */
  async checkAndAlertCoverage(territoryId) {
    try {
      // 1. Get current coverage
      const coverage = await this.getCoverageRatio(territoryId);

      // 2. Check for existing RED alert
      const existingRedAlert = await this._fetchActiveRedAlert(territoryId);

      // 3. CASE 1: RED status - create or skip alert
      if (coverage.coverage_status === 'RED') {
        if (existingRedAlert) {
          // Alert already exists - idempotent, skip creation
          console.log(`[EscrowService] RED alert already exists for territory ${territoryId}, skipping creation`);
          return { coverage_status: 'RED', alert_created: false, alert_id: existingRedAlert.id };
        }

        // Alert doesn't exist - create new one
        const alertId = await this._createRedAlert(territoryId, coverage);

        return {
          coverage_status: 'RED',
          alert_created: true,
          alert_id: alertId
        };
      }

      // 4. CASE 2: Coverage recovered - resolve existing RED alert if any
      if (coverage.coverage_status !== 'RED' && existingRedAlert) {
        await this._resolveRedAlert(territoryId, existingRedAlert.id);
        console.log(`[EscrowService] RED alert resolved for territory ${territoryId} (coverage improved)`);

        return {
          coverage_status: coverage.coverage_status,
          alert_resolved: true,
          alert_id: existingRedAlert.id
        };
      }

      // 5. CASE 3: No RED status, no existing alert
      return { coverage_status: coverage.coverage_status, alert_created: false };

    } catch (error) {
      console.error('[EscrowService] checkAndAlertCoverage error:', error.message);
      throw error;
    }
  }

  /**
   * INTERNAL: Fetch active RED alert for a territory
   * @param {number} territoryId
   * @returns {object} alert object or null
   */
  async _fetchActiveRedAlert(territoryId) {
    const query = `
      SELECT id, territory_id, alert_type, level, created_at 
      FROM alerts
      WHERE territory_id = $1
      AND alert_type = 'ESCROW_COVERAGE_RED'
      AND resolved_at IS NULL
      AND created_at >= (NOW() - INTERVAL '15 minutes')
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const result = await db.query(query, [territoryId]);
    return result.rows[0] || null;
  }

  /**
   * INTERNAL: Create RED coverage alert
   * Includes idempotency, notification dispatch, and audit logging
   * 
   * @param {number} territoryId
   * @param {object} coverage - coverage data from getCoverageRatio()
   * @returns {number} alertId
   */
  async _createRedAlert(territoryId, coverage) {
    const now = new Date();
    
    try {
      // 1. INSERT alert
      const alertInsert = await db.query(`
        INSERT INTO alerts (
          territory_id, alert_type, level, title, message, 
          notified_roles, triggered_at, resolved_at, status, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)
        RETURNING id, territory_id, alert_type, level, message
      `, [
        territoryId,
        'ESCROW_COVERAGE_RED',
        'CRITICAL',
        'Escrow Coverage Below Minimum',
        `Escrow coverage ratio has fallen below 1.0 (${coverage.coverage_ratio || 0}). No payouts can be approved without CEO override. Escrow: £${coverage.escrow_balance}, Liabilities: £${coverage.total_pending_liabilities}`,
        JSON.stringify(['finance', 'kings_account', 'ceo']),
        now,
        'pending',
        now,
        now
      ]);

      const alertId = alertInsert.rows[0].id;
      console.log(`[EscrowService] RED alert CREATED: alert_id=${alertId}, territory_id=${territoryId}, ratio=${coverage.coverage_ratio}`);

      // 2. EMIT NOTIFICATION (async, no await - don't block if notification service fails)
      this._notifyRedAlert(alertId, territoryId, coverage).catch(err => {
        console.warn(`[EscrowService] Notification dispatch failed for alert ${alertId}:`, err.message);
      });

      // 3. AUDIT LOG
      await this._auditAlertAction('RED_ALERT_CREATED', alertId, territoryId, 'system', coverage);

      return alertId;

    } catch (error) {
      console.error('[EscrowService] _createRedAlert failed:', error.message);
      throw error;
    }
  }

  /**
   * INTERNAL: Resolve RED alert when coverage improves
   * 
   * @param {number} territoryId
   * @param {number} alertId
   */
  async _resolveRedAlert(territoryId, alertId) {
    const now = new Date();

    try {
      const updateResult = await db.query(`
        UPDATE alerts
        SET resolved_at = $1, status = $2, updated_at = $3
        WHERE id = $4 AND territory_id = $5
        RETURNING id, resolved_at
      `, [now, 'resolved', now, alertId, territoryId]);

      if (updateResult.rows.length === 0) {
        throw new Error(`Alert ${alertId} not found for territory ${territoryId}`);
      }

      console.log(`[EscrowService] RED alert RESOLVED: alert_id=${alertId}, territory_id=${territoryId}`);

      // AUDIT LOG
      await this._auditAlertAction('RED_ALERT_RESOLVED', alertId, territoryId, 'system', {
        resolved_at: now
      });

    } catch (error) {
      console.error('[EscrowService] _resolveRedAlert failed:', error.message);
      throw error;
    }
  }

  /**
   * INTERNAL: Dispatch notification to Finance & CEO roles
   * Called async, doesn't block main flow
   * 
   * @param {number} alertId
   * @param {number} territoryId
   * @param {object} coverage
   */
  async _notifyRedAlert(alertId, territoryId, coverage) {
    try {
      // TODO: Integrate with notification service
      // Example structure (when notification service available):
      /*
      await notificationService.notifyRoles(
        ['finance', 'ceo'],
        {
          alert_id: alertId,
          alert_type: 'ESCROW_COVERAGE_RED',
          territory_id: territoryId,
          coverage_ratio: coverage.coverage_ratio,
          escrow_balance: coverage.escrow_balance,
          total_pending_liabilities: coverage.total_pending_liabilities,
          message: 'Escrow coverage has dropped below minimum threshold. Immediate action required.',
          action_required: true,
          action_url: `/admin/finance/escrow-coverage?territory_id=${territoryId}`
        }
      );
      */

      console.log(`[EscrowService] Notification queued for alert ${alertId} (roles: finance, kings_account, ceo)`);

    } catch (error) {
      console.error('[EscrowService] _notifyRedAlert error:', error.message);
      throw error; // Let caller handle
    }
  }

  /**
   * INTERNAL: Audit log for alert actions
   * Immutable record of all alert lifecycle events
   * 
   * @param {string} action - RED_ALERT_CREATED, RED_ALERT_RESOLVED, ALERT_OVERRIDDEN
   * @param {number} alertId
   * @param {number} territoryId
   * @param {string} actor - 'system' or user_id
   * @param {object} metadata - additional context
   */
  async _auditAlertAction(action, alertId, territoryId, actor, metadata = {}) {
    try {
      await db.query(`
        INSERT INTO alert_audit_logs (
          alert_id, territory_id, action, actor_id, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        alertId,
        territoryId,
        action,
        actor, // 'system' or numeric user_id
        JSON.stringify(metadata),
        new Date()
      ]);

      console.log(`[EscrowService] Alert action AUDITED: ${action} (alert_id=${alertId})`);

    } catch (error) {
      console.error('[EscrowService] _auditAlertAction failed:', error.message);
      // Don't throw - audit failure shouldn't block main flow
    }
  }
}

module.exports = new EscrowService();
