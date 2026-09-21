/**
 * Ledger Core Service — single internal function for all financial movements.
 * Every financial module must call createLedgerEntry(); no direct writes to ledger_entries elsewhere.
 */

const pool = require("../db");

const REQUIRED_FIELDS = [
  "entry_type",
  "user_id",
  "role",
  "territory_id",
  "amount",
  "status",
];

/**
 * Validate that all required fields are present. Throws if any missing.
 * @param {Object} data - Ledger entry payload
 * @throws {Error} LEDGER_MISSING_FIELD: <field>
 */
function validateRequired(data) {
  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null) {
      throw new Error(`LEDGER_MISSING_FIELD: ${field}`);
    }
  }
}

/**
 * Create a single immutable ledger entry. Used internally by financial modules and by the export endpoint.
 * @param {Object} data - Must include entry_type, user_id, role, territory_id, amount, status. Optional: level, network_id, rate_applied, gross_credit, net_credit, reference_id, reference_type, approval_actor_id, proof_reference
 * @returns {Promise<number>} The id of the new ledger entry
 * @throws {Error} LEDGER_MISSING_FIELD: <field> on validation; rethrows DB errors
 */
async function createLedgerEntry(data) {
  validateRequired(data);

  const result = await pool.query(
    `INSERT INTO ledger_entries (
      entry_type, user_id, role, level, territory_id, network_id,
      amount, rate_applied, gross_credit, net_credit,
      reference_id, reference_type, approval_actor_id, proof_reference, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id`,
    [
      data.entry_type,
      data.user_id,
      data.role,
      data.level ?? null,
      data.territory_id,
      data.network_id ?? null,
      data.amount,
      data.rate_applied ?? null,
      data.gross_credit ?? null,
      data.net_credit ?? null,
      data.reference_id ?? null,
      data.reference_type ?? null,
      data.approval_actor_id ?? null,
      data.proof_reference ?? null,
      data.status,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error("Ledger insert did not return id");
  return row.id;
}

module.exports = {
  createLedgerEntry,
  validateRequired,
  REQUIRED_FIELDS,
};
