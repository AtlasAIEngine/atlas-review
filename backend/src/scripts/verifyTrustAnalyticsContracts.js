import assert from 'node:assert/strict';
import process from 'node:process';
import db from '../db/index.js';
import trustAnalyticsFactService from '../services/trustAnalyticsFactService.js';
import trustAnalyticsService from '../services/trustAnalyticsService.js';
import trustAnalyticsBreakdownService from '../services/trustAnalyticsBreakdownService.js';

function parseArgs(argv = []) {
  const projectIdIndex = argv.findIndex((value) => value === '--project-id');
  return {
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

function sumMetric(groups = [], field = 'numerator') {
  return groups.reduce((total, group) => total + Math.max(0, Number(group?.metric?.[field]) || 0), 0);
}

function countRowsByReviewType(rows = []) {
  return rows.reduce((counts, row) => {
    const reviewType = String(row?.reviewType || '').trim().toLowerCase();
    if (!reviewType) return counts;
    counts[reviewType] = (counts[reviewType] || 0) + 1;
    return counts;
  }, {});
}

function sumIssueCounts(rows = []) {
  return rows.reduce((total, row) => total + Math.max(0, Number(row?.issueCount) || 0), 0);
}

function assertShare(actual, expected, label) {
  const delta = Math.abs((Number(actual) || 0) - expected);
  assert.ok(delta < 1e-9, `${label} must match expected share`);
}

async function verifyProject(project) {
  await trustAnalyticsFactService.backfillProjectTrustAnalytics({
    projectId: project.id,
    projectPath: project.path,
    dryRun: false,
  });

  const summary = await trustAnalyticsService.getProjectTrustAnalyticsSummary({
    projectId: project.id,
    projectPath: project.path,
    window: '30d',
  });
  const branchesSummary = await trustAnalyticsService.getProjectTrustAnalyticsSummary({
    projectId: project.id,
    projectPath: project.path,
    window: '30d',
    scope: 'branches',
  });
  const prsSummary = await trustAnalyticsService.getProjectTrustAnalyticsSummary({
    projectId: project.id,
    projectPath: project.path,
    window: '30d',
    scope: 'prs',
  });
  const factRows = await trustAnalyticsFactService.listReviewFactSnapshots({
    projectId: project.id,
    from: summary.window.from,
    to: summary.window.to,
  });
  const branchFactRows = await trustAnalyticsFactService.listReviewFactSnapshots({
    projectId: project.id,
    scope: 'branches',
    from: summary.window.from,
    to: summary.window.to,
  });
  const prFactRows = await trustAnalyticsFactService.listReviewFactSnapshots({
    projectId: project.id,
    scope: 'prs',
    from: summary.window.from,
    to: summary.window.to,
  });
  const dimensionRows = await trustAnalyticsFactService.listDimensionFactRows({
    projectId: project.id,
    from: summary.window.from,
    to: summary.window.to,
  });
  const prDimensionRows = await trustAnalyticsFactService.listDimensionFactRows({
    projectId: project.id,
    scope: 'prs',
    from: summary.window.from,
    to: summary.window.to,
  });
  const providerBreakdown = await trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
    projectId: project.id,
    projectPath: project.path,
    by: 'provider_model',
    metric: 'review_count',
    window: '30d',
  });
  const prProviderBreakdown = await trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
    projectId: project.id,
    projectPath: project.path,
    by: 'provider_model',
    metric: 'review_count',
    scope: 'prs',
    window: '30d',
  });
  const languageBreakdown = await trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
    projectId: project.id,
    projectPath: project.path,
    by: 'language',
    metric: 'issues_found',
    window: '30d',
  });
  const prLanguageBreakdown = await trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
    projectId: project.id,
    projectPath: project.path,
    by: 'language',
    metric: 'issues_found',
    scope: 'prs',
    window: '30d',
  });
  const countsByReviewType = countRowsByReviewType(factRows);
  const branchScopedCount = branchFactRows.length;
  const prReviewCount = prFactRows.length;
  const totalReviewCount = factRows.length;

  assert.equal(summary.reviewCount, factRows.length, 'summary review count must match fact rows in the same window');
  assert.equal(branchesSummary.reviewCount, branchFactRows.length, 'branches summary review count must match branch-scoped fact rows');
  assert.equal(prsSummary.reviewCount, prFactRows.length, 'PR summary review count must match PR fact rows');
  assert.equal(summary.reviewCount, branchesSummary.reviewCount + prsSummary.reviewCount, 'all-scope review count must equal branches plus PRs');
  assert.deepEqual(summary.scopeBreakdown, {
    branchScopedCount,
    branchReviewCount: countsByReviewType.branch_review || 0,
    changesetCount: countsByReviewType.changeset || 0,
    prReviewCount,
  }, 'all-scope breakdown must match persisted fact counts by review type');
  assert.deepEqual(branchesSummary.scopeBreakdown, {
    branchScopedCount,
    branchReviewCount: countsByReviewType.branch_review || 0,
    changesetCount: countsByReviewType.changeset || 0,
    prReviewCount: 0,
  }, 'branches breakdown must exclude PR counts');
  assert.deepEqual(prsSummary.scopeBreakdown, {
    branchScopedCount: 0,
    branchReviewCount: 0,
    changesetCount: 0,
    prReviewCount,
  }, 'PR breakdown must exclude branch-scoped counts');
  assert.equal(summary.comparison.branchScopedCount, branchScopedCount, 'all-scope comparison branch count must match branch facts');
  assert.equal(summary.comparison.prReviewCount, prReviewCount, 'all-scope comparison PR count must match PR facts');
  assertShare(
    summary.comparison.branchShare,
    totalReviewCount > 0 ? branchScopedCount / totalReviewCount : 0,
    'all-scope branch share'
  );
  assertShare(
    summary.comparison.prShare,
    totalReviewCount > 0 ? prReviewCount / totalReviewCount : 0,
    'all-scope PR share'
  );
  assert.equal(
    summary.hero.deepCoverageRate.numerator,
    factRows.reduce((total, row) => total + (Number(row.deepCoverageNumerator) || 0), 0),
    'summary deep coverage numerator must match fact rows'
  );
  assert.equal(
    summary.hero.deepCoverageRate.denominator,
    factRows.reduce((total, row) => total + (Number(row.deepCoverageDenominator) || 0), 0),
    'summary deep coverage denominator must match fact rows'
  );
  assert.equal(
    sumMetric(providerBreakdown.groups, 'numerator'),
    factRows.length,
    'provider breakdown review counts must sum to review fact rows'
  );
  assert.equal(
    sumMetric(prProviderBreakdown.groups, 'numerator'),
    prFactRows.length,
    'PR provider breakdown review counts must sum to PR fact rows'
  );
  assert.equal(
    sumMetric(languageBreakdown.groups, 'numerator'),
    sumIssueCounts(dimensionRows),
    'language breakdown issue counts must sum to dimension fact issue totals'
  );
  assert.equal(
    sumMetric(prLanguageBreakdown.groups, 'numerator'),
    sumIssueCounts(prDimensionRows),
    'PR language breakdown issue counts must sum to PR dimension fact issue totals'
  );

  console.log(
    `[trust-analytics] Verified project ${project.name || project.id}: `
    + `${summary.reviewCount} review facts `
    + `(${branchScopedCount} branch-scoped, ${prReviewCount} PR), `
    + `${dimensionRows.length} dimension rows`
  );
}

async function main() {
  const { projectId } = parseArgs(process.argv.slice(2));
  await db.initialize();
  const projects = await listProjects(projectId);
  if (projects.length === 0) {
    console.log('[trust-analytics] No active projects found to verify');
    return;
  }

  for (const project of projects) {
    await verifyProject(project);
  }

  console.log(`[trust-analytics] Verification passed for ${projects.length} project(s)`);
}

main()
  .catch((error) => {
    console.error('[trust-analytics] Verification failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close().catch(() => {});
  });
