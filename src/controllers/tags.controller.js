const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");

/**
 * Generate slug from tag name
 */
function generateSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

/**
 * Create or get tag (with auto-create)
 * POST /tags
 * Body: { name }
 */
async function createOrGetTag(req, res) {
  try {
    const { name } = req.body;

    if (!name) {
      return fail(res, req, 400, "VALIDATION_FAILED", "Tag name is required");
    }

    // Check if tag exists (case-insensitive)
    const existingTag = await pool.query(
      `SELECT id, name, slug, sort_order, is_active
       FROM tags
       WHERE LOWER(name) = LOWER($1)`,
      [name]
    );

    if (existingTag.rowCount > 0) {
      return ok(res, req, {
        tag: existingTag.rows[0],
        created: false,
        message: "Tag already exists"
      });
    }

    // Create new tag
    const slug = generateSlug(name);

    const result = await pool.query(
      `INSERT INTO tags (name, slug)
       VALUES ($1, $2)
       RETURNING id, name, slug, sort_order, is_active, created_at`,
      [name, slug]
    );

    return ok(res, req, {
      tag: result.rows[0],
      created: true,
      message: "Tag created successfully"
    });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Create multiple tags (with auto-create)
 * POST /tags/batch
 * Body: { tagNames: [name1, name2] }
 */
async function createOrGetTagsBatch(req, res) {
  try {
    const { tagNames } = req.body;

    if (!tagNames || !Array.isArray(tagNames) || tagNames.length === 0) {
      return fail(res, req, 400, "VALIDATION_FAILED", "tagNames array is required");
    }

    const results = [];

    for (const tagName of tagNames) {
      if (!tagName || typeof tagName !== 'string') continue;

      // Check if tag exists (case-insensitive)
      const existingTag = await pool.query(
        `SELECT id, name, slug, sort_order, is_active
         FROM tags
         WHERE LOWER(name) = LOWER($1)`,
        [tagName]
      );

      if (existingTag.rowCount > 0) {
        results.push({
          name: tagName,
          tag: existingTag.rows[0],
          created: false
        });
      } else {
        // Create new tag
        const slug = generateSlug(tagName);
        const result = await pool.query(
          `INSERT INTO tags (name, slug)
           VALUES ($1, $2)
           RETURNING id, name, slug, sort_order, is_active, created_at`,
          [tagName, slug]
        );

        results.push({
          name: tagName,
          tag: result.rows[0],
          created: true
        });
      }
    }

    return ok(res, req, {
      tags: results,
      createdCount: results.filter(r => r.created).length,
      existingCount: results.filter(r => !r.created).length
    });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get tags with optional search
 * GET /tags?search=rock
 */
async function getTags(req, res) {
  try {
    const { search } = req.query;

    if (search) {
      // Search mode
      const tagsResult = await pool.query(
        `SELECT id, name, slug, sort_order, is_active
         FROM tags
         WHERE (name ILIKE $1 OR slug ILIKE $1) AND is_active = true
         ORDER BY name ASC LIMIT 20`,
        [`%${search}%`]
      );
      return ok(res, req, { tags: tagsResult.rows, search: search });
    } else {
      // List all tags
      const tagsResult = await pool.query(
        `SELECT id, name, slug, sort_order, is_active, created_at, updated_at
         FROM tags
         WHERE is_active = true
         ORDER BY sort_order ASC, name ASC`
      );
      return ok(res, req, { tags: tagsResult.rows });
    }
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get single tag by ID
 * GET /tags/:id
 */
async function getTagById(req, res) {
  try {
    const { id } = req.params;

    const tagResult = await pool.query(
      `SELECT id, name, slug, sort_order, is_active, created_at, updated_at
       FROM tags WHERE id = $1`,
      [id]
    );

    if (tagResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Tag not found");
    }

    return ok(res, req, { tag: tagResult.rows[0] });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Update tag (Admin only)
 * PUT /admin/tags/:id
 */
async function updateTag(req, res) {
  try {
    const { id } = req.params;
    const { name, sortOrder, isActive } = req.body;

    const tagResult = await pool.query(
      `SELECT id FROM tags WHERE id = $1`,
      [id]
    );

    if (tagResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Tag not found");
    }

    const fields = [];
    const values = [];
    let idx = 1;

    const addField = (column, value) => {
      fields.push(`${column} = $${idx++}`);
      values.push(value);
    };

    if (name !== undefined) {
      // Check for duplicate name (case-insensitive)
      const duplicateCheck = await pool.query(
        `SELECT id FROM tags WHERE LOWER(name) = LOWER($1) AND id != $2`,
        [name, id]
      );
      if (duplicateCheck.rowCount > 0) {
        return fail(res, req, 409, "DUPLICATE", "Tag name already exists");
      }

      addField("name", name);
      addField("slug", generateSlug(name));
    }
    if (sortOrder !== undefined) addField("sort_order", sortOrder);
    if (isActive !== undefined) addField("is_active", isActive);

    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(id);
      await pool.query(
        `UPDATE tags SET ${fields.join(", ")} WHERE id = $${idx}`,
        values
      );
    }

    const updatedTag = await pool.query(
      `SELECT id, name, slug, sort_order, is_active, created_at, updated_at
       FROM tags WHERE id = $1`,
      [id]
    );

    return ok(res, req, { tag: updatedTag.rows[0] });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Delete tag (Admin only)
 * DELETE /admin/tags/:id
 */
async function deleteTag(req, res) {
  try {
    const { id } = req.params;

    const tagResult = await pool.query(
      `SELECT id FROM tags WHERE id = $1`,
      [id]
    );

    if (tagResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Tag not found");
    }

    // Check if tag is in use
    const inUseCheck = await pool.query(
      `SELECT 1 FROM event_tags WHERE tag_id = $1 LIMIT 1`,
      [id]
    );
    if (inUseCheck.rowCount > 0) {
      return fail(res, req, 400, "VALIDATION_FAILED", "Cannot delete tag that is in use by events. Remove from events first.");
    }

    await pool.query(`DELETE FROM tags WHERE id = $1`, [id]);

    return ok(res, req, { message: "Tag deleted successfully" });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get tags by name search
 * GET /tags/search?name=rock
 */
async function searchTags(req, res) {
  try {
    const { name } = req.query;

    if (!name) {
      return fail(res, req, 400, "VALIDATION_FAILED", "Search name is required");
    }

    const tagsResult = await pool.query(
      `SELECT id, name, slug, sort_order, is_active
       FROM tags
       WHERE (name ILIKE $1 OR slug ILIKE $1)
       ORDER BY name ASC LIMIT 20`,
      [`%${name}%`]
    );

    return ok(res, req, { tags: tagsResult.rows });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

module.exports = {
  createOrGetTag,
  createOrGetTagsBatch,
  getTags,
  getTagById,
  updateTag,
  deleteTag,
  searchTags,
};
