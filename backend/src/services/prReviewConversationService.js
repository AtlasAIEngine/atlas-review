import db, { getDbType, transaction } from '../db/connection.js';
import githubService from './githubService.js';
import { buildGitHubReviewStatus, resolveGitHubMeta } from './prReviewSyncService.js';

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const ATLAS_APP_AUTHOR_LOGINS = new Set(
  [
    process.env.GITHUB_APP_LOGIN,
    process.env.GITHUB_APP_NAME,
    process.env.GITHUB_APP_SLUG,
    'atlasengineapp',
    'atlasengine',
  ]
    .flatMap((value) => {
      const normalized = normalizeLogin(value);
      return normalized ? [normalized, `${normalized}[bot]`] : [];
    })
    .filter(Boolean)
);

function normalizeLogin(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function nullableInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  return integer > 0 ? integer : null;
}

function dbBool(value) {
  return getDbType() === 'sqlite' ? (value ? 1 : 0) : Boolean(value);
}

function rowBool(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function nowExpr() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

function normalizeDate(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeAuthor(author) {
  if (!author || typeof author !== 'object') {
    return { login: null, avatarUrl: null, url: null };
  }
  return {
    login: nullableText(author.login),
    avatarUrl: nullableText(author.avatarUrl || author.avatar_url),
    url: nullableText(author.url || author.html_url),
  };
}

function normalizeThread(rawThread, githubPrNumber) {
  const threadNodeId = nullableText(rawThread?.id);
  if (!threadNodeId) return null;
  const comments = Array.isArray(rawThread?.comments?.nodes)
    ? rawThread.comments.nodes
    : Array.isArray(rawThread?.comments)
      ? rawThread.comments
      : [];
  const normalizedComments = comments
    .map((comment) => normalizeThreadComment(comment, rawThread))
    .filter(Boolean);
  const timestamps = normalizedComments
    .flatMap((comment) => [comment.createdAtSource, comment.updatedAtSource])
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    threadNodeId,
    githubPrNumber: nullableInt(githubPrNumber),
    isResolved: rawThread?.isResolved === true,
    isOutdated: rawThread?.isOutdated === true,
    resolvedByLogin: nullableText(rawThread?.resolvedBy?.login),
    path: nullableText(rawThread?.path),
    line: nullableInt(rawThread?.line),
    startLine: nullableInt(rawThread?.startLine),
    side: nullableText(rawThread?.diffSide || rawThread?.side),
    originalLine: nullableInt(rawThread?.originalLine),
    originalStartLine: nullableInt(rawThread?.originalStartLine),
    firstCommentAt: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
    lastCommentAt: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
    commentCount: normalizedComments.length,
    comments: normalizedComments,
  };
}

function normalizeThreadComment(rawComment, rawThread) {
  const commentNodeId = nullableText(rawComment?.id || rawComment?.node_id);
  if (!commentNodeId) return null;
  const author = normalizeAuthor(rawComment?.author || rawComment?.user);
  return {
    threadNodeId: nullableText(rawThread?.id),
    commentNodeId,
    databaseId: nullableInt(rawComment?.databaseId || rawComment?.id),
    replyToNodeId: nullableText(rawComment?.replyTo?.id || rawComment?.in_reply_to_id),
    githubReviewNodeId: nullableText(rawComment?.pullRequestReview?.id),
    githubReviewDatabaseId: nullableInt(rawComment?.pullRequestReview?.databaseId || rawComment?.pull_request_review_id),
    body: normalizeString(rawComment?.body),
    bodyText: nullableText(rawComment?.bodyText || rawComment?.body),
    authorLogin: author.login,
    authorAvatarUrl: author.avatarUrl,
    authorUrl: author.url,
    htmlUrl: nullableText(rawComment?.url || rawComment?.html_url),
    path: nullableText(rawComment?.path || rawThread?.path),
    line: nullableInt(rawComment?.line || rawThread?.line),
    startLine: nullableInt(rawComment?.startLine || rawThread?.startLine),
    side: nullableText(rawComment?.diffSide || rawComment?.side || rawThread?.diffSide || rawThread?.side),
    diffHunk: nullableText(rawComment?.diffHunk || rawComment?.diff_hunk),
    isMinimized: rawComment?.isMinimized === true,
    minimizedReason: nullableText(rawComment?.minimizedReason),
    createdAtSource: normalizeDate(rawComment?.createdAt || rawComment?.created_at),
    updatedAtSource: normalizeDate(rawComment?.updatedAt || rawComment?.updated_at),
  };
}

function normalizeIssueComment(rawComment, githubPrNumber) {
  const commentNodeId = nullableText(rawComment?.node_id || rawComment?.id);
  if (!commentNodeId) return null;
  const author = normalizeAuthor(rawComment?.user || rawComment?.author);
  return {
    githubPrNumber: nullableInt(githubPrNumber),
    commentNodeId,
    databaseId: nullableInt(rawComment?.id || rawComment?.databaseId),
    body: normalizeString(rawComment?.body),
    bodyText: nullableText(rawComment?.body_text || rawComment?.body),
    authorLogin: author.login,
    authorAvatarUrl: author.avatarUrl,
    authorUrl: author.url,
    htmlUrl: nullableText(rawComment?.html_url || rawComment?.url),
    createdAtSource: normalizeDate(rawComment?.created_at || rawComment?.createdAt),
    updatedAtSource: normalizeDate(rawComment?.updated_at || rawComment?.updatedAt),
  };
}

function placeholders(start, count) {
  return Array.from({ length: count }, (_, index) => `$${start + index}`).join(', ');
}

async function deleteMissingRows(client, table, idColumn, projectId, prReviewId, ids) {
  const normalizedIds = Array.from(new Set((ids || []).map(nullableText).filter(Boolean)));
  if (normalizedIds.length === 0) {
    await client.query(
      `DELETE FROM ${table} WHERE project_id = $1 AND pr_review_id = $2`,
      [projectId, prReviewId]
    );
    return;
  }
  await client.query(
    `DELETE FROM ${table}
      WHERE project_id = $1
        AND pr_review_id = $2
        AND ${idColumn} NOT IN (${placeholders(3, normalizedIds.length)})`,
    [projectId, prReviewId, ...normalizedIds]
  );
}

async function upsertThread(client, projectId, prReviewId, thread) {
  const currentNow = nowExpr();
  await client.query(
    `INSERT INTO github_pr_threads (
      project_id, pr_review_id, github_pr_number, thread_node_id, is_resolved, is_outdated,
      resolved_by_login, path, line, start_line, side, original_line, original_start_line,
      first_comment_at, last_comment_at, comment_count, synced_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, ${currentNow}
    )
    ON CONFLICT (project_id, pr_review_id, thread_node_id) DO UPDATE SET
      github_pr_number = EXCLUDED.github_pr_number,
      is_resolved = EXCLUDED.is_resolved,
      is_outdated = EXCLUDED.is_outdated,
      resolved_by_login = EXCLUDED.resolved_by_login,
      path = EXCLUDED.path,
      line = EXCLUDED.line,
      start_line = EXCLUDED.start_line,
      side = EXCLUDED.side,
      original_line = EXCLUDED.original_line,
      original_start_line = EXCLUDED.original_start_line,
      first_comment_at = EXCLUDED.first_comment_at,
      last_comment_at = EXCLUDED.last_comment_at,
      comment_count = EXCLUDED.comment_count,
      synced_at = ${currentNow},
      updated_at = ${currentNow}`,
    [
      projectId,
      prReviewId,
      thread.githubPrNumber,
      thread.threadNodeId,
      dbBool(thread.isResolved),
      dbBool(thread.isOutdated),
      thread.resolvedByLogin,
      thread.path,
      thread.line,
      thread.startLine,
      thread.side,
      thread.originalLine,
      thread.originalStartLine,
      thread.firstCommentAt,
      thread.lastCommentAt,
      thread.commentCount,
    ]
  );
}

async function upsertThreadComment(client, projectId, prReviewId, comment) {
  const currentNow = nowExpr();
  await client.query(
    `INSERT INTO github_pr_thread_comments (
      project_id, pr_review_id, thread_node_id, comment_node_id, database_id, reply_to_node_id,
      github_review_node_id, github_review_database_id, body, body_text, author_login,
      author_avatar_url, author_url, html_url, path, line, start_line, side, diff_hunk,
      is_minimized, minimized_reason, created_at_source, updated_at_source, synced_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17, $18, $19,
      $20, $21, $22, $23, ${currentNow}
    )
    ON CONFLICT (project_id, pr_review_id, comment_node_id) DO UPDATE SET
      thread_node_id = EXCLUDED.thread_node_id,
      database_id = EXCLUDED.database_id,
      reply_to_node_id = EXCLUDED.reply_to_node_id,
      github_review_node_id = EXCLUDED.github_review_node_id,
      github_review_database_id = EXCLUDED.github_review_database_id,
      body = EXCLUDED.body,
      body_text = EXCLUDED.body_text,
      author_login = EXCLUDED.author_login,
      author_avatar_url = EXCLUDED.author_avatar_url,
      author_url = EXCLUDED.author_url,
      html_url = EXCLUDED.html_url,
      path = EXCLUDED.path,
      line = EXCLUDED.line,
      start_line = EXCLUDED.start_line,
      side = EXCLUDED.side,
      diff_hunk = EXCLUDED.diff_hunk,
      is_minimized = EXCLUDED.is_minimized,
      minimized_reason = EXCLUDED.minimized_reason,
      created_at_source = EXCLUDED.created_at_source,
      updated_at_source = EXCLUDED.updated_at_source,
      synced_at = ${currentNow},
      updated_at = ${currentNow}`,
    [
      projectId,
      prReviewId,
      comment.threadNodeId,
      comment.commentNodeId,
      comment.databaseId,
      comment.replyToNodeId,
      comment.githubReviewNodeId,
      comment.githubReviewDatabaseId,
      comment.body,
      comment.bodyText,
      comment.authorLogin,
      comment.authorAvatarUrl,
      comment.authorUrl,
      comment.htmlUrl,
      comment.path,
      comment.line,
      comment.startLine,
      comment.side,
      comment.diffHunk,
      dbBool(comment.isMinimized),
      comment.minimizedReason,
      comment.createdAtSource,
      comment.updatedAtSource,
    ]
  );
}

async function upsertIssueComment(client, projectId, prReviewId, comment) {
  const currentNow = nowExpr();
  await client.query(
    `INSERT INTO github_pr_issue_comments (
      project_id, pr_review_id, github_pr_number, comment_node_id, database_id, body,
      body_text, author_login, author_avatar_url, author_url, html_url,
      created_at_source, updated_at_source, synced_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, ${currentNow}
    )
    ON CONFLICT (project_id, pr_review_id, comment_node_id) DO UPDATE SET
      github_pr_number = EXCLUDED.github_pr_number,
      database_id = EXCLUDED.database_id,
      body = EXCLUDED.body,
      body_text = EXCLUDED.body_text,
      author_login = EXCLUDED.author_login,
      author_avatar_url = EXCLUDED.author_avatar_url,
      author_url = EXCLUDED.author_url,
      html_url = EXCLUDED.html_url,
      created_at_source = EXCLUDED.created_at_source,
      updated_at_source = EXCLUDED.updated_at_source,
      synced_at = ${currentNow},
      updated_at = ${currentNow}`,
    [
      projectId,
      prReviewId,
      comment.githubPrNumber,
      comment.commentNodeId,
      comment.databaseId,
      comment.body,
      comment.bodyText,
      comment.authorLogin,
      comment.authorAvatarUrl,
      comment.authorUrl,
      comment.htmlUrl,
      comment.createdAtSource,
      comment.updatedAtSource,
    ]
  );
}

function canManageThreadComment(row, viewerGitHubLogins = new Set()) {
  const authorLogin = normalizeLogin(row?.author_login);
  const hasEditableShape = row?.database_id != null;
  if (!hasEditableShape || !authorLogin) return false;
  return viewerGitHubLogins.has(authorLogin) || ATLAS_APP_AUTHOR_LOGINS.has(authorLogin);
}

function canManageIssueComment(row, viewerGitHubLogins = new Set()) {
  const authorLogin = normalizeLogin(row?.author_login);
  const hasEditableShape = row?.database_id != null;
  if (!hasEditableShape || !authorLogin) return false;
  return viewerGitHubLogins.has(authorLogin) || ATLAS_APP_AUTHOR_LOGINS.has(authorLogin);
}

function toComment(row, options = {}) {
  const canManage = canManageThreadComment(row, options.viewerGitHubLogins || new Set());
  return {
    id: row.comment_node_id,
    nodeId: row.comment_node_id,
    databaseId: row.database_id != null ? Number(row.database_id) : null,
    threadNodeId: row.thread_node_id ?? null,
    replyToNodeId: row.reply_to_node_id ?? null,
    githubReviewNodeId: row.github_review_node_id ?? null,
    githubReviewDatabaseId: row.github_review_database_id != null ? Number(row.github_review_database_id) : null,
    body: row.body ?? '',
    bodyText: row.body_text ?? null,
    authorLogin: row.author_login ?? null,
    authorAvatarUrl: row.author_avatar_url ?? null,
    authorUrl: row.author_url ?? null,
    htmlUrl: row.html_url ?? null,
    path: row.path ?? null,
    line: row.line != null ? Number(row.line) : null,
    startLine: row.start_line != null ? Number(row.start_line) : null,
    side: row.side ?? null,
    diffHunk: row.diff_hunk ?? null,
    isMinimized: rowBool(row.is_minimized),
    minimizedReason: row.minimized_reason ?? null,
    createdAt: row.created_at_source ?? null,
    updatedAt: row.updated_at_source ?? null,
    syncedAt: row.synced_at ?? null,
    canEdit: canManage,
    canDelete: canManage,
  };
}

function toIssueComment(row, options = {}) {
  const canManage = canManageIssueComment(row, options.viewerGitHubLogins || new Set());
  return {
    id: row.comment_node_id,
    nodeId: row.comment_node_id,
    databaseId: row.database_id != null ? Number(row.database_id) : null,
    githubPrNumber: row.github_pr_number != null ? Number(row.github_pr_number) : null,
    body: row.body ?? '',
    bodyText: row.body_text ?? null,
    authorLogin: row.author_login ?? null,
    authorAvatarUrl: row.author_avatar_url ?? null,
    authorUrl: row.author_url ?? null,
    htmlUrl: row.html_url ?? null,
    createdAt: row.created_at_source ?? null,
    updatedAt: row.updated_at_source ?? null,
    syncedAt: row.synced_at ?? null,
    canEdit: canManage,
    canDelete: canManage,
  };
}

function toThread(row, comments = []) {
  return {
    id: row.thread_node_id,
    nodeId: row.thread_node_id,
    githubPrNumber: row.github_pr_number != null ? Number(row.github_pr_number) : null,
    isResolved: rowBool(row.is_resolved),
    isOutdated: rowBool(row.is_outdated),
    resolvedByLogin: row.resolved_by_login ?? null,
    path: row.path ?? null,
    line: row.line != null ? Number(row.line) : null,
    startLine: row.start_line != null ? Number(row.start_line) : null,
    side: row.side ?? null,
    originalLine: row.original_line != null ? Number(row.original_line) : null,
    originalStartLine: row.original_start_line != null ? Number(row.original_start_line) : null,
    firstCommentAt: row.first_comment_at ?? null,
    lastCommentAt: row.last_comment_at ?? null,
    commentCount: row.comment_count != null ? Number(row.comment_count) : comments.length,
    syncedAt: row.synced_at ?? null,
    comments,
  };
}

async function getViewerGitHubLogins(userId) {
  const normalizedUserId = nullableText(userId);
  if (!normalizedUserId) return new Set();
  const result = await db.query(
    'SELECT account_login FROM github_integrations WHERE user_id = $1 AND is_active = TRUE',
    [normalizedUserId]
  );
  return new Set(
    (result.rows || [])
      .map((row) => normalizeLogin(row?.account_login))
      .filter(Boolean)
  );
}

async function listConversations(projectId, prReviewId, options = {}) {
  const viewerGitHubLogins = await getViewerGitHubLogins(options.userId);
  const [threadResult, commentResult, issueCommentResult, prReviewResult] = await Promise.all([
    db.query(
      `SELECT *
         FROM github_pr_threads
        WHERE project_id = $1 AND pr_review_id = $2
        ORDER BY is_resolved ASC, COALESCE(last_comment_at, updated_at) DESC`,
      [projectId, prReviewId]
    ),
    db.query(
      `SELECT *
         FROM github_pr_thread_comments
        WHERE project_id = $1 AND pr_review_id = $2
        ORDER BY created_at_source ASC, updated_at_source ASC`,
      [projectId, prReviewId]
    ),
    db.query(
      `SELECT *
         FROM github_pr_issue_comments
        WHERE project_id = $1 AND pr_review_id = $2
        ORDER BY created_at_source ASC, updated_at_source ASC`,
      [projectId, prReviewId]
    ),
    db.query(
      `SELECT github_pr_number, github_review_decision, github_merge_state_status,
              github_latest_review_state, github_latest_review_author,
              github_latest_review_submitted_at, github_review_state_counts,
              github_review_status_synced_at
         FROM pr_reviews
        WHERE project_id = $1 AND id = $2
        LIMIT 1`,
      [projectId, prReviewId]
    ),
  ]);

  const commentsByThread = new Map();
  for (const row of commentResult.rows || []) {
    const comment = toComment(row, { viewerGitHubLogins });
    const list = commentsByThread.get(comment.threadNodeId) || [];
    list.push(comment);
    commentsByThread.set(comment.threadNodeId, list);
  }
  const threads = (threadResult.rows || []).map((row) => (
    toThread(row, commentsByThread.get(row.thread_node_id) || [])
  ));
  const issueComments = (issueCommentResult.rows || []).map((row) => (
    toIssueComment(row, { viewerGitHubLogins })
  ));
  return {
    threads,
    issueComments,
    summary: summarizeConversations(threads, issueComments),
    sync: buildPersistedSyncMetadata(prReviewResult.rows?.[0] || null, threads, issueComments),
  };
}

async function assertThreadBelongsToReview(projectId, prReviewId, threadNodeId) {
  const normalizedThreadNodeId = nullableText(threadNodeId);
  if (!normalizedThreadNodeId) {
    throw new Error('GitHub review thread id is required.');
  }
  const result = await db.query(
    `SELECT thread_node_id
       FROM github_pr_threads
      WHERE project_id = $1
        AND pr_review_id = $2
        AND thread_node_id = $3
      LIMIT 1`,
    [projectId, prReviewId, normalizedThreadNodeId]
  );
  if (!result.rows?.[0]) {
    const error = new Error('GitHub review thread not found for this PR review.');
    error.status = 404;
    throw error;
  }
  return normalizedThreadNodeId;
}

async function assertEditableThreadComment(projectId, prReviewId, commentNodeId, userId) {
  const normalizedCommentNodeId = nullableText(commentNodeId);
  if (!normalizedCommentNodeId) {
    throw new Error('GitHub review comment id is required.');
  }
  const result = await db.query(
    `SELECT *
       FROM github_pr_thread_comments
      WHERE project_id = $1
        AND pr_review_id = $2
        AND comment_node_id = $3
      LIMIT 1`,
    [projectId, prReviewId, normalizedCommentNodeId]
  );
  const row = result.rows?.[0];
  if (!row) {
    const error = new Error('GitHub review comment not found for this PR review.');
    error.status = 404;
    throw error;
  }
  if (row.database_id == null) {
    const error = new Error('GitHub review comment is missing its REST comment id.');
    error.status = 409;
    throw error;
  }

  const authorLogin = normalizeLogin(row.author_login);
  const viewerGitHubLogins = await getViewerGitHubLogins(userId);
  if (viewerGitHubLogins.has(authorLogin)) {
    return { row, commentNodeId: normalizedCommentNodeId, authMode: 'user' };
  }
  if (ATLAS_APP_AUTHOR_LOGINS.has(authorLogin)) {
    return { row, commentNodeId: normalizedCommentNodeId, authMode: 'installation' };
  }

  const error = new Error('Only your comments and Atlas-authored comments can be edited from Atlas.');
  error.status = 403;
  throw error;
}

async function assertEditableIssueComment(projectId, prReviewId, commentNodeId, userId) {
  const normalizedCommentNodeId = nullableText(commentNodeId);
  if (!normalizedCommentNodeId) {
    throw new Error('GitHub PR comment id is required.');
  }
  const result = await db.query(
    `SELECT *
       FROM github_pr_issue_comments
      WHERE project_id = $1
        AND pr_review_id = $2
        AND comment_node_id = $3
      LIMIT 1`,
    [projectId, prReviewId, normalizedCommentNodeId]
  );
  const row = result.rows?.[0];
  if (!row) {
    const error = new Error('GitHub PR comment not found for this PR review.');
    error.status = 404;
    throw error;
  }
  if (row.database_id == null) {
    const error = new Error('GitHub PR comment is missing its REST comment id.');
    error.status = 409;
    throw error;
  }

  const authorLogin = normalizeLogin(row.author_login);
  const viewerGitHubLogins = await getViewerGitHubLogins(userId);
  if (viewerGitHubLogins.has(authorLogin)) {
    return { row, commentNodeId: normalizedCommentNodeId, authMode: 'user' };
  }
  if (ATLAS_APP_AUTHOR_LOGINS.has(authorLogin)) {
    return { row, commentNodeId: normalizedCommentNodeId, authMode: 'installation' };
  }

  const error = new Error('Only your PR comments and Atlas-authored PR comments can be edited from Atlas.');
  error.status = 403;
  throw error;
}

function summarizeConversations(threads, issueComments) {
  const openThreads = threads.filter((thread) => !thread.isResolved);
  const resolvedThreads = threads.filter((thread) => thread.isResolved);
  const outdatedThreads = threads.filter((thread) => thread.isOutdated);
  const threadCommentCount = threads.reduce((sum, thread) => (
    sum + Math.max(0, Number(thread.commentCount || thread.comments?.length || 0))
  ), 0);
  const syncedAtValues = [
    ...threads.map((thread) => thread.syncedAt),
    ...issueComments.map((comment) => comment.syncedAt),
  ].filter(Boolean);
  syncedAtValues.sort();
  return {
    totalThreads: threads.length,
    openThreads: openThreads.length,
    resolvedThreads: resolvedThreads.length,
    outdatedThreads: outdatedThreads.length,
    threadComments: threadCommentCount,
    issueComments: issueComments.length,
    syncedAt: syncedAtValues[syncedAtValues.length - 1] || null,
  };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildPersistedSyncMetadata(row, threads, issueComments) {
  if (!row) return null;
  const reviewStateCounts = parseJsonObject(row.github_review_state_counts);
  const hasStatus = Boolean(
    row.github_review_decision
    || row.github_merge_state_status
    || row.github_latest_review_state
    || Object.keys(reviewStateCounts).length > 0
    || row.github_review_status_synced_at
  );
  if (!hasStatus) return null;
  return {
    githubPrNumber: row.github_pr_number != null ? Number(row.github_pr_number) : null,
    pullRequestNodeId: null,
    reviewDecision: row.github_review_decision ?? null,
    mergeStateStatus: row.github_merge_state_status ?? null,
    latestReviewState: row.github_latest_review_state ?? null,
    latestReviewAuthor: row.github_latest_review_author ?? null,
    latestReviewSubmittedAt: row.github_latest_review_submitted_at ?? null,
    reviewStateCounts,
    threadCount: threads.length,
    issueCommentCount: issueComments.length,
    syncedAt: row.github_review_status_synced_at ?? null,
  };
}

async function updatePrReviewGitHubReviewStatus(projectId, prReviewId, reviewStatus) {
  if (!reviewStatus) return;
  await db.query(
    `UPDATE pr_reviews
        SET github_review_decision = $3,
            github_merge_state_status = $4,
            github_latest_review_state = $5,
            github_latest_review_author = $6,
            github_latest_review_submitted_at = $7,
            github_review_state_counts = $8,
            github_review_status_synced_at = $9,
            updated_at = ${nowExpr()}
      WHERE project_id = $1 AND id = $2`,
    [
      projectId,
      prReviewId,
      reviewStatus.githubReviewDecision,
      reviewStatus.githubMergeStateStatus,
      reviewStatus.githubLatestReviewState,
      reviewStatus.githubLatestReviewAuthor,
      reviewStatus.githubLatestReviewSubmittedAt,
      JSON.stringify(reviewStatus.githubReviewStateCounts || {}),
      reviewStatus.githubReviewStatusSyncedAt,
    ]
  );
}

async function syncConversations({ project, prReview, userId = null }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR conversation sync.');
  }
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  const [threadPayload, rawIssueComments, reviews] = await Promise.all([
    githubService.getPullRequestConversationThreads(
      gh.installationId,
      gh.owner,
      gh.repo,
      prReview.githubPrNumber
    ),
    githubService.getPullRequestIssueComments(
      gh.installationId,
      gh.owner,
      gh.repo,
      prReview.githubPrNumber
    ).catch(() => []),
    githubService.getPullRequestReviews(
      gh.installationId,
      gh.owner,
      gh.repo,
      prReview.githubPrNumber
    ).catch(() => []),
  ]);

  const threads = (Array.isArray(threadPayload?.threads) ? threadPayload.threads : [])
    .map((thread) => normalizeThread(thread, prReview.githubPrNumber))
    .filter(Boolean);
  const threadComments = threads.flatMap((thread) => thread.comments || []);
  const issueComments = (Array.isArray(rawIssueComments) ? rawIssueComments : [])
    .map((comment) => normalizeIssueComment(comment, prReview.githubPrNumber))
    .filter(Boolean);

  await transaction(async (client) => {
    for (const thread of threads) {
      await upsertThread(client, project.id, prReview.id, thread);
      for (const comment of thread.comments) {
        await upsertThreadComment(client, project.id, prReview.id, comment);
      }
    }
    for (const comment of issueComments) {
      await upsertIssueComment(client, project.id, prReview.id, comment);
    }

    await deleteMissingRows(
      client,
      'github_pr_thread_comments',
      'comment_node_id',
      project.id,
      prReview.id,
      threadComments.map((comment) => comment.commentNodeId)
    );
    await deleteMissingRows(
      client,
      'github_pr_threads',
      'thread_node_id',
      project.id,
      prReview.id,
      threads.map((thread) => thread.threadNodeId)
    );
    await deleteMissingRows(
      client,
      'github_pr_issue_comments',
      'comment_node_id',
      project.id,
      prReview.id,
      issueComments.map((comment) => comment.commentNodeId)
    );
  });

  const reviewStatus = buildGitHubReviewStatus(reviews, {
    reviewDecision: threadPayload?.reviewDecision,
    mergeStateStatus: threadPayload?.mergeStateStatus,
  });
  await updatePrReviewGitHubReviewStatus(project.id, prReview.id, reviewStatus);

  const conversations = await listConversations(project.id, prReview.id, { userId });
  return {
    ...conversations,
    sync: {
      githubPrNumber: prReview.githubPrNumber,
      pullRequestNodeId: threadPayload?.pullRequestNodeId || null,
      reviewDecision: reviewStatus.githubReviewDecision,
      mergeStateStatus: reviewStatus.githubMergeStateStatus,
      latestReviewState: reviewStatus.githubLatestReviewState,
      latestReviewAuthor: reviewStatus.githubLatestReviewAuthor,
      latestReviewSubmittedAt: reviewStatus.githubLatestReviewSubmittedAt,
      reviewStateCounts: reviewStatus.githubReviewStateCounts,
      threadCount: threads.length,
      issueCommentCount: issueComments.length,
      syncedAt: reviewStatus.githubReviewStatusSyncedAt || conversations.summary.syncedAt || new Date().toISOString(),
    },
  };
}

async function replyToThread({ project, prReview, userId = null, threadNodeId, body }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR conversation replies.');
  }
  const normalizedBody = normalizeString(body);
  if (!normalizedBody) {
    throw new Error('Reply body is required.');
  }
  if (normalizedBody.length > 65536) {
    throw new Error('Reply body is too long.');
  }
  const normalizedThreadNodeId = await assertThreadBelongsToReview(project.id, prReview.id, threadNodeId);
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  await githubService.addPullRequestReviewThreadReply(
    gh.installationId,
    normalizedThreadNodeId,
    normalizedBody
  );
  return syncConversations({ project, prReview, userId });
}

async function createThreadComment({ project, prReview, userId = null, path, line, side = 'RIGHT', body }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR conversation comments.');
  }
  const normalizedPath = normalizeString(path);
  const normalizedLine = Number.isFinite(Number(line)) && Number(line) > 0
    ? Math.floor(Number(line))
    : null;
  const normalizedSide = String(side || 'RIGHT').trim().toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
  const normalizedBody = normalizeString(body);
  if (!normalizedPath || !normalizedLine) {
    throw new Error('A valid file path and diff line are required.');
  }
  if (!normalizedBody) {
    throw new Error('Comment body is required.');
  }
  if (normalizedBody.length > 65536) {
    throw new Error('Comment body is too long.');
  }
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  await githubService.submitPullRequestReview(
    gh.installationId,
    gh.owner,
    gh.repo,
    prReview.githubPrNumber,
    {
      event: 'COMMENT',
      commitId: prReview.headSha || null,
      comments: [{
        path: normalizedPath,
        line: normalizedLine,
        side: normalizedSide,
        body: normalizedBody,
      }],
    }
  );
  return syncConversations({ project, prReview, userId });
}

async function setThreadResolved({ project, prReview, userId = null, threadNodeId, resolved }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR conversation status updates.');
  }
  const normalizedThreadNodeId = await assertThreadBelongsToReview(project.id, prReview.id, threadNodeId);
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  await githubService.setPullRequestReviewThreadResolved(
    gh.installationId,
    normalizedThreadNodeId,
    resolved === true
  );
  return syncConversations({ project, prReview, userId });
}

async function updateThreadComment({ project, prReview, userId = null, commentNodeId, body }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR conversation comment updates.');
  }
  const normalizedBody = normalizeString(body);
  if (!normalizedBody) {
    throw new Error('Comment body is required.');
  }
  if (normalizedBody.length > 65536) {
    throw new Error('Comment body is too long.');
  }

  const { row, authMode } = await assertEditableThreadComment(project.id, prReview.id, commentNodeId, userId);
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  await githubService.updatePullRequestReviewComment(
    gh.installationId,
    gh.owner,
    gh.repo,
    row.database_id,
    normalizedBody,
    { authMode }
  );
  return syncConversations({ project, prReview, userId });
}

async function deleteThreadComment({ project, prReview, userId = null, commentNodeId }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR conversation comment deletes.');
  }

  const { row, authMode } = await assertEditableThreadComment(project.id, prReview.id, commentNodeId, userId);
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  await githubService.deletePullRequestReviewComment(
    gh.installationId,
    gh.owner,
    gh.repo,
    row.database_id,
    { authMode }
  );
  return syncConversations({ project, prReview, userId });
}

async function addIssueComment({ project, prReview, userId = null, body }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR comments.');
  }
  const normalizedBody = normalizeString(body);
  if (!normalizedBody) {
    throw new Error('Comment body is required.');
  }
  if (normalizedBody.length > 65536) {
    throw new Error('Comment body is too long.');
  }
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  await githubService.addPullRequestIssueComment(
    gh.installationId,
    gh.owner,
    gh.repo,
    prReview.githubPrNumber,
    normalizedBody
  );
  return syncConversations({ project, prReview, userId });
}

async function updateIssueComment({ project, prReview, userId = null, commentNodeId, body }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR comment updates.');
  }
  const normalizedBody = normalizeString(body);
  if (!normalizedBody) {
    throw new Error('Comment body is required.');
  }
  if (normalizedBody.length > 65536) {
    throw new Error('Comment body is too long.');
  }

  const { row, authMode } = await assertEditableIssueComment(project.id, prReview.id, commentNodeId, userId);
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  await githubService.updatePullRequestIssueComment(
    gh.installationId,
    gh.owner,
    gh.repo,
    row.database_id,
    normalizedBody,
    { authMode }
  );
  return syncConversations({ project, prReview, userId });
}

async function deleteIssueComment({ project, prReview, userId = null, commentNodeId }) {
  if (!project?.id || !prReview?.id || !prReview?.githubPrNumber) {
    throw new Error('Project and PR review are required for PR comment deletes.');
  }

  const { row, authMode } = await assertEditableIssueComment(project.id, prReview.id, commentNodeId, userId);
  const gh = await resolveGitHubMeta(project, userId || project.user_id || ANONYMOUS_USER_ID);
  if (!gh) {
    throw new Error('Project is not connected to GitHub');
  }

  await githubService.deletePullRequestIssueComment(
    gh.installationId,
    gh.owner,
    gh.repo,
    row.database_id,
    { authMode }
  );
  return syncConversations({ project, prReview, userId });
}

const prReviewConversationService = {
  listConversations,
  syncConversations,
  replyToThread,
  createThreadComment,
  setThreadResolved,
  updateThreadComment,
  deleteThreadComment,
  addIssueComment,
  updateIssueComment,
  deleteIssueComment,
  __testing: {
    normalizeThread,
    normalizeThreadComment,
    normalizeIssueComment,
    summarizeConversations,
  },
};

export default prReviewConversationService;
