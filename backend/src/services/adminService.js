/**
 * Admin Service
 *
 * Aggregation queries for the admin dashboard.
 * Supports both PostgreSQL (Railway) and SQLite (local dev).
 */

import { query, getDbType } from '../db/connection.js';

function isPostgres() {
  return getDbType() === 'postgres';
}

// Date helpers for cross-DB compat
function ago30Days() {
  return isPostgres()
    ? "NOW() - INTERVAL '30 days'"
    : "datetime('now', '-30 days')";
}

function dateTrunc(interval, column) {
  if (isPostgres()) return `DATE_TRUNC('${interval}', ${column})`;
  if (interval === 'week') return `date(${column}, 'weekday 0', '-6 days')`;
  return `date(${column})`;
}

function countFilter(condition) {
  if (isPostgres()) return `COUNT(*) FILTER (WHERE ${condition})`;
  return `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`;
}

function avgFilter(column, condition) {
  if (isPostgres()) return `COALESCE(AVG(${column}) FILTER (WHERE ${condition}), 0)`;
  return `COALESCE(AVG(CASE WHEN ${condition} THEN ${column} END), 0)`;
}

function ilike(column, paramRef) {
  if (isPostgres()) return `${column} ILIKE ${paramRef}`;
  return `${column} LIKE ${paramRef}`;
}

function currentTimestampExpr() {
  return isPostgres() ? 'NOW()' : "datetime('now')";
}

const OVERVIEW_RANGES = {
  '24h': { postgres: "NOW() - INTERVAL '24 hours'", sqlite: "datetime('now', '-24 hours')" },
  '7d':  { postgres: "NOW() - INTERVAL '7 days'",   sqlite: "datetime('now', '-7 days')" },
  '30d': { postgres: "NOW() - INTERVAL '30 days'",  sqlite: "datetime('now', '-30 days')" },
};

function sinceExprFor(range) {
  const entry = OVERVIEW_RANGES[range];
  if (!entry) return null;
  return isPostgres() ? entry.postgres : entry.sqlite;
}

// Returns " AND <col> >= <sinceExpr>" (leading space) or "" when range is all/invalid.
function sinceAndClause(sinceExpr, col = 'occurred_at') {
  return sinceExpr ? ` AND ${col} >= ${sinceExpr}` : '';
}

// ============================================================================
// OVERVIEW
// ============================================================================

export async function getOverviewMetrics({ range = 'all' } = {}) {
  const sinceExpr = sinceExprFor(range);
  const sessionSince = sinceExpr ? `AND last_seen_at >= ${sinceExpr}` : '';
  const eventSinceWhere = sinceExpr ? `WHERE occurred_at >= ${sinceExpr}` : '';
  const eventSinceAnd = sinceAndClause(sinceExpr);

  // Core platform metrics from app tables (identity counts stay all-time)
  const result = await query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE is_active = TRUE AND id != '00000000-0000-0000-0000-000000000000') AS total_users,
      (SELECT COUNT(*) FROM users WHERE last_login > ${ago30Days()} AND id != '00000000-0000-0000-0000-000000000000') AS active_users_30d,
      (SELECT COUNT(*) FROM projects WHERE status = 'active') AS total_projects,
      (SELECT COUNT(*) FROM previews WHERE status = 'healthy') AS active_previews,
      (SELECT COALESCE(SUM(estimated_cost), 0) FROM review_usage) AS total_review_cost,
      (SELECT COALESCE(SUM(total_tokens), 0) FROM review_usage) AS total_review_tokens,
      (SELECT COALESCE(SUM(amount), 0) FROM usage_ledger WHERE kind = 'tokens') AS total_tokens_used,
      (SELECT COALESCE(SUM(cost), 0) FROM usage_ledger) AS total_cost,
      (SELECT COUNT(*) FROM review_sync_sessions WHERE revoked_at IS NULL ${sessionSince}) AS sync_sessions,
      (SELECT COUNT(*) FROM review_sync_events ${eventSinceWhere}) AS sync_events,
      (SELECT COUNT(DISTINCT user_id) FROM review_sync_events ${eventSinceWhere}) AS active_reviewers
  `);

  // Review metrics: prefer trust_review_facts (local), fall back to review_sync_events (Railway)
  const factsCount = await query('SELECT COUNT(*) as count FROM trust_review_facts');
  const hasFacts = parseInt(factsCount.rows[0].count, 10) > 0;

  let reviewMetrics;
  if (hasFacts) {
    // Local DB has trust facts — use them
    const r = await query(`
      SELECT
        (SELECT COUNT(*) FROM review_usage) AS total_reviews,
        (SELECT COALESCE(SUM(issues_found), 0) FROM trust_review_facts) AS total_findings,
        (SELECT COALESCE(SUM(high_risk_findings), 0) FROM trust_review_facts) AS total_high_risk_findings,
        (SELECT ${countFilter("status = 'addressed'")} FROM review_outcomes) AS findings_addressed,
        (SELECT ${countFilter("status = 'dismissed'")} FROM review_outcomes) AS findings_dismissed,
        (SELECT COUNT(*) FROM review_publications) AS total_publications,
        (SELECT COUNT(DISTINCT project_id) FROM trust_review_facts) AS projects_reviewed
    `);
    reviewMetrics = r.rows[0];
  } else {
    // Railway: derive metrics from review_sync_events
    const syncMetrics = await query(`
      SELECT
        ${countFilter("event_type = 'review_completed'")} AS total_reviews,
        ${countFilter("event_type = 'finding_addressed'")} AS findings_addressed,
        ${countFilter("event_type = 'finding_dismissed'")} AS findings_dismissed,
        ${countFilter("event_type = 'review_published'")} AS total_publications,
        COUNT(DISTINCT project_id) AS projects_reviewed,
        COUNT(DISTINCT user_id) AS active_reviewers
      FROM review_sync_events
      ${eventSinceWhere}
    `);
    // Extract findings from payload_json for review_completed events
    const findingsQuery = isPostgres()
      ? `SELECT
           COALESCE(SUM(NULLIF(payload_json::jsonb->>'issuesFound', '')::int), 0) AS total_findings,
           COALESCE(SUM(NULLIF(payload_json::jsonb->>'highRiskFindings', '')::int), 0) AS total_high_risk_findings
         FROM review_sync_events
         WHERE event_type = 'review_completed'${eventSinceAnd}`
      : `SELECT
           COALESCE(SUM(json_extract(payload_json, '$.issuesFound')), 0) AS total_findings,
           COALESCE(SUM(json_extract(payload_json, '$.highRiskFindings')), 0) AS total_high_risk_findings
         FROM review_sync_events
         WHERE event_type = 'review_completed'${eventSinceAnd}`;
    const findings = await query(findingsQuery);
    const usageQuery = isPostgres()
      ? `SELECT
           COALESCE(SUM(NULLIF(payload_json::jsonb->>'estimatedCost', '')::numeric), 0) AS total_review_cost,
           COALESCE(SUM(NULLIF(payload_json::jsonb->>'totalTokens', '')::bigint), 0) AS total_review_tokens
         FROM review_sync_events
         WHERE event_type = 'review_completed'${eventSinceAnd}`
      : `SELECT
           COALESCE(SUM(json_extract(payload_json, '$.estimatedCost')), 0) AS total_review_cost,
           COALESCE(SUM(json_extract(payload_json, '$.totalTokens')), 0) AS total_review_tokens
         FROM review_sync_events
         WHERE event_type = 'review_completed'${eventSinceAnd}`;
    const usageMetrics = await query(usageQuery);
    const syncedReviewCost = Number(usageMetrics.rows[0]?.total_review_cost || 0);
    const syncedReviewTokens = Number(usageMetrics.rows[0]?.total_review_tokens || 0);
    const localPlatformCost = Number(result.rows[0]?.total_cost || 0);
    const localPlatformTokens = Number(result.rows[0]?.total_tokens_used || 0);

    reviewMetrics = {
      total_reviews: syncMetrics.rows[0].total_reviews,
      total_findings: findings.rows[0].total_findings,
      total_high_risk_findings: findings.rows[0].total_high_risk_findings,
      findings_addressed: syncMetrics.rows[0].findings_addressed,
      findings_dismissed: syncMetrics.rows[0].findings_dismissed,
      total_publications: syncMetrics.rows[0].total_publications,
      projects_reviewed: syncMetrics.rows[0].projects_reviewed,
      total_review_cost: syncedReviewCost,
      total_review_tokens: syncedReviewTokens,
      total_cost: localPlatformCost > 0 ? localPlatformCost : syncedReviewCost,
      total_tokens_used: localPlatformTokens > 0 ? localPlatformTokens : syncedReviewTokens,
    };
  }

  // Review type breakdown (branch vs PR) — always from sync events
  const byType = await query(`
    SELECT review_type, COUNT(*) as count
    FROM review_sync_events
    WHERE event_type = 'review_completed'${eventSinceAnd}
    GROUP BY review_type
    ORDER BY count DESC
  `);

  // Fix run metrics: union review_fix_runs (local) with fix_run_completed sync
  // events (desktop devices), deduped by run_id so neither source masks the other.
  // Either source alone is incomplete: Railway-local rows miss desktop activity;
  // sync events miss in-progress runs and locally-resolved historical data.
  let fixMetrics = {
    total_fix_runs: 0,
    fix_runs_successful: 0,
    fix_runs_failed: 0,
    fix_runs_stopped: 0,
    fix_runs_active: 0,
    total_findings_selected: 0,
    findings_patched: 0,
  };
  try {
    const fixUnionQuery = isPostgres()
      ? `WITH local_runs AS (
           SELECT
             id::text AS run_id,
             status,
             COALESCE(jsonb_array_length(
               CASE WHEN jsonb_typeof(selected_recommendation_keys) = 'array'
                    THEN selected_recommendation_keys
                    ELSE '[]'::jsonb END
             ), 0) AS findings_selected,
             COALESCE((
               SELECT COUNT(*) FROM jsonb_each(
                 CASE WHEN jsonb_typeof(recommendation_statuses) = 'object'
                      THEN recommendation_statuses
                      ELSE '{}'::jsonb END
               ) kv
               WHERE kv.value->>'status' IN ('patch_applied','verification_pending')
             ), 0)::int AS findings_patched
           FROM review_fix_runs
         ),
         synced_runs AS (
           SELECT
             payload_json::jsonb->>'runId' AS run_id,
             payload_json::jsonb->>'runStatus' AS status,
             COALESCE(NULLIF(payload_json::jsonb->>'findingsSelected', '')::int, 0) AS findings_selected,
             COALESCE(NULLIF(payload_json::jsonb->>'findingsPatched', '')::int, 0) AS findings_patched
           FROM review_sync_events
           WHERE event_type = 'fix_run_completed'${eventSinceAnd}
             AND payload_json::jsonb->>'runId' IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM local_runs l WHERE l.run_id = (review_sync_events.payload_json::jsonb->>'runId')
             )
         ),
         combined AS (
           SELECT * FROM local_runs
           UNION ALL
           SELECT * FROM synced_runs
         )
         SELECT
           COUNT(*) AS total_fix_runs,
           ${countFilter("status IN ('patch_applied','verification_pending')")} AS fix_runs_successful,
           ${countFilter("status = 'failed'")} AS fix_runs_failed,
           ${countFilter("status = 'stopped'")} AS fix_runs_stopped,
           ${countFilter("status = 'running'")} AS fix_runs_active,
           COALESCE(SUM(findings_selected), 0) AS total_findings_selected,
           COALESCE(SUM(findings_patched), 0) AS findings_patched
         FROM combined`
      : `WITH local_runs AS (
           SELECT
             id AS run_id,
             status,
             json_array_length(
               CASE WHEN selected_recommendation_keys IS NOT NULL AND selected_recommendation_keys != ''
                    THEN selected_recommendation_keys ELSE '[]' END
             ) AS findings_selected,
             (SELECT COUNT(*) FROM json_each(
                CASE WHEN recommendation_statuses IS NOT NULL AND recommendation_statuses != ''
                     THEN recommendation_statuses ELSE '{}' END
              ) je
              WHERE json_extract(je.value, '$.status') IN ('patch_applied','verification_pending')
             ) AS findings_patched
           FROM review_fix_runs
         ),
         synced_runs AS (
           SELECT
             json_extract(payload_json, '$.runId') AS run_id,
             json_extract(payload_json, '$.runStatus') AS status,
             COALESCE(CAST(json_extract(payload_json, '$.findingsSelected') AS INTEGER), 0) AS findings_selected,
             COALESCE(CAST(json_extract(payload_json, '$.findingsPatched') AS INTEGER), 0) AS findings_patched
           FROM review_sync_events
           WHERE event_type = 'fix_run_completed'${eventSinceAnd}
             AND json_extract(payload_json, '$.runId') IS NOT NULL
             AND json_extract(payload_json, '$.runId') NOT IN (SELECT run_id FROM local_runs)
         ),
         combined AS (
           SELECT * FROM local_runs
           UNION ALL
           SELECT * FROM synced_runs
         )
         SELECT
           COUNT(*) AS total_fix_runs,
           ${countFilter("status IN ('patch_applied','verification_pending')")} AS fix_runs_successful,
           ${countFilter("status = 'failed'")} AS fix_runs_failed,
           ${countFilter("status = 'stopped'")} AS fix_runs_stopped,
           ${countFilter("status = 'running'")} AS fix_runs_active,
           COALESCE(SUM(findings_selected), 0) AS total_findings_selected,
           COALESCE(SUM(findings_patched), 0) AS findings_patched
         FROM combined`;
    const fixResult = await query(fixUnionQuery);
    fixMetrics = fixResult.rows[0] || fixMetrics;
  } catch (err) {
    // Tables may not exist yet on a fresh DB — keep zero defaults.
    console.warn('[admin] fix run metrics query failed:', err?.message || err);
  }

  // Atlas Chat metrics — derived from chat_message_sent sync events.
  // These only populate on the cloud side (Railway) where chat events
  // arrive via the sync flush worker.
  let chatMetrics = {
    chat_messages_sent: 0,
    chat_active_users: 0,
    chat_projects_used: 0,
  };
  try {
    const chatQuery = await query(`
      SELECT
        COUNT(*) AS chat_messages_sent,
        COUNT(DISTINCT user_id) AS chat_active_users,
        COUNT(DISTINCT project_id) AS chat_projects_used
      FROM review_sync_events
      WHERE event_type = 'chat_message_sent'${eventSinceAnd}
    `);
    chatMetrics = chatQuery.rows[0] || chatMetrics;
  } catch {
    // review_sync_events may be empty or schema not migrated yet — defaults.
  }

  // Walkthrough metrics — derived from walkthrough_generated and
  // walkthrough_step_read sync events.
  let walkthroughMetrics = {
    walkthroughs_generated: 0,
    walkthrough_active_users: 0,
    walkthrough_projects_used: 0,
    walkthrough_steps_read: 0,
  };
  try {
    const walkthroughQuery = await query(`
      SELECT
        ${countFilter("event_type = 'walkthrough_generated'")} AS walkthroughs_generated,
        COUNT(DISTINCT CASE WHEN event_type = 'walkthrough_generated' THEN user_id END) AS walkthrough_active_users,
        COUNT(DISTINCT CASE WHEN event_type = 'walkthrough_generated' THEN project_id END) AS walkthrough_projects_used,
        ${countFilter("event_type = 'walkthrough_step_read'")} AS walkthrough_steps_read
      FROM review_sync_events
      WHERE event_type IN ('walkthrough_generated', 'walkthrough_step_read')${eventSinceAnd}
    `);
    walkthroughMetrics = walkthroughQuery.rows[0] || walkthroughMetrics;
  } catch {
    // review_sync_events may be empty or schema not migrated yet — defaults.
  }

  return {
    ...result.rows[0],
    ...reviewMetrics,
    ...fixMetrics,
    ...chatMetrics,
    ...walkthroughMetrics,
    reviews_by_type: byType.rows,
    range: OVERVIEW_RANGES[range] ? range : 'all',
  };
}

export async function getReviewInsights() {
  const factsCount = await query('SELECT COUNT(*) as count FROM trust_review_facts');
  const hasFacts = parseInt(factsCount.rows[0].count, 10) > 0;

  if (hasFacts) {
    // Local DB: use trust_review_facts for full insights
    const factsSummary = await query(`
      SELECT
        COUNT(*) AS total_reviews,
        ${countFilter("review_status = 'reviewed'")} AS completed_reviews,
        ${countFilter("review_status = 'failed'")} AS failed_reviews,
        COALESCE(SUM(issues_found), 0) AS total_findings,
        COALESCE(SUM(high_risk_findings), 0) AS high_risk_findings,
        COALESCE(SUM(deep_coverage_numerator), 0) AS deep_coverage_num,
        COALESCE(SUM(deep_coverage_denominator), 0) AS deep_coverage_den,
        COALESCE(SUM(grounded_issue_numerator), 0) AS grounded_issue_num,
        COALESCE(SUM(grounded_issue_denominator), 0) AS grounded_issue_den,
        COALESCE(SUM(issue_addressed_numerator), 0) AS issue_addressed_num,
        COALESCE(SUM(issue_addressed_denominator), 0) AS issue_addressed_den,
        COALESCE(SUM(issue_dismissed_numerator), 0) AS issue_dismissed_num,
        COALESCE(SUM(issue_dismissed_denominator), 0) AS issue_dismissed_den
      FROM trust_review_facts
    `);

    const outcomes = await query(`
      SELECT status, COUNT(*) as count
      FROM review_outcomes
      GROUP BY status
    `);

    const byModel = await query(`
      SELECT provider_model,
             COUNT(*) AS review_count,
             COALESCE(SUM(issues_found), 0) AS total_findings,
             COALESCE(SUM(high_risk_findings), 0) AS high_risk_findings
      FROM trust_review_facts
      WHERE provider_model IS NOT NULL
      GROUP BY provider_model
      ORDER BY review_count DESC
    `);

    const dimensionBreakdown = await query(`
      SELECT recommendation_key,
             COALESCE(SUM(issue_count), 0) AS issue_count,
             COALESCE(SUM(high_risk_count), 0) AS high_risk_count,
             COALESCE(SUM(outcome_addressed_count), 0) AS addressed,
             COALESCE(SUM(outcome_dismissed_count), 0) AS dismissed
      FROM trust_review_dimension_facts
      GROUP BY recommendation_key
      ORDER BY issue_count DESC
      LIMIT 20
    `);

    const publications = await query(`
      SELECT channel, COUNT(*) as count
      FROM review_publications
      GROUP BY channel
    `);

    const localByType = await query(`
      SELECT review_type, COUNT(*) as count
      FROM trust_review_facts
      GROUP BY review_type
      ORDER BY count DESC
    `);

    return {
      summary: factsSummary.rows[0],
      outcomes: outcomes.rows,
      by_model: byModel.rows,
      by_dimension: dimensionBreakdown.rows,
      publications: publications.rows,
      by_review_type: localByType.rows,
    };
  }

  // Railway: derive insights from review_sync_events payload_json
  const summaryQuery = isPostgres()
    ? `SELECT
         ${countFilter("event_type = 'review_completed'")} AS total_reviews,
         ${countFilter("event_type = 'review_completed' AND (payload_json::jsonb->>'reviewStatus') = 'reviewed'")} AS completed_reviews,
         ${countFilter("event_type = 'review_completed' AND (payload_json::jsonb->>'reviewStatus') = 'failed'")} AS failed_reviews,
         COALESCE(SUM(CASE WHEN event_type = 'review_completed' THEN NULLIF(payload_json::jsonb->>'issuesFound', '')::int ELSE 0 END), 0) AS total_findings,
         COALESCE(SUM(CASE WHEN event_type = 'review_completed' THEN NULLIF(payload_json::jsonb->>'highRiskFindings', '')::int ELSE 0 END), 0) AS high_risk_findings,
         ${countFilter("event_type = 'finding_addressed'")} AS findings_addressed,
         ${countFilter("event_type = 'finding_dismissed'")} AS findings_dismissed,
         ${countFilter("event_type = 'review_published'")} AS total_publications,
         COUNT(DISTINCT user_id) AS active_reviewers,
         COUNT(DISTINCT project_id) AS projects_reviewed
       FROM review_sync_events`
    : `SELECT
         ${countFilter("event_type = 'review_completed'")} AS total_reviews,
         ${countFilter("event_type = 'review_completed' AND json_extract(payload_json, '$.reviewStatus') = 'reviewed'")} AS completed_reviews,
         ${countFilter("event_type = 'review_completed' AND json_extract(payload_json, '$.reviewStatus') = 'failed'")} AS failed_reviews,
         COALESCE(SUM(CASE WHEN event_type = 'review_completed' THEN json_extract(payload_json, '$.issuesFound') ELSE 0 END), 0) AS total_findings,
         COALESCE(SUM(CASE WHEN event_type = 'review_completed' THEN json_extract(payload_json, '$.highRiskFindings') ELSE 0 END), 0) AS high_risk_findings,
         ${countFilter("event_type = 'finding_addressed'")} AS findings_addressed,
         ${countFilter("event_type = 'finding_dismissed'")} AS findings_dismissed,
         ${countFilter("event_type = 'review_published'")} AS total_publications,
         COUNT(DISTINCT user_id) AS active_reviewers,
         COUNT(DISTINCT project_id) AS projects_reviewed
       FROM review_sync_events`;

  const syncSummary = await query(summaryQuery);

  const byModelQuery = isPostgres()
    ? `SELECT payload_json::jsonb->>'providerModel' AS provider_model,
             COUNT(*) AS review_count,
             COALESCE(SUM(NULLIF(payload_json::jsonb->>'issuesFound', '')::int), 0) AS total_findings,
             COALESCE(SUM(NULLIF(payload_json::jsonb->>'highRiskFindings', '')::int), 0) AS high_risk_findings
       FROM review_sync_events
       WHERE event_type = 'review_completed' AND payload_json::jsonb->>'providerModel' IS NOT NULL
       GROUP BY payload_json::jsonb->>'providerModel'
       ORDER BY review_count DESC`
    : `SELECT json_extract(payload_json, '$.providerModel') AS provider_model,
             COUNT(*) AS review_count,
             COALESCE(SUM(json_extract(payload_json, '$.issuesFound')), 0) AS total_findings,
             COALESCE(SUM(json_extract(payload_json, '$.highRiskFindings')), 0) AS high_risk_findings
       FROM review_sync_events
       WHERE event_type = 'review_completed' AND json_extract(payload_json, '$.providerModel') IS NOT NULL
       GROUP BY json_extract(payload_json, '$.providerModel')
       ORDER BY review_count DESC`;

  const byModel = await query(byModelQuery);

  const byProjectQuery = isPostgres()
    ? `SELECT project_name,
             COUNT(*) AS review_count,
             COALESCE(SUM(NULLIF(payload_json::jsonb->>'issuesFound', '')::int), 0) AS total_findings,
             COALESCE(SUM(NULLIF(payload_json::jsonb->>'highRiskFindings', '')::int), 0) AS high_risk_findings
       FROM review_sync_events
       WHERE event_type = 'review_completed' AND project_name IS NOT NULL
       GROUP BY project_name
       ORDER BY review_count DESC
       LIMIT 20`
    : `SELECT project_name,
             COUNT(*) AS review_count,
             COALESCE(SUM(json_extract(payload_json, '$.issuesFound')), 0) AS total_findings,
             COALESCE(SUM(json_extract(payload_json, '$.highRiskFindings')), 0) AS high_risk_findings
       FROM review_sync_events
       WHERE event_type = 'review_completed' AND project_name IS NOT NULL
       GROUP BY project_name
       ORDER BY review_count DESC
       LIMIT 20`;

  const byProject = await query(byProjectQuery);

  const byReviewType = await query(`
    SELECT review_type, COUNT(*) as count
    FROM review_sync_events
    WHERE event_type = 'review_completed'
    GROUP BY review_type
    ORDER BY count DESC
  `);

  const s = syncSummary.rows[0];
  return {
    summary: {
      ...s,
      deep_coverage_num: 0,
      deep_coverage_den: 0,
      grounded_issue_num: 0,
      grounded_issue_den: 0,
      issue_addressed_num: s.findings_addressed,
      issue_addressed_den: s.total_findings,
      issue_dismissed_num: s.findings_dismissed,
      issue_dismissed_den: s.total_findings,
    },
    outcomes: [
      ...(Number(s.findings_addressed) > 0 ? [{ status: 'addressed', count: s.findings_addressed }] : []),
      ...(Number(s.findings_dismissed) > 0 ? [{ status: 'dismissed', count: s.findings_dismissed }] : []),
    ],
    by_model: byModel.rows,
    by_dimension: byProject.rows.map((r) => ({
      recommendation_key: r.project_name,
      issue_count: r.total_findings,
      high_risk_count: r.high_risk_findings,
      addressed: 0,
      dismissed: 0,
    })),
    publications: [],
    by_review_type: byReviewType.rows,
  };
}

// ============================================================================
// USERS
// ============================================================================

const ALLOWED_USER_SORT_COLUMNS = new Set([
  'created_at', 'last_login', 'last_active_at', 'email', 'name', 'plan',
]);

export async function getUsers({ page = 1, limit = 50, search, plan, sort = 'last_active_at', order = 'desc' }) {
  const safeSort = ALLOWED_USER_SORT_COLUMNS.has(sort) ? sort : 'last_active_at';
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';
  // last_active_at is a computed alias (not a u.* column); reference it bare.
  const sortExpr = safeSort === 'last_active_at' ? 'last_active_at' : `u.${safeSort}`;
  const offset = (page - 1) * limit;

  const conditions = ["u.id != '00000000-0000-0000-0000-000000000000'"];
  const params = [];
  let paramIdx = 1;

  if (search) {
    conditions.push(`(${ilike('u.email', `$${paramIdx}`)} OR ${ilike('u.name', `$${paramIdx}`)})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  if (plan) {
    conditions.push(`u.plan = $${paramIdx}`);
    params.push(plan);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(
    `SELECT COUNT(*) as count FROM users u ${whereClause}`,
    params
  );

  const userIdMatch = isPostgres() ? 'e.user_id = u.id::text' : 'e.user_id = CAST(u.id AS TEXT)';
  const sessionIdMatch = isPostgres() ? 's.user_id = u.id::text' : 's.user_id = CAST(u.id AS TEXT)';
  const isLinkedExpr = isPostgres()
    ? '(u.github_user_id IS NOT NULL)'
    : 'CASE WHEN u.github_user_id IS NOT NULL THEN 1 ELSE 0 END';
  const usersResult = await query(
    `SELECT u.id, u.email, u.name, u.plan, u.is_active, u.is_admin, u.created_at, u.last_login,
            u.github_login, u.github_avatar_url, u.client_source, ${isLinkedExpr} AS is_linked,
            q.tokens_used_this_month, q.cost_this_month, q.quota_exceeded,
            (SELECT COUNT(*) FROM review_sync_events e
               WHERE ${userIdMatch} AND e.event_type = 'review_completed') AS reviews_completed,
            (SELECT COUNT(DISTINCT e.project_name) FROM review_sync_events e
               WHERE ${userIdMatch}
                 AND e.event_type = 'review_completed'
                 AND e.project_name IS NOT NULL
                 AND e.project_name != '') AS review_projects_count,
            COALESCE(
              (SELECT MAX(e.occurred_at) FROM review_sync_events e WHERE ${userIdMatch}),
              (SELECT MAX(s.last_seen_at) FROM review_sync_sessions s WHERE ${sessionIdMatch}),
              u.last_login
            ) AS last_active_at
     FROM users u
     LEFT JOIN user_quotas q ON q.user_id = u.id
     ${whereClause}
     ORDER BY ${sortExpr} ${safeOrder} NULLS LAST
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset]
  );

  return {
    users: usersResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
    page,
    limit,
  };
}

export async function getUserDetail(userId) {
  const userResult = await query(
    `SELECT u.*, q.*
     FROM users u
     LEFT JOIN user_quotas q ON q.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );

  if (userResult.rows.length === 0) return null;

  // Check if this user has local project data
  const projectsResult = await query(
    `SELECT COUNT(*) AS total,
            ${countFilter("status = 'active'")} AS active
     FROM projects WHERE user_id = $1`,
    [userId]
  );

  const usageResult = await query(
    `SELECT kind, COALESCE(SUM(amount), 0) AS total_amount, COALESCE(SUM(cost), 0) AS total_cost
     FROM usage_ledger WHERE user_id = $1
     GROUP BY kind`,
    [userId]
  );

  // Enrich with sync event data (works on Railway where local tables are empty)
  const syncSummaryQuery = isPostgres()
    ? `SELECT
         ${countFilter("event_type = 'review_completed'")} AS reviews_completed,
         COALESCE(SUM(CASE WHEN event_type = 'review_completed' THEN NULLIF(payload_json::jsonb->>'issuesFound', '')::int ELSE 0 END), 0) AS total_findings,
         COALESCE(SUM(CASE WHEN event_type = 'review_completed' THEN NULLIF(payload_json::jsonb->>'highRiskFindings', '')::int ELSE 0 END), 0) AS high_risk_findings,
         ${countFilter("event_type = 'finding_addressed'")} AS findings_addressed,
         ${countFilter("event_type = 'finding_dismissed'")} AS findings_dismissed,
         ${countFilter("event_type = 'review_published'")} AS publications,
         COUNT(DISTINCT project_name) AS projects_reviewed,
         MIN(occurred_at) AS first_activity,
         MAX(occurred_at) AS last_activity
       FROM review_sync_events WHERE user_id = $1`
    : `SELECT
         ${countFilter("event_type = 'review_completed'")} AS reviews_completed,
         COALESCE(SUM(CASE WHEN event_type = 'review_completed' THEN json_extract(payload_json, '$.issuesFound') ELSE 0 END), 0) AS total_findings,
         COALESCE(SUM(CASE WHEN event_type = 'review_completed' THEN json_extract(payload_json, '$.highRiskFindings') ELSE 0 END), 0) AS high_risk_findings,
         ${countFilter("event_type = 'finding_addressed'")} AS findings_addressed,
         ${countFilter("event_type = 'finding_dismissed'")} AS findings_dismissed,
         ${countFilter("event_type = 'review_published'")} AS publications,
         COUNT(DISTINCT project_name) AS projects_reviewed,
         MIN(occurred_at) AS first_activity,
         MAX(occurred_at) AS last_activity
       FROM review_sync_events WHERE user_id = $1`;

  const syncSummary = await query(syncSummaryQuery, [userId]);

  const syncProjectsQuery = isPostgres()
    ? `SELECT project_name,
             COUNT(*) AS review_count,
             COALESCE(SUM(NULLIF(payload_json::jsonb->>'issuesFound', '')::int), 0) AS findings,
             MAX(occurred_at) AS last_review
       FROM review_sync_events
       WHERE user_id = $1 AND event_type = 'review_completed' AND project_name IS NOT NULL
       GROUP BY project_name
       ORDER BY last_review DESC
       LIMIT 10`
    : `SELECT project_name,
             COUNT(*) AS review_count,
             COALESCE(SUM(json_extract(payload_json, '$.issuesFound')), 0) AS findings,
             MAX(occurred_at) AS last_review
       FROM review_sync_events
       WHERE user_id = $1 AND event_type = 'review_completed' AND project_name IS NOT NULL
       GROUP BY project_name
       ORDER BY last_review DESC
       LIMIT 10`;

  const syncProjects = await query(syncProjectsQuery, [userId]);

  return {
    ...userResult.rows[0],
    project_summary: projectsResult.rows[0],
    usage_by_kind: usageResult.rows,
    sync_activity: syncSummary.rows[0] || null,
    sync_projects: syncProjects.rows,
  };
}

export async function updateUser(userId, updates) {
  const ALLOWED_FIELDS = new Set(['plan', 'is_active', 'is_admin', 'name']);
  const entries = Object.entries(updates).filter(([key]) => ALLOWED_FIELDS.has(key));

  if (entries.length === 0) return null;

  const setClauses = entries.map(([key], idx) => `${key} = $${idx + 2}`);
  const values = entries.map(([, val]) => val);

  const result = await query(
    `UPDATE users SET ${setClauses.join(', ')}, updated_at = ${currentTimestampExpr()}
     WHERE id = $1
     RETURNING id, email, name, plan, is_active, is_admin`,
    [userId, ...values]
  );

  return result.rows[0] || null;
}

// ============================================================================
// PROJECTS
// ============================================================================

const ALLOWED_PROJECT_SORT_COLUMNS = new Set([
  'created_at', 'updated_at', 'name', 'last_accessed',
]);

export async function getProjects({ page = 1, limit = 50, search, status, sort = 'updated_at', order = 'desc' }) {
  // Check if projects table has data; if not, derive from sync events
  const projectsCount = await query('SELECT COUNT(*) as count FROM projects');
  const hasProjects = parseInt(projectsCount.rows[0].count, 10) > 0;

  if (!hasProjects) {
    return getSyncDerivedProjects({ page, limit, search });
  }

  const safeSort = ALLOWED_PROJECT_SORT_COLUMNS.has(sort) ? sort : 'updated_at';
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (search) {
    conditions.push(`(${ilike('p.name', `$${paramIdx}`)} OR ${ilike('u.email', `$${paramIdx}`)})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  if (status) {
    conditions.push(`p.status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(
    `SELECT COUNT(*) as count FROM projects p LEFT JOIN users u ON u.id = p.user_id ${whereClause}`,
    params
  );

  const projectsResult = await query(
    `SELECT p.id, p.name, p.status, p.framework, p.language, p.source,
            p.github_repo_full_name, p.created_at, p.updated_at, p.last_accessed,
            u.email AS user_email, u.name AS user_name
     FROM projects p
     LEFT JOIN users u ON u.id = p.user_id
     ${whereClause}
     ORDER BY p.${safeSort} ${safeOrder}
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset]
  );

  return {
    projects: projectsResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
    page,
    limit,
  };
}

async function getSyncDerivedProjects({ page = 1, limit = 50, search } = {}) {
  const offset = (page - 1) * limit;
  const conditions = ["e.project_name IS NOT NULL", "e.project_name != ''", "e.event_type = 'review_completed'"];
  const params = [];
  let paramIdx = 1;

  if (search) {
    conditions.push(ilike('e.project_name', `$${paramIdx}`));
    params.push(`%${search}%`);
    paramIdx++;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // Group by repo_identity_hash when available (same repo across all users/devices = one row).
  // Fall back to (project_name, user_id) for projects without a git remote.
  const groupExpr = isPostgres()
    ? "COALESCE(e.repo_identity_hash, e.project_name || '::' || e.user_id)"
    : "COALESCE(e.repo_identity_hash, e.project_name || '::' || e.user_id)";

  const baseQuery = isPostgres()
    ? `SELECT
         MAX(e.project_name) AS name,
         COUNT(*) AS review_count,
         COALESCE(SUM(NULLIF(e.payload_json::jsonb->>'issuesFound', '')::int), 0) AS findings,
         COALESCE(SUM(NULLIF(e.payload_json::jsonb->>'highRiskFindings', '')::int), 0) AS high_risk,
         COUNT(DISTINCT e.user_id) AS reviewers,
         MIN(e.occurred_at) AS first_review,
         MAX(e.occurred_at) AS last_review,
         MAX(e.repo_remote_url) AS repo_url
       FROM review_sync_events e
       ${whereClause}
       GROUP BY ${groupExpr}
       ORDER BY last_review DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`
    : `SELECT
         MAX(e.project_name) AS name,
         COUNT(*) AS review_count,
         COALESCE(SUM(json_extract(e.payload_json, '$.issuesFound')), 0) AS findings,
         COALESCE(SUM(json_extract(e.payload_json, '$.highRiskFindings')), 0) AS high_risk,
         COUNT(DISTINCT e.user_id) AS reviewers,
         MIN(e.occurred_at) AS first_review,
         MAX(e.occurred_at) AS last_review,
         MAX(e.repo_remote_url) AS repo_url
       FROM review_sync_events e
       ${whereClause}
       GROUP BY ${groupExpr}
       ORDER BY last_review DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

  const countQuery = isPostgres()
    ? `SELECT COUNT(*)::int as count FROM (SELECT ${groupExpr} AS grp FROM review_sync_events e ${whereClause} GROUP BY ${groupExpr}) grouped`
    : `SELECT COUNT(*) as count FROM (SELECT ${groupExpr} AS grp FROM review_sync_events e ${whereClause} GROUP BY ${groupExpr}) grouped`;

  const [countResult, projectsResult] = await Promise.all([
    query(countQuery, params),
    query(baseQuery, [...params, limit, offset]),
  ]);

  return {
    projects: projectsResult.rows.map((r) => ({
      id: r.name,
      name: r.name,
      status: 'reviewed',
      framework: null,
      language: null,
      source: 'sync',
      github_repo_full_name: r.repo_url || null,
      created_at: r.first_review,
      updated_at: r.last_review,
      last_accessed: r.last_review,
      user_email: `${r.reviewers} reviewer${Number(r.reviewers) !== 1 ? 's' : ''}`,
      user_name: null,
      review_count: r.review_count,
      findings: r.findings,
      high_risk: r.high_risk,
    })),
    total: parseInt(countResult.rows[0].count, 10),
    page,
    limit,
  };
}

// ============================================================================
// REVIEWS
// ============================================================================

export async function getReviewSummary({ from, to } = {}) {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (from) {
    conditions.push(`reviewed_at >= $${paramIdx}`);
    params.push(from);
    paramIdx++;
  }
  if (to) {
    conditions.push(`reviewed_at <= $${paramIdx}`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT
       COUNT(*) AS total_reviews,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(estimated_cost), 0) AS total_cost,
       COALESCE(AVG(total_tokens), 0) AS avg_tokens_per_review
     FROM review_usage ${whereClause}`,
    params
  );

  const byModel = await query(
    `SELECT model, provider_type,
            COUNT(*) AS review_count,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(estimated_cost), 0) AS total_cost
     FROM review_usage ${whereClause}
     GROUP BY model, provider_type
     ORDER BY total_cost DESC`,
    params
  );

  return {
    ...result.rows[0],
    by_model: byModel.rows,
  };
}

export async function getReviewTimeseries({ from, to, interval = 'day' } = {}) {
  const truncInterval = interval === 'week' ? 'week' : 'day';
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (from) {
    conditions.push(`reviewed_at >= $${paramIdx}`);
    params.push(from);
    paramIdx++;
  }
  if (to) {
    conditions.push(`reviewed_at <= $${paramIdx}`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const periodExpr = dateTrunc(truncInterval, 'reviewed_at');
  const result = await query(
    `SELECT ${periodExpr} AS period,
            COUNT(*) AS review_count,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(estimated_cost), 0) AS total_cost
     FROM review_usage ${whereClause}
     GROUP BY period
     ORDER BY period ASC`,
    params
  );

  return result.rows;
}

// ============================================================================
// USAGE
// ============================================================================

export async function getUsageSummary({ from, to } = {}) {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (from) {
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(from);
    paramIdx++;
  }
  if (to) {
    conditions.push(`created_at <= $${paramIdx}`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT kind,
            COUNT(*) AS entry_count,
            COALESCE(SUM(amount), 0) AS total_amount,
            COALESCE(SUM(cost), 0) AS total_cost
     FROM usage_ledger ${whereClause}
     GROUP BY kind
     ORDER BY total_cost DESC`,
    params
  );

  return result.rows;
}

export async function getUsageTimeseries({ from, to, interval = 'day' } = {}) {
  const truncInterval = interval === 'week' ? 'week' : 'day';
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (from) {
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(from);
    paramIdx++;
  }
  if (to) {
    conditions.push(`created_at <= $${paramIdx}`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const periodExpr = dateTrunc(truncInterval, 'created_at');
  const result = await query(
    `SELECT ${periodExpr} AS period,
            kind,
            COALESCE(SUM(amount), 0) AS total_amount,
            COALESCE(SUM(cost), 0) AS total_cost
     FROM usage_ledger ${whereClause}
     GROUP BY period, kind
     ORDER BY period ASC`,
    params
  );

  return result.rows;
}

export async function getTopUsers({ by = 'cost', limit = 10, from, to } = {}) {
  const conditions = ["u.id != '00000000-0000-0000-0000-000000000000'"];
  const params = [];
  let paramIdx = 1;

  if (from) {
    conditions.push(`ul.created_at >= $${paramIdx}`);
    params.push(from);
    paramIdx++;
  }
  if (to) {
    conditions.push(`ul.created_at <= $${paramIdx}`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const orderColumn = by === 'tokens' ? 'total_amount' : 'total_cost';

  const result = await query(
    `SELECT u.id, u.email, u.name, u.plan,
            COALESCE(SUM(ul.amount), 0) AS total_amount,
            COALESCE(SUM(ul.cost), 0) AS total_cost
     FROM users u
     LEFT JOIN usage_ledger ul ON ul.user_id = u.id
     ${whereClause}
     GROUP BY u.id, u.email, u.name, u.plan
     ORDER BY ${orderColumn} DESC
     LIMIT $${paramIdx}`,
    [...params, limit]
  );

  return result.rows;
}

// ============================================================================
// BUILDS
// ============================================================================

export async function getBuildStats({ from, to } = {}) {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (from) {
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(from);
    paramIdx++;
  }
  if (to) {
    conditions.push(`created_at <= $${paramIdx}`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT
       COUNT(*) AS total_builds,
       ${countFilter("status = 'succeeded'")} AS succeeded,
       ${countFilter("status = 'failed'")} AS failed,
       ${countFilter("status IN ('queued', 'running')")} AS in_progress,
       ${avgFilter('duration_seconds', "status = 'succeeded'")} AS avg_duration_seconds
     FROM builds ${whereClause}`,
    params
  );

  return result.rows[0];
}

// ============================================================================
// EVENTS
// ============================================================================

export async function getEvents({ page = 1, limit = 50, kind, status } = {}) {
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (kind) {
    conditions.push(`e.kind = $${paramIdx}`);
    params.push(kind);
    paramIdx++;
  }
  if (status) {
    conditions.push(`e.status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(
    `SELECT COUNT(*) as count FROM events e ${whereClause}`,
    params
  );

  const eventsResult = await query(
    `SELECT e.id, e.kind, e.status, e.message, e.created_at,
            u.email AS user_email
     FROM events e
     LEFT JOIN users u ON u.id = e.user_id
     ${whereClause}
     ORDER BY e.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset]
  );

  return {
    events: eventsResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
    page,
    limit,
  };
}

// ============================================================================
// REVIEW SYNC
// ============================================================================

export async function getReviewSyncStats() {
  const sessions = await query(
    `SELECT COUNT(*) AS total_sessions,
            ${countFilter('revoked_at IS NULL')} AS active_sessions
     FROM review_sync_sessions`
  );

  const events = await query(
    `SELECT sync_status, COUNT(*) AS count
     FROM review_sync_events
     GROUP BY sync_status`
  );

  return {
    sessions: sessions.rows[0],
    events_by_status: events.rows,
  };
}
