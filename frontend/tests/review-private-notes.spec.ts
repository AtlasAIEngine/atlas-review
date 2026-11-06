import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const UI_BASE_URL = process.env.PW_BASE_URL || 'http://127.0.0.1:5186';
const API_BASE_URL = process.env.PW_API_BASE_URL || 'http://127.0.0.1:3237/api';

const API_TIMEOUT_MS = 20_000;
const WAIT_TIMEOUT_MS = 90_000;

type ReviewLifecycleStatus = 'queued' | 'running' | 'retrying' | 'partial' | 'failed' | 'completed';
type BranchReview = {
  id: string;
  branchName: string;
  baseBranch: string;
  headSha: string;
  reviewHeadSha?: string | null;
  fileCount: number;
  commitCount: number;
  isCurrent: boolean;
  reviewStatus: string;
  reviewLifecycle?: {
    status: ReviewLifecycleStatus;
    phase: string;
    isActive: boolean;
    isTerminal: boolean;
    canRetry: boolean;
    sourceStatus?: string | null;
  } | null;
};

type FixtureRepo = {
  tmpRoot: string;
  remoteDir: string;
  repoDir: string;
  collabDir: string;
};

const TERMINAL_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['partial', 'failed', 'completed']);

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
  return run('git', args, { cwd: repoPath });
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

async function createFixtureRepo(): Promise<FixtureRepo> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-private-notes-'));
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
  await fs.writeFile(path.join(repoDir, 'README.md'), '# Private Notes Workflow\n', 'utf8');
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

function findReviewByBranch(reviews: BranchReview[], branchName: string): BranchReview | null {
  return reviews.find((review) => review.branchName === branchName) || null;
}

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
  if (normalized === 'reviewed' || normalized === 'none') {
    return normalized === 'reviewed' ? 'completed' : fallback;
  }
  return fallback;
}

async function openProjectInReview(page: import('@playwright/test').Page, projectName: string) {
  await page.addInitScript(() => {
    localStorage.setItem('atlas_active_tab', 'trust-pipeline');
    localStorage.setItem('atlas_visited', 'true');
  });
  await page.goto(UI_BASE_URL, { waitUntil: 'domcontentloaded' });

  const openAppButton = page.getByRole('button', { name: /^Open App$/i }).first();
  if (await openAppButton.isVisible().catch(() => false)) {
    await openAppButton.click();
  }

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 30_000 });
  const title = page.locator('h3', { hasText: projectName }).first();
  await expect(title).toBeVisible({ timeout: 30_000 });
  await title.click();

  await expect(page.getByTitle('Back to Dashboard')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(new RegExp(`^${projectName}$`))).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'BRANCH REVIEWS' })).toBeVisible({ timeout: 20_000 });
}

test.describe('Review private notes browser flow', () => {
  test('persists branch-review private notes across reload and shows them in the Notes section', async ({ page }) => {
    const fixture = await createFixtureRepo();
    const projectName = `Review Private Notes ${Date.now()}`;
    const branchName = 'feature/private-notes';
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

      await api('PUT', '/settings/auto_review_enabled', { value: 'false' });
      await syncWatcher(projectId);

      await git(fixture.repoDir, 'checkout', '-b', branchName);
      await fs.writeFile(
        path.join(fixture.repoDir, 'src', 'notes-target.js'),
        [
          "export function privateNotesTarget(input) {",
          "  const normalized = input?.trim?.() || '';",
          "  return normalized.toUpperCase();",
          "}",
          '',
        ].join('\n'),
        'utf8'
      );
      await git(fixture.repoDir, 'add', 'src/notes-target.js');
      await git(fixture.repoDir, 'commit', '-m', 'feat: add notes target');
      await syncWatcher(projectId);

      await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        return found?.isCurrent ? found : null;
      }, { label: 'branch review creation for private notes test' });

      await openProjectInReview(page, projectName);
      await page.getByRole('button', { name: /Run Review|Review Now/i }).first().click();

      await waitFor(async () => {
        const list = await listBranchReviews(projectId!);
        const found = findReviewByBranch(list, branchName);
        if (!found) return null;
        const lifecycleStatus = normalizeLifecycleStatus(
          found.reviewLifecycle?.status || found.reviewStatus || 'none',
          'completed'
        );
        return TERMINAL_LIFECYCLE_STATUSES.has(lifecycleStatus) ? found : null;
      }, { label: 'branch review terminal state for private notes test' });

      const fileCard = page.locator('[data-file-path="src/notes-target.js"]').first();
      await expect(fileCard).toBeVisible({ timeout: 30_000 });
      await fileCard.getByRole('button', { name: /File note/i }).click();
      await fileCard.locator('textarea').fill('File follow-up: revisit normalization edge cases.');
      await fileCard.getByRole('button', { name: /^Save note$/i }).click();
      await fileCard.getByRole('button', { name: /notes-target\.js/i }).click();

      const noteButtons = page.getByLabel('Add private note');
      await expect(noteButtons.first()).toBeVisible({ timeout: 15_000 });
      await noteButtons.first().click();
      const noteComposer = page.getByText(/Private note on line/i).locator('..').first();
      await expect(noteComposer).toBeVisible({ timeout: 15_000 });
      await noteComposer.locator('textarea').fill('Line follow-up: consider null input before trim.');
      await noteComposer.getByRole('button', { name: /^Save note$/i }).click();

      await expect(page.getByRole('button', { name: /^Notes 2$/i })).toBeVisible();
      await expect(page.getByText('File follow-up: revisit normalization edge cases.').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Line follow-up: consider null input before trim.').first()).toBeVisible({ timeout: 15_000 });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await openProjectInReview(page, projectName);
      await expect(page.getByRole('button', { name: /^Notes 2$/i })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('File follow-up: revisit normalization edge cases.').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Line follow-up: consider null input before trim.').first()).toBeVisible({ timeout: 15_000 });

      await page.getByTitle('Browse historical private notes for this project').click();
      await expect(page.locator('.review-shell-title', { hasText: 'Project Notes' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(branchName).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('File follow-up: revisit normalization edge cases.').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Line follow-up: consider null input before trim.').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Open review' }).first()).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Open review' }).first().click();
      await expect(page.locator('.review-shell-title', { hasText: 'Project Notes' })).not.toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: /^Notes 2$/i })).toBeVisible({ timeout: 15_000 });
    } finally {
      await api('PUT', '/settings/auto_review_enabled', { value: 'false' }, { expectOk: false });
      if (projectId) {
        await api('DELETE', `/projects/${projectId}`, undefined, { expectOk: false });
      }
      await cleanupFixtureRepo(fixture);
    }
  });
});
