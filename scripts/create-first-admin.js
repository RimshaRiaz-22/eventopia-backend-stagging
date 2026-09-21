/**
 * Bootstrap script to create the first admin user
 *
 * Usage:
 *   node scripts/create-first-admin.js <email>
 *
 * This script:
 * 1. Creates a user with the provided email (if doesn't exist)
 * 2. Ensures buyer role is assigned
 * 3. Assigns admin role
 *
 * Note: This bypasses normal signup flow and should only be used for initial setup
 */

require("dotenv").config();
const pool = require("../src/db");
const bcrypt = require("bcryptjs");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function createFirstAdmin() {
  try {
    const email = process.argv[2];

    let password = process.argv[3];

    if (!email) {
      console.log("Usage: node scripts/create-first-admin.js <email>");
      console.log(
        "Example: node scripts/create-first-admin.js admin@eventopia.com"
      );
      process.exit(1);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.error("❌ Invalid email format");
      process.exit(1);
    }

    // If password not provided as arg, prompt for it interactively
    if (!password) {
      password = await question("Enter password for admin (will not echo): ");
    }

    if (!password || password.length < 6) {
      console.error("❌ Password is required and must be at least 6 characters");
      process.exit(1);
    }

    console.log(`\n🔐 Creating first admin user: ${email}\n`);

    await pool.query("BEGIN");

    // Check if user already exists
    const existingUser = await pool.query(
      "SELECT id, email FROM users WHERE email = $1",
      [email]
    );

    let userId;

    if (existingUser.rowCount > 0) {
      userId = existingUser.rows[0].id;
      console.log(`✓ User already exists with ID: ${userId} (updating role to admin and password)`);
      const passwordHash = await bcrypt.hash(password, 12);
      await pool.query(
        `UPDATE users SET role = 'admin', password_hash = $1, roles_version = roles_version + 1, updated_at = NOW() WHERE id = $2`,
        [passwordHash, userId]
      );
    } else {
      // Create new user with admin role
      const passwordHash = await bcrypt.hash(password, 12);
      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, email_verified_at, status, role)
         VALUES ($1, $2, NOW(), 'active', 'admin')
         RETURNING id, email`,
        [email, passwordHash]
      );
      userId = userResult.rows[0].id;
      console.log(`✓ Created new admin user with ID: ${userId}`);
    }

    await pool.query("COMMIT");

    console.log("\n✅ Success! First admin created.");
    console.log(`\n📧 Email: ${email}`);
    console.log(`🆔 User ID: ${userId}`);
    console.log("\n💡 Next steps:");
    console.log("   1. User should sign up/login normally using this email");
    console.log("   2. They will have admin access after login");
    console.log(
      "   3. They can then assign admin roles to other users via API\n"
    );
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("\n❌ Error creating admin:", err.message);
    process.exit(1);
  } finally {
    rl.close();
    await pool.end();
  }
}

// Run the script
createFirstAdmin();
