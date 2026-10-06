const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");

/**
 * Validate ticket type ID
 */
function validateTicketTypeId(ticketTypeId) {
  const id = parseInt(ticketTypeId, 10);
  if (isNaN(id) || id <= 0) {
    const error = new Error("Invalid ticket type ID");
    error.status = 404;
    throw error;
  }
  return id;
}

/**
 * Get ticket types for an event
 */
const getTicketTypes = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { status, page = "1", pageSize = "20" } = req.query;

    const eventIdNum = parseInt(eventId, 10);
    if (isNaN(eventIdNum) || eventIdNum <= 0) {
      return fail(res, req, 404, "INVALID_EVENT_ID", "Invalid event ID");
    }

    const pageNum = parseInt(page, 10);
    const sizeNum = Math.min(parseInt(pageSize, 10), 50);
    const offset = (pageNum - 1) * sizeNum;

    let whereClause = "WHERE tt.event_id = $1";
    const queryParams = [eventIdNum];
    let paramCount = 1;

    if (status && status !== 'all') {
      paramCount++;
      whereClause += " AND tt.status = $" + paramCount;
      queryParams.push(status);
    }

    const query = `
      SELECT
        tt.id,
        tt.name,
        tt.description,
        tt.currency,
        tt.price_amount as "priceAmount",
        tt.booking_fee_amount as "bookingFeeAmount",
        (tt.price_amount + tt.booking_fee_amount) as "totalAmount",
        tt.sales_start_at as "salesStartAt",
        tt.sales_end_at as "salesEndAt",
        tt.capacity_total as "capacityTotal",
        tt.qty_sold as "capacitySold",
        (COALESCE(tt.capacity_total, 999999) - tt.qty_sold) as "capacityRemaining",
        tt.per_order_limit as "perOrderLimit",
        tt.visibility,
        tt.status,
        tt.sort_order as "sortOrder",
        tt.created_at as "createdAt",
        tt.updated_at as "updatedAt"
      FROM ticket_types tt
      ${whereClause}
      ORDER BY tt.sort_order ASC, tt.name ASC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    queryParams.push(sizeNum, offset);

    const result = await pool.query(query, queryParams);

    const countQuery = `
      SELECT COUNT(*) as total
      FROM ticket_types tt
      ${whereClause}
    `;
    const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
    const total = parseInt(countResult.rows[0].total, 10);

    return ok(res, req, {
      items: result.rows,
      pagination: {
        page: pageNum,
        pageSize: sizeNum,
        total: total,
        totalPages: Math.ceil(total / sizeNum)
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

/**
 * Create a new ticket type
 */
const createTicketType = async (req, res) => {
  try {
    const { eventId } = req.params;
    const {
      name,
      description,
      priceAmount,
      bookingFeeAmount = 0,
      currency = "GBP",
      salesStartAt,
      salesEndAt,
      capacityTotal,
      perOrderLimit = 10,
      visibility = "public",
      status = "active",
      sortOrder = 0,
      access_mode = "IN_PERSON",
      reveal_rule,
      on_demand_start_at,
      on_demand_end_at
    } = req.body;

    const eventIdNum = parseInt(eventId, 10);
    if (isNaN(eventIdNum) || eventIdNum <= 0) {
      return fail(res, req, 404, "INVALID_EVENT_ID", "Invalid event ID");
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Name is required");
    }

    if (name.length > 100) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Name must be less than 100 characters");
    }

    if (!Number.isInteger(priceAmount) || priceAmount < 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Price must be a non-negative integer");
    }

    if (!Number.isInteger(perOrderLimit) || perOrderLimit < 1 || perOrderLimit > 100) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Per order limit must be between 1 and 100");
    }

    if (!["public", "hidden"].includes(visibility)) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Visibility must be 'public' or 'hidden'");
    }

    if (!["IN_PERSON", "ONLINE_LIVE", "ON_DEMAND"].includes(access_mode)) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Access mode must be 'IN_PERSON', 'ONLINE_LIVE', or 'ON_DEMAND'");
    }

    if (reveal_rule !== null && reveal_rule !== undefined) {
      if (access_mode !== "ONLINE_LIVE") {
        return fail(res, req, 400, "VALIDATION_ERROR", "Reveal rule can only be set for ONLINE_LIVE tickets");
      }
      if (!["AT_PURCHASE", "ONE_HOUR_BEFORE", "AT_START"].includes(reveal_rule)) {
        return fail(res, req, 400, "VALIDATION_ERROR", "Reveal rule must be 'AT_PURCHASE', 'ONE_HOUR_BEFORE', or 'AT_START'");
      }
    }

    if (on_demand_start_at !== null && on_demand_start_at !== undefined) {
      const startTime = new Date(on_demand_start_at);
      if (isNaN(startTime.getTime())) {
        return fail(res, req, 400, "VALIDATION_ERROR", "on_demand_start_at must be a valid ISO 8601 date string");
      }
    }

    if (on_demand_end_at !== null && on_demand_end_at !== undefined) {
      const endTime = new Date(on_demand_end_at);
      if (isNaN(endTime.getTime())) {
        return fail(res, req, 400, "VALIDATION_ERROR", "on_demand_end_at must be a valid ISO 8601 date string");
      }
    }

    if (on_demand_start_at !== null && on_demand_end_at !== null) {
      const startTime = new Date(on_demand_start_at);
      const endTime = new Date(on_demand_end_at);
      if (startTime >= endTime) {
        return fail(res, req, 400, "VALIDATION_ERROR", "on_demand_start_at must be before on_demand_end_at");
      }
    }

    const hasOnDemandFields = (on_demand_start_at !== null && on_demand_start_at !== undefined) ||
                               (on_demand_end_at !== null && on_demand_end_at !== undefined);

    if (hasOnDemandFields && access_mode !== "ON_DEMAND") {
      return fail(res, req, 400, "VALIDATION_ERROR", "On-demand windows can only be set for ON_DEMAND tickets");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const eventResult = await client.query(
        "SELECT id FROM events WHERE id = $1 AND promoter_id = $2",
        [eventIdNum, req.user.id]
      );

      if (eventResult.rowCount === 0) {
        return fail(res, req, 404, "EVENT_NOT_FOUND", "Event not found or you don't have permission");
      }

      const result = await client.query(
        `INSERT INTO ticket_types (
          event_id, name, description, currency, price_amount, booking_fee_amount,
          sales_start_at, sales_end_at, capacity_total, per_order_limit,
          visibility, status, sort_order, access_mode, reveal_rule,
          on_demand_start_at, on_demand_end_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id`,
        [
          eventIdNum, name.trim(), description, currency, priceAmount,
          bookingFeeAmount, salesStartAt, salesEndAt, capacityTotal,
          perOrderLimit, visibility, status, sortOrder, access_mode, reveal_rule,
          on_demand_start_at, on_demand_end_at
        ]
      );

      await client.query("COMMIT");

      return ok(res, req, {
        id: result.rows[0].id,
        message: "Ticket type created successfully"
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

/**
 * Update a ticket type
 */
const updateTicketType = async (req, res) => {
  try {
    const { ticketTypeId } = req.params;
    const updates = req.body;
    const ticketTypeIdNum = validateTicketTypeId(ticketTypeId);

    const allowedFields = [
      "name", "description", "price_amount", "booking_fee_amount",
      "sales_start_at", "sales_end_at", "capacity_total", "per_order_limit",
      "visibility", "status", "sort_order", "access_mode", "reveal_rule",
      "on_demand_start_at", "on_demand_end_at"
    ];

    const setClause = [];
    const queryParams = [];
    let paramCount = 0;

    if (updates.priceAmount !== undefined || updates.bookingFeeAmount !== undefined) {
      const checkResult = await pool.query(
        "SELECT qty_sold FROM ticket_types WHERE id = $1",
        [ticketTypeIdNum]
      );

      if (checkResult.rowCount === 0) {
        return fail(res, req, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
      }

      if (checkResult.rows[0].qty_sold > 0) {
        return fail(res, req, 400, "CANNOT_MODIFY_AFTER_SALE", "Cannot modify pricing after tickets have been sold");
      }
    }

    for (const field in updates) {
      if (allowedFields.includes(field)) {
        paramCount++;
        let value = updates[field];
        let dbField = field.replace(/([A-Z])/g, "_$1").toLowerCase();

        if (field === "priceAmount" && (!Number.isInteger(value) || value < 0)) {
          return fail(res, req, 400, "VALIDATION_ERROR", "Price must be a non-negative integer");
        }

        if (field === "capacityTotal" && value !== null && value !== undefined) {
          if (!Number.isInteger(value) || value < 1) {
            return fail(res, req, 400, "VALIDATION_ERROR", "Capacity must be a positive integer");
          }

          const checkResult = await pool.query(
            "SELECT qty_sold FROM ticket_types WHERE id = $1",
            [ticketTypeIdNum]
          );

          if (checkResult.rows[0].qty_sold > value) {
            return fail(res, req, 400, "CAPACITY_BELOW_SOLD", "Cannot set capacity below number of tickets already sold");
          }
        }

        if (field === "perOrderLimit" && (!Number.isInteger(value) || value < 1 || value > 100)) {
          return fail(res, req, 400, "VALIDATION_ERROR", "Per order limit must be between 1 and 100");
        }

        if (field === "visibility" && !["public", "hidden"].includes(value)) {
          return fail(res, req, 400, "VALIDATION_ERROR", "Visibility must be 'public' or 'hidden'");
        }

        if (field === "status" && !["active", "hidden", "ended"].includes(value)) {
          return fail(res, req, 400, "VALIDATION_ERROR", "Status must be 'active', 'hidden', or 'ended'");
        }

        if (field === "access_mode" && !["IN_PERSON", "ONLINE_LIVE", "ON_DEMAND"].includes(value)) {
          return fail(res, req, 400, "VALIDATION_ERROR", "Access mode must be 'IN_PERSON', 'ONLINE_LIVE', or 'ON_DEMAND'");
        }

        if (field === "reveal_rule" && value !== null && !["AT_PURCHASE", "ONE_HOUR_BEFORE", "AT_START"].includes(value)) {
          return fail(res, req, 400, "VALIDATION_ERROR", "Reveal rule must be 'AT_PURCHASE', 'ONE_HOUR_BEFORE', or 'AT_START'");
        }

        if (field === "on_demand_start_at" && value !== null) {
          const startTime = new Date(value);
          if (isNaN(startTime.getTime())) {
            return fail(res, req, 400, "VALIDATION_ERROR", "on_demand_start_at must be a valid ISO 8601 date string");
          }
        }

        if (field === "on_demand_end_at" && value !== null) {
          const endTime = new Date(value);
          if (isNaN(endTime.getTime())) {
            return fail(res, req, 400, "VALIDATION_ERROR", "on_demand_end_at must be a valid ISO 8601 date string");
          }
        }

        // Validate on-demand window order if both are provided
        if ((field === "on_demand_start_at" || field === "on_demand_end_at") && value !== null) {
          const updates_1 = updates.on_demand_start_at ? new Date(updates.on_demand_start_at) : null;
          const updates_2 = updates.on_demand_end_at ? new Date(updates.on_demand_end_at) : null;
          const value_1 = field === "on_demand_start_at" ? new Date(value) : updates_1;
          const value_2 = field === "on_demand_end_at" ? new Date(value) : updates_2;

          if (value_1 && value_2 && value_1 >= value_2) {
            return fail(res, req, 400, "VALIDATION_ERROR", "on_demand_start_at must be before on_demand_end_at");
          }
        }

        setClause.push(`${dbField} = $${paramCount}`);
        queryParams.push(value);
      }
    }

    if (setClause.length === 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "No valid fields to update");
    }

    queryParams.push(ticketTypeIdNum);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const ownershipResult = await client.query(
        `SELECT e.promoter_id FROM ticket_types tt
         JOIN events e ON e.id = tt.event_id
         WHERE tt.id = $1`,
        [ticketTypeIdNum]
      );

      if (ownershipResult.rowCount === 0) {
        return fail(res, req, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
      }

      if (ownershipResult.rows[0].promoter_id !== req.user.id) {
        return fail(res, req, 403, "FORBIDDEN", "You don't have permission to update this ticket type");
      }

      const updateQuery = `
        UPDATE ticket_types
        SET ${setClause.join(", ")}, updated_at = NOW()
        WHERE id = $${paramCount + 1}
        RETURNING id
      `;

      const result = await client.query(updateQuery, queryParams);

      if (result.rowCount === 0) {
        return fail(res, req, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
      }

      await client.query("COMMIT");

      return ok(res, req, {
        id: result.rows[0].id,
        message: "Ticket type updated successfully"
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

/**
 * Duplicate a ticket type
 */
const duplicateTicketType = async (req, res) => {
  try {
    const { ticketTypeId } = req.params;
    const { name, capacityTotal, adjustSalesWindow } = req.body;
    const ticketTypeIdNum = validateTicketTypeId(ticketTypeId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const originalResult = await client.query(
        `SELECT tt.*, e.promoter_id
         FROM ticket_types tt
         JOIN events e ON e.id = tt.event_id
         WHERE tt.id = $1`,
        [ticketTypeIdNum]
      );

      if (originalResult.rowCount === 0) {
        return fail(res, req, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
      }

      if (originalResult.rows[0].promoter_id !== req.user.id) {
        return fail(res, req, 403, "FORBIDDEN", "You don't have permission to duplicate this ticket type");
      }

      const original = originalResult.rows[0];
      const newName = name || `${original.name} (Copy)`;
      const newCapacity = capacityTotal || original.capacity_total;

      let newSalesStart = original.sales_start_at;
      let newSalesEnd = original.sales_end_at;

      if (adjustSalesWindow && adjustSalesWindow.shiftByDays) {
        const days = parseInt(adjustSalesWindow.shiftByDays, 10);
        if (!isNaN(days) && days > 0) {
          const startDate = new Date(original.sales_start_at);
          const endDate = new Date(original.sales_end_at);
          newSalesStart = new Date(startDate.getTime() + (days * 24 * 60 * 60 * 1000));
          newSalesEnd = new Date(endDate.getTime() + (days * 24 * 60 * 60 * 1000));
        }
      }

      const result = await client.query(
        `INSERT INTO ticket_types (
          event_id, name, description, currency, price_amount, booking_fee_amount,
          sales_start_at, sales_end_at, capacity_total, per_order_limit,
          visibility, status, sort_order, access_mode, reveal_rule,
          on_demand_start_at, on_demand_end_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id`,
        [
          original.event_id,
          newName,
          original.description,
          original.currency,
          original.price_amount,
          original.booking_fee_amount,
          newSalesStart,
          newSalesEnd,
          newCapacity,
          original.per_order_limit,
          original.visibility,
          "active",
          original.sort_order + 1,
          original.access_mode,
          original.reveal_rule,
          original.on_demand_start_at,
          original.on_demand_end_at
        ]
      );

      await client.query("COMMIT");

      return ok(res, req, {
        id: result.rows[0].id,
        message: "Ticket type duplicated successfully"
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

/**
 * Pause a ticket type
 */
const pauseTicketType = async (req, res) => {
  try {
    const { ticketTypeId } = req.params;
    const ticketTypeIdNum = validateTicketTypeId(ticketTypeId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT e.promoter_id FROM ticket_types tt
         JOIN events e ON e.id = tt.event_id
         WHERE tt.id = $1`,
        [ticketTypeIdNum]
      );

      if (result.rowCount === 0) {
        return fail(res, req, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
      }

      if (result.rows[0].promoter_id !== req.user.id) {
        return fail(res, req, 403, "FORBIDDEN", "You don't have permission to pause this ticket type");
      }

      const updateResult = await client.query(
        "UPDATE ticket_types SET status = 'hidden', updated_at = NOW() WHERE id = $1 RETURNING id",
        [ticketTypeIdNum]
      );

      await client.query("COMMIT");

      return ok(res, req, {
        id: updateResult.rows[0].id,
        message: "Ticket type paused successfully"
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

/**
 * Resume a ticket type
 */
const resumeTicketType = async (req, res) => {
  try {
    const { ticketTypeId } = req.params;
    const ticketTypeIdNum = validateTicketTypeId(ticketTypeId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT e.promoter_id FROM ticket_types tt
         JOIN events e ON e.id = tt.event_id
         WHERE tt.id = $1`,
        [ticketTypeIdNum]
      );

      if (result.rowCount === 0) {
        return fail(res, req, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
      }

      if (result.rows[0].promoter_id !== req.user.id) {
        return fail(res, req, 403, "FORBIDDEN", "You don't have permission to resume this ticket type");
      }

      const updateResult = await client.query(
        "UPDATE ticket_types SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING id",
        [ticketTypeIdNum]
      );

      await client.query("COMMIT");

      return ok(res, req, {
        id: updateResult.rows[0].id,
        message: "Ticket type resumed successfully"
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

/**
 * Delete a ticket type
 */
const deleteTicketType = async (req, res) => {
  try {
    const { ticketTypeId } = req.params;
    const ticketTypeIdNum = validateTicketTypeId(ticketTypeId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT e.promoter_id, tt.qty_sold, tt.name
         FROM ticket_types tt
         JOIN events e ON e.id = tt.event_id
         WHERE tt.id = $1`,
        [ticketTypeIdNum]
      );

      if (result.rowCount === 0) {
        return fail(res, req, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
      }

      const ticketType = result.rows[0];

      if (ticketType.promoter_id !== req.user.id) {
        return fail(res, req, 403, "FORBIDDEN", "You don't have permission to delete this ticket type");
      }

      if (ticketType.qty_sold > 0) {
        return fail(res, req, 400, "CANNOT_DELETE_AFTER_SALE", "Cannot delete ticket type that has sold tickets");
      }

      await client.query("DELETE FROM ticket_types WHERE id = $1", [ticketTypeIdNum]);

      await client.query("COMMIT");

      return ok(res, req, {
        message: "Ticket type deleted successfully"
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

module.exports = {
  getTicketTypes,
  createTicketType,
  updateTicketType,
  duplicateTicketType,
  pauseTicketType,
  resumeTicketType,
  deleteTicketType,
};