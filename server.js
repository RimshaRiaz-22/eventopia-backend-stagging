/**
 * Backend server entry point.
 * Loads environment config and starts the Express app.
 */

require("dotenv").config();
const app = require("./src/app");
const { setupDatabase } = require("./src/db/initDb");

// Server port comes from environment config, with a local fallback.
const PORT = process.env.PORT || 3059;

/**
 * Starts the HTTP server and handles startup failures.
 */
async function startServer() {
  try {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('💥 Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();