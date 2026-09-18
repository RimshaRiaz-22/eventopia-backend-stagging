/**
 * Ledger API routes — King's Account only. Mounted at /v1/ledger
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireKingsAccount } = require("../middlewares/auth.middleware");
const {
	getLedgerTerritories,
	getLedgerUsers,
	getLedgerList,
	getLedgerEntry,
	exportLedgerCsv,
} = require("../controllers/ledger.controller");

router.use(requireAuth);
router.use(requireKingsAccount);

router.get("/territories", getLedgerTerritories);
router.get("/users", getLedgerUsers);
router.get("/", getLedgerList);
router.get("/export", exportLedgerCsv);
router.get("/:entry_id", getLedgerEntry);

module.exports = router;
