const express = require("express");
const path = require("path");
const authRoutes = require("./routes/auth.routes");
const categoriesRoutes = require("./routes/categories.routes");
const eventsRoutes = require("./routes/events.routes");
const usersRoutes = require("./routes/users.routes");
const apiRoutes = require("./routes"); // central router: mounts /auth, /network-managers, /territories, etc.
const { requestMeta } = require("./middlewares/requestMeta.middleware");
const { trackEventView } = require("./middlewares/viewTracking.middleware");
const { handleStripeOrdersWebhook } = require("./controllers/stripeWebhooks.controller");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const app = express();
const { initScheduler } = require("./services/scheduler.service");

// Stripe webhooks need the raw body for signature verification (must be before express.json()).
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  handleStripeOrdersWebhook
);

app.use(express.json());
app.use(cookieParser());
app.use(requestMeta);
app.use(trackEventView);



/////donr wuth updates
// adding coments for esting?

app.use(cors());

// Serve uploaded images
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

// Legacy direct mounts (kept for backward compatibility)
app.use("/api/auth", authRoutes);
app.use("/categories", categoriesRoutes);
app.use("/events", eventsRoutes);
app.use("/users", usersRoutes);

// New consolidated API router (all new routes, including /network-managers)
app.use("/api", apiRoutes);

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "UP",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "1.0.0",
  });
});

// Initialize scheduler after app starts
setTimeout(() => {
  initScheduler();
}, 1000);

module.exports = app;
