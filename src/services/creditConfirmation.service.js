/**
 * Credit confirmation: when an event completes, the credit earned on its ticket sales stops being
 * "projected" and becomes confirmed, available credit.
 *
 * For every PROJECTED CREDIT_ALLOCATION row of the event (promoter and referrer):
 *   - credit_ledger.metadata_json.status  PROJECTED -> CONFIRMED
 *   - credit_wallets.projected_balance    goes down by the amount
 *   - credit_wallets.available_balance    goes up by the amount
 *
 * Idempotent: only PROJECTED rows are touched, so running it twice for an event changes nothing.
 */

/**
 * @param {import("pg").PoolClient} client - client with an open transaction (or any client)
 * @param {number|string} eventId
 * @returns {Promise<{rows: number, totals: Array<{user_id: string, role: string, amount: number}>}>}
 */
async function confirmCreditForEvent(client, eventId) {
  const confirmed = await client.query(
    `UPDATE credit_ledger
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                         || jsonb_build_object('status', 'CONFIRMED', 'confirmed_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
     WHERE event_id = $1
       AND entry_type = 'CREDIT_ALLOCATION'
       AND COALESCE(metadata_json->>'status', 'PROJECTED') = 'PROJECTED'
     RETURNING user_id, role, amount`,
    [eventId]
  );

  const totals = new Map();
  for (const row of confirmed.rows) {
    const key = `${row.user_id}:${row.role}`;
    const current = totals.get(key) || { user_id: row.user_id, role: row.role, amount: 0 };
    current.amount += Number(row.amount) || 0;
    totals.set(key, current);
  }

  for (const { user_id, role, amount } of totals.values()) {
    if (amount <= 0) continue;
    await client.query(
      `UPDATE credit_wallets
       SET projected_balance = GREATEST(projected_balance - $3, 0),
           available_balance = available_balance + $3,
           updated_at = NOW()
       WHERE user_id = $1 AND role = $2`,
      [user_id, role, amount]
    );
  }

  return { rows: confirmed.rowCount, totals: [...totals.values()] };
}

module.exports = { confirmCreditForEvent };
