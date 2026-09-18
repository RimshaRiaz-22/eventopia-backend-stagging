const pool = require("../db");

async function trackEventView(req, res, next) {
  // Only track views for GET requests to public event detail endpoints
  // Match both /events/:id and /api/events/:id
  if (req.method === 'GET' && req.path.match(/^\/?(api\/)?events\/(\d+)$/)) {
    try {
      // Extract event ID from path
      const match = req.path.match(/events\/(\d+)/);
      const eventId = match ? match[1] : null;

      if (eventId) {
        // Log the view for analytics. The canonical source of truth is event_views.
        await pool.query(
          `INSERT INTO event_views (event_id, viewer_user_id, ip_address, user_agent)
           VALUES ($1, $2, $3, $4)`,
          [eventId, req.user?.id || null, req.ip || null, req.get('user-agent') || null]
        );
      }
    } catch (err) {
      // Log error but don't fail the request
      console.error("View tracking error:", err);
    }
  }
  next();
}

module.exports = { trackEventView };
