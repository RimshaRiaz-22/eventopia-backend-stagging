/**
 * Escrow Receive Service — on confirmed ticket purchase:
 * 1. Credit territory escrow with ticket_price × quantity (pence)
 * 2. Write ledger entries for escrow receive and booking fee (operating)
 * No separate "operating account" table; booking fee is audit-only in ledger for now.
 */

const pool = require("../db");
const { createLedgerEntry } = require("./ledgerCore.service");
const { addGrossRevenueToLiability } = require("./escrowLiability.service");
const { getEscrowColumns, ensureEscrowAccount, adjustEscrowPence } = require("./escrowAccount.util");

/**
 * Process incoming ticket payment: update escrow balance and write ledger entries.
 * @param {Object} params
 * @param {number} params.territory_id - Territory ID (required for escrow)
 * @param {number} params.escrow_amount_pence - Ticket price × quantity in pence
 * @param {number} params.booking_fee_pence - Booking fee × quantity in pence
 * @param {number} params.buyer_id - User ID of buyer (for ledger)
 * @param {number} [params.order_id] - Order ID for reference
 * @param {number} [params.event_id] - Event ID for reference
 * @returns {Promise<{ escrow_ledger_id: number, booking_fee_ledger_id: number }>}
 */
async function receiveTicketPayment({
  territory_id,
  escrow_amount_pence,
  booking_fee_pence,
  buyer_id,
  order_id = null,
  event_id = null,
}) {
  if (!territory_id || escrow_amount_pence == null || buyer_id == null) {
    throw new Error("escrowReceive: territory_id, escrow_amount_pence, and buyer_id required");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ensure escrow account exists for territory (works with the legacy and newer column layouts)
    const escrowCols = await getEscrowColumns(client);
    await ensureEscrowAccount(client, territory_id, escrowCols);

    // Credit escrow balance (amounts in pence)
    if (escrow_amount_pence > 0) {
      await adjustEscrowPence(client, territory_id, escrowCols, { balanceDeltaPence: escrow_amount_pence });

      // Keep promoter escrow view in sync with confirmed ticket revenue.
      // Best-effort: do not interrupt payment routing if liability context is not available yet.
      if (event_id) {
        try {
          await addGrossRevenueToLiability(event_id, escrow_amount_pence, { client });
        } catch (liabilityErr) {
          console.warn("[escrowReceive] liability sync skipped:", liabilityErr.message);
        }
      }
    }

    let escrow_ledger_id = null;
    let booking_fee_ledger_id = null;

    if (escrow_amount_pence > 0) {
      escrow_ledger_id = await createLedgerEntry(
        {
          entry_type: "ESCROW_RECEIVE",
          user_id: buyer_id,
          role: "buyer",
          territory_id,
          amount: escrow_amount_pence,
          reference_id: order_id ?? event_id,
          reference_type: order_id ? "ORDER" : "EVENT",
          status: "POSTED",
        },
        { client }
      );
    }

    if (booking_fee_pence > 0) {
      booking_fee_ledger_id = await createLedgerEntry(
        {
          entry_type: "BOOKING_FEE",
          user_id: buyer_id,
          role: "buyer",
          territory_id,
          amount: booking_fee_pence,
          reference_id: order_id ?? event_id,
          reference_type: order_id ? "ORDER" : "EVENT",
          status: "POSTED",
        },
        { client }
      );
    }

    await client.query("COMMIT");
    return { escrow_ledger_id, booking_fee_ledger_id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  receiveTicketPayment,
};
