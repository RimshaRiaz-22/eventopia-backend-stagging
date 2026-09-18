const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");


async function getUserPreferences(req, res) {
  try {
    const userId = req.user.id;

    // Get user preferences
    const prefsResult = await pool.query(
      `SELECT city FROM user_preferences WHERE user_id = $1`,
      [userId]
    );

    // Get user's tag preferences
    const tagsResult = await pool.query(
      `SELECT tag_id FROM user_preference_tags WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );

    const city = prefsResult.rows[0]?.city || null;
    const tagIds = tagsResult.rows.map((r) => r.tag_id);

    return ok(res, req, {
      city,
      tagIds,
    });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

async function updateUserPreferences(req, res) {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const { city, tagIds } = req.body;

    if (tagIds !== undefined && !Array.isArray(tagIds)) {
      return fail(res, req, 400, "INVALID_INPUT", "tagIds must be an array");
    }

    if (city !== undefined && city !== null && typeof city !== "string") {
      return fail(res, req, 400, "INVALID_INPUT", "city must be a string or null");
    }

    const finalTagIds = tagIds || [];
    const finalCity = city === undefined ? null : city;

    await client.query("BEGIN");

    // Validate all tagIds exist and are active
    if (finalTagIds.length > 0) {
      const placeholders = finalTagIds.map((_, i) => `$${i + 1}`).join(",");
      const tagCheckResult = await client.query(
        `SELECT id FROM tags WHERE id IN (${placeholders}) AND is_active = true`,
        finalTagIds
      );

      if (tagCheckResult.rowCount !== finalTagIds.length) {
        await client.query("ROLLBACK");
        return fail(
          res,
          req,
          400,
          "INVALID_TAG_IDS",
          "One or more tagIds do not exist or are not active"
        );
      }
    }

    // Upsert user_preferences
    await client.query(
      `INSERT INTO user_preferences (user_id, city, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET city = $2, updated_at = NOW()`,
      [userId, finalCity]
    );

    // Replace tag mappings: delete old, insert new
    await client.query(`DELETE FROM user_preference_tags WHERE user_id = $1`, [userId]);

    if (finalTagIds.length > 0) {
      for (const tagId of finalTagIds) {
        await client.query(
          `INSERT INTO user_preference_tags (user_id, tag_id, created_at) VALUES ($1, $2, NOW())`,
          [userId, tagId]
        );
      }
    }

    await client.query("COMMIT");

    return ok(res, req, {
      city: finalCity,
      tagIds: finalTagIds,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

module.exports = {
  getUserPreferences,
  updateUserPreferences,
};
