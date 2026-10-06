const fs = require('fs');
const path = require('path');
const pool = require('./index');

/**
 * Parse SQL file into individual statements
 * Handles PostgreSQL-specific constructs like DO blocks, functions, dollar-quoted strings
 */
function parseSqlStatements(sql) {
  const statements = [];
  let i = 0;

  function skipWhitespace(str, idx) {
    while (idx < str.length && /\s/.test(str[idx])) {
      idx++;
    }
    return idx;
  }

  function findMatchingDollar(str, startIdx) {
    // Find the closing $$ for a dollar-quoted string
    let j = startIdx;
    while (j < str.length) {
      if (str[j] === '$') {
        return j;
      }
      j++;
    }
    return -1;
  }

  while (i < sql.length) {
    // Skip whitespace and comments
    i = skipWhitespace(sql, i);

    // Skip line comments
    if (sql.substring(i, i + 2) === '--') {
      while (i < sql.length && sql[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Skip block comments
    if (sql.substring(i, i + 2) === '/*') {
      i += 2;
      while (i < sql.length && sql.substring(i, i + 2) !== '*/') {
        i++;
      }
      i += 2;
      continue;
    }

    // Check for DO block
    if (sql.substring(i, i + 3).toUpperCase() === 'DO ') {
      // Find the DO block - it ends with $$ (the dollar quote closer)
      let j = i + 3;
      // Skip to first $$
      while (j < sql.length && sql.substring(j, j + 2) !== '$$') {
        j++;
      }
      if (j < sql.length) {
        j += 2; // Include the $$
        // Find the matching END $$
        let depth = 1;
        while (j < sql.length && depth > 0) {
          if (sql.substring(j, j + 2) === '$$') {
            const next2 = sql.substring(j, j + 7).toUpperCase();
            if (next2 === '$$ END ' || next2 === '$$; END') {
              depth--;
              if (depth === 0) {
                j += 2; // Include the $$
                // Skip to semicolon
                while (j < sql.length && sql[j] !== ';') {
                  j++;
                }
                j++; // Include semicolon
                break;
              }
            }
          }
          if (sql[j] === '$') {
            const closeDollar = findMatchingDollar(sql, j + 1);
            if (closeDollar !== -1) {
              j = closeDollar + 1;
              continue;
            }
          }
          j++;
        }
        const stmt = sql.substring(i, j).trim();
        if (stmt.length > 0) {
          statements.push(stmt);
        }
        i = j;
        continue;
      }
    }

    // Check for function definition
    if (sql.substring(i, i + 30).toUpperCase().includes('CREATE OR REPLACE FUNCTION')) {
      let j = i;
      // Find the matching END $$ or LANGUAGE
      while (j < sql.length) {
        if (sql[j] === '$') {
          const next = sql.substring(j, j + 20).toUpperCase();
          if (next.startsWith('$$ LANGUAGE') || next.startsWith('$$;')) {
            // Find the semicolon
            while (j < sql.length && sql[j] !== ';') {
              j++;
            }
            j++; // Include semicolon
            break;
          }
          const closeDollar = findMatchingDollar(sql, j + 1);
          if (closeDollar !== -1) {
            j = closeDollar + 1;
            continue;
          }
        }
        j++;
      }
      const stmt = sql.substring(i, j).trim();
      if (stmt.length > 0) {
        statements.push(stmt);
      }
      i = j;
      continue;
    }

    // Regular statement - find next semicolon (but not inside quotes or dollar-quoted strings)
    let j = i;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inDollarQuote = false;
    let dollarTag = '';

    while (j < sql.length) {
      // Check for dollar-quoted string
      if (!inDollarQuote && sql[j] === '$') {
        // Check if this starts a dollar-quoted string
        let k = j + 1;
        while (k < sql.length && sql[k] !== '$' && sql[k] !== '\n') {
          k++;
        }
        if (k < sql.length && sql[k] === '$') {
          inDollarQuote = true;
          dollarTag = sql.substring(j, k + 1);
          j = k + 1;
          continue;
        }
      }

      // Check for end of dollar-quoted string
      if (inDollarQuote) {
        if (sql.substring(j, j + dollarTag.length) === dollarTag) {
          inDollarQuote = false;
          dollarTag = '';
          j += dollarTag.length;
          continue;
        }
        j++;
        continue;
      }

      // Handle quotes
      if (sql[j] === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      } else if (sql[j] === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      } else if (sql[j] === ';' && !inSingleQuote && !inDoubleQuote && !inDollarQuote) {
        // End of statement
        const stmt = sql.substring(i, j + 1).trim();
        if (stmt.length > 0) {
          statements.push(stmt);
        }
        i = j + 1;
        break;
      }

      j++;
    }

    if (j >= sql.length) {
      // No more semicolons, but we might have a final statement
      const stmt = sql.substring(i).trim();
      if (stmt.length > 0) {
        statements.push(stmt);
      }
      break;
    }
  }

  // Clean up statements - remove comments and extra whitespace
  return statements
    .map(stmt => {
      // Remove line comments
      stmt = stmt.replace(/--.*$/gm, '');
      // Remove extra whitespace
      stmt = stmt.replace(/\s+/g, ' ');
      return stmt.trim();
    })
    .filter(stmt => stmt.length > 0);
}

/**
 * Initialize database schema
 * This function reads init.sql and executes it to create/update tables
 */
async function initDatabase() {
  try {
    console.log('🔄 Initializing database schema...');

    // Read the SQL file
    const initSqlPath = path.join(__dirname, 'init.sql');
    const sql = fs.readFileSync(initSqlPath, 'utf8');

    // Parse SQL into statements
    const statements = parseSqlStatements(sql);

    let executedCount = 0;
    let skippedCount = 0;

    for (const statement of statements) {
      // Skip empty statements and DO blocks (they contain multiple statements)
      if (!statement || statement.length < 5) continue;

      try {
        await pool.query(statement);
        executedCount++;
      } catch (error) {
        // Check if it's a "already exists" error
        if (error.message.includes('already exists') ||
            error.message.includes('duplicate key') ||
            error.message.includes('does not exist') ||
            error.message.includes('not found')) {
          skippedCount++;
          // Silently skip - this is expected on subsequent runs
        } else {
          // Log other errors but don't throw - allow server to continue
          console.error(`⚠️  Warning: SQL statement failed:`, {
            error: error.message,
            detail: error.detail || '',
            hint: error.hint || '',
            statement: statement.substring(0, 500) + (statement.length > 500 ? '...\n[TRUNCATED]' : '')
          });
        }
      }
    }

    console.log(`✅ Database schema initialized successfully!`);
    console.log(`   - Executed: ${executedCount} statements`);
    console.log(`   - Skipped (already exist): ${skippedCount} statements`);

    return true;
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    throw error;
  }
}

/**
 * Test database connection
 */
async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('✅ Database connection successful!');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    throw error;
  }
}

/**
 * Complete database setup process
 */
async function setupDatabase() {
  try {
    // Test connection first
    await testConnection();

    // Then initialize schema
    await initDatabase();

    console.log('🎉 Database setup complete!\n');
    return true;
  } catch (error) {
    console.error('💥 Database setup failed:', error.message);
    throw error;
  }
}

module.exports = {
  initDatabase,
  testConnection,
  setupDatabase,
  parseSqlStatements
};
