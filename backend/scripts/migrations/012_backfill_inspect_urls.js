#!/usr/bin/env node
/**
 * Migration: Backfill inspect_url from stored logs
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/atlasengine_dev';

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
});

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function extractInspectUrl(logs) {
  if (!logs) return null;

  const cleanLogs = stripAnsi(logs);
  const match = cleanLogs.match(/Inspect:\s*(https:\/\/vercel\.com\/[^\s]+)/);
  return match ? match[1] : null;
}

async function main() {
  console.log('Backfilling inspect_url from logs...\n');

  const result = await pool.query(`
    SELECT id, logs, inspect_url
    FROM publish_attempts
    WHERE logs IS NOT NULL AND (inspect_url IS NULL OR inspect_url = '')
    ORDER BY created_at DESC
  `);

  console.log(`Found ${result.rows.length} deployments to process\n`);

  let updated = 0;

  for (const row of result.rows) {
    const inspectUrl = extractInspectUrl(row.logs);

    if (inspectUrl) {
      await pool.query(
        `UPDATE publish_attempts SET inspect_url = $1 WHERE id = $2`,
        [inspectUrl, row.id]
      );
      console.log(`Updated ${row.id.substring(0, 8)}...`);
      console.log(`  inspect_url: ${inspectUrl}\n`);
      updated++;
    }
  }

  console.log(`\nComplete: ${updated} updated`);

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
