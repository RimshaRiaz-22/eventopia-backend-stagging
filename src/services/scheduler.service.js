const cron = require("node-cron");
const pool = require("../db");
const { issueRewardsForEvent } = require('./reward.service');
const { sendRewardNotificationEmails, sendVoucherExpiryReminderEmail } = require('./email.service');
const { startJob, markJobSuccess, markJobFailed } = require('./jobMonitoring.service');
const { expireActivePromoterReferrals } = require("./promoterReferral.service");

/**
 * Runs every hour to mark events as completed when they end
 */
async function completePastEvents() {
  const client = await pool.connect();
  let runId = null;
  try {
    runId = await startJob('completePastEvents');

    const result = await client.query(
      `SELECT id FROM events
       WHERE status IN ('published', 'unpublished')
       AND completion_status = 'pending'
       AND end_at < NOW()`
    );

    if (result.rowCount > 0) {
      const eventIds = result.rows.map(row => row.id);

      // Update all completed events (also set settlement_status for My Gurus metrics)
      await client.query(
        `UPDATE events
         SET completion_status = 'completed',
             settlement_status = 'SETTLED',
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = ANY($1::bigint[])`,
        [eventIds]
      );

      console.log(`Completed ${eventIds.length} events automatically`);

      // Issue rewards for each event (async, don't block)
      for (const eventId of eventIds) {
        try {
          const rewards = await issueRewardsForEvent(eventId, null); // null = system
          console.log(`Rewards issued for event ${eventId}`);

          // Send reward notification emails
          await sendRewardNotificationEmails(eventId, rewards)
            .catch(err => console.error('Error sending reward emails:', err));
        } catch (err) {
          console.error(`Failed to issue rewards for event ${eventId}:`, err);
        }
      }
    }

    await markJobSuccess(runId);
  } catch (err) {
    console.error("Error completing past events:", err);
    if (runId) {
      await markJobFailed(runId, err.message);
    }
  } finally {
    client.release();
  }
}

/**
 * Runs every 5 minutes to expire reservations
 */
async function expireReservations() {
  const client = await pool.connect();
  let runId = null;
  try {
    runId = await startJob('expireReservations');

    // Find expired reservations
    const result = await client.query(
      `SELECT DISTINCT order_id
       FROM inventory_reservations
       WHERE status = 'active'
       AND expires_at < NOW()`
    );

    if (result.rowCount > 0) {
      const orderIds = result.rows.map(row => row.order_id);

      // Update reservations to expired
      await client.query(
        `UPDATE inventory_reservations
         SET status = 'expired',
             updated_at = NOW()
         WHERE order_id = ANY($1::bigint[])
         AND status = 'active'`,
        [orderIds]
      );

      // Update orders to expired
      await client.query(
        `UPDATE orders
         SET status = 'EXPIRED',
             updated_at = NOW()
         WHERE id = ANY($1::bigint[])
         AND status = 'PENDING'`,
        [orderIds]
      );

      console.log(`Expired ${orderIds.length} orders and their reservations`);
    }

    await markJobSuccess(runId);
  } catch (err) {
    console.error("Error expiring reservations:", err);
    if (runId) {
      await markJobFailed(runId, err.message);
    }
  } finally {
    client.release();
  }
}

/**
 * Runs daily at midnight to mark expired vouchers
 */
async function expireVouchers() {
  const client = await pool.connect();
  let runId = null;
  try {
    runId = await startJob('expireVouchers');

    const result = await client.query(
      `UPDATE reward_vouchers
       SET status = 'expired'
       WHERE status = 'active'
       AND expires_at < NOW()`
    );

    if (result.rowCount > 0) {
      console.log(`Expired ${result.rowCount} vouchers`);
    }

    await markJobSuccess(runId);
  } catch (err) {
    console.error("Error expiring vouchers:", err);
    if (runId) {
      await markJobFailed(runId, err.message);
    }
  } finally {
    client.release();
  }
}

/**
 * Runs daily at 9 AM to send voucher expiry reminders
 */
async function sendVoucherExpiryReminders() {
  const client = await pool.connect();
  let runId = null;
  try {
    runId = await startJob('sendVoucherExpiryReminders');

    // Get reminder days from config
    const configResult = await client.query(
      "SELECT config_value FROM system_config WHERE config_key = 'voucher_expiry_reminder_days'"
    );

    const reminderDays = configResult.rowCount > 0
      ? parseInt(configResult.rows[0].config_value)
      : 7; // Default to 7 days

    // Find vouchers expiring in reminderDays that haven't had a reminder sent
    const result = await client.query(
      `SELECT rv.id, rv.owner_type, rv.owner_id, rv.event_id, rv.amount, rv.expires_at,
              e.title as event_title, u.email, u.name
       FROM reward_vouchers rv
       JOIN events e ON rv.event_id = e.id
       JOIN users u ON rv.owner_id = u.id
       WHERE rv.status = 'active'
       AND rv.reminder_sent_at IS NULL
       AND rv.expires_at BETWEEN NOW() AND (NOW() + INTERVAL '${reminderDays} days')`
    );

    if (result.rowCount > 0) {
      console.log(`Found ${result.rowCount} vouchers expiring soon`);

      // Send reminder for each voucher
      for (const voucher of result.rows) {
        try {
          await sendVoucherExpiryReminderEmail({
            to: voucher.email,
            userName: voucher.name || voucher.owner_type,
            eventTitle: voucher.event_title,
            amountPence: voucher.amount,
            expiresAt: voucher.expires_at
          });

          // Mark reminder as sent
          await client.query(
            'UPDATE reward_vouchers SET reminder_sent_at = NOW() WHERE id = $1',
            [voucher.id]
          );

          console.log(`Sent expiry reminder for voucher ${voucher.id}`);
        } catch (err) {
          console.error(`Failed to send expiry reminder for voucher ${voucher.id}:`, err);
        }
      }
    }

    await markJobSuccess(runId);
  } catch (err) {
    console.error("Error sending voucher expiry reminders:", err);
    if (runId) {
      await markJobFailed(runId, err.message);
    }
  } finally {
    client.release();
  }
}

/**
 * Runs daily to expire promoter referral windows.
 */
async function expirePromoterReferralWindows() {
  let runId = null;
  try {
    runId = await startJob("expirePromoterReferralWindows");
    const count = await expireActivePromoterReferrals();
    if (count > 0) {
      console.log(`Expired ${count} promoter referral window(s)`);
    }
    await markJobSuccess(runId);
  } catch (err) {
    console.error("Error expiring promoter referral windows:", err);
    if (runId) {
      await markJobFailed(runId, err.message);
    }
  }
}

/**
 * Initialize scheduled jobs
 */
function initScheduler() {
  // Run every hour at minute 0 - complete past events
  cron.schedule("0 * * * *", async () => {
    console.log("Running automatic event completion job...");
    await completePastEvents();
  });

  // Run every 5 minutes - expire reservations
  cron.schedule("*/5 * * * *", async () => {
    console.log("Running reservation expiry job...");
    await expireReservations();
  });

  // Run daily at midnight - expire vouchers
  cron.schedule("0 0 * * *", async () => {
    console.log("Running voucher expiry job...");
    await expireVouchers();
  });

  // Run daily at 9 AM - send voucher expiry reminders
  cron.schedule("0 9 * * *", async () => {
    console.log("Running voucher expiry reminder job...");
    await sendVoucherExpiryReminders();
  });

  // Run daily at 1:30 AM - expire promoter referral windows
  cron.schedule("30 1 * * *", async () => {
    await expirePromoterReferralWindows();
  });

  console.log("Event completion, reservation expiry, voucher expiry, reminder, and referral window scheduler initialized");
}

module.exports = {
  initScheduler,
  completePastEvents,
  expireReservations,
  expireVouchers,
  sendVoucherExpiryReminders,
  expirePromoterReferralWindows,
};
