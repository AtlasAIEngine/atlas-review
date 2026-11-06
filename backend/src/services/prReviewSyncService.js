import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import db from '../db/connection.js';
import prReviewService from './prReviewService.js';
import githubService from './githubService.js';

const execFileAsync = promisify(execFile);
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDate(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeReviewState(value) {
  const normalized = normalizeString(value).toUpperCase();
  return normalized || null;
}

export function buildGitHubReviewStatus(reviews = [], options = {}) {
  const latestByReviewer = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const state = normalizeReviewState(review?.state);
    if (!state || state === 'PENDING') continue;
    const authorLogin = normalizeString(review?.user?.login || review?.author?.login) || 'github';
    const submittedAt = normalizeDate(review?.submitted_at || review?.submittedAt);
    const fallbackSortTime = normalizeDate(review?.updated_at || review?.created_at || review?.updatedAt || review?.createdAt);
    const sortTime = Date.parse(submittedAt || fallbackSortTime || '') || 0;
    const previous = latestByReviewer.get(authorLogin);
    if (!previous || sortTime >= previous.sortTime) {
      latestByReviewer.set(authorLogin, {
        state,
        authorLogin,
        submittedAt,
        sortTime,
      });
    }
  }

  const latestReviews = Array.from(latestByReviewer.values()).sort((left, right) => right.sortTime - left.sortTime);
  const stateCounts = latestReviews.reduce((acc, review) => {
    acc[review.state] = (acc[review.state] || 0) + 1;
    return acc;
  }, {});
  const latestReview = latestReviews[0] || null;

  return {
    githubReviewDecision: normalizeReviewState(options.reviewDecision),
    githubMergeStateStatus: normalizeReviewState(options.mergeStateStatus),
    githubLatestReviewState: latestReview?.state || null,
    githubLatestReviewAuthor: latestReview?.authorLogin || null,
    githubLatestReviewSubmittedAt: latestReview?.submittedAt || null,
    githubReviewStateCounts: stateCounts,
    githubReviewStatusSyncedAt: new Date().toISOString(),
  };
}

async function resolvePreferredConnectedLogin(userId, installationId = null) {
  const effectiveUserId = normalizeString(userId);
  if (!effectiveUserId) return null;

  try {
    const result = await db.query(
      `SELECT installation_id, account_login, account_type
       FROM github_integrations
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC`,
      [effectiveUserId]
    );
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (!rows.length) return null;

    const normalizedInstallationId = Number(installationId);
    const matchingUserRow = rows.find((row) => (
      String(row?.account_type || '').toLowerCase() === 'user'
      && Number(row?.installation_id) === normalizedInstallationId
    ));
    if (matchingUserRow) return normalizeString(matchingUserRow.account_login) || null;

    const preferredUserRow = rows.find((row) => String(row?.account_type || '').toLowerCase() === 'user');
    if (preferredUserRow) return normalizeString(preferredUserRow.account_login) || null;

    const matchingInstallationRow = rows.find((row) => Number(row?.installation_id) === normalizedInstallationId);
    if (matchingInstallationRow) return normalizeString(matchingInstallationRow.account_login) || null;

    return normalizeString(rows[0]?.account_login) || null;
  } catch {
    return null;
  }
}

function getGitHubDocumentationUrl(error) {
  const direct = normalizeString(error?.documentation_url);
  if (direct) return direct;
  const nested = normalizeString(error?.response?.data?.documentation_url);
  return nested || '';
}

function isGitHubRepoAccessDenied(error) {
  if (!error) return false;
  const status = Number(error?.status || error?.statusCode || 0);
  const message = normalizeString(error?.message).toLowerCase();
  const documentationUrl = getGitHubDocumentationUrl(error).toLowerCase();

  if (status === 404) {
    return documentationUrl.includes('docs.github.com/rest/pulls/pulls')
      || message.includes('docs.github.com/rest/pulls/pulls')
      || message.includes('list-pull-requests');
  }
  if (status === 403 && message.includes('resource not accessible')) return true;
  if (status === 403 && documentationUrl.includes('docs.github.com/rest/pulls/pulls')) return true;
  return false;
}

function buildGitHubRepoAccessDeniedError(githubMeta, error) {
  const repoLabel = githubMeta?.owner && githubMeta?.repo
    ? `${githubMeta.owner}/${githubMeta.repo}`
    : 'this repository';
  const login = normalizeString(githubMeta?.connectedLogin);
  const connectedAccountText = login ? ` (${login})` : '';
  const friendlyError = new Error(
    `The connected GitHub account${connectedAccountText} cannot access pull requests for ${repoLabel}. Reconnect GitHub with an account that has repo access, or grant the Atlas GitHub App access to this repository.`
  );
  friendlyError.code = 'GITHUB_REPO_ACCESS_DENIED';
  friendlyError.statusCode = 403;
  friendlyError.owner = githubMeta?.owner || null;
  friendlyError.repo = githubMeta?.repo || null;
  friendlyError.connectedLogin = login || null;
  friendlyError.cause = error;
  return friendlyError;
}

function normalizeGitHubPrSyncError(error, githubMeta) {
  if (isGitHubRepoAccessDenied(error)) {
    return buildGitHubRepoAccessDeniedError(githubMeta, error);
  }
  return error;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function parseAccessibleRepositories(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeString(entry)).filter(Boolean);
  }
  const normalized = normalizeString(value);
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed)
      ? parsed.map((entry) => normalizeString(entry)).filter(Boolean)
      : null;
  } catch {
    return null;
  }
}

function repositoryListContains(accessibleRepos, repoFullName) {
  return Array.isArray(accessibleRepos)
    && accessibleRepos.some((entry) => normalizeString(entry).toLowerCase() === repoFullName);
}

function selectInstallationForRepo(rows, { installationId, owner, repo }) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const normalizedInstallationId = Number(installationId);
  const ownerLower = normalizeString(owner).toLowerCase();
  const repoFullName = `${ownerLower}/${normalizeString(repo).toLowerCase()}`;

  const currentRow = normalizedRows.find((row) => Number(row?.installation_id) === normalizedInstallationId) || null;
  const repoMatchRow = normalizedRows.find((row) => (
    repositoryListContains(parseAccessibleRepositories(row?.repositories_accessible), repoFullName)
  )) || null;
  if (repoMatchRow) return repoMatchRow;

  const ownerMatchRow = normalizedRows.find((row) => (
    normalizeString(row?.account_login).toLowerCase() === ownerLower
  )) || null;
  if (ownerMatchRow) {
    const currentRepos = parseAccessibleRepositories(currentRow?.repositories_accessible);
    const currentKnownMissing = Array.isArray(currentRepos)
      && currentRepos.length > 0
      && !repositoryListContains(currentRepos, repoFullName);
    const currentOwnerMatches = normalizeString(currentRow?.account_login).toLowerCase() === ownerLower;
    if (!currentRow || currentKnownMissing || !currentOwnerMatches) {
      return ownerMatchRow;
    }
  }

  return currentRow;
}

function buildReviewerParticipants(reviews) {
  return Array.from(new Set(
    (Array.isArray(reviews) ? reviews : [])
      .map((review) => String(review?.user?.login || '').trim())
      .filter(Boolean)
  ));
}

function normalizePrState(value, draft = false) {
  const normalized = normalizeString(value).toLowerCase();
  // Closed/merged take precedence over draft: a draft that was closed is closed.
  if (normalized === 'closed' || normalized === 'merged') return normalized;
  if (draft || normalized === 'draft') return 'draft';
  return 'open';
}

function listEqual(left, right) {
  const leftNormalized = normalizeStringArray(left).sort();
  const rightNormalized = normalizeStringArray(right).sort();
  if (leftNormalized.length !== rightNormalized.length) return false;
  return leftNormalized.every((value, index) => value === rightNormalized[index]);
}

function hasMetadataChanged(previous, next) {
  if (!previous) return true;
  return (
    previous.title !== next.title
    || (previous.body || null) !== (next.body || null)
    || previous.state !== next.state
    || previous.headBranch !== next.headBranch
    || previous.baseBranch !== next.baseBranch
    || (previous.headSha || null) !== (next.headSha || null)
    || (previous.baseSha || null) !== (next.baseSha || null)
    || Number(previous.fileCount || 0) !== Number(next.fileCount || 0)
    || Number(previous.totalAdditions || 0) !== Number(next.totalAdditions || 0)
    || Number(previous.totalDeletions || 0) !== Number(next.totalDeletions || 0)
    || Number(previous.commitCount || 0) !== Number(next.commitCount || 0)
    || Number(previous.githubCommentCount || 0) !== Number(next.githubCommentCount || 0)
    || Number(previous.githubReviewCommentCount || 0) !== Number(next.githubReviewCommentCount || 0)
    || (previous.githubReviewDecision || null) !== (next.githubReviewDecision || null)
    || (previous.githubMergeStateStatus || null) !== (next.githubMergeStateStatus || null)
    || (previous.githubLatestReviewState || null) !== (next.githubLatestReviewState || null)
    || (previous.githubLatestReviewAuthor || null) !== (next.githubLatestReviewAuthor || null)
    || (previous.githubLatestReviewSubmittedAt || null) !== (next.githubLatestReviewSubmittedAt || null)
    || (previous.githubUpdatedAt || null) !== (next.githubUpdatedAt || null)
    || (previous.authorLogin || null) !== (next.authorLogin || null)
    || (previous.authorAvatarUrl || null) !== (next.authorAvatarUrl || null)
    || (previous.htmlUrl || null) !== (next.htmlUrl || null)
    || !listEqual(previous.assignees, next.assignees)
    || !listEqual(previous.requestedReviewers, next.requestedReviewers)
    || !listEqual(previous.reviewerParticipants, next.reviewerParticipants)
  );
}

export function buildPrReviewUpsertPayload(projectId, pr) {
  return {
    projectId,
    githubPrNumber: pr.number,
    title: pr.title,
    body: pr.body,
    authorLogin: pr.user?.login || null,
    authorAvatarUrl: pr.user?.avatar_url || null,
    assignees: Array.isArray(pr.assignees)
      ? pr.assignees.map((entry) => (typeof entry === 'string' ? entry : entry?.login)).filter(Boolean)
      : [],
    requestedReviewers: Array.isArray(pr.requested_reviewers)
      ? pr.requested_reviewers.map((entry) => (typeof entry === 'string' ? entry : entry?.login)).filter(Boolean)
      : [],
    reviewerParticipants: Array.isArray(pr.reviewer_participants)
      ? pr.reviewer_participants.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [],
    state: normalizePrState(pr.state, pr?.draft === true),
    headBranch: pr.head?.ref,
    baseBranch: pr.base?.ref,
    headSha: pr.head?.sha,
    baseSha: pr.base?.sha,
    fileCount: pr.changed_files || 0,
    totalAdditions: pr.additions || 0,
    totalDeletions: pr.deletions || 0,
    commitCount: pr.commits || 0,
    githubCommentCount: normalizeCount(pr.comments),
    githubReviewCommentCount: normalizeCount(pr.review_comments),
    githubReviewDecision: pr.github_review_decision || null,
    githubMergeStateStatus: pr.github_merge_state_status || null,
    githubLatestReviewState: pr.github_latest_review_state || null,
    githubLatestReviewAuthor: pr.github_latest_review_author || null,
    githubLatestReviewSubmittedAt: pr.github_latest_review_submitted_at || null,
    githubReviewStateCounts: pr.github_review_state_counts || {},
    githubReviewStatusSyncedAt: pr.github_review_status_synced_at || null,
    githubUpdatedAt: pr.updated_at || null,
    labels: [],
    htmlUrl: pr.html_url,
  };
}

export async function resolveGitHubMeta(project, userId = null) {
  if (!project) return null;

  if (project.github_installation_id && project.github_repo_owner && project.github_repo_name) {
    const effectiveUserId = userId || project.user_id || ANONYMOUS_USER_ID;
    let selectedInstallation = null;
    try {
      const integrationResult = await db.query(
        `SELECT installation_id, account_login, account_type, repositories_accessible
         FROM github_integrations
         WHERE user_id = $1 AND is_active = TRUE
         ORDER BY created_at DESC`,
        [effectiveUserId]
      );
      selectedInstallation = selectInstallationForRepo(integrationResult.rows, {
        installationId: project.github_installation_id,
        owner: project.github_repo_owner,
        repo: project.github_repo_name,
      });
    } catch {
      selectedInstallation = null;
    }
    const installationId = selectedInstallation?.installation_id || project.github_installation_id;
    let connectedLogin = normalizeString(selectedInstallation?.account_login) || null;
    if (!connectedLogin) {
      connectedLogin = await resolvePreferredConnectedLogin(effectiveUserId, installationId);
    }

    return {
      installationId,
      owner: project.github_repo_owner,
      repo: project.github_repo_name,
      connectedLogin,
    };
  }

  if (!project.path) return null;

  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: project.path });
    const match = stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) return null;

    const remoteOwner = normalizeString(match[1]);
    const remoteRepo = normalizeString(match[2]);
    if (!remoteOwner || !remoteRepo) return null;

    const effectiveUserId = userId || project.user_id || ANONYMOUS_USER_ID;
    const result = await db.query(
      `SELECT installation_id, account_login, account_type, repositories_accessible
         FROM github_integrations
        WHERE user_id = $1 AND is_active = TRUE
        ORDER BY created_at DESC`,
      [effectiveUserId]
    );

    const remoteFullName = `${remoteOwner}/${remoteRepo}`.toLowerCase();
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const matchingRow = rows.find((row) => {
      const accessibleRepos = parseAccessibleRepositories(row?.repositories_accessible);
      return Array.isArray(accessibleRepos)
        && accessibleRepos.some((repoFullName) => repoFullName.toLowerCase() === remoteFullName);
    });

    if (!matchingRow) {
      const unknownRows = rows.filter((row) => parseAccessibleRepositories(row?.repositories_accessible) === null);
      if (unknownRows.length === 0) {
        const ownerMatchRow = rows.find((row) => normalizeString(row?.account_login).toLowerCase() === remoteOwner.toLowerCase());
        const preferredUserRow = rows.find((row) => normalizeString(row?.account_type).toLowerCase() === 'user');
        const fallbackRow = ownerMatchRow || preferredUserRow || rows[0] || null;
        if (!fallbackRow) return null;
        return {
          installationId: fallbackRow.installation_id,
          owner: remoteOwner,
          repo: remoteRepo,
          connectedLogin: normalizeString(fallbackRow.account_login) || null,
        };
      }
      const ownerMatch = unknownRows.find((row) => normalizeString(row?.account_login).toLowerCase() === remoteOwner.toLowerCase());
      const preferredUserRow = unknownRows.find((row) => normalizeString(row?.account_type).toLowerCase() === 'user');
      const fallbackRow = ownerMatch || preferredUserRow || unknownRows[0] || null;
      if (!fallbackRow) return null;
      return {
        installationId: fallbackRow.installation_id,
        owner: remoteOwner,
        repo: remoteRepo,
        connectedLogin: normalizeString(fallbackRow.account_login) || null,
      };
    }

    return {
      installationId: matchingRow.installation_id,
      owner: remoteOwner,
      repo: remoteRepo,
      connectedLogin: normalizeString(matchingRow.account_login) || null,
    };
  } catch {
    return null;
  }

  return null;
}

class PrReviewSyncService extends EventEmitter {
  async syncProject(project, options = {}) {
    const source = normalizeString(options.source) || 'manual';
    const projectId = project?.id || null;
    const userId = options.userId || project?.user_id || ANONYMOUS_USER_ID;
    let githubMeta = null;
    if (!projectId) {
      throw new Error('Project is required');
    }

    try {
      githubMeta = await resolveGitHubMeta(project, userId);
      if (!githubMeta) {
        throw new Error('Project is not connected to GitHub');
      }

      this.emit('sync-started', {
        projectId,
        source,
        startedAt: new Date().toISOString(),
      });

      const existingReviews = await prReviewService.getByProject(projectId);
      const existingByNumber = new Map(existingReviews.map((review) => [review.githubPrNumber, review]));
      const [openPulls, recentlyClosedPulls] = await Promise.all([
        githubService.listPullRequests(
          githubMeta.installationId,
          githubMeta.owner,
          githubMeta.repo,
          { state: 'open' }
        ),
        githubService.listPullRequests(
          githubMeta.installationId,
          githubMeta.owner,
          githubMeta.repo,
          { state: 'closed', sort: 'updated', direction: 'desc', maxResults: 20 }
        ),
      ]);

      const pulls = [
        ...(Array.isArray(openPulls) ? openPulls : []),
        ...(Array.isArray(recentlyClosedPulls) ? recentlyClosedPulls : []),
      ];

      const deltas = [];
      let synced = 0;

      for (const pr of pulls) {
        const previous = existingByNumber.get(pr.number) || null;
        const upserted = await prReviewService.upsert(buildPrReviewUpsertPayload(projectId, pr));
        synced += 1;
        const deltaType = previous ? (hasMetadataChanged(previous, upserted) ? 'updated' : 'unchanged') : 'created';
        if (deltaType !== 'unchanged') {
          deltas.push({ type: deltaType, prReview: upserted });
        }
        existingByNumber.delete(pr.number);
      }

      for (const review of existingByNumber.values()) {
        const state = String(review.state || '').toLowerCase();
        if (state === 'closed' || state === 'merged') continue;
        const closedReview = await prReviewService.updateReview(review.id, { state: 'closed' }) || {
          ...review,
          state: 'closed',
        };
        deltas.push({ type: 'closed', prReview: closedReview });
      }

      const completedAt = new Date().toISOString();
      // Persist the sync timestamp on the project row so the UI can show
      // the actual last-sync time across reloads, and so a fresh page load
      // doesn't read "0m ago" just because nothing client-side remembered.
      try {
        await db.query(
          'UPDATE projects SET last_pr_synced_at = $1 WHERE id = $2',
          [completedAt, projectId]
        );
      } catch (persistError) {
        console.warn('[prReviewSyncService] failed to persist last_pr_synced_at:', persistError?.message || persistError);
      }
      const prReviews = await prReviewService.getByProject(projectId);
      const completedPayload = {
        projectId,
        source,
        synced,
        deltas,
        prReviews,
        completedAt,
      };
      this.emit('sync-completed', completedPayload);
      return completedPayload;
    } catch (error) {
      const normalizedError = normalizeGitHubPrSyncError(error, githubMeta);
      const failedPayload = {
        projectId,
        source,
        error: normalizedError?.message || 'Failed to sync PRs from GitHub',
        code: normalizedError?.code || null,
        owner: normalizedError?.owner || githubMeta?.owner || null,
        repo: normalizedError?.repo || githubMeta?.repo || null,
        connectedLogin: normalizedError?.connectedLogin || githubMeta?.connectedLogin || null,
        failedAt: new Date().toISOString(),
      };
      this.emit('sync-failed', failedPayload);
      throw normalizedError;
    }
  }

  async refreshPrReview(project, prReview, options = {}) {
    const projectId = project?.id || null;
    const userId = options.userId || project?.user_id || ANONYMOUS_USER_ID;
    const source = normalizeString(options.source) || 'refresh';
    let githubMeta = null;
    if (!projectId || !prReview?.githubPrNumber) {
      throw new Error('Project and PR review are required');
    }

    try {
      githubMeta = await resolveGitHubMeta(project, userId);
      if (!githubMeta) {
        throw new Error('Project is not connected to GitHub');
      }
      this.emit('sync-started', {
        projectId,
        source,
        startedAt: new Date().toISOString(),
      });

      const [detail, reviews] = await Promise.all([
        githubService.getPullRequestDetail(
          githubMeta.installationId,
          githubMeta.owner,
          githubMeta.repo,
          prReview.githubPrNumber
        ),
        githubService.getPullRequestReviews(
          githubMeta.installationId,
          githubMeta.owner,
          githubMeta.repo,
          prReview.githubPrNumber
        ).catch(() => []),
      ]);
      const reviewStatus = buildGitHubReviewStatus(reviews);
      const refreshed = await prReviewService.upsert(buildPrReviewUpsertPayload(projectId, {
        ...detail,
        reviewer_participants: buildReviewerParticipants(reviews),
        github_review_decision: reviewStatus.githubReviewDecision,
        github_merge_state_status: reviewStatus.githubMergeStateStatus,
        github_latest_review_state: reviewStatus.githubLatestReviewState,
        github_latest_review_author: reviewStatus.githubLatestReviewAuthor,
        github_latest_review_submitted_at: reviewStatus.githubLatestReviewSubmittedAt,
        github_review_state_counts: reviewStatus.githubReviewStateCounts,
        github_review_status_synced_at: reviewStatus.githubReviewStatusSyncedAt,
      }));
      const deltaType = hasMetadataChanged(prReview, refreshed) ? 'updated' : 'refreshed';
      this.emit('sync-completed', {
        projectId,
        source,
        synced: 1,
        deltas: [{ type: deltaType, prReview: refreshed }],
        prReviews: null,
        completedAt: new Date().toISOString(),
      });
      return { prReview: refreshed, deltaType };
    } catch (error) {
      const normalizedError = normalizeGitHubPrSyncError(error, githubMeta);
      this.emit('sync-failed', {
        projectId,
        source,
        error: normalizedError?.message || 'Failed to refresh pull request',
        code: normalizedError?.code || null,
        owner: normalizedError?.owner || githubMeta?.owner || null,
        repo: normalizedError?.repo || githubMeta?.repo || null,
        connectedLogin: normalizedError?.connectedLogin || githubMeta?.connectedLogin || null,
        failedAt: new Date().toISOString(),
      });
      throw normalizedError;
    }
  }
}

const prReviewSyncService = new PrReviewSyncService();

export default prReviewSyncService;
