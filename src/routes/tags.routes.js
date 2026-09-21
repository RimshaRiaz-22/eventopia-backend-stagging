const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middlewares/auth.middleware");
const {
  createOrGetTag,
  getTags,
  getTagById,
  updateTag,
  deleteTag,
} = require("../controllers/tags.controller");

// Public: Get tags (with optional search)
router.get("/", getTags);

// Public: Create tag (auto-create if not exists)
router.post("/", createOrGetTag);

// Public: Get tag by ID
router.get("/:id", getTagById);

// Admin: Update/Delete tag
router.use(requireAuth);
router.use(requireAdmin);

router.put("/:id", updateTag);
router.delete("/:id", deleteTag);

module.exports = router;
