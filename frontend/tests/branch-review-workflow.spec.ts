import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const UI_BASE_URL = process.env.PW_BASE_URL || 'http://127.0.0.1:5176';
const API_BASE_URL = process.env.PW_API_BASE_URL || 'http://127.0.0.1:3217/api';

const API_TIMEOUT_MS = 20_000;
const WAIT_TIMEOUT_MS = 60_000;

type LegacyReviewStatus = 'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed';
type ReviewLifecycleStatus = 'queued' | 'running' | 'retrying' | 'partial' | 'failed' | 'completed';
type ReviewStatus = LegacyReviewStatus | ReviewLifecycleStatus;
type ReviewActionEligibility = {
  canApprove: boolean;
  canRequestChanges: boolean;
  blockedReason: string | null;
  staleReason: string | null;
};

const LEGACY_REVIEW_STATUS_TO_LIFECYCLE: Record<LegacyReviewStatus, ReviewLifecycleStatus> = {
  none: 'completed',
  queued: 'queued',
  reviewing: 'running',
  reviewed: 'completed',
  failed: 'failed',
};
const ACTIVE_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['queued', 'running', 'retrying']);
const TERMINAL_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['partial', 'failed', 'completed']);

function normalizeLifecycleStatus(
  value: unknown,
  fallback: ReviewLifecycleStatus = 'queued'
): ReviewLifecycleStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'queued'
    || normalized === 'running'
    || normalized === 'retrying'
    || normalized === 'partial'
    || normalized === 'failed'
    || normalized === 'completed'
  ) {
    return normalized;
  }
  if (
    normalized === 'none'
    || normalized === 'reviewing'
    || normalized === 'reviewed'
  ) {
    return LEGACY_REVIEW_STATUS_TO_LIFECYCLE[normalized];
  }
  return fallback;
}

type BranchReview = {
  id: string;
  branchName: string;
  baseBranch: string;
  status?: 'active' | 'merged' | 'closed' | 'stale' | string;
  headSha: string;
  mergeBaseSha: string | null;
  reviewBaseBranch?: string | null;
  reviewMergeBaseSha?: string | null;
  reviewHeadSha?: string | null;
  reviewedAt?: string | null;
  fileCount: number;
  commitCount: number;
  isCurrent: boolean;
  reviewStatus: ReviewStatus;
  reviewActionEligibility?: ReviewActionEligibility | null;
  reviewLifecycle?: {
    status: ReviewLifecycleStatus;
    phase: string;
    isActive: boolean;
    isTerminal: boolean;
    canRetry: boolean;
    error?: string | null;
    updatedAt?: string | null;
    reviewedAt?: string | null;
    hasProgress?: boolean;
    sourceStatus?: string | null;
  } | null;
};

function inferFallbackActionEligibility(review: BranchReview): ReviewActionEligibility {
  const lifecycleStatus = normalizeLifecycleStatus(
    review.reviewLifecycle?.status || review.reviewStatus || 'none',
    'completed'
  );
  const sourceStatus = String(review.reviewLifecycle?.sourceStatus || review.reviewStatus || '').trim().toLowerCase();
  const staleReason = (
    review.reviewHeadSha
    && review.headSha
    && review.reviewHeadSha !== review.headSha
  )
    ? 'head_mismatch'
    : null;

  if (staleReason) {
    return {
      canApprove: false,
      canRequestChanges: false,
      blockedReason: 'Review is stale. Run review again before actioning.',
      staleReason,
    };
  }

  if (sourceStatus === 'none') {
    return {
      canApprove: false,
      canRequestChanges: false,
      blockedReason: 'No completed review is available yet.',
      staleReason: null,
    };
  }

  if (!TERMINAL_LIFECYCLE_STATUSES.has(lifecycleStatus)) {
    return {
      canApprove: false,
      canRequestChanges: false,
      blockedReason: `Review is still in progress (${lifecycleStatus}).`,
      staleReason: null,
    };
  }

  return {
    canApprove: true,
    canRequestChanges: true,
    blockedReason: null,
    staleReason: null,
  };
}

function resolveActionEligibility(review: BranchReview): ReviewActionEligibility {
  const fromApi = review.reviewActionEligibility;
  if (fromApi && typeof fromApi === 'object') {
    return {
      canApprove: fromApi.canApprove !== false,
      canRequestChanges: fromApi.canRequestChanges !== false,
      blockedReason: fromApi.blockedReason || null,
      staleReason: fromApi.staleReason || null,
    };
  }
  return inferFallbackActionEligibility(review);
}

type BranchReviewDetails = BranchReview & {
  files: Array<{
    path: string;
    status: string;
    oldPath?: string | null;
  }>;
  reviewJson?: {
    stats?: {
      diffScopeMode?: string;
      diffBaseSha?: string | null;
      diffHeadSha?: string | null;
      deltaEligible?: boolean;
    };
    recommendations?: Array<{
      file?: string;
    }>;
  } | null;
};

type FixtureRepo = {
  tmpRoot: string;
  remoteDir: string;
  repoDir: string;
  collabDir: string;
};

type WorkflowContext = {
  fixture: FixtureRepo;
  projectId: string;
  projectName: string;
};

function buildBranchReviewSnapshot(overrides: Partial<BranchReview> = {}): BranchReview {
  return {
    id: 'br-snapshot',
    branchName: 'feature/snapshot',
    baseBranch: 'main',
    headSha: 'head-1',
    mergeBaseSha: 'merge-1',
    fileCount: 1,
    commitCount: 1,
    isCurrent: true,
    reviewStatus: 'none',
    ...overrides,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  const { cwd, env } = options;
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: stdout?.toString().trim() || '',
    stderr: stderr?.toString().trim() || '',
  };
}

async function git(repoPath: string, ...args: string[]) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await run('git', args, { cwd: repoPath });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error || '');
      if (!message.includes('.git/index.lock') || attempt === 2) {
        throw error;
      }
      await fs.rm(path.join(repoPath, '.git', 'index.lock'), { force: true }).catch(() => {});
      await delay(200);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'git command failed'));
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  {
    timeoutMs = WAIT_TIMEOUT_MS,
    intervalMs = 300,
    label = 'condition',
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const start = Date.now();
  let lastError: unknown = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }

  const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

async function api<T>(
  method: string,
  endpoint: string,
  body?: unknown,
  { expectOk = true }: { expectOk?: boolean } = {}
): Promise<{ payload: T | null; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let payload: T | null = null;
    try {
      payload = (await response.json()) as T;
    } catch {
      payload = null;
    }

    if (expectOk && !response.ok) {
      throw new Error(`${method} ${endpoint} failed with HTTP ${response.status}`);
    }

    return { payload, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function createFixtureRepo(): Promise<FixtureRepo> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-branch-review-ui-'));
  const remoteDir = path.join(tmpRoot, 'origin.git');
  const repoDir = path.join(tmpRoot, 'worktree');
  const collabDir = path.join(tmpRoot, 'collab');

  await fs.mkdir(remoteDir, { recursive: true });
  await run('git', ['init', '--bare', remoteDir]);

  await fs.mkdir(repoDir, { recursive: true });
  await run('git', ['init', repoDir]);
  await git(repoDir, 'config', 'user.name', 'Workflow Tester');
  await git(repoDir, 'config', 'user.email', 'workflow@example.com');
  await git(repoDir, 'checkout', '-b', 'main');

  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'app.js'), "export const app = 'v1';\n", 'utf8');
  await fs.writeFile(path.join(repoDir, 'src', 'config.js'), "export const cfg = { env: 'dev' };\n", 'utf8');
  await fs.writeFile(path.join(repoDir, 'src', 'temp.txt'), 'temporary file\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'README.md'), '# Branch Review UI Workflow\n', 'utf8');
  await fs.writeFile(path.join(repoDir, '.gitignore'), '.atlas/\n', 'utf8');

  await git(repoDir, 'add', '.');
  await git(repoDir, 'commit', '-m', 'chore: initial main');
  await git(repoDir, 'remote', 'add', 'origin', remoteDir);
  await git(repoDir, 'push', '-u', 'origin', 'main');

  await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remoteDir });

  await run('git', ['clone', remoteDir, collabDir]);
  await git(collabDir, 'config', 'user.name', 'Collaborator');
  await git(collabDir, 'config', 'user.email', 'collab@example.com');

  return { tmpRoot, remoteDir, repoDir, collabDir };
}

async function cleanupFixtureRepo(fixture: FixtureRepo | null) {
  if (!fixture) return;
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true });
}

async function syncWatcher(projectId: string) {
  await api('POST', `/projects/${projectId}/watcher/sync`, {});
}

async function listBranchReviews(projectId: string): Promise<BranchReview[]> {
  const { payload } = await api<{ branchReviews: BranchReview[] }>(
    'GET',
    `/projects/${projectId}/branch-reviews`
  );
  return payload?.branchReviews || [];
}

async function getBranchReview(projectId: string, branchReviewId: string): Promise<BranchReviewDetails> {
  const { payload } = await api<{ branchReview: BranchReviewDetails }>(
    'GET',
    `/projects/${projectId}/branch-reviews/${branchReviewId}`
  );
  if (!payload?.branchReview) {
    throw new Error(`Branch review ${branchReviewId} not found`);
  }
  return payload.branchReview;
}

function findReviewByBranch(reviews: BranchReview[], branchName: string): BranchReview | null {
  return reviews.find((review) => review.branchName === branchName) || null;
}

function expectLifecycleParity(review: BranchReview) {
  expect(review.reviewLifecycle).toBeTruthy();
  const lifecycle = review.reviewLifecycle!;
  const lifecycleStatus = normalizeLifecycleStatus(lifecycle.status, 'completed');
  const sourceLifecycleStatus = normalizeLifecycleStatus(
    lifecycle.sourceStatus || review.reviewStatus || 'none',
    'completed'
  );
  expect(['queued', 'running', 'retrying', 'partial', 'failed', 'completed']).toContain(lifecycleStatus);
  expect(typeof review.reviewLifecycle?.phase).toBe('string');
  expect(typeof review.reviewLifecycle?.isActive).toBe('boolean');
  expect(typeof review.reviewLifecycle?.isTerminal).toBe('boolean');
  expect(typeof review.reviewLifecycle?.canRetry).toBe('boolean');

  expect(review.reviewLifecycle?.isActive).toBe(ACTIVE_LIFECYCLE_STATUSES.has(lifecycleStatus));
  expect(review.reviewLifecycle?.isTerminal).toBe(TERMINAL_LIFECYCLE_STATUSES.has(lifecycleStatus));
  expect(review.reviewLifecycle?.canRetry).toBe(review.reviewLifecycle?.isTerminal);

  if (sourceLifecycleStatus === 'queued') {
    expect(['queued', 'retrying']).toContain(lifecycleStatus);
    return;
  }
  if (sourceLifecycleStatus === 'running') {
    expect(['running', 'retrying']).toContain(lifecycleStatus);
    return;
  }
  if (sourceLifecycleStatus === 'completed') {
    expect(['completed', 'partial']).toContain(lifecycleStatus);
    return;
  }
  expect(lifecycleStatus).toBe(sourceLifecycleStatus);
}

async function openProjectInReview(page: import('@playwright/test').Page, projectName: string) {
  await page.addInitScript(() => {
    localStorage.setItem('atlas_active_tab', 'trust-pipeline');
    localStorage.setItem('atlas_visited', 'true');
  });
  await page.goto(UI_BASE_URL, { waitUntil: 'domcontentloaded' });

  // Browser mode can land on the marketing page first; always enter the app shell.
  const openAppButton = page.getByRole('button', { name: /^Open App$/i }).first();
  if (await openAppButton.isVisible().catch(() => false)) {
    await openAppButton.click();
  }

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 30_000 });
  const title = page.locator('h3', { hasText: projectName }).first();
  await expect(title).toBeVisible({ timeout: 30_000 });
  await title.click();

  await expect(page.getByTitle('Back to Dashboard')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Reviews', { exact: true })).toBeVisible({ timeout: 20_000 });
}

test.describe('Branch review workflow UI integration', () => {
  test.describe.configure({ mode: 'serial' });

  test('uses backend stale action eligibility contract for approve/request gating', async () => {
    const review = buildBranchReviewSnapshot({
      id: 'br-action-contract',
      branchName: 'feature/eligibility',
      headSha: 'head-new',
      reviewHeadSha: 'head-old',
      reviewStatus: 'reviewed',
      reviewLifecycle: {
        status: 'completed',
        phase: 'complete',
        isActive: false,
        isTerminal: true,
        canRetry: true,
        sourceStatus: 'reviewed',
      },
      reviewActionEligibility: {
        canApprove: false,
        canRequestChanges: false,
        blockedReason: 'Review is stale: branch head changed after review completion.',
        staleReason: 'head_mismatch',
      },
    });

    const eligibility = resolveActionEligibility(review);
    expect(eligibility.canApprove).toBe(false);
    expect(eligibility.canRequestChanges).toBe(false);
    expect(eligibility.staleReason).toBe('head_mismatch');
    expect(eligibility.blockedReason).toMatch(/stale/i);
  });

  test('falls back to lifecycle retry gating when action eligibility payload is missing', async () => {
    const review = buildBranchReviewSnapshot({
      id: 'br-action-fallback',
      branchName: 'feature/eligibility-fallback',
      reviewStatus: 'queued',
      reviewLifecycle: {
        status: 'retrying',
        phase: 'provider_retry',
        isActive: true,
        isTerminal: false,
        canRetry: false,
        sourceStatus: 'queued',
      },
    });

    const eligibility = resolveActionEligibility(review);
    expect(eligibility.canApprove).toBe(false);
    expect(eligibility.canRequestChanges).toBe(false);
    expect(eligibility.blockedReason).toMatch(/in progress|retrying/i);
    expect(eligibility.staleReason).toBeNull();
  });

  test('uses action eligibility payload precedence to unblock approve/request after rerun recovery', async () => {
    const recoveredReview = buildBranchReviewSnapshot({
      id: 'br-rerun-recovered',
      reviewStatus: 'reviewed',
      headSha: 'head-new',
      reviewHeadSha: 'head-old',
      reviewLifecycle: {
        status: 'completed',
        phase: 'complete',
        isActive: false,
        isTerminal: true,
        canRetry: true,
        sourceStatus: 'reviewed',
      },
      reviewActionEligibility: {
        canApprove: true,
        canRequestChanges: true,
        blockedReason: null,
        staleReason: null,
      },
    });

    const eligibility = resolveActionEligibility(recoveredReview);
    expect(eligibility.canApprove).toBe(true);
    expect(eligibility.canRequestChanges).toBe(true);
    expect(eligibility.blockedReason).toBeNull();
    expect(eligibility.staleReason).toBeNull();
  });

  test('gates approve/request across retrying, stale, and rerun terminal lifecycle snapshots without payload fallback', async () => {
    const cases: Array<{
      label: string;
      review: BranchReview;
      expected: ReviewActionEligibility;
    }> = [
      {
        label: 'retrying in-flight',
        review: buildBranchReviewSnapshot({
          id: 'br-retrying',
          reviewStatus: 'queued',
          reviewLifecycle: {
            status: 'retrying',
            phase: 'provider_retry',
            isActive: true,
            isTerminal: false,
            canRetry: false,
            sourceStatus: 'queued',
          },
        }),
        expected: {
          canApprove: false,
          canRequestChanges: false,
          blockedReason: 'Review is still in progress (retrying).',
          staleReason: null,
        },
      },
      {
        label: 'stale terminal snapshot',
        review: buildBranchReviewSnapshot({
          id: 'br-stale',
          reviewStatus: 'reviewed',
          headSha: 'head-new',
          reviewHeadSha: 'head-old',
          reviewLifecycle: {
            status: 'completed',
            phase: 'complete',
            isActive: false,
            isTerminal: true,
            canRetry: true,
            sourceStatus: 'reviewed',
          },
        }),
        expected: {
          canApprove: false,
          canRequestChanges: false,
          blockedReason: 'Review is stale. Run review again before actioning.',
          staleReason: 'head_mismatch',
        },
      },
      {
        label: 'rerun recovered terminal snapshot',
        review: buildBranchReviewSnapshot({
          id: 'br-rerun-terminal',
          reviewStatus: 'reviewed',
          headSha: 'head-terminal',
          reviewHeadSha: 'head-terminal',
          reviewLifecycle: {
            status: 'completed',
            phase: 'complete',
            isActive: false,
            isTerminal: true,
            canRetry: true,
            sourceStatus: 'reviewed',
          },
        }),
        expected: {
          canApprove: true,
          canRequestChanges: true,
          blockedReason: null,
          staleReason: null,
        },
      },
    ];

    for (const testCase of cases) {
      const eligibility = resolveActionEligibility(testCase.review);
      expect(eligibility.canApprove, testCase.label).toBe(testCase.expected.canApprove);
      expect(eligibility.canRequestChanges, testCase.label).toBe(testCase.expected.canRequestChanges);
      if (testCase.expected.blockedReason) {
        expect(eligibility.blockedReason, testCase.label).toContain(testCase.expected.blockedReason);
      } else {
        expect(eligibility.blockedReason, testCase.label).toBeNull();
      }
      expect(eligibility.staleReason, testCase.label).toBe(testCase.expected.staleReason);
    }
  });

  test('validates canonical lifecycle parity for queued, retrying, failed, partial, and completed states', async () => {
    const baseReview: Omit<BranchReview, 'reviewStatus' | 'reviewLifecycle'> = {
      id: 'br-lifecycle-shape',
      branchName: 'feature/lifecycle-shape',
      baseBranch: 'main',
      headSha: 'abc1234',
      mergeBaseSha: 'def5678',
      fileCount: 1,
      commitCount: 1,
      isCurrent: true,
    };

    const samples: BranchReview[] = [
      {
        ...baseReview,
        id: 'br-lifecycle-queued',
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          phase: 'queued',
          isActive: true,
          isTerminal: false,
          canRetry: false,
          sourceStatus: 'queued',
        },
      },
      {
        ...baseReview,
        id: 'br-lifecycle-retrying',
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'retrying',
          phase: 'provider_retry',
          isActive: true,
          isTerminal: false,
          canRetry: false,
          sourceStatus: 'queued',
        },
      },
      {
        ...baseReview,
        id: 'br-lifecycle-failed',
        reviewStatus: 'failed',
        reviewLifecycle: {
          status: 'failed',
          phase: 'failed',
          isActive: false,
          isTerminal: true,
          canRetry: true,
          error: 'provider unavailable',
          sourceStatus: 'failed',
        },
      },
      {
        ...baseReview,
        id: 'br-lifecycle-partial',
        reviewStatus: 'reviewed',
        reviewLifecycle: {
          status: 'partial',
          phase: 'partial',
          isActive: false,
          isTerminal: true,
          canRetry: true,
          error: 'partial coverage',
          sourceStatus: 'reviewed',
        },
      },
      {
        ...baseReview,
        id: 'br-lifecycle-completed',
        reviewStatus: 'reviewed',
        reviewLifecycle: {
          status: 'completed',
          phase: 'complete',
          isActive: false,
          isTerminal: true,
          canRetry: true,
          sourceStatus: 'reviewed',
        },
      },
    ];

    for (const sample of samples) {
      expectLifecycleParity(sample);
    }
  });

  let context: WorkflowContext | null = null;

  test.beforeAll(async () => {
    const fixture = await createFixtureRepo();
    const projectName = `BR UI Workflow ${Date.now()}`;

    const openProject = await api<{ project: { id: string } }>('POST', '/projects/open-local', {
      localPath: fixture.repoDir,
      name: projectName,
    });
    const projectId = openProject.payload?.project?.id;
    if (!projectId) {
      throw new Error('Project creation failed: missing project id');
    }

    await api('PUT', '/settings/auto_review_enabled', { value: 'false' });
    await syncWatcher(projectId);

    context = {
      fixture,
      projectId,
      projectName,
    };
  });

  test.afterAll(async () => {
    if (!context) return;

    try {
      await api('DELETE', `/projects/${context.projectId}`, undefined, { expectOk: false });
    } catch {
      // Best-effort cleanup.
    }
    await cleanupFixtureRepo(context.fixture);
  });

  test('shows branch review section even when there are zero active branch reviews', async ({ page }) => {
    if (!context) {
      throw new Error('Workflow context was not initialized');
    }

    const { projectId, projectName } = context;
    await openProjectInReview(page, projectName);

    const reviews = await listBranchReviews(projectId);
    expect(reviews.length).toBe(0);

    await expect(
      page.getByText(/^Reviews$/i).first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: 'Notes' })
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: 'Agent Rules' })
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/^AI Review$/i).first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/No reviewable changes detected yet\./i)
    ).toBeVisible({ timeout: 10_000 });
  });

  test('hides non-active branch reviews in All filter while on base branch', async ({ page }) => {
    const fixture = await createFixtureRepo();
    const projectName = `BR All Filter ${Date.now()}`;
    const branchName = 'feature/history-visible';
    let projectId: string | null = null;

    try {
      const openProject = await api<{ project: { id: string } }>('POST', '/projects/open-local', {
        localPath: fixture.repoDir,
        name: projectName,
      });
      projectId = openProject.payload?.project?.id || null;
      if (!projectId) {
        throw new Error('Project creation failed: missing project id');
      }

      await syncWatcher(projectId);

      await git(fixture.repoDir, 'checkout', '-b', branchName);
      await fs.writeFile(path.join(fixture.repoDir, 'src', 'history-visible.js'), "export const historyVisible = true;\n", 'utf8');
      await git(fixture.repoDir, 'add', 'src/history-visible.js');
      await git(fixture.repoDir, 'commit', '-m', 'feat: history visible review');
      await syncWatcher(projectId);

      const createdReview = await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        return findReviewByBranch(list, branchName);
      }, { label: 'topic branch review exists before merge' });

      await git(fixture.repoDir, 'checkout', 'main');
      await syncWatcher(projectId);
      await api(
        'PATCH',
        `/projects/${projectId}/branch-reviews/${createdReview.id}/status`,
        { status: 'closed' }
      );

      await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const closedReview = findReviewByBranch(list, branchName);
        if (!closedReview) return null;
        return closedReview.status === 'closed'
          ? { closedReview, total: list.length }
          : null;
      }, { label: 'branch review closed while on base branch' });

      await openProjectInReview(page, projectName);
      await expect(
        page.getByText(/^Reviews$/i).first()
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText(/No reviewable changes detected yet\./i).first()
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText(new RegExp(branchName.replace('/', '\\/'), 'i')).first()
      ).not.toBeVisible();
    } finally {
      if (projectId) {
        await api('DELETE', `/projects/${projectId}`, undefined, { expectOk: false });
      }
      await cleanupFixtureRepo(fixture);
    }
  });

  test('shows the current rerun head SHA in the live AI review banner', async ({ page }) => {
    const fixture = await createFixtureRepo();
    const projectName = `BR Live Scope ${Date.now()}`;
    const branchName = 'feature/live-scope';
    let projectId: string | null = null;

    try {
      const openProject = await api<{ project: { id: string } }>('POST', '/projects/open-local', {
        localPath: fixture.repoDir,
        name: projectName,
      });
      projectId = openProject.payload?.project?.id || null;
      if (!projectId) {
        throw new Error('Project creation failed: missing project id');
      }

      await syncWatcher(projectId);
      await openProjectInReview(page, projectName);

      await git(fixture.repoDir, 'checkout', '-b', branchName);
      await fs.writeFile(path.join(fixture.repoDir, 'src', 'live-scope.js'), "export const liveScope = 'a';\n", 'utf8');
      await git(fixture.repoDir, 'add', 'src/live-scope.js');
      await git(fixture.repoDir, 'commit', '-m', 'feat: seed branch review');
      await syncWatcher(projectId);

      const createdReview = await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        return found?.isCurrent ? found : null;
      }, { label: 'branch review creation for live scope test' });

      await page.getByRole('button', { name: /Run Review|Review Now/i }).first().click();
      const initialManualReview = await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        if (!found) return null;
        const lifecycleStatus = normalizeLifecycleStatus(
          found.reviewLifecycle?.status || found.reviewStatus || 'none',
          'completed'
        );
        return lifecycleStatus === 'completed' ? found : null;
      }, { timeoutMs: 90_000, label: 'initial review terminal state for live scope test' });

      const previousReviewedHeadShort = String(initialManualReview.reviewHeadSha || '').trim().slice(0, 7);
      expect(previousReviewedHeadShort).toHaveLength(7);

      await api('PUT', '/settings/auto_review_enabled', { value: 'true' });
      await fs.appendFile(path.join(fixture.repoDir, 'src', 'live-scope.js'), "\nexport const liveScopeB = 'b';\n", 'utf8');
      await git(fixture.repoDir, 'add', 'src/live-scope.js');
      await git(fixture.repoDir, 'commit', '-m', 'feat: trigger incremental rerun');
      const rerunHeadShort = (await git(fixture.repoDir, 'rev-parse', '--short=7', 'HEAD')).stdout.trim();
      expect(rerunHeadShort).toHaveLength(7);
      await syncWatcher(projectId);

      await expect(
        page.getByText(/Incremental review/i).first()
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText(new RegExp(`${escapeRegex(previousReviewedHeadShort)}\\.\\.${escapeRegex(rerunHeadShort)}`, 'i')).first()
      ).toBeVisible({ timeout: 20_000 });

      const rerunTerminal = await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        if (!found) return null;
        const lifecycleStatus = normalizeLifecycleStatus(
          found.reviewLifecycle?.status || found.reviewStatus || 'none',
          'completed'
        );
        const sourceStatus = String(found.reviewLifecycle?.sourceStatus || found.reviewStatus || '').trim().toLowerCase();
        return sourceStatus && sourceStatus !== 'none' && TERMINAL_LIFECYCLE_STATUSES.has(lifecycleStatus) ? found : null;
      }, { timeoutMs: 90_000, label: 'incremental rerun terminal state for live scope test' });
      expect(rerunTerminal.reviewHeadSha?.slice(0, 7)).toBe(rerunHeadShort);

      const details = await getBranchReview(projectId, createdReview.id);
      expect(details.reviewJson?.stats?.diffScopeMode).toBe('delta');
      expect(details.reviewJson?.stats?.diffHeadSha?.slice(0, 7)).toBe(rerunHeadShort);
    } finally {
      await api('PUT', '/settings/auto_review_enabled', { value: 'false' }, { expectOk: false });
      if (projectId) {
        await api('DELETE', `/projects/${projectId}`, undefined, { expectOk: false });
      }
      await cleanupFixtureRepo(fixture);
    }
  });

  test('auto-review catches up to the latest head when a new commit lands during an active review', async ({ page }) => {
    const fixture = await createFixtureRepo();
    const projectName = `BR Catch Up ${Date.now()}`;
    const branchName = 'feature/catch-up-review';
    let projectId: string | null = null;

    try {
      const openProject = await api<{ project: { id: string } }>('POST', '/projects/open-local', {
        localPath: fixture.repoDir,
        name: projectName,
      });
      projectId = openProject.payload?.project?.id || null;
      if (!projectId) {
        throw new Error('Project creation failed: missing project id');
      }

      await syncWatcher(projectId);
      await openProjectInReview(page, projectName);

      await git(fixture.repoDir, 'checkout', '-b', branchName);
      await fs.writeFile(path.join(fixture.repoDir, 'src', 'catch-up.js'), "export const catchUp = 'seed';\n", 'utf8');
      await git(fixture.repoDir, 'add', 'src/catch-up.js');
      await git(fixture.repoDir, 'commit', '-m', 'feat: seed catch-up branch');
      await syncWatcher(projectId);

      const createdReview = await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        return found?.isCurrent ? found : null;
      }, { label: 'branch review creation for catch-up test' });

      await page.getByRole('button', { name: /Run Review|Review Now/i }).first().click();
      const initialManualReview = await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        if (!found) return null;
        const lifecycleStatus = normalizeLifecycleStatus(
          found.reviewLifecycle?.status || found.reviewStatus || 'none',
          'completed'
        );
        return lifecycleStatus === 'completed' ? found : null;
      }, { timeoutMs: 90_000, label: 'initial review terminal state for catch-up test' });

      await api('PUT', '/settings/auto_review_enabled', { value: 'true' });

      await fs.appendFile(path.join(fixture.repoDir, 'src', 'catch-up.js'), "\nexport const catchUpA = 'a';\n", 'utf8');
      await git(fixture.repoDir, 'add', 'src/catch-up.js');
      await git(fixture.repoDir, 'commit', '-m', 'feat: start auto review');
      const inFlightHeadShort = (await git(fixture.repoDir, 'rev-parse', '--short=7', 'HEAD')).stdout.trim();
      await syncWatcher(projectId);

      await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        const lifecycleStatus = normalizeLifecycleStatus(
          found?.reviewLifecycle?.status || found?.reviewStatus || 'none',
          'completed'
        );
        return lifecycleStatus === 'running' ? found : null;
      }, { timeoutMs: 20_000, label: 'catch-up test auto-review running' });

      await fs.appendFile(path.join(fixture.repoDir, 'src', 'catch-up.js'), "\nexport const catchUpB = 'b';\n", 'utf8');
      await git(fixture.repoDir, 'add', 'src/catch-up.js');
      await git(fixture.repoDir, 'commit', '-m', 'feat: queue catch-up rerun');
      const catchUpHeadShort = (await git(fixture.repoDir, 'rev-parse', '--short=7', 'HEAD')).stdout.trim();
      await syncWatcher(projectId);

      await expect(
        page.getByText(/Incremental review/i).first()
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText(new RegExp(`${escapeRegex(inFlightHeadShort)}\\.\\.${escapeRegex(catchUpHeadShort)}`, 'i')).first()
      ).toBeVisible({ timeout: 20_000 });

      const catchUpTerminal = await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        if (!found) return null;
        const lifecycleStatus = normalizeLifecycleStatus(
          found.reviewLifecycle?.status || found.reviewStatus || 'none',
          'completed'
        );
        return lifecycleStatus === 'completed' && found.reviewHeadSha?.slice(0, 7) === catchUpHeadShort
          ? found
          : null;
      }, { timeoutMs: 90_000, label: 'catch-up auto-review terminal state' });

      expect(catchUpTerminal.reviewHeadSha?.slice(0, 7)).toBe(catchUpHeadShort);
      expect(catchUpTerminal.reviewedAt).not.toBe(initialManualReview.reviewedAt);

      const details = await getBranchReview(projectId, catchUpTerminal.id);
      expect(details.reviewJson?.stats?.diffScopeMode).toBe('delta');
      expect(details.reviewJson?.stats?.diffBaseSha?.slice(0, 7)).toBe(inFlightHeadShort);
      expect(details.reviewJson?.stats?.diffHeadSha?.slice(0, 7)).toBe(catchUpHeadShort);
    } finally {
      await api('PUT', '/settings/auto_review_enabled', { value: 'false' }, { expectOk: false });
      if (projectId) {
        await api('DELETE', `/projects/${projectId}`, undefined, { expectOk: false });
      }
      await cleanupFixtureRepo(fixture);
    }
  });

  test('covers branch switch, behind-base sync, local changes, review queue, and base-branch updates', async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);

    if (!context) {
      throw new Error('Workflow context was not initialized');
    }

    const { fixture, projectId, projectName } = context;

    await openProjectInReview(page, projectName);

    // Edge case: switch to a new branch with zero diff vs base.
    await git(fixture.repoDir, 'checkout', '-b', 'feature/empty');
    await syncWatcher(projectId);
    await expect(
      page.getByText(/(feature\/empty has no changes vs main|No changes on feature\/empty vs main)/i)
    ).toBeVisible({ timeout: 10_000 });

    let reviews = await listBranchReviews(projectId);
    expect(reviews.length).toBe(0);

    // First commit on topic branch creates a branch review.
    await fs.writeFile(path.join(fixture.repoDir, 'src', 'feature.js'), "export const feature = 'a1';\n", 'utf8');
    await fs.appendFile(path.join(fixture.repoDir, 'src', 'app.js'), '\nexport const branchA = true;\n', 'utf8');
    await git(fixture.repoDir, 'add', 'src/app.js', 'src/feature.js');
    await git(fixture.repoDir, 'commit', '-m', 'feat: create branch review');
    await syncWatcher(projectId);

    const createdReview = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      return found?.isCurrent ? found : null;
    }, { label: 'branch review creation' });

    expect(createdReview.fileCount).toBeGreaterThan(0);
    expectLifecycleParity(createdReview);

    await expect(
      page.getByText(/feature\/empty/i).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/vs main/i).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /Run Review|Review Now/i }).first().click();
    const initialManualReview = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      if (!found) return null;
      const lifecycleStatus = normalizeLifecycleStatus(
        found.reviewLifecycle?.status || found.reviewStatus || 'none',
        'completed'
      );
      return lifecycleStatus === 'completed' ? found : null;
    }, { timeoutMs: 90_000, label: 'initial manual review terminal state' });
    expect(initialManualReview.reviewHeadSha).toBeTruthy();
    expect(initialManualReview.reviewedAt).toBeTruthy();

    const initialManualReviewDetails = await getBranchReview(projectId, initialManualReview.id);
    expect(initialManualReviewDetails.reviewJson?.stats?.diffScopeMode).toBeTruthy();
    expect(initialManualReviewDetails.reviewJson?.stats?.diffBaseSha).toBeTruthy();
    expect(initialManualReviewDetails.reviewJson?.stats?.diffHeadSha).toBe(initialManualReview.reviewHeadSha);

    await expect(page.locator('span[title="feature/empty"]').first()).toBeVisible();
    await expect(page.getByText(/vs main/i).first()).toBeVisible();

    // Dashboard card should reflect current branch-review status.
    await page.getByTitle('Back to Dashboard').click();
    await expect(page.locator('h3', { hasText: projectName })).toBeVisible();
    await expect(page.getByText('1 BR').first()).toBeVisible();
    await page.locator('h3', { hasText: projectName }).first().click();
    await expect(page.getByTitle('Back to Dashboard')).toBeVisible();

    // Edge case: local uncommitted changes must not update BR head SHA.
    const previousHeadSha = createdReview.headSha;
    await fs.appendFile(path.join(fixture.repoDir, 'src', 'feature.js'), '\n// local uncommitted change\n', 'utf8');
    await syncWatcher(projectId);
    await delay(500);

    reviews = await listBranchReviews(projectId);
    const uncommittedState = findReviewByBranch(reviews, 'feature/empty');
    expect(uncommittedState?.headSha).toBe(previousHeadSha);

    // Edge case: auto-review lifecycle and duplicate queueing are stable.
    await api('PUT', '/settings/auto_review_enabled', { value: 'true' });
    await git(fixture.repoDir, 'add', 'src/feature.js');
    await git(fixture.repoDir, 'commit', '-m', 'feat: commit local edits');
    const autoReviewHeadShort = (await git(fixture.repoDir, 'rev-parse', '--short=7', 'HEAD')).stdout.trim();
    await syncWatcher(projectId);

    const reviewAfterAutoQueue = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      if (!found) return null;
      const sourceStatus = String(found.reviewLifecycle?.sourceStatus || found.reviewStatus || '').trim().toLowerCase();
      return sourceStatus && sourceStatus !== 'none' ? found : null;
    }, { label: 'auto-review lifecycle' });
    expectLifecycleParity(reviewAfterAutoQueue);
    await expect(
      page.getByText(/Incremental review/i).first()
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(new RegExp(escapeRegex(autoReviewHeadShort), 'i')).first()
    ).toBeVisible({ timeout: 20_000 });

    const terminalAutoReview = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      if (!found) return null;
      const lifecycleStatus = normalizeLifecycleStatus(
        found.reviewLifecycle?.status || found.reviewStatus || 'none',
        'completed'
      );
      const sourceStatus = String(found.reviewLifecycle?.sourceStatus || found.reviewStatus || '').trim().toLowerCase();
      const hasReviewRun = sourceStatus && sourceStatus !== 'none';
      return hasReviewRun && TERMINAL_LIFECYCLE_STATUSES.has(lifecycleStatus) ? found : null;
    }, { timeoutMs: 90_000, label: 'auto-review terminal state' });
    expectLifecycleParity(terminalAutoReview);

    const queued1 = await api<{ success: boolean }>(
      'POST',
      `/projects/${projectId}/branch-reviews/${reviewAfterAutoQueue.id}/review/queue`,
      {}
    );
    const queued2 = await api<{ success: boolean }>(
      'POST',
      `/projects/${projectId}/branch-reviews/${reviewAfterAutoQueue.id}/review/queue`,
      {}
    );
    expect(queued1.payload?.success).toBe(true);
    expect(queued2.payload?.success).toBe(true);

    const terminalAfterQueue = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      if (!found) return null;
      const lifecycleStatus = normalizeLifecycleStatus(
        found.reviewLifecycle?.status || found.reviewStatus || 'none',
        'completed'
      );
      const sourceStatus = String(found.reviewLifecycle?.sourceStatus || found.reviewStatus || '').trim().toLowerCase();
      const hasReviewRun = sourceStatus && sourceStatus !== 'none';
      return hasReviewRun && TERMINAL_LIFECYCLE_STATUSES.has(lifecycleStatus) ? found : null;
    }, { timeoutMs: 90_000, label: 'queued review terminal state' });
    const terminalLifecycleStatus = normalizeLifecycleStatus(
      terminalAfterQueue.reviewLifecycle?.status || terminalAfterQueue.reviewStatus || 'none',
      'completed'
    );
    expect(terminalLifecycleStatus).toBe('completed');
    expectLifecycleParity(terminalAfterQueue);
    expect(terminalAfterQueue.reviewLifecycle?.isTerminal).toBe(true);
    await expect(page.getByRole('button', { name: /Re-run Review/i }).first()).toBeVisible({ timeout: 15_000 });
    expect(terminalAfterQueue.reviewHeadSha).toBeTruthy();
    expect(terminalAfterQueue.reviewedAt).toBeTruthy();
    const latestReviewedAt = terminalAfterQueue.reviewedAt || null;

    // Edge case: branch behind base branch, then pull/merge updates BR.
    await git(fixture.collabDir, 'checkout', 'main');
    await fs.appendFile(path.join(fixture.collabDir, 'src', 'config.js'), '\nexport const remoteFlag = true;\n', 'utf8');
    await git(fixture.collabDir, 'add', 'src/config.js');
    await git(fixture.collabDir, 'commit', '-m', 'feat: remote main advance');
    await git(fixture.collabDir, 'push', 'origin', 'main');

    await git(fixture.repoDir, 'checkout', 'main');
    await git(fixture.repoDir, 'pull', 'origin', 'main');
    await git(fixture.repoDir, 'checkout', 'feature/empty');
    await git(fixture.repoDir, 'merge', 'main', '--no-edit');
    await syncWatcher(projectId);

    const afterMergeState = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      if (!found) return null;
      return found.headSha !== terminalAfterQueue.headSha ? found : null;
    }, { label: 'branch review updated after merge from base' });
    expect(afterMergeState.commitCount).toBeGreaterThanOrEqual(1);
    expectLifecycleParity(afterMergeState);
    const afterMergeReviewed = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      if (!found || found.headSha !== afterMergeState.headSha) return null;
      const lifecycleStatus = normalizeLifecycleStatus(
        found.reviewLifecycle?.status || found.reviewStatus || 'none',
        'completed'
      );
      if (lifecycleStatus !== 'completed') return null;
      return found.reviewedAt && found.reviewedAt !== latestReviewedAt ? found : null;
    }, { timeoutMs: 90_000, label: 'merge auto-review terminal state' });
    expectLifecycleParity(afterMergeReviewed);
    const mergeReviewedAt = afterMergeReviewed.reviewedAt || null;
    const mergeReviewedHeadSha = afterMergeReviewed.reviewHeadSha || null;

    // Edge case: rename + delete commit should surface correct diff statuses.
    await git(fixture.repoDir, 'mv', 'src/feature.js', 'src/feature-renamed.js');
    await git(fixture.repoDir, 'rm', 'src/temp.txt');
    await git(fixture.repoDir, 'commit', '-m', 'refactor: rename and delete files');
    await syncWatcher(projectId);

    const afterRenameDelete = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      if (!found) return null;
      return found.headSha !== afterMergeState.headSha ? found : null;
    }, { label: 'branch review update after rename/delete' });
    const afterRenameDeleteReviewed = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      if (!found || found.headSha !== afterRenameDelete.headSha) return null;
      const lifecycleStatus = normalizeLifecycleStatus(
        found.reviewLifecycle?.status || found.reviewStatus || 'none',
        'completed'
      );
      if (lifecycleStatus !== 'completed') return null;
      return found.reviewedAt && found.reviewedAt !== mergeReviewedAt ? found : null;
    }, { timeoutMs: 90_000, label: 'rename/delete auto-review terminal state' });
    expectLifecycleParity(afterRenameDeleteReviewed);
    expect(afterRenameDeleteReviewed.reviewHeadSha).toBe(afterRenameDeleteReviewed.headSha);

    const details = await getBranchReview(projectId, afterRenameDeleteReviewed.id);
    expect(details.files.some((file) => file.status === 'D')).toBe(true);
    expect(
      details.files.some(
        (file) => file.status === 'R' || Boolean(file.oldPath) || file.path.endsWith('feature-renamed.js')
      )
    ).toBe(true);
    expect(details.reviewJson?.stats?.diffScopeMode).toBe('delta');
    expect(details.reviewJson?.stats?.diffBaseSha).toBe(mergeReviewedHeadSha);
    expect(details.reviewJson?.stats?.diffHeadSha).toBe(afterRenameDeleteReviewed.reviewHeadSha);
    expect(details.reviewJson?.stats?.deltaEligible).toBe(true);

    await page.locator('span[title="feature/empty"]').first().click();
    await expect(
      page.getByText(new RegExp(`${afterRenameDeleteReviewed.fileCount} file`, 'i')).first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(new RegExp(`${afterRenameDeleteReviewed.commitCount} commit`, 'i')).first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: /feature-renamed\.js/i }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Optional UI validation for recommendation->diff jump when review data exists.
    const recommendationFile = details.reviewJson?.recommendations?.find((rec) => rec.file)?.file;
    if (recommendationFile) {
      const recommendationButton = page
        .getByRole('button', { name: new RegExp(escapeRegex(recommendationFile), 'i') })
        .first();
      if (await recommendationButton.isVisible().catch(() => false)) {
        await recommendationButton.click();
        await expect(
          page.getByText(new RegExp(escapeRegex(recommendationFile), 'i')).first()
        ).toBeVisible();
      }
    }

    // Edge case: switching directly from an active topic branch to another
    // topic branch with zero diff should not keep the previous BR as current.
    await git(fixture.repoDir, 'checkout', '-B', 'feature/no-diff', 'main');
    await syncWatcher(projectId);

    const afterNoDiffFromTopicSwitch = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const noDiffCreated = list.some((review) => review.branchName === 'feature/no-diff');
      const hasCurrent = list.some((review) => review.isCurrent);
      if (noDiffCreated || hasCurrent) return null;
      return list;
    }, { label: 'topic->zero-diff switch clears current BR without creating a new BR' });
    expect(afterNoDiffFromTopicSwitch.some((review) => review.branchName === 'feature/no-diff')).toBe(false);
    expect(afterNoDiffFromTopicSwitch.some((review) => review.isCurrent)).toBe(false);

    // Switching back to the topic branch should restore the existing BR as current.
    await git(fixture.repoDir, 'checkout', 'feature/empty');
    await syncWatcher(projectId);
    const restoredReview = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const current = list.find((review) => review.isCurrent);
      return current?.branchName === 'feature/empty' ? current : null;
    }, { label: 'feature/empty restored as current BR' });
    expect(restoredReview.id).toBe(afterRenameDeleteReviewed.id);
    expect(
      normalizeLifecycleStatus(
        restoredReview.reviewLifecycle?.status || restoredReview.reviewStatus || 'none',
        'completed'
      )
    ).toBe('completed');

    // Edge case: switching to base branch clears current BR.
    await git(fixture.repoDir, 'checkout', 'main');
    await syncWatcher(projectId);

    await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const current = list.find((review) => review.isCurrent);
      return current ? null : true;
    }, { label: 'no current branch review on base branch' });

    const reviewsOnBase = await listBranchReviews(projectId);
    expect(reviewsOnBase.some((review) => review.isCurrent)).toBe(false);
    await expect(page.getByText(/Reviewing .*feature\/empty/i)).toHaveCount(0);

    // Edge case: user changes base branch and watcher state updates.
    await git(fixture.repoDir, 'checkout', 'main');
    await git(fixture.repoDir, 'checkout', '-b', 'develop');
    await git(fixture.repoDir, 'push', '-u', 'origin', 'develop');
    await git(fixture.repoDir, 'checkout', 'feature/empty');
    await syncWatcher(projectId);

    await expect(
      page.getByText(/feature\/empty/i).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/vs\s*main/i).first()).toBeVisible({ timeout: 15_000 });
    await api('PATCH', `/projects/${projectId}/base-branch`, { baseBranch: 'develop' });

    const watcherStatus = await waitFor(async () => {
      const response = await api<{ status?: { baseBranch?: string } }>('GET', `/projects/${projectId}/watcher/status`);
      return response.payload?.status?.baseBranch === 'develop' ? response.payload : null;
    }, { label: 'watcher base branch update to develop' });
    expect(watcherStatus.status?.baseBranch).toBe('develop');
  });

  test('shows Open on GitHub action for branch reviews when origin is GitHub', async ({ page }) => {
    if (!context) {
      throw new Error('Workflow context was not initialized');
    }

    const { fixture, projectId, projectName } = context;

    await git(fixture.repoDir, 'remote', 'set-url', 'origin', 'https://github.com/acme/widget.git');
    await syncWatcher(projectId);

    const gitStatusResponse = await api<{
      isGitRepo?: boolean;
      isGitHub?: boolean;
      owner?: string | null;
      repo?: string | null;
    }>('GET', `/projects/${projectId}/git-status`);
    expect(gitStatusResponse.payload?.isGitRepo).toBe(true);
    expect(gitStatusResponse.payload?.isGitHub).toBe(true);
    expect(gitStatusResponse.payload?.owner).toBe('acme');
    expect(gitStatusResponse.payload?.repo).toBe('widget');

    const currentBranch = (await git(fixture.repoDir, 'branch', '--show-current')).stdout;
    if (currentBranch !== 'feature/empty') {
      await git(fixture.repoDir, 'checkout', 'feature/empty');
      await syncWatcher(projectId);
    }

    await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const found = findReviewByBranch(list, 'feature/empty');
      return found ? found : null;
    }, { label: 'feature/empty branch review exists' });

    await openProjectInReview(page, projectName);
    await page.locator('span[title="feature/empty"]').first().click();

    await expect(
      page.getByRole('button', { name: /Open on GitHub/i })
    ).toBeVisible({ timeout: 15_000 });

    const copyPrimary = page.getByTestId('review-copy-primary').first();
    const copyMenuToggle = page.getByTestId('review-copy-menu-toggle').first();
    await expect(copyPrimary).toBeVisible({ timeout: 15_000 });
    await expect(copyMenuToggle).toBeVisible({ timeout: 15_000 });

    await copyMenuToggle.click();
    await expect(page.getByTestId('review-copy-menu')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('review-copy-option-copy_prompt')).toBeVisible();
    await expect(page.getByTestId('review-copy-option-copy_github')).toBeVisible();
    await expect(page.getByTestId('review-copy-option-copy_markdown')).toBeVisible();
    await expect(page.getByTestId('review-copy-option-download_markdown')).toBeVisible();
  });

  test('top banner Run Review targets the selected branch review (not the first row/current branch)', async ({ page }) => {
    if (!context) {
      throw new Error('Workflow context was not initialized');
    }

    const { fixture, projectId, projectName } = context;
    await api('PUT', '/settings/auto_review_enabled', { value: 'false' });

    // Create first branch review.
    await git(fixture.repoDir, 'checkout', 'main');
    await git(fixture.repoDir, 'checkout', '-B', 'feature/review-now-a');
    await fs.writeFile(path.join(fixture.repoDir, 'src', 'review-now-a.js'), "export const branchA = 'a';\n", 'utf8');
    await git(fixture.repoDir, 'add', 'src/review-now-a.js');
    await git(fixture.repoDir, 'commit', '-m', 'feat: branch A for review-now targeting');
    await syncWatcher(projectId);

    const reviewA = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      return findReviewByBranch(list, 'feature/review-now-a');
    }, { label: 'branch review A' });

    // Create second branch review and keep it as current branch.
    await git(fixture.repoDir, 'checkout', 'main');
    await git(fixture.repoDir, 'checkout', '-B', 'feature/review-now-b');
    await fs.writeFile(path.join(fixture.repoDir, 'src', 'review-now-b.js'), "export const branchB = 'b';\n", 'utf8');
    await git(fixture.repoDir, 'add', 'src/review-now-b.js');
    await git(fixture.repoDir, 'commit', '-m', 'feat: branch B for review-now targeting');
    await syncWatcher(projectId);

    const reviewB = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      return findReviewByBranch(list, 'feature/review-now-b');
    }, { label: 'branch review B' });

    await openProjectInReview(page, projectName);

    // Select the non-current review explicitly.
    await page.locator('span[title="feature/review-now-a"]').first().click();
    await expect(page.getByText(/feature\/review-now-a/i).first()).toBeVisible({ timeout: 15_000 });

    // Trigger top banner action.
    await page.getByRole('button', { name: /Run Review|Review Now/i }).first().click();

    // Validate top-banner action targets the selected branch review, even when
    // queue transitions happen too quickly to observe in /review-queue.
    const targetedSelectedReview = await waitFor(async () => {
      const list = await listBranchReviews(projectId);
      const selected = list.find((review) => review.id === reviewA.id);
      const nonSelected = list.find((review) => review.id === reviewB.id);
      if (!selected || !nonSelected) return null;

      const selectedTriggered = selected.reviewStatus !== 'none';
      const nonSelectedUntouched = nonSelected.reviewStatus === 'none';
      return selectedTriggered && nonSelectedUntouched ? true : null;
    }, { label: 'selected branch review targeted by top banner review now' });

    expect(targetedSelectedReview).toBe(true);
  });
});
