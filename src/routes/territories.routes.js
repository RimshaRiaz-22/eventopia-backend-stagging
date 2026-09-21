const express = require("express");
const router = express.Router();
const { getTerritories, searchTerritories } = require("../controllers/territories.controller");

// Public routes
router.get("/", getTerritories);// Search territories using GeoNames API

module.exports = router;
