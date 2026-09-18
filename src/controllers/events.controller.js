const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");
const { logEventChange } = require("../middlewares/audit.middleware");
const { BUYER_VISIBLE_EVENT_STATUS } = require("../utils/eventStatus");
const { ensureEscrowLiabilityForEvent, markPayoutEligibleForEvent } = require("../services/escrowLiability.service");
const crypto = require("crypto");

/**
 * Validate and parse eventId
 */
function validateEventId(eventId) {
  const eventIdNum = parseInt(eventId, 10);
  if (isNaN(eventIdNum) || eventIdNum <= 0) {
    const error = new Error("Invalid event ID");
    error.status = 404;
    throw error;
  }
  return eventIdNum;
}

/**
 * Generate a secure share token for private link events
 */
function generateShareToken() {
  return crypto.randomBytes(32).toString("hex");
}

function canManageEventStatus(user) {
  return user?.role === "promoter" || user?.role === "kings_account";
}

async function getEventForStatusAction(client, eventId, user, selectClause) {
  if (!canManageEventStatus(user)) {
    return { unauthorized: true, result: null };
  }

  if (user.role === "kings_account") {
    const result = await client.query(
      `SELECT ${selectClause} FROM events WHERE id = $1`,
      [eventId]
    );
    return { unauthorized: false, result };
  }

  const result = await client.query(
    `SELECT ${selectClause} FROM events WHERE id = $1 AND promoter_id = $2`,
    [eventId, user.id]
  );
  return { unauthorized: false, result };
}

let cachedEventsColumns = null;

async function getEventsColumnSet(client) {
  if (cachedEventsColumns) return cachedEventsColumns;
  const columnsResult = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'events'`
  );
  cachedEventsColumns = new Set(columnsResult.rows.map((r) => r.column_name));
  return cachedEventsColumns;
}

/**
 * Helper function to derive hierarchy attribution from promoter
 */
async function deriveHierarchyFromPromoter(promoterId) {
  const result = await pool.query(
    `SELECT
      pgl.guru_user_id as guru_id,
      gnm.network_manager_user_id as network_manager_id,
      gnm.territory_id,
      t.name as territory_name
    FROM users u
    LEFT JOIN promoter_guru_links pgl ON pgl.promoter_user_id = u.id
    LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = pgl.guru_user_id
    LEFT JOIN territories t ON t.id = gnm.territory_id
    WHERE u.id = $1 AND u.role = 'promoter'`,
    [promoterId]
  );

  if (result.rowCount === 0) {
    return { guru_id: null, network_manager_id: null, territory_id: null };
  }

  return result.rows[0];
}

/**
 * Phase E2: Create event
 * POST /promoter/events
 * Creates draft event with derived hierarchy attribution
 */
async function createEvent(req, res) {
  const client = await pool.connect();
  try {
    const promoterId = req.user.id;

    // Phase E0: Guard - Check if promoter is active
    if (req.user.account_status !== 'active') {
      return fail(res, req, 403, "FORBIDDEN", "Active promoter account required to create events");
    }

    const {
      title,
      description,
      startAt,
      endAt,
      timezone = "Europe/London",
      format = "in_person", // in_person, online_live, virtual_on_demand, hybrid
      accessMode = "ticketed", // ticketed, guest_list, mixed
      visibilityMode = "public", // public, private_link
      city,
      venueName,
      venueAddress,
      lat,
      lng,
      categoryId,
      tagIds,
      tagNames,
    } = req.body;

    // Validation
    if (!title && !description && !city && !startAt && !endAt) {
      return fail(res, req, 400, "VALIDATION_FAILED", "At least one field is required");
    }

    await client.query("BEGIN");

    // Phase E2: Derive hierarchy attribution from promoter
    const hierarchy = await deriveHierarchyFromPromoter(promoterId);

    // Generate share token if visibility mode is private_link
    let shareToken = null;
    if (visibilityMode === 'private_link') {
      shareToken = generateShareToken();
    }

    const eventColumns = await getEventsColumnSet(client);
    const insertColumns = [
      "promoter_id", "guru_id", "network_manager_id", "territory_id",
      "title", "description", "start_at", "end_at", "timezone",
      "format", "access_mode", "visibility", "share_token",
      "venue_name", "venue_address", "lat", "lng",
      "category_id", "status", "ticketing_required"
    ];
    const insertValues = [
      promoterId,
      hierarchy.guru_id,
      hierarchy.network_manager_id,
      hierarchy.territory_id,
      title || null,
      description || null,
      startAt || null,
      endAt || null,
      timezone,
      format,
      accessMode,
      visibilityMode,
      shareToken,
      venueName || null,
      venueAddress || null,
      lat ?? null,
      lng ?? null,
      categoryId || null,
      "draft",
      true
    ];

    if (eventColumns.has("city_display")) {
      insertColumns.push("city_display");
      insertValues.push(city || null);
    }
    if (eventColumns.has("city")) {
      insertColumns.push("city");
      insertValues.push(city || null);
    }

    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(", ");
    const eventResult = await client.query(
      `INSERT INTO events (${insertColumns.join(", ")})
       VALUES (${placeholders})
       RETURNING id`,
      insertValues
    );

    const eventId = eventResult.rows[0].id;

    // Handle tags if provided
    if (tagIds || tagNames) {
      await attachTagsToEvent(client, eventId, tagIds, tagNames);
    }

    await client.query("COMMIT");

    return ok(res, req, { id: eventId, message: "Event created successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Phase E2: Update event
 * PATCH /promoter/events/:eventId
 */
async function updateEvent(req, res) {
  const client = await pool.connect();
  try {
    const eventId = validateEventId(req.params.eventId);
    const promoterId = req.user.id;

    const {
      title,
      description,
      startAt,
      endAt,
      timezone,
      format, // in_person, online_live, virtual_on_demand, hybrid
      accessMode, // ticketed, guest_list, mixed
      visibilityMode, // public, private_link
      city,
      venueName,
      venueAddress,
      lat,
      lng,
      categoryId,
      tagIds,
      tagNames,
      resetShareToken, // boolean flag to regenerate share token
    } = req.body;

    await client.query("BEGIN");

    // Check ownership
    const checkResult = await client.query(
      `SELECT status, visibility, share_token FROM events WHERE id = $1 AND promoter_id = $2`,
      [eventId, promoterId]
    );

    if (checkResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = checkResult.rows[0];

    // Phase E0: Guard - Cannot edit cancelled or cancellation-requested events
    if (event.status === 'cancelled' || event.status === 'cancellation_requested') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Cancelled or cancellation-requested events cannot be edited");
    }

    // Build dynamic update
    const fields = [];
    const values = [];
    let idx = 1;

    const addField = (column, value) => {
      fields.push(`${column} = $${idx++}`);
      values.push(value);
    };

    if (title !== undefined) addField("title", title);
    if (description !== undefined) addField("description", description);
    if (startAt !== undefined) addField("start_at", startAt);
    if (endAt !== undefined) addField("end_at", endAt);
    if (timezone !== undefined) addField("timezone", timezone);
    if (format !== undefined) addField("format", format);
    if (accessMode !== undefined) addField("access_mode", accessMode);
    if (visibilityMode !== undefined) addField("visibility", visibilityMode);
    const eventColumns = await getEventsColumnSet(client);
    if (city !== undefined) {
      if (eventColumns.has("city_display")) addField("city_display", city);
      if (eventColumns.has("city")) addField("city", city);
    }
    if (venueName !== undefined) addField("venue_name", venueName);
    if (venueAddress !== undefined) addField("venue_address", venueAddress);
    if (lat !== undefined) addField("lat", lat);
    if (lng !== undefined) addField("lng", lng);
    if (categoryId !== undefined) addField("category_id", categoryId);

    // Handle share token reset
    if (resetShareToken || (visibilityMode === 'private_link' && !event.share_token)) {
      const newShareToken = generateShareToken();
      addField("share_token", newShareToken);
    }

    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(eventId);
      await client.query(
        `UPDATE events SET ${fields.join(", ")} WHERE id = $${idx}`,
        values
      );
    }

    // Handle tag updates if provided
    if (tagIds !== undefined || tagNames !== undefined) {
      await attachTagsToEvent(client, eventId, tagIds, tagNames);
    }

    await client.query("COMMIT");

    return ok(res, req, { id: eventId });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Helper function to attach tags to an event
 */
async function attachTagsToEvent(client, eventId, tagIds, tagNames) {
  const tagIdArray = Array.isArray(tagIds) ? tagIds : tagIds ? [tagIds] : [];
  const tagNameArray = Array.isArray(tagNames) ? tagNames : tagNames ? [tagNames] : [];

  let allTagIds = [...tagIdArray];

  // Auto-create tags from names if provided
  if (tagNameArray.length > 0) {
    for (const tagName of tagNameArray) {
      if (!tagName || typeof tagName !== 'string') continue;

      // Check if tag exists (case-insensitive)
      const existingTag = await client.query(
        `SELECT id FROM tags WHERE LOWER(name) = LOWER($1)`,
        [tagName]
      );

      let tagId;
      if (existingTag.rowCount > 0) {
        tagId = existingTag.rows[0].id;
      } else {
        // Create new tag
        const slug = tagName.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .trim();

        const newTagResult = await client.query(
          `INSERT INTO tags (name, slug) VALUES ($1, $2) RETURNING id`,
          [tagName, slug]
        );
        tagId = newTagResult.rows[0].id;
      }

      allTagIds.push(tagId);
    }
  }

  // Replace existing tags
  await client.query(`DELETE FROM event_tags WHERE event_id = $1`, [eventId]);
  if (allTagIds.length > 0) {
    const uniqueTagIds = [...new Set(allTagIds)];
    const placeholders = uniqueTagIds.map((_, i) => `($1, $${i + 2})`).join(",");
    await client.query(
      `INSERT INTO event_tags (event_id, tag_id) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      [eventId, ...uniqueTagIds]
    );
  }
}

/**
 * Phase E3: Upload event image
 * POST /promoter/events/:eventId/images
 */
async function uploadEventImage(req, res) {
  try {
    const eventId = validateEventId(req.params.eventId);
    const { type } = req.query; // 'cover' or 'gallery'

    if (!req.file) {
      return fail(res, req, 400, "NO_FILE", "Image file is required");
    }

    const url = `/uploads/${req.file.filename}`;

    if (type === 'cover') {
      // Update event_media table
      const result = await pool.query(
        `INSERT INTO event_media (event_id, file_url, file_type, is_cover, sort_order)
         VALUES ($1, $2, 'image', true, 0)
         RETURNING id`,
        [eventId, url]
      );

      // Unset any existing cover images
      await pool.query(
        `UPDATE event_media SET is_cover = false WHERE event_id = $1 AND id != $2`,
        [eventId, result.rows[0].id]
      );

      // Update legacy events table field for backward compatibility
      await pool.query(
        `UPDATE events SET cover_image_url = $1, updated_at = NOW() WHERE id = $2`,
        [url, eventId]
      );

      return ok(res, req, {
        mediaId: result.rows[0].id,
        coverImageUrl: url
      });
    } else if (type === 'gallery') {
      // Check gallery limit (max 10 images)
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM event_media WHERE event_id = $1 AND is_cover = false`,
        [eventId]
      );

      const galleryCount = parseInt(countResult.rows[0].count);

      if (galleryCount >= 10) {
        return fail(res, req, 400, "GALLERY_LIMIT_EXCEEDED", "Maximum 10 gallery images allowed");
      }

      // Get next sort order
      const sortResult = await pool.query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort
         FROM event_media WHERE event_id = $1`,
        [eventId]
      );

      const nextSortOrder = parseInt(sortResult.rows[0].next_sort);

      // Insert into event_media table
      const result = await pool.query(
        `INSERT INTO event_media (event_id, file_url, file_type, is_cover, sort_order)
         VALUES ($1, $2, 'image', false, $3)
         RETURNING id`,
        [eventId, url, nextSortOrder]
      );

      // Update legacy gallery array for backward compatibility
      await pool.query(
        `UPDATE events
         SET gallery_image_urls =
           CASE
             WHEN gallery_image_urls IS NULL THEN ARRAY[$1]::text[]
             ELSE array_append(gallery_image_urls, $1)
           END,
           updated_at = NOW()
         WHERE id = $2`,
        [url, eventId]
      );

      return ok(res, req, {
        id: result.rows[0].id,
        mediaId: result.rows[0].id,
        imageUrl: url,
        sortOrder: nextSortOrder
      });
    } else {
      return fail(res, req, 400, "INVALID_TYPE", "Type must be 'cover' or 'gallery'");
    }
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Phase E3: Set event category
 * PUT /promoter/events/:eventId/category
 */
async function setEventCategory(req, res) {
  const eventId = validateEventId(req.params.eventId);
  const { categoryId } = req.body;

  await pool.query(
    `UPDATE events SET category_id = $1, updated_at = NOW() WHERE id = $2`,
    [categoryId || null, eventId]
  );

  return ok(res, req, { message: "Category updated successfully" });
}

/**
 * Phase E3: Set event tags
 * PUT /promoter/events/:eventId/tags
 */
async function setEventTags(req, res) {
  const client = await pool.connect();
  try {
    const eventId = validateEventId(req.params.eventId);
    const { tagIds, tagNames } = req.body;

    await attachTagsToEvent(client, eventId, tagIds, tagNames);

    await client.query("COMMIT");
    return ok(res, req, { message: "Tags updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Shared validation for submit/publish readiness
 */
async function getEventSubmissionMissingFields(client, event, eventId) {
  const missingFields = [];

  if (!event.title) missingFields.push("title");
  if (!event.description) missingFields.push("description");
  if (!event.start_at) missingFields.push("startAt");
  if (!event.end_at) missingFields.push("endAt");
  if (!event.city_display) missingFields.push("city");
  if (!event.format) missingFields.push("format");
  if (!event.access_mode) missingFields.push("accessMode");

  // Require at least 1 active ticket type for ticketed or mixed events
  if (event.access_mode === 'ticketed' || event.access_mode === 'mixed') {
    const ticketCountResult = await client.query(
      `SELECT COUNT(*) as count FROM ticket_types WHERE event_id = $1 AND status = 'active'`,
      [eventId]
    );

    if (parseInt(ticketCountResult.rows[0].count, 10) === 0) {
      missingFields.push("At least 1 active ticket type");
    }
  }

  return missingFields;
}

/**
 * Phase E4: Submit event for admin approval
 * POST /promoter/events/:eventId/submit
 */
async function submitEvent(req, res) {
  const client = await pool.connect();
  try {
    const eventId = validateEventId(req.params.eventId);
    await client.query("BEGIN");

    const { unauthorized, result: eventResult } = await getEventForStatusAction(
      client,
      eventId,
      req.user,
      "status, title, description, start_at, end_at, city_display, format, access_mode, venue_name, venue_address, cover_image_url"
    );

    if (unauthorized) {
      await client.query("ROLLBACK");
      return fail(res, req, 403, "FORBIDDEN", "Only promoters or kings_account can update event status");
    }

    if (eventResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = eventResult.rows[0];

    if (event.status === 'pending_approval') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Event is already pending approval");
    }

    if (event.status === 'published') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Published events cannot be submitted for approval");
    }

    if (event.status === 'cancelled' || event.status === 'cancellation_requested') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Cancelled or cancellation-requested events cannot be submitted for approval");
    }

    const missingFields = await getEventSubmissionMissingFields(client, event, eventId);

    if (missingFields.length > 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "VALIDATION_FAILED",
        `Cannot submit for approval. Missing required: ${missingFields.join(", ")}`);
    }

    await client.query(
      `UPDATE events SET status = 'pending_approval', updated_at = NOW() WHERE id = $1`,
      [eventId]
    );

    await client.query("COMMIT");
    await logEventChange(req, 'submitted_for_approval', eventId);

    return ok(res, req, {
      id: parseInt(eventId, 10),
      status: 'pending_approval',
      message: "Event submitted for admin approval"
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Phase E4: Publish event
 * POST /promoter/events/:eventId/publish
 */
async function publishEvent(req, res) {
  const client = await pool.connect();
  try {
    const eventId = validateEventId(req.params.eventId);
    await client.query("BEGIN");

    const { unauthorized, result: eventResult } = await getEventForStatusAction(
      client,
      eventId,
      req.user,
      "status, title, description, start_at, end_at, city_display, format, access_mode, venue_name, venue_address, cover_image_url"
    );

    if (unauthorized) {
      await client.query("ROLLBACK");
      return fail(res, req, 403, "FORBIDDEN", "Only promoters or kings_account can update event status");
    }

    if (eventResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = eventResult.rows[0];

    if (event.status === 'published') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Event is already published");
    }

    if (event.status === 'cancelled' || event.status === 'cancellation_requested') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Cancelled or cancellation-requested events cannot be published");
    }

    // Phase E4: Publish validation (client-aligned)
    const missingFields = await getEventSubmissionMissingFields(client, event, eventId);

    if (missingFields.length > 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "VALIDATION_FAILED",
        `Cannot publish. Missing required: ${missingFields.join(", ")}`);
    }

    await client.query(
      `UPDATE events SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [eventId]
    );

    try {
      await ensureEscrowLiabilityForEvent(eventId, { client });
    } catch (liabilityErr) {
      console.warn("[publishEvent] liability sync skipped:", liabilityErr.message);
    }

    await client.query("COMMIT");
    await logEventChange(req, 'published', eventId);

    return ok(res, req, { id: parseInt(eventId, 10), status: 'published', publishedAt: new Date().toISOString() });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Phase E4: Pause event
 * POST /promoter/events/:eventId/pause
 */
async function pauseEvent(req, res) {
  const client = await pool.connect();
  try {
    const eventId = validateEventId(req.params.eventId);
    await client.query("BEGIN");

    const { unauthorized, result } = await getEventForStatusAction(
      client,
      eventId,
      req.user,
      "status"
    );

    if (unauthorized) {
      await client.query("ROLLBACK");
      return fail(res, req, 403, "FORBIDDEN", "Only promoters or kings_account can update event status");
    }

    if (result.rowCount === 0 || result.rows[0].status !== 'published') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Only published events can be paused");
    }

    await client.query(
      `UPDATE events SET status = 'unpublished', updated_at = NOW() WHERE id = $1`,
      [eventId]
    );

    await client.query("COMMIT");
    await logEventChange(req, 'paused', eventId);

    return ok(res, req, { id: parseInt(eventId, 10), status: 'unpublished' });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Phase E4: Cancel event
 * POST /promoter/events/:eventId/cancel
 */
async function cancelEvent(req, res) {
  const client = await pool.connect();
  try {
    const eventId = validateEventId(req.params.eventId);
    const { reason } = req.body; // cancel_reason is optional but recommended

    await client.query("BEGIN");

    const { unauthorized, result } = await getEventForStatusAction(
      client,
      eventId,
      req.user,
      "status"
    );

    if (unauthorized) {
      await client.query("ROLLBACK");
      return fail(res, req, 403, "FORBIDDEN", "Only promoters or kings_account can update event status");
    }

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    if (result.rows[0].status === 'cancelled') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Event is already cancelled");
    }
    if (result.rows[0].status === 'cancellation_requested') {
      await client.query("ROLLBACK");
      return fail(res, req, 409, "DUPLICATE_REQUEST", "Cancellation request already submitted and pending admin review");
    }

    await client.query(
      `UPDATE events
       SET status = 'cancellation_requested',
           cancel_reason = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [reason || null, eventId]
    );

    await client.query("COMMIT");
    await logEventChange(req, 'cancellation_requested', eventId, { cancelReason: reason });

    return ok(res, req, {
      id: parseInt(eventId, 10),
      status: 'cancellation_requested',
      message: 'Cancellation request submitted. Awaiting admin approval.'
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Phase E4: Republish event (from unpublished state)
 * POST /promoter/events/:eventId/republish
 */
async function republishEvent(req, res) {
  const client = await pool.connect();
  try {
    const eventId = validateEventId(req.params.eventId);
    await client.query("BEGIN");

    const { unauthorized, result } = await getEventForStatusAction(
      client,
      eventId,
      req.user,
      "status"
    );

    if (unauthorized) {
      await client.query("ROLLBACK");
      return fail(res, req, 403, "FORBIDDEN", "Only promoters or kings_account can update event status");
    }

    if (result.rowCount === 0 || result.rows[0].status !== 'unpublished') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Only unpublished events can be republished");
    }

    await client.query(
      `UPDATE events SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [eventId]
    );

    try {
      await ensureEscrowLiabilityForEvent(eventId, { client });
    } catch (liabilityErr) {
      console.warn("[republishEvent] liability sync skipped:", liabilityErr.message);
    }

    await client.query("COMMIT");
    await logEventChange(req, 'republished', eventId);

    return ok(res, req, { id: parseInt(eventId, 10), status: 'published' });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Phase E2: Get promoter's events
 * GET /promoter/events
 */
async function getPromoterEvents(req, res) {
  const { status, sort = "updated", page = "1", pageSize = "20", search } = req.query;
  const promoterId = req.user.id;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSizeNum = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * pageSizeNum;

  const conditions = ["e.promoter_id = $1"];
  const params = [promoterId];
  let paramCount = 2;

  if (status) {
    conditions.push(`e.status = $${paramCount++}`);
    params.push(status);
  }

  const searchTrim = typeof search === "string" ? search.trim() : "";
  if (searchTrim.length > 0) {
    conditions.push(`(
      e.title ILIKE $${paramCount} OR
      e.venue_name ILIKE $${paramCount} OR
      e.city_display ILIKE $${paramCount}
    )`);
    params.push(`%${searchTrim}%`);
    paramCount++;
  }

  const orderBy = sort === "created" ? "e.created_at DESC" :
    sort === "start" ? "e.start_at ASC" :
      sort === "title" ? "e.title ASC" :
        sort === "tickets" ? "e.tickets_sold DESC" : "e.updated_at DESC";

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const countQuery = `SELECT COUNT(*) as total FROM events e ${whereClause}`;
  const countResult = await pool.query(countQuery, params);
  const total = parseInt(countResult.rows[0].total, 10);

  const eventsQuery = `
    SELECT e.id, e.title, e.status, e.visibility AS "visibility_mode", e.start_at as "startAt",
           e.end_at as "endAt", e.city_display AS city, e.venue_name as "venueName",
           e.format, e.access_mode, e.cover_image_url as "coverImageUrl",
           e.gallery_image_urls as "galleryImageUrls", e.tickets_sold,
           (SELECT SUM(tt.capacity_total)::int FROM ticket_types tt WHERE tt.event_id = e.id) AS "capacityTotal",
           (SELECT COUNT(*)::int FROM event_views ev WHERE ev.event_id = e.id) AS "views_count",
           e.published_at as "publishedAt", e.share_token
    FROM events e ${whereClause}
    ORDER BY ${orderBy}
    LIMIT $${paramCount} OFFSET $${paramCount + 1}
  `;
  params.push(pageSizeNum, offset);
  const eventsResult = await pool.query(eventsQuery, params);

  return ok(res, req, {
    items: eventsResult.rows,
    pagination: { page: pageNum, pageSize: pageSizeNum, total }
  });
}

/**
 * Phase E2: Get single event for promoter
 * GET /promoter/events/:eventId
 */
async function getPromoterEventDetail(req, res) {
  const eventId = validateEventId(req.params.eventId);

  const eventResult = await pool.query(
    `SELECT
       e.*,
       u.name as promoter_name,
       c.name as category_name,
       t.name as territory_name
     FROM events e
     LEFT JOIN users u ON u.id = e.promoter_id
     LEFT JOIN categories c ON c.id = e.category_id
     LEFT JOIN territories t ON t.id = e.territory_id
     WHERE e.id = $1 AND e.promoter_id = $2`,
    [eventId, req.user.id]
  );

  if (eventResult.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Event not found");
  }

  const event = eventResult.rows[0];

  // Get tags
  const tagsResult = await pool.query(
    `SELECT t.id, t.name, t.slug
     FROM event_tags et
     JOIN tags t ON t.id = et.tag_id
     WHERE et.event_id = $1
     ORDER BY t.sort_order, t.name`,
    [eventId]
  );

  event.tags = tagsResult.rows;

  // API / older docs use visibility_mode + city; DB columns are visibility + city_display
  event.visibility_mode = event.visibility;
  event.city = event.city_display ?? event.city;

  // Get ticket types with availability
  const ticketTypesResult = await pool.query(
    `SELECT
      id, name, description, currency, price_amount as "priceAmount",
      booking_fee_amount as "bookingFeeAmount",
      (price_amount + booking_fee_amount) as "totalAmount",
      sales_start_at as "salesStartAt",
      sales_end_at as "salesEndAt",
      capacity_total as "capacityTotal",
      qty_sold as "capacitySold",
      per_order_limit as "perOrderLimit",
      visibility,
      status,
      sort_order as "sortOrder"
     FROM ticket_types
     WHERE event_id = $1
     ORDER BY sort_order, name`,
    [eventId]
  );

  event.ticketTypes = ticketTypesResult.rows.map(tt => {
    const capacityTotal = tt.capacityTotal;
    const capacitySold = tt.capacitySold || 0;
    const capacityRemaining = capacityTotal
      ? capacityTotal - capacitySold
      : null;

    return {
      id: tt.id,
      name: tt.name,
      description: tt.description,
      currency: tt.currency,
      priceAmount: tt.priceAmount,
      bookingFeeAmount: tt.bookingFeeAmount,
      totalAmount: parseInt(tt.totalAmount, 10),
      salesStartAt: tt.salesStartAt,
      salesEndAt: tt.salesEndAt,
      capacityTotal: capacityTotal,
      capacitySold: capacitySold,
      capacityRemaining: capacityRemaining,
      perOrderLimit: tt.perOrderLimit,
      visibility: tt.visibility,
      status: tt.status,
      sortOrder: tt.sortOrder,
    };
  });

  return ok(res, req, event);
}

/**
 * Phase E5: Public event listing (buyers)
 * GET /events
 */
async function getEventsList(req, res) {
  try {
    const {
      city,
      categoryId,
      tagIds,
      dateFrom,
      dateTo,
      search,
      sort = "soonest",
      page = "1",
      pageSize = "20",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 20));
    const offset = (pageNum - 1) * pageSizeNum;

    // Build WHERE conditions
    const conditions = [`e.status = '${BUYER_VISIBLE_EVENT_STATUS}'`, "e.visibility = 'public'"];
    const params = [];
    let paramCount = 1;

    if (city) {
      conditions.push(`e.city_display = $${paramCount++}`);
      params.push(city);
    }

    if (dateFrom) {
      conditions.push(`e.start_at >= $${paramCount++}`);
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push(`e.end_at <= $${paramCount++}`);
      params.push(dateTo);
    }

    if (categoryId) {
      conditions.push(`e.category_id = $${paramCount++}`);
      params.push(categoryId);
    }

    if (search) {
      conditions.push(`(e.title ILIKE $${paramCount} OR e.venue_name ILIKE $${paramCount})`);
      params.push(`%${search}%`);
      paramCount++;
    }

    // Handle tagIds filter
    let tagJoin = "";
    if (tagIds) {
      const tagIdArray = Array.isArray(tagIds)
        ? tagIds
        : tagIds.split(",").map(t => t.trim()).filter(Boolean);
      if (tagIdArray.length > 0) {
        const tagPlaceholders = tagIdArray.map((_, i) => `$${paramCount + i}`).join(",");
        tagJoin = `INNER JOIN event_tags et ON et.event_id = e.id AND et.tag_id IN (${tagPlaceholders})`;
        params.push(...tagIdArray);
        paramCount += tagIdArray.length;
      }
    }

    // Build sort clause
    let orderBy = "";
    switch (sort) {
      case "newest":
        orderBy = "e.created_at DESC";
        break;
      case "popular":
        orderBy = "e.tickets_sold DESC";
        break;
      case "soonest":
      default:
        orderBy = "e.start_at ASC";
        break;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total
    const countQuery = `
      SELECT COUNT(DISTINCT e.id) as total
      FROM events e
      ${tagJoin}
      ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Get events with pagination
    const eventsQuery = `
      SELECT DISTINCT
        e.id,
        e.title,
        e.start_at as "startAt",
        e.end_at as "endAt",
        e.city_display AS city,
        e.venue_name as "venueName",
        e.format,
        e.access_mode,
        e.category_id,
        e.tickets_sold,
        e.cover_image_url as "coverImageUrl"
      FROM events e
      ${tagJoin}
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    params.push(pageSizeNum, offset);
    const eventsResult = await pool.query(eventsQuery, params);

    const eventIds = eventsResult.rows.map(e => e.id);
    if (eventIds.length === 0) {
      return ok(res, req, {
        items: [],
        pagination: { page: pageNum, pageSize: pageSizeNum, total: 0 },
      });
    }

    // Get categories and tags for each event
    const categoriesResult = await pool.query(
      `SELECT id, name, slug FROM categories WHERE id = ANY($1::bigint[])`,
      [eventsResult.rows.map(e => e.category_id).filter(Boolean)]
    );
    const categoriesMap = new Map(categoriesResult.rows.map(c => [c.id, c]));

    const eventTagsResult = await pool.query(
      `SELECT et.event_id, t.id, t.name, t.slug
       FROM event_tags et
       JOIN tags t ON t.id = et.tag_id
       WHERE et.event_id = ANY($1::bigint[])
       ORDER BY et.event_id, t.sort_order, t.name`,
      [eventIds]
    );
    const tagsByEvent = new Map();
    for (const row of eventTagsResult.rows) {
      if (!tagsByEvent.has(row.event_id)) {
        tagsByEvent.set(row.event_id, []);
      }
      tagsByEvent.get(row.event_id).push({
        id: row.id,
        name: row.name,
        slug: row.slug,
      });
    }

    // Build response items
    const items = eventsResult.rows.map(event => {
      const category = event.category_id ? categoriesMap.get(event.category_id) : null;
      return {
        id: event.id,
        title: event.title,
        startAt: event.startAt,
        endAt: event.endAt,
        city: event.city,
        venueName: event.venueName,
        format: event.format,
        accessMode: event.access_mode,
        category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
        tags: tagsByEvent.get(event.id) || [],
        coverImageUrl: event.coverImageUrl || null,
        ticketsSold: event.tickets_sold,
      };
    });

    return ok(res, req, { items, pagination: { page: pageNum, pageSize: pageSizeNum, total } });
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Phase E5: Public event detail (buyers)
 * GET /events/:id
 */
async function getEventDetail(req, res) {
  try {
    const eventId = validateEventId(req.params.id);

    // Only buyer-visible + public events
    const eventResult = await pool.query(
      `SELECT
        e.*,
        u.name as promoter_name
       FROM events e
       LEFT JOIN users u ON u.id = e.promoter_id
       WHERE e.id = $1 AND e.status = '${BUYER_VISIBLE_EVENT_STATUS}' AND e.visibility = 'public'`,
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Event not found or not accessible");
    }

    const event = eventResult.rows[0];

    // Get category
    let category = null;
    if (event.category_id) {
      const catResult = await pool.query(
        `SELECT id, name, slug FROM categories WHERE id = $1`,
        [event.category_id]
      );
      if (catResult.rowCount > 0) {
        category = catResult.rows[0];
      }
    }

    // Get tags
    const tagsResult = await pool.query(
      `SELECT t.id, t.name, t.slug
       FROM event_tags et
       JOIN tags t ON t.id = et.tag_id
       WHERE et.event_id = $1
       ORDER BY t.sort_order, t.name`,
      [eventId]
    );

    // Get ticket types (if access mode includes ticketed)
    let ticketTypes = [];
    if (event.access_mode === 'ticketed' || event.access_mode === 'mixed') {
      const ticketTypesResult = await pool.query(
        `SELECT
          id, name, description, currency, price_amount as "priceAmount",
          booking_fee_amount as "bookingFeeAmount",
          (price_amount + booking_fee_amount) as "totalAmount",
          sales_start_at as "salesStartAt",
          sales_end_at as "salesEndAt",
          capacity_total as "capacityTotal",
          qty_sold as "capacitySold",
          per_order_limit as "perOrderLimit",
          visibility,
          status
         FROM ticket_types
         WHERE event_id = $1 AND status != 'hidden' AND visibility = 'public'
         ORDER BY sort_order, name`,
        [eventId]
      );

      ticketTypes = ticketTypesResult.rows.map(tt => {
        const capacityTotal = tt.capacityTotal;
        const capacitySold = tt.capacitySold || 0;
        const capacityRemaining = capacityTotal
          ? capacityTotal - capacitySold
          : null; // Unlimited if capacity_total is null

        return {
          id: tt.id,
          name: tt.name,
          description: tt.description,
          currency: tt.currency,
          priceAmount: tt.priceAmount,
          bookingFeeAmount: tt.bookingFeeAmount,
          totalAmount: parseInt(tt.totalAmount, 10),
          salesStartAt: tt.salesStartAt,
          salesEndAt: tt.salesEndAt,
          capacityTotal: capacityTotal,
          capacitySold: capacitySold,
          capacityRemaining: capacityRemaining,
          perOrderLimit: tt.perOrderLimit,
          status: tt.status,
        };
      });
    }

    const response = {
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        startAt: event.start_at,
        endAt: event.end_at,
        timezone: event.timezone,
        city: event.city_display ?? event.city,
        venueName: event.venue_name,
        venueAddress: event.venue_address,
        format: event.format,
        accessMode: event.access_mode,
        category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
        tags: tagsResult.rows,
        promoter: event.promoter_name ? { name: event.promoter_name } : null,
        images: {
          coverImageUrl: event.cover_image_url,
          galleryImageUrls: event.gallery_image_urls || [],
        },
      },
      ticketTypes,
    };

    return ok(res, req, response);
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Phase E5: Private link event detail
 * GET /events/share/:shareToken
 */
async function getEventByShareToken(req, res) {
  try {
    const { shareToken } = req.params;

    // Only buyer-visible + private_link events
    const eventResult = await pool.query(
      `SELECT
        e.*,
        u.name as promoter_name
       FROM events e
       LEFT JOIN users u ON u.id = e.promoter_id
       WHERE e.share_token = $1 AND e.status = '${BUYER_VISIBLE_EVENT_STATUS}' AND e.visibility = 'private_link'`,
      [shareToken]
    );

    if (eventResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Event not found or not accessible");
    }

    const event = eventResult.rows[0];

    // Generate access grant for this event
    const { generateAccessGrant } = require('../services/access.service');
    const accessGrant = generateAccessGrant(event.id, req.user?.id);

    // Set access grant cookie (httpOnly for security, secure in production)
    res.cookie('event_access_grant', accessGrant, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 60 * 1000, // 30 minutes
      sameSite: 'strict'
    });

    // Get category
    let category = null;
    if (event.category_id) {
      const catResult = await pool.query(
        `SELECT id, name, slug FROM categories WHERE id = $1`,
        [event.category_id]
      );
      if (catResult.rowCount > 0) {
        category = catResult.rows[0];
      }
    }

    // Get tags
    const tagsResult = await pool.query(
      `SELECT t.id, t.name, t.slug
       FROM event_tags et
       JOIN tags t ON t.id = et.tag_id
       WHERE et.event_id = $1
       ORDER BY t.sort_order, t.name`,
      [event.id]
    );

    // Get ticket types (if access mode includes ticketed)
    let ticketTypes = [];
    if (event.access_mode === 'ticketed' || event.access_mode === 'mixed') {
      const ticketTypesResult = await pool.query(
        `SELECT
          id, name, currency, price_amount as "priceAmount",
          booking_fee_amount as "bookingFeeAmount",
          (price_amount + booking_fee_amount) as "totalAmount",
          sales_start_at as "salesStartAt",
          sales_end_at as "salesEndAt",
          capacity_total as "capacityTotal",
          status
         FROM ticket_types
         WHERE event_id = $1 AND status != 'hidden'
         ORDER BY sort_order, name`,
        [event.id]
      );

      ticketTypes = ticketTypesResult.rows.map(tt => ({
        id: tt.id,
        name: tt.name,
        currency: tt.currency,
        priceAmount: tt.priceAmount,
        bookingFeeAmount: tt.bookingFeeAmount,
        totalAmount: parseInt(tt.totalAmount, 10),
        salesStartAt: tt.salesStartAt,
        salesEndAt: tt.salesEndAt,
        capacityTotal: tt.capacityTotal,
        remaining: null,
        status: tt.status,
      }));
    }

    const response = {
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        startAt: event.start_at,
        endAt: event.end_at,
        timezone: event.timezone,
        city: event.city_display ?? event.city,
        venueName: event.venue_name,
        venueAddress: event.venue_address,
        format: event.format,
        accessMode: event.access_mode,
        category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
        tags: tagsResult.rows,
        promoter: event.promoter_name ? { name: event.promoter_name } : null,
        images: {
          coverImageUrl: event.cover_image_url,
          galleryImageUrls: event.gallery_image_urls || [],
        },
      },
      ticketTypes,
    };

    return ok(res, req, response);
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Phase E6: Event performance metrics
 * GET /promoter/events/:eventId/performance
 */
async function getEventPerformance(req, res) {
  const eventId = validateEventId(req.params.eventId);

  const eventResult = await pool.query(
    `SELECT e.tickets_sold,
            (SELECT COUNT(*)::int FROM event_views ev WHERE ev.event_id = e.id) AS views_count
     FROM events e WHERE e.id = $1`,
    [eventId]
  );

  const ticketsSold = eventResult.rows[0]?.tickets_sold || 0;
  const viewsCount = eventResult.rows[0]?.views_count || 0;
  const conversionRate = viewsCount > 0 ? (ticketsSold / viewsCount) * 100 : 0;

  const performance = {
    eventId: parseInt(eventId, 10),
    ticketsSold,
    viewsCount,
    conversionRate: Math.round(conversionRate * 100) / 100,
    grossRevenue: 0, // Placeholder
    bookingFeesCollected: 0, // Placeholder
    refundsTotal: 0, // Placeholder
    generatedAt: new Date().toISOString(),
  };

  return ok(res, req, performance);
}

/**
 * Phase E7: Complete event (manual)
 * POST /promoter/events/:eventId/complete
 */
async function completeEvent(req, res) {
  const client = await pool.connect();
  try {
    const eventId = validateEventId(req.params.eventId);
    await client.query("BEGIN");

    const { unauthorized, result } = await getEventForStatusAction(
      client,
      eventId,
      req.user,
      "status, end_at"
    );

    if (unauthorized) {
      await client.query("ROLLBACK");
      return fail(res, req, 403, "FORBIDDEN", "Only promoters or kings_account can update event status");
    }

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Event not found");
    }

    const event = result.rows[0];

    if (event.status === 'cancelled' || event.status === 'cancellation_requested') {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Cancelled or cancellation-requested events cannot be completed");
    }

    await client.query(
      `UPDATE events SET completion_status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [eventId]
    );

    try {
      await markPayoutEligibleForEvent(eventId, { client });
    } catch (liabilityErr) {
      console.warn("[completeEvent] payout-eligible sync skipped:", liabilityErr.message);
    }

    await client.query("COMMIT");
    await logEventChange(req, 'completed', eventId);

    return ok(res, req, { id: parseInt(eventId, 10), completionStatus: 'completed', completedAt: new Date().toISOString() });
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Delete event cover image
 * DELETE /promoter/events/:eventId/cover
 */
async function deleteEventCover(req, res) {
  const eventId = validateEventId(req.params.eventId);

  const result = await pool.query(
    `SELECT cover_image_url, promoter_id FROM events WHERE id = $1`,
    [eventId]
  );

  if (result.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Event not found");
  }

  if (result.rows[0].promoter_id !== req.user.id) {
    return fail(res, req, 403, "FORBIDDEN", "You cannot edit this event");
  }

  const coverImageUrl = result.rows[0].cover_image_url;

  if (!coverImageUrl) {
    return fail(res, req, 400, "NO_IMAGE", "No cover image to delete");
  }

  await pool.query(
    `UPDATE events SET cover_image_url = NULL, updated_at = NOW() WHERE id = $1`,
    [eventId]
  );

  await logEventChange(req, 'image_deleted', eventId, {
    fieldName: 'cover_image_url',
    oldValue: coverImageUrl,
    newValue: null
  });

  return ok(res, req, { message: "Cover image deleted successfully" });
}

/**
 * Delete an event (promoter can only delete their own events)
 * DELETE /api/promoters/events/:eventId
 */
async function deleteEvent(req, res) {
  const eventId = validateEventId(req.params.eventId);
  const promoterId = req.user.id;

  // Check if event exists and belongs to the promoter
  const eventResult = await pool.query(
    `SELECT id, title, promoter_id, status, tickets_sold FROM events WHERE id = $1`,
    [eventId]
  );

  if (eventResult.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Event not found");
  }

  const event = eventResult.rows[0];

  // Check ownership
  if (event.promoter_id !== promoterId) {
    return fail(res, req, 403, "FORBIDDEN", "You cannot delete this event");
  }

  // Check if event has tickets sold
  if (event.tickets_sold > 0) {
    return fail(res, req, 400, "TICKETS_SOLD", "Cannot delete event with tickets sold. Consider cancelling the event instead.");
  }

  // Check if event is active (published)
  if (event.status === 'published') {
    return fail(res, req, 400, "CANNOT_DELETE", "Cannot delete a published event. Please cancel or pause the event first.");
  }

  // Delete event (cascade will handle related records)
  await pool.query('DELETE FROM events WHERE id = $1', [eventId]);

  await logEventChange(req, 'event_deleted', eventId, {
    eventTitle: event.title,
    oldStatus: event.status
  });

  return ok(res, req, { message: "Event deleted successfully", eventId });
}

/**
 * Delete gallery image
 * DELETE /promoter/events/:eventId/gallery/:imageId
 */
async function deleteEventGalleryImage(req, res) {
  const eventId = validateEventId(req.params.eventId);
  const imageId = parseInt(req.params.imageId, 10);

  // Check event ownership
  const eventResult = await pool.query(
    `SELECT promoter_id FROM events WHERE id = $1`,
    [eventId]
  );

  if (eventResult.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Event not found");
  }

  if (eventResult.rows[0].promoter_id !== req.user.id) {
    return fail(res, req, 403, "FORBIDDEN", "You cannot edit this event");
  }

  // Delete from event_media table
  const result = await pool.query(
    `DELETE FROM event_media WHERE id = $1 AND event_id = $2 RETURNING file_url`,
    [imageId, eventId]
  );

  if (result.rowCount === 0) {
    return fail(res, req, 404, "IMAGE_NOT_FOUND", "Image not found");
  }

  const deletedImageUrl = result.rows[0].file_url;

  // Update legacy gallery array for backward compatibility
  await pool.query(
    `UPDATE events
     SET gallery_image_urls = array_remove(gallery_image_urls, $1),
         updated_at = NOW()
     WHERE id = $2`,
    [deletedImageUrl, eventId]
  );

  await logEventChange(req, 'image_deleted', eventId, {
    fieldName: 'gallery_image_urls',
    oldValue: deletedImageUrl,
    newValue: null
  });

  return ok(res, req, { message: "Gallery image deleted successfully" });
}

/**
 * Reorder gallery images
 * PATCH /promoter/events/:eventId/images/reorder
 */
async function reorderGalleryImages(req, res) {
  const eventId = validateEventId(req.params.eventId);
  const { imageOrder } = req.body;

  if (!Array.isArray(imageOrder)) {
    return fail(res, req, 400, "VALIDATION_FAILED", "imageOrder must be an array");
  }

  // Update sort_order for each media item
  for (let i = 0; i < imageOrder.length; i++) {
    await pool.query(
      `UPDATE event_media SET sort_order = $1 WHERE id = $2 AND event_id = $3`,
      [i, imageOrder[i], eventId]
    );
  }

  // Update legacy gallery array for backward compatibility
  // Get the URLs in the new order
  const mediaResult = await pool.query(
    `SELECT file_url FROM event_media WHERE event_id = $1 AND is_cover = false ORDER BY sort_order ASC`,
    [eventId]
  );

  const galleryUrls = mediaResult.rows.map(row => row.file_url);

  await pool.query(
    `UPDATE events SET gallery_image_urls = $1, updated_at = NOW() WHERE id = $2`,
    [galleryUrls, eventId]
  );

  await logEventChange(req, 'image_reordered', eventId);

  return ok(res, req, { message: "Gallery images reordered successfully" });
}

module.exports = {
  createEvent,
  updateEvent,
  getPromoterEvents,
  getPromoterEventDetail,
  uploadEventImage,
  setEventCategory,
  setEventTags,
  submitEvent,
  publishEvent,
  pauseEvent,
  cancelEvent,
  republishEvent,
  getEventsList,
  getEventDetail,
  getEventByShareToken,
  getEventPerformance,
  completeEvent,
  deleteEventCover,
  deleteEventGalleryImage,
  reorderGalleryImages,
  deleteEvent,
};
