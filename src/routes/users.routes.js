const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { getUserPreferences, updateUserPreferences } = require("../controllers/user-preferences.controller");
const { changePassword } = require("../controllers/user.controller");


router.get("/me/preferences", requireAuth, getUserPreferences);
router.put("/me/preferences", requireAuth, updateUserPreferences);
router.patch("/me/change-password", requireAuth, changePassword);

module.exports = router;
