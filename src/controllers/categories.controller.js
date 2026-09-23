const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");

function buildTree(categories) {
  const byId = new Map();
  const roots = [];

  // init nodes
  for (const c of categories) {
    byId.set(c.id, {
      id: c.id,
      name: c.name,
      slug: c.slug,
      sortOrder: c.sort_order,
      children: [],
    });
  }

  // attach children
  for (const c of categories) {
    const node = byId.get(c.id);
    if (!c.parent_id) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(c.parent_id);
    if (parent) parent.children.push(node);
  }

  return roots;
}

async function getCategoriesTree(req, res) {
  try {
    const categoriesResult = await pool.query(
      `
      SELECT id, parent_id, name, slug, sort_order
      FROM categories
      WHERE is_active = true
      ORDER BY sort_order ASC, name ASC, id ASC
      `
    );

    const tree = buildTree(categoriesResult.rows);

    return ok(res, req, { categories: tree });
  } catch (err) {
    console.error(err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Create category (Admin only)
 * POST /admin/categories
 */
async function createCategory(req, res) {
  const client = await pool.connect();
  try {
    const { name, parentId, sortOrder = 0 } = req.body;

    if (!name) {
      return fail(res, req, 400, "VALIDATION_FAILED", "Category name is required");
    }

    await client.query("BEGIN");

    // Check if parent exists (if parentId provided)
    if (parentId) {
      const parentResult = await client.query(
        `SELECT id FROM categories WHERE id = $1`,
        [parentId]
      );
      if (parentResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return fail(res, req, 400, "VALIDATION_FAILED", "Parent category not found");
      }
    }

    // Generate slug from name
    const slug = name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .trim();

    // Check for duplicate name at same level
    const duplicateCheck = await client.query(
      `SELECT id FROM categories WHERE name ILIKE $1 AND ($2::bigint IS NULL AND parent_id IS NULL OR parent_id = $2::bigint)`,
      [name, parentId || null]
    );
    if (duplicateCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 409, "DUPLICATE", "Category name already exists at this level");
    }

    const result = await client.query(
      `INSERT INTO categories (name, parent_id, sort_order, slug)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, parent_id, sort_order, is_active, created_at`,
      [name, parentId || null, sortOrder, slug]
    );

    await client.query("COMMIT");

    return ok(res, req, { category: result.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Update category (Admin only)
 * PUT /admin/categories/:id
 */
async function updateCategory(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { name, parentId, sortOrder, isActive } = req.body;

    await client.query("BEGIN");

    // Check if category exists
    const categoryResult = await client.query(
      `SELECT id, parent_id FROM categories WHERE id = $1`,
      [id]
    );
    if (categoryResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Category not found");
    }

    const category = categoryResult.rows[0];

    // Validate parent relationship (prevent circular reference)
    if (parentId) {
      if (parentId === parseInt(id, 10)) {
        await client.query("ROLLBACK");
        return fail(res, req, 400, "VALIDATION_FAILED", "Category cannot be its own parent");
      }

      // Check if new parent is a descendant of this category
      const descendantCheck = await client.query(
        `WITH RECURSIVE descendants AS (
           SELECT id, parent_id FROM categories WHERE id = $1
           UNION
           SELECT c.id, c.parent_id FROM categories c
           INNER JOIN descendants d ON c.parent_id = d.id
         )
         SELECT 1 FROM descendants WHERE id = $2 AND id != $1`,
        [id, parentId]
      );
      if (descendantCheck.rowCount > 0) {
        await client.query("ROLLBACK");
        return fail(res, req, 400, "VALIDATION_FAILED", "Cannot set a descendant as parent");
      }
    }

    // Build dynamic update
    const fields = [];
    const values = [];
    let idx = 1;

    const addField = (column, value) => {
      fields.push(`${column} = $${idx++}`);
      values.push(value);
    };

    if (name !== undefined) {
      // Check for duplicate name at same level
      const duplicateCheck = await client.query(
        `SELECT id FROM categories WHERE name ILIKE $1 AND ($2::bigint IS NULL AND parent_id IS NULL OR parent_id = $2::bigint) AND id != $3`,
        [name, parentId || category.parent_id, id]
      );
      if (duplicateCheck.rowCount > 0) {
        await client.query("ROLLBACK");
        return fail(res, req, 409, "DUPLICATE", "Category name already exists at this level");
      }

      // Update slug when name changes
      const slug = name.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .trim();
      addField("name", name);
      addField("slug", slug);
    }
    if (parentId !== undefined) addField("parent_id", parentId);
    if (sortOrder !== undefined) addField("sort_order", sortOrder);
    if (isActive !== undefined) addField("is_active", isActive);

    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(id);
      await client.query(
        `UPDATE categories SET ${fields.join(", ")} WHERE id = $${idx}`,
        values
      );
    }

    const updatedCategory = await client.query(
      `SELECT id, name, parent_id, sort_order, is_active, created_at, updated_at
       FROM categories WHERE id = $1`,
      [id]
    );

    await client.query("COMMIT");

    return ok(res, req, { category: updatedCategory.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Delete category (Admin only)
 * DELETE /admin/categories/:id
 */
async function deleteCategory(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    // Check if category exists
    const categoryResult = await client.query(
      `SELECT id FROM categories WHERE id = $1`,
      [id]
    );
    if (categoryResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Category not found");
    }

    // Check if category has subcategories
    const subcategoryCheck = await client.query(
      `SELECT id FROM categories WHERE parent_id = $1 LIMIT 1`,
      [id]
    );
    if (subcategoryCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "VALIDATION_FAILED", "Cannot delete category with subcategories. Delete subcategories first.");
    }

    // Check if category is in use by events
    const inUseCheck = await client.query(
      `SELECT id FROM events WHERE category_id = $1 LIMIT 1`,
      [id]
    );
    if (inUseCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "VALIDATION_FAILED", "Cannot delete category that is in use by events. Reassign events first.");
    }

    // Check if category has tags
    const tagsCheck = await client.query(
      `SELECT id FROM tags WHERE category_id = $1 LIMIT 1`,
      [id]
    );
    if (tagsCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "VALIDATION_FAILED", "Cannot delete category that has tags. Delete tags first.");
    }

    await client.query(
      `DELETE FROM categories WHERE id = $1`,
      [id]
    );

    await client.query("COMMIT");

    return ok(res, req, { message: "Category deleted successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Get all categories with subcategories (Admin)
 * GET /admin/categories
 */
async function getAllCategories(req, res) {
  try {
    const categoriesResult = await pool.query(`
      SELECT
        id,
        name,
        parent_id,
        sort_order,
        is_active,
        slug,
        created_at,
        updated_at
      FROM categories
      ORDER BY parent_id NULLS FIRST, sort_order ASC, name ASC
    `);

    return ok(res, req, { categories: categoriesResult.rows });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get single category (Admin)
 * GET /admin/categories/:id
 */
async function getCategoryById(req, res) {
  try {
    const { id } = req.params;

    const categoryResult = await pool.query(
      `SELECT id, name, parent_id, sort_order, is_active, slug, created_at, updated_at
       FROM categories WHERE id = $1`,
      [id]
    );

    if (categoryResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Category not found");
    }

    return ok(res, req, { category: categoryResult.rows[0] });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

module.exports = {
  getCategoriesTree,
  createCategory,
  updateCategory,
  deleteCategory,
  getAllCategories,
  getCategoryById,
};

