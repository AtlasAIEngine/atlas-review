import process from 'node:process';
import db from '../db/index.js';
import trustAnalyticsFactService from '../services/trustAnalyticsFactService.js';

function parseArgs(argv = []) {
  const args = new Set(argv);
  const projectIdIndex = argv.findIndex((value) => value === '--project-id');
  return {
    dryRun: args.has('--dry-run'),
    projectId: projectIdIndex >= 0 ? argv[projectIdIndex + 1] || null : null,
  };
}

async function listProjects(projectId = null) {
  const params = [];
  let sql = `
    SELECT id, name, path
    FROM projects
    WHERE status = 'active'
      AND path IS NOT NULL
      AND TRIM(path) <> ''
  `;
  if (projectId) {
    params.push(projectId);
    sql += ` AND id = $${params.length}`;
  }
  sql += ' ORDER BY updated_at DESC';
  const result = await db.query(sql, params);
  return result.rows || [];
}

async function main() {
  const { dryRun, projectId } = parseArgs(process.argv.slice(2));
  await db.initialize();

  const projects = await listProjects(projectId);
  if (projects.length === 0) {
    console.log('[trust-analytics] No active projects found for backfill');
    return;
  }

  let totalReviews = 0;
  let totalSynced = 0;
  let hadFailures = false;

  for (const project of projects) {
    try {
      const result = await trustAnalyticsFactService.backfillProjectTrustAnalytics({
        projectId: project.id,
        projectPath: project.path,
        dryRun,
      });
      totalReviews += result.reviewCount;
      totalSynced += result.syncedCount;
      console.log(`[trust-analytics] ${dryRun ? 'Scanned' : 'Backfilled'} ${project.name || project.id}: ${result.reviewCount} review(s), ${result.syncedCount} synced`);
    } catch (error) {
      hadFailures = true;
      console.error(`[trust-analytics] Failed for project ${project.id}: ${error?.message || error}`);
    }
  }

  console.log(`[trust-analytics] Completed ${dryRun ? 'dry-run ' : ''}backfill across ${projects.length} project(s): ${totalReviews} review(s), ${totalSynced} synced`);
  if (hadFailures) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('[trust-analytics] Backfill failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close().catch(() => {});
  });
