import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AtlasConfig } from './config.js';
import { AtlasMcpError } from './errors.js';
import type { BranchReviewSummary, WorkspaceReviewSummary, PrReviewSummary, ProjectSummary } from './types.js';
import type { AtlasApiClient } from './client.js';

const execFileAsync = promisify(execFile);
const PROJECT_CACHE_TTL_MS = 60_000;
const PROJECT_CACHE_MAX_SIZE = 200;

interface ProjectCacheEntry {
  project: ProjectSummary;
  cachedAt: number;
}

const projectCache = new Map<string, ProjectCacheEntry>();

function getCachedProject(gitRoot: string, now: number = Date.now()): ProjectSummary | null {
  const cached = projectCache.get(gitRoot);
  if (!cached) return null;
  if (now - cached.cachedAt > PROJECT_CACHE_TTL_MS) {
    projectCache.delete(gitRoot);
    return null;
  }
  return cached.project;
}

function setCachedProject(gitRoot: string, project: ProjectSummary, now: number = Date.now()): void {
  pruneExpiredCache(now);
  if (projectCache.has(gitRoot)) {
    projectCache.delete(gitRoot);
  }
  if (projectCache.size >= PROJECT_CACHE_MAX_SIZE) {
    const oldestKey = projectCache.keys().next().value;
    if (typeof oldestKey === 'string') {
      projectCache.delete(oldestKey);
    }
  }
  projectCache.set(gitRoot, { project, cachedAt: now });
}

function pruneExpiredCache(now: number): void {
  for (const [key, entry] of projectCache.entries()) {
    if (now - entry.cachedAt > PROJECT_CACHE_TTL_MS) {
      projectCache.delete(key);
    }
  }
}

export interface ResolvedProjectContext {
  cwd: string;
  gitRoot: string;
  project: ProjectSummary;
}

function normalizePath(filePath: string | null | undefined): string {
  if (!filePath) return '';
  return path.resolve(filePath);
}

function asDateValue(value: string | undefined | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function resolveGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    const gitRoot = stdout.trim();
    if (!gitRoot) {
      throw new Error('git root was empty');
    }
    return normalizePath(gitRoot);
  } catch (error) {
    throw new AtlasMcpError(
      'PROJECT_NOT_FOUND',
      'Current working directory is not inside a git repository. Run Atlas MCP tools inside a git repo.',
      { details: error }
    );
  }
}

/**
 * Resolve the main repository root when `cwd` is inside a git worktree.
 *
 * Returns the main repo's working tree path (the parent of the common `.git` dir).
 * Returns null when not in a worktree, when the repo is bare, or when the
 * common dir has an unexpected layout.
 */
export async function resolveMainRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', cwd,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const commonDir = stdout.trim();
    if (!commonDir) return null;
    const normalizedCommonDir = normalizePath(commonDir);
    if (path.basename(normalizedCommonDir) !== '.git') {
      // Bare repo or non-standard layout — no implicit main working tree.
      return null;
    }
    return path.dirname(normalizedCommonDir);
  } catch {
    return null;
  }
}

export async function resolveProjectContext(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string = process.cwd()
): Promise<ResolvedProjectContext> {
  const gitRoot = await resolveGitRoot(cwd);
  const now = Date.now();

  const cached = getCachedProject(gitRoot, now);
  if (cached) {
    return { cwd, gitRoot, project: cached };
  }

  const mainRepoRoot = await resolveMainRepoRoot(cwd);
  const isWorktree = mainRepoRoot !== null && mainRepoRoot !== gitRoot;
  const lookupPaths = isWorktree ? [gitRoot, mainRepoRoot!] : [gitRoot];

  const projects = await client.getProjects();

  for (const lookupPath of lookupPaths) {
    const foundProject = projects.find((project) => normalizePath(project.path) === lookupPath);
    if (foundProject) {
      setCachedProject(gitRoot, foundProject, now);
      return { cwd, gitRoot, project: foundProject };
    }
  }

  if (config.autoImport) {
    // Import the main repo root when in a worktree so we don't register the
    // worktree as a duplicate project.
    const importPath = mainRepoRoot || gitRoot;
    const imported = await client.openLocal(importPath);
    if (imported) {
      setCachedProject(gitRoot, imported, now);
      return { cwd, gitRoot, project: imported };
    }
  }

  const reportedPath = mainRepoRoot && mainRepoRoot !== gitRoot
    ? `${gitRoot} (worktree of ${mainRepoRoot})`
    : gitRoot;
  throw new AtlasMcpError(
    'PROJECT_NOT_FOUND',
    `No Atlas project mapped to ${reportedPath}. Import it via Atlas UI or set ATLAS_AUTO_IMPORT=true.`,
    { details: { gitRoot, mainRepoRoot } }
  );
}

export interface BranchReviewResolveOptions {
  branchReviewId?: string;
  displayId?: string;
  requireReview?: boolean;
}

export interface WorkspaceReviewResolveOptions {
  workspaceReviewId?: string;
  requireReview?: boolean;
}

export interface PrReviewResolveOptions {
  prReviewId?: string;
  githubPrNumber?: number | string;
  requireReview?: boolean;
  gitRoot?: string;
  branchName?: string;
}

export function selectBranchReview(
  reviews: BranchReviewSummary[],
  options: BranchReviewResolveOptions = {}
): BranchReviewSummary | null {
  const reviewList = Array.isArray(reviews) ? reviews : [];
  if (reviewList.length === 0) return null;

  if (options.branchReviewId) {
    const byId = reviewList.find((review) => review.id === options.branchReviewId);
    if (!byId) {
      throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `Branch review ${options.branchReviewId} not found.`);
    }
    return byId;
  }

  if (options.displayId) {
    const byDisplayId = reviewList.find((review) => review.displayId === options.displayId);
    if (!byDisplayId) {
      throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `Branch review ${options.displayId} not found.`);
    }
    return byDisplayId;
  }

  const activeCurrent = reviewList.find((review) => review.status === 'active' && review.isCurrent === true);
  if (activeCurrent) return activeCurrent;

  const active = reviewList.find((review) => review.status === 'active');
  if (active) return active;

  return [...reviewList].sort((a, b) => {
    const aTimestamp = Math.max(asDateValue(a.updatedAt), asDateValue(a.createdAt));
    const bTimestamp = Math.max(asDateValue(b.updatedAt), asDateValue(b.createdAt));
    return bTimestamp - aTimestamp;
  })[0] || null;
}

export async function resolveBranchReviewContext(
  client: AtlasApiClient,
  project: ProjectSummary,
  options: BranchReviewResolveOptions = {}
): Promise<BranchReviewSummary | null> {
  const reviews = await client.listBranchReviews(project.id);
  const selected = selectBranchReview(reviews, options);

  if (!selected && options.requireReview) {
    throw new AtlasMcpError(
      'BRANCH_REVIEW_NOT_FOUND',
      `No branch reviews found for project ${project.id}. Create one in Atlas before running this tool.`,
      { details: { projectId: project.id } }
    );
  }

  return selected;
}

export async function resolveWorkspaceReviewContext(
  client: AtlasApiClient,
  project: ProjectSummary,
  options: WorkspaceReviewResolveOptions = {}
): Promise<WorkspaceReviewSummary | null> {
  if (typeof (client as { listWorkspaceReviews?: unknown }).listWorkspaceReviews !== 'function') {
    if (options.requireReview) {
      throw new AtlasMcpError(
        'BRANCH_REVIEW_NOT_FOUND',
        `No workspace review found for project ${project.id}. Create or refresh a workspace review first.`,
        { details: { projectId: project.id } }
      );
    }
    return null;
  }

  const reviews = await client.listWorkspaceReviews(project.id);
  const reviewList = Array.isArray(reviews) ? reviews : [];
  if (!reviewList.length) {
    if (options.requireReview) {
      throw new AtlasMcpError(
        'BRANCH_REVIEW_NOT_FOUND',
        `No workspace review found for project ${project.id}. Create or refresh a workspace review first.`,
        { details: { projectId: project.id } }
      );
    }
    return null;
  }

  const requestedId = typeof options.workspaceReviewId === 'string' ? options.workspaceReviewId.trim() : '';
  if (requestedId) {
    const byId = reviewList.find((review) => review.id === requestedId);
    if (!byId) {
      throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `Workspace review ${requestedId} not found.`);
    }
    return byId;
  }

  return reviewList[0] || null;
}

export async function resolveCurrentBranchName(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branchName = stdout.trim();
    if (!branchName || branchName === 'HEAD') return null;
    return branchName;
  } catch {
    return null;
  }
}

export async function resolvePrReviewContext(
  client: AtlasApiClient,
  project: ProjectSummary,
  options: PrReviewResolveOptions = {}
): Promise<PrReviewSummary | null> {
  const reviews = await client.listPrReviews(project.id);
  const reviewList = Array.isArray(reviews) ? reviews : [];
  if (!reviewList.length) {
    if (options.requireReview) {
      throw new AtlasMcpError(
        'PR_REVIEW_NOT_FOUND',
        `No PR reviews found for project ${project.id}. Sync PR reviews in Atlas before running this tool.`,
        { details: { projectId: project.id } }
      );
    }
    return null;
  }

  const normalizedPrReviewId = typeof options.prReviewId === 'string' ? options.prReviewId.trim() : '';
  if (normalizedPrReviewId) {
    const byId = reviewList.find((review) => review.id === normalizedPrReviewId);
    if (!byId) {
      throw new AtlasMcpError('PR_REVIEW_NOT_FOUND', `PR review ${normalizedPrReviewId} not found.`);
    }
    return byId;
  }

  const parsedPrNumber = normalizePrNumber(options.githubPrNumber);
  if (parsedPrNumber != null) {
    const byNumber = reviewList.find((review) => Number(review.githubPrNumber) === parsedPrNumber);
    if (!byNumber) {
      throw new AtlasMcpError('PR_REVIEW_NOT_FOUND', `PR review #${parsedPrNumber} not found.`);
    }
    return byNumber;
  }

  const branchName = normalizeBranchName(options.branchName)
    || (options.gitRoot ? await resolveCurrentBranchName(options.gitRoot) : null);
  if (branchName) {
    const matching = reviewList.filter((review) => normalizeBranchName(review.headBranch) === branchName);
    if (matching.length === 1) return matching[0];
    if (matching.length > 1) {
      throw new AtlasMcpError(
        'INVALID_INPUT',
        `Multiple PR reviews match current branch ${branchName}. Provide prReviewId or githubPrNumber explicitly.`,
        {
          details: {
            branchName,
            matches: matching.map((review) => review.id),
          },
        }
      );
    }
  }

  if (options.requireReview) {
    throw new AtlasMcpError(
      'INVALID_INPUT',
      'PR review scope requires prReviewId or githubPrNumber unless the current branch maps to exactly one PR review.',
      { details: { projectId: project.id, branchName } }
    );
  }

  return null;
}

function normalizePrNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AtlasMcpError('INVALID_INPUT', `githubPrNumber must be a positive number. Received: ${String(value)}`);
  }
  return parsed;
}

function normalizeBranchName(value: string | null | undefined): string {
  return String(value || '').trim();
}
