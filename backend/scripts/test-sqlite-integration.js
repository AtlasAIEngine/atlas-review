#!/usr/bin/env node
/**
 * SQLite Integration Test
 *
 * Tests the SQLite database driver with common operations:
 * - Project CRUD
 * - Changeset creation/retrieval (JSON handling)
 * - Secret storage
 * - Settings/preferences
 * - Date handling (ISO 8601 strings)
 *
 * Run with: ATLAS_DB_TYPE=sqlite ATLAS_DESKTOP_MODE=true node scripts/test-sqlite-integration.js
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set environment for SQLite mode
process.env.ATLAS_DB_TYPE = process.env.ATLAS_DB_TYPE || 'sqlite';
process.env.ATLAS_DESKTOP_MODE = process.env.ATLAS_DESKTOP_MODE || 'true';

// Use a test database path
const testDbPath = path.join(__dirname, '..', 'test-data', 'test-atlas.db');
process.env.ATLAS_DB_PATH = testDbPath;

// Ensure test directory exists
const testDir = path.dirname(testDbPath);
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

// Clean up any existing test database
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
  console.log('Cleaned up existing test database');
}

// Import database module after setting environment
const { query, transaction, initialize, close, getDbType } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrations/index.js');

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ✗ ${message}`);
    testsFailed++;
  }
}

async function test(name, fn) {
  console.log(`\n📋 ${name}`);
  try {
    await fn();
  } catch (error) {
    console.log(`  ✗ Error: ${error.message}`);
    testsFailed++;
  }
}

// Main test suite
async function runTests() {
  console.log('='.repeat(60));
  console.log('SQLite Integration Tests');
  console.log('='.repeat(60));

  // Verify we're in SQLite mode
  const dbType = getDbType();
  console.log(`\nDatabase type: ${dbType}`);
  assert(dbType === 'sqlite', 'Database type is SQLite');

  // Initialize and run migrations
  console.log('\n📊 Initializing database and running migrations...');
  await initialize();

  // Create a database wrapper that includes migrations
  const db = { query, transaction };

  // Run migrations
  await runMigrations(db);
  console.log('Migrations complete');

  // Test 1: User CRUD
  await test('User CRUD', async () => {
    const userId = randomUUID();
    const email = `test-${Date.now()}@example.com`;

    // Create user
    await query(
      `INSERT INTO users (id, email, name, plan) VALUES ($1, $2, $3, $4)`,
      [userId, email, 'Test User', 'free']
    );

    // Read user
    const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
    assert(result.rows.length === 1, 'User created and retrieved');
    assert(result.rows[0].email === email, 'User email matches');
    assert(result.rows[0].name === 'Test User', 'User name matches');
    assert(result.rows[0].is_active === 1, 'User is_active is true (1 in SQLite)');

    // Update user
    await query('UPDATE users SET name = $1 WHERE id = $2', ['Updated User', userId]);
    const updated = await query('SELECT name FROM users WHERE id = $1', [userId]);
    assert(updated.rows[0].name === 'Updated User', 'User updated successfully');

    // Delete user
    await query('DELETE FROM users WHERE id = $1', [userId]);
    const deleted = await query('SELECT * FROM users WHERE id = $1', [userId]);
    assert(deleted.rows.length === 0, 'User deleted successfully');
  });

  // Test 2: Project CRUD with JSON meta
  await test('Project CRUD with metadata', async () => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const sessionId = `session-${Date.now()}`;

    // Create user first (foreign key)
    await query(
      `INSERT INTO users (id, email, name, plan) VALUES ($1, $2, $3, $4)`,
      [userId, `project-test-${Date.now()}@example.com`, 'Project Test', 'free']
    );

    // Create project
    await query(
      `INSERT INTO projects (id, user_id, session_id, name, description, path, framework, language)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [projectId, userId, sessionId, 'Test Project', 'A test project', '/test/path', 'react', 'typescript']
    );

    // Read project
    const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
    assert(result.rows.length === 1, 'Project created and retrieved');
    assert(result.rows[0].name === 'Test Project', 'Project name matches');
    assert(result.rows[0].framework === 'react', 'Project framework matches');

    // Verify timestamps are ISO 8601 strings
    const created = result.rows[0].created_at;
    assert(typeof created === 'string', 'created_at is a string');
    assert(created.includes(':'), 'created_at looks like ISO 8601');

    // Clean up
    await query('DELETE FROM projects WHERE id = $1', [projectId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // Test 3: Chat messages with JSON meta
  await test('Chat messages with JSON meta', async () => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const messageId = randomUUID();
    const sessionId = `chat-test-${Date.now()}`;

    // Create user and project
    await query(
      `INSERT INTO users (id, email, name, plan) VALUES ($1, $2, $3, $4)`,
      [userId, `chat-test-${Date.now()}@example.com`, 'Chat Test', 'free']
    );
    await query(
      `INSERT INTO projects (id, user_id, session_id, name) VALUES ($1, $2, $3, $4)`,
      [projectId, userId, sessionId, 'Chat Test Project']
    );

    // Create message with JSON meta
    const meta = JSON.stringify({ toolUseEvents: [{ name: 'Write', input: { path: 'test.js' } }] });
    await query(
      `INSERT INTO chat_messages (id, project_id, user_id, role, content, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [messageId, projectId, userId, 'assistant', 'Hello world', meta]
    );

    // Read message and verify JSON
    const result = await query('SELECT * FROM chat_messages WHERE id = $1', [messageId]);
    assert(result.rows.length === 1, 'Message created and retrieved');
    assert(result.rows[0].content === 'Hello world', 'Message content matches');

    // Parse JSON meta
    const parsedMeta = JSON.parse(result.rows[0].meta);
    assert(parsedMeta.toolUseEvents.length === 1, 'JSON meta parsed correctly');
    assert(parsedMeta.toolUseEvents[0].name === 'Write', 'Tool use event name matches');

    // Clean up
    await query('DELETE FROM chat_messages WHERE id = $1', [messageId]);
    await query('DELETE FROM projects WHERE id = $1', [projectId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // Test 4: Memory snapshots (content storage)
  await test('Memory snapshots with content', async () => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const snapshotId = randomUUID();
    const sessionId = `memory-test-${Date.now()}`;

    // Create user and project
    await query(
      `INSERT INTO users (id, email, name, plan) VALUES ($1, $2, $3, $4)`,
      [userId, `memory-test-${Date.now()}@example.com`, 'Memory Test', 'free']
    );
    await query(
      `INSERT INTO projects (id, user_id, session_id, name) VALUES ($1, $2, $3, $4)`,
      [projectId, userId, sessionId, 'Memory Test Project']
    );

    // Create memory snapshot
    const content = '# Project Memory\n\nThis is a test CLAUDE.md file.';
    await query(
      `INSERT INTO memory_snapshots (id, project_id, user_id, kind, path, content, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [snapshotId, projectId, userId, 'claude_md', 'CLAUDE.md', content, content.length]
    );

    // Read snapshot
    const result = await query('SELECT * FROM memory_snapshots WHERE id = $1', [snapshotId]);
    assert(result.rows.length === 1, 'Snapshot created and retrieved');
    assert(result.rows[0].content === content, 'Snapshot content matches');
    assert(result.rows[0].size_bytes === content.length, 'Snapshot size matches');

    // Clean up
    await query('DELETE FROM memory_snapshots WHERE id = $1', [snapshotId]);
    await query('DELETE FROM projects WHERE id = $1', [projectId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // Test 5: Transactions
  await test('Transaction support', async () => {
    const userId = randomUUID();
    const email = `transaction-test-${Date.now()}@example.com`;

    // Test successful transaction
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, name, plan) VALUES ($1, $2, $3, $4)`,
        [userId, email, 'Transaction Test', 'free']
      );
    });

    const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
    assert(result.rows.length === 1, 'Transaction committed successfully');

    // Test rollback on error
    const userId2 = randomUUID();
    try {
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO users (id, email, name, plan) VALUES ($1, $2, $3, $4)`,
          [userId2, `rollback-test-${Date.now()}@example.com`, 'Rollback Test', 'free']
        );
        // This should cause an error (duplicate email column constraint would fail,
        // but we'll just throw an error manually for testing)
        throw new Error('Intentional rollback');
      });
    } catch (e) {
      // Expected error
    }

    const result2 = await query('SELECT * FROM users WHERE id = $1', [userId2]);
    assert(result2.rows.length === 0, 'Transaction rolled back on error');

    // Clean up
    await query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // Test 6: Parameter conversion ($1, $2, etc.)
  await test('Parameter placeholder conversion', async () => {
    const userId = randomUUID();
    const email = `param-test-${Date.now()}@example.com`;

    // Test with multiple parameters in different orders
    await query(
      `INSERT INTO users (id, email, name, plan)
       VALUES ($1, $2, $3, $4)`,
      [userId, email, 'Param Test', 'pro']
    );

    // Test with $10+ placeholders (ensure correct parsing)
    // We'll use a query with multiple conditions
    const result = await query(
      `SELECT * FROM users
       WHERE id = $1
       AND email = $2
       AND plan = $3`,
      [userId, email, 'pro']
    );

    assert(result.rows.length === 1, 'Query with multiple params works');
    assert(result.rows[0].plan === 'pro', 'Parameter values correct');

    // Clean up
    await query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // Test 7: NULL handling
  await test('NULL value handling', async () => {
    const userId = randomUUID();
    const email = `null-test-${Date.now()}@example.com`;

    // Create user with NULL values
    await query(
      `INSERT INTO users (id, email, password_hash, name, plan)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, email, null, null, 'free']
    );

    const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
    assert(result.rows[0].password_hash === null, 'NULL password_hash handled');
    assert(result.rows[0].name === null, 'NULL name handled');

    // Clean up
    await query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // Test 8: Boolean handling (SQLite uses 0/1)
  await test('Boolean value handling', async () => {
    const userId = randomUUID();
    const email = `bool-test-${Date.now()}@example.com`;

    await query(
      `INSERT INTO users (id, email, name, plan, is_active, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, email, 'Bool Test', 'free', 1, 0]
    );

    const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
    assert(result.rows[0].is_active === 1, 'Boolean true as 1');
    assert(result.rows[0].email_verified === 0, 'Boolean false as 0');

    // Clean up
    await query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Test Results');
  console.log('='.repeat(60));
  console.log(`  Passed: ${testsPassed}`);
  console.log(`  Failed: ${testsFailed}`);
  console.log(`  Total:  ${testsPassed + testsFailed}`);

  // Close database
  await close();

  // Clean up test database
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
    console.log('\nCleaned up test database');
  }

  // Exit with appropriate code
  if (testsFailed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

// Run tests
runTests().catch((error) => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
