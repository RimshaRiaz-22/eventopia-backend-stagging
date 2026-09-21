const db = require("../config/database");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { apiResponse } = require("../utils/apiResponse");
const { validatePaginationParams, generatePagination } = require("../utils/pagination");

/**
 * Get all posts with pagination
 */
exports.getAllPosts = asyncHandler(async (req, res, next) => {
  const { page = 1, limit = 10 } = req.query;
  const { page: pageNum, limit: limitNum, offset } = validatePaginationParams(page, limit);

  // Get total count
  const countResult = await db.query(
    "SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL"
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Get posts
  const result = await db.query(
    "SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    [limitNum, offset]
  );

  const pagination = generatePagination(pageNum, limitNum, total);

  return apiResponse(res, 200, "Resources retrieved successfully", {
    posts: result.rows,
    pagination,
  });
});

/**
 * Get post by ID
 */
exports.getPostById = asyncHandler(async (req, res, next) => {
  const { id } = req.params;

  const result = await db.query(
    "SELECT * FROM posts WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );

  if (result.rows.length === 0) {
    return next(new AppError("Resource not found", 404));
  }

  return apiResponse(res, 200, "Resource retrieved successfully", {
    post: result.rows[0],
  });
});

/**
 * Create new post
 */
exports.createPost = asyncHandler(async (req, res, next) => {
  const { title, content } = req.body;
  const userId = req.user.id;

  if (!title || !content) {
    return next(new AppError("Missing required fields", 400));
  }

  const result = await db.query(
    "INSERT INTO posts (title, content, user_id) VALUES ($1, $2, $3) RETURNING *",
    [title, content, userId]
  );

  return apiResponse(res, 201, "Resource created successfully", {
    post: result.rows[0],
  });
});

/**
 * Update post
 */
exports.updatePost = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const { title, content } = req.body;
  const userId = req.user.id;

  // Check if post exists and belongs to user (or user is admin)
  const checkResult = await db.query(
    "SELECT * FROM posts WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );

  if (checkResult.rows.length === 0) {
    return next(new AppError("Resource not found", 404));
  }

  // Check ownership (unless admin)
  if (checkResult.rows[0].user_id !== userId && req.user.role !== "admin") {
    return next(new AppError("You do not have permission to perform this action", 403));
  }

  const updateFields = [];
  const values = [];
  let paramCount = 1;

  if (title !== undefined) {
    updateFields.push(`title = $${paramCount++}`);
    values.push(title);
  }
  if (content !== undefined) {
    updateFields.push(`content = $${paramCount++}`);
    values.push(content);
  }

  if (updateFields.length === 0) {
    return next(new AppError("No fields to update", 400));
  }

  updateFields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await db.query(
    `UPDATE posts SET ${updateFields.join(", ")} WHERE id = $${paramCount} RETURNING *`,
    values
  );

  return apiResponse(res, 200, "Resource updated successfully", {
    post: result.rows[0],
  });
});

/**
 * Delete post (soft delete)
 */
exports.deletePost = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user.id;

  // Check if post exists
  const checkResult = await db.query(
    "SELECT * FROM posts WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );

  if (checkResult.rows.length === 0) {
    return next(new AppError("Resource not found", 404));
  }

  // Check ownership (unless admin)
  if (checkResult.rows[0].user_id !== userId && req.user.role !== "admin") {
    return next(new AppError("You do not have permission to perform this action", 403));
  }

  await db.query(
    "UPDATE posts SET deleted_at = NOW() WHERE id = $1",
    [id]
  );

  return apiResponse(res, 200, "Resource deleted successfully");
});

