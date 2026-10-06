/**
 * Helpers for reading and adjusting a territory's escrow account row.
 *
 * escrow_accounts exists in two shapes that can be present together:
 *   - legacy: account_type (NOT NULL, unique with territory_id), current_balance in pounds
 *   - newer:  balance and pending_liabilities in pence
 * init.sql adds the newer columns on top of the legacy table, so a real database usually has both.
 * These helpers keep every column that exists in step, so escrow receive, refund ring-fencing and
 * refund approval all see the same balance.
 */

async function getEscrowColumns(client) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'escrow_accounts'`
  );
  const columns = new Set(result.rows.map((r) => r.column_name));
  return {
    hasType: columns.has("account_type"),
    hasBalance: columns.has("balance"),
    hasCurrentBalance: columns.has("current_balance"),
    hasPending: columns.has("pending_liabilities"),
    hasDeposited: columns.has("total_deposited"),
  };
}

function typeFilter(cols) {
  return cols.hasType ? "AND account_type = 'escrow'" : "";
}

async function ensureEscrowAccount(client, territoryId, cols) {
  if (cols.hasType) {
    await client.query(
      `INSERT INTO escrow_accounts (territory_id, account_type)
       VALUES ($1, 'escrow')
       ON CONFLICT (territory_id, account_type) DO NOTHING`,
      [territoryId]
    );
  } else {
    await client.query(
      `INSERT INTO escrow_accounts (territory_id)
       VALUES ($1)
       ON CONFLICT (territory_id) DO NOTHING`,
      [territoryId]
    );
  }
}

/**
 * @returns {Promise<{ balancePence: number, pendingPence: number }>}
 */
async function readEscrowPence(client, territoryId, cols) {
  const result = await client.query(
    `SELECT
       ${cols.hasBalance ? "COALESCE(balance, 0)" : "0"} AS balance,
       ${cols.hasCurrentBalance ? "COALESCE(current_balance, 0)" : "0"} AS current_balance,
       ${cols.hasPending ? "COALESCE(pending_liabilities, 0)" : "0"} AS pending
     FROM escrow_accounts
     WHERE territory_id = $1 ${typeFilter(cols)}
     LIMIT 1`,
    [territoryId]
  );
  const row = result.rows[0] || {};
  if (cols.hasBalance) {
    return { balancePence: Number(row.balance || 0), pendingPence: Number(row.pending || 0) };
  }
  return {
    balancePence: Math.round(Number(row.current_balance || 0) * 100),
    pendingPence: Math.round(Number(row.pending || 0) * 100),
  };
}

/**
 * Move an escrow account's balance and/or pending liabilities by a signed pence amount.
 * Never lets a value go below zero.
 */
async function adjustEscrowPence(client, territoryId, cols, { balanceDeltaPence = 0, pendingDeltaPence = 0 }) {
  const sets = [];
  const params = [territoryId];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (balanceDeltaPence !== 0) {
    if (cols.hasBalance) {
      sets.push(`balance = GREATEST(COALESCE(balance, 0) + ${add(balanceDeltaPence)}::bigint, 0)`);
    }
    if (cols.hasCurrentBalance) {
      sets.push(
        `current_balance = GREATEST(COALESCE(current_balance, 0) + ${add(balanceDeltaPence / 100)}::numeric, 0)`
      );
    }
    if (cols.hasDeposited && balanceDeltaPence > 0) {
      sets.push(`total_deposited = COALESCE(total_deposited, 0) + ${add(balanceDeltaPence / 100)}::numeric`);
    }
  }

  if (pendingDeltaPence !== 0 && cols.hasPending) {
    const delta = cols.hasBalance ? pendingDeltaPence : pendingDeltaPence / 100;
    sets.push(`pending_liabilities = GREATEST(COALESCE(pending_liabilities, 0) + ${add(delta)}::numeric, 0)`);
  }

  if (sets.length === 0) return;

  await client.query(
    `UPDATE escrow_accounts
     SET ${sets.join(", ")}, updated_at = NOW()
     WHERE territory_id = $1 ${typeFilter(cols)}`,
    params
  );
}

module.exports = {
  getEscrowColumns,
  ensureEscrowAccount,
  readEscrowPence,
  adjustEscrowPence,
};
