const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middlewares/auth.middleware");
const {
  getCategoriesTree,
  createCategory,
  updateCategory,
  deleteCategory,
  getAllCategories,
  getCategoryById,
} = require("../controllers/categories.controller");

// Public: Get categories tree (hierarchical, no tags)
router.get("/tree", getCategoriesTree);

// Admin: CRUD operations
// router.use(requireAuth);
// router.use(requireAdmin);

router.get("/", getAllCategories);
router.get("/:id", getCategoryById);
router.post("/", createCategory);
router.put("/:id", updateCategory);
router.delete("/:id", deleteCategory);

module.exports = router;

