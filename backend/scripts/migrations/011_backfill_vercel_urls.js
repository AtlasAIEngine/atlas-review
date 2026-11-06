#!/usr/bin/env node
/**
 * Migration: Backfill vercel_url and deployment_id from stored logs
 *
 * This script parses the stored deployment logs to extract:
 * - vercel_url: The unique immutable Vercel deployment URL
 * - deployment_id: The deployment ID from the Inspect URL
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/atlasengine_dev';

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
});

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function extractFromLogs(logs) {
  if (!logs) return { vercelUrl: null, deploymentId: null };

  const cleanLogs = stripAnsi(logs);

  // Extract Production URL (unique Vercel URL)
  const prodMatch = cleanLogs.match(/Production:\s*(https:\/\/[^\s]+\.vercel\.app)/);
  const vercelUrl = prodMatch ? prodMatch[1] : null;

  // Extract deployment ID from Inspect URL
  const inspectMatch = cleanLogs.match(/Inspect:\s*https:\/\/vercel\.com\/[^\/]+\/[^\/]+\/([a-zA-Z0-9]+)/);
  const deploymentId = inspectMatch ? inspectMatch[1] : null;

  return { vercelUrl, deploymentId };
}

async function main() {
  console.log('Backfilling vercel_url and deployment_id from logs...\n');

  // Get all deployments with logs but missing vercel_url
  const result = await pool.query(`
    SELECT id, logs, vercel_url, deployment_id
    FROM publish_attempts
    WHERE logs IS NOT NULL
      AND (vercel_url IS NULL OR vercel_url = '' OR deployment_id = 'unknown')
    ORDER BY created_at DESC
  `);

  console.log(`Found ${result.rows.length} deployments to process\n`);

  let updated = 0;
  let skipped = 0;

  for (const row of result.rows) {
    const { vercelUrl, deploymentId } = extractFromLogs(row.logs);

    if (vercelUrl || (deploymentId && deploymentId !== 'unknown')) {
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (vercelUrl && !row.vercel_url) {
        updates.push(`vercel_url = $${paramIndex++}`);
        values.push(vercelUrl);
      }

      if (deploymentId && row.deployment_id === 'unknown') {
        updates.push(`deployment_id = $${paramIndex++}`);
        values.push(deploymentId);
      }

      if (updates.length > 0) {
        values.push(row.id);
        await pool.query(
          `UPDATE publish_attempts SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
          values
        );
        console.log(`Updated ${row.id.substring(0, 8)}...`);
        console.log(`  vercel_url: ${vercelUrl || '(unchanged)'}`);
        console.log(`  deployment_id: ${deploymentId || '(unchanged)'}\n`);
        updated++;
      } else {
        skipped++;
      }
    } else {
      console.log(`Skipped ${row.id.substring(0, 8)}... (no data found in logs)`);
      skipped++;
    }
  }

  console.log(`\nComplete: ${updated} updated, ${skipped} skipped`);

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
