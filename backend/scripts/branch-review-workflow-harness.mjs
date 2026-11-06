#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const ANON_USER = '00000000-0000-0000-0000-000000000000';
const DEFAULT_PORT = 3217;
const API_TIMEOUT_MS = 20_000;
const WAIT_TIMEOUT_MS = 25_000;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function logStep(message) {
  log(`\n[STEP] ${message}`);
}

async function run(cmd, args, options = {}) {
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

async function git(cwd, ...args) {
  return run('git', args, { cwd });
}

async function waitFor(checkFn, { timeoutMs = WAIT_TIMEOUT_MS, intervalMs = 250, label = 'condition' } = {}) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await checkFn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }

  const suffix = lastError ? ` (last error: ${lastError.message})` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

async function api(baseUrl, method, endpoint, body, { expectOk = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (expectOk && !response.ok) {
      throw new Error(`${method} ${endpoint} failed: HTTP ${response.status} ${JSON.stringify(payload)}`);
    }

    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function syncWatcher(apiBaseUrl, projectId) {
  return api(apiBaseUrl, 'POST', `/projects/${projectId}/watcher/sync`, {});
}

async function listBranchReviews(apiBaseUrl, projectId) {
  const { payload } = await api(apiBaseUrl, 'GET', `/projects/${projectId}/branch-reviews`);
  return payload?.branchReviews || [];
}

async function getBranchReview(apiBaseUrl, projectId, branchReviewId) {
  const { payload } = await api(apiBaseUrl, 'GET', `/projects/${projectId}/branch-reviews/${branchReviewId}`);
  return payload?.branchReview;
}

function findByBranch(reviews, branchName) {
  return reviews.find((r) => r.branchName === branchName) || null;
}

function currentReview(reviews) {
  return reviews.find((r) => r.isCurrent) || null;
}

async function createFixtureRepo(rootDir) {
  const remoteDir = path.join(rootDir, 'origin.git');
  const repoDir = path.join(rootDir, 'worktree');
  const collabDir = path.join(rootDir, 'collab');

  await fs.mkdir(remoteDir, { recursive: true });
  await run('git', ['init', '--bare', remoteDir]);

  await fs.mkdir(repoDir, { recursive: true });
  await run('git', ['init', repoDir]);
  await git(repoDir, 'config', 'user.name', 'Harness User');
  await git(repoDir, 'config', 'user.email', 'harness@example.com');
  await git(repoDir, 'checkout', '-b', 'main');

  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'app.js'), "export const app = 'v1';\n", 'utf8');
  await fs.writeFile(path.join(repoDir, 'src', 'config.js'), "export const cfg = { env: 'dev' };\n", 'utf8');
  await fs.writeFile(path.join(repoDir, 'src', 'temp.txt'), 'temp-file\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'README.md'), '# Branch Review Harness\n', 'utf8');
  await fs.writeFile(path.join(repoDir, '.gitignore'), '.atlas/\n', 'utf8');

  await git(repoDir, 'add', '.');
  await git(repoDir, 'commit', '-m', 'chore: initial main');
  await git(repoDir, 'remote', 'add', 'origin', remoteDir);
  await git(repoDir, 'push', '-u', 'origin', 'main');

  await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remoteDir });

  await run('git', ['clone', remoteDir, collabDir]);
  await git(collabDir, 'config', 'user.name', 'Collaborator');
  await git(collabDir, 'config', 'user.email', 'collab@example.com');

  return { remoteDir, repoDir, collabDir };
}

async function startBackendServer(workspaceRoot, env) {
  const server = spawn('node', ['backend/server.js'], {
    cwd: workspaceRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  server.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  server.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  server.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      log(`[SERVER] exited unexpectedly code=${code} signal=${signal}`);
      if (stderr.trim()) log(`[SERVER stderr]\n${stderr}`);
    }
  });

  const apiBaseUrl = `http://127.0.0.1:${env.PORT}/api`;
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${env.PORT}/health`);
    return res.ok;
  }, { timeoutMs: 45_000, label: 'backend /health' });

  return {
    process: server,
    apiBaseUrl,
    getLogs: () => ({ stdout, stderr }),
  };
}

async function stopBackendServer(serverProc) {
  if (!serverProc || serverProc.killed) return;
  serverProc.kill('SIGTERM');
  await waitFor(
    () => serverProc.exitCode !== null || serverProc.killed,
    { timeoutMs: 8_000, intervalMs: 100, label: 'server shutdown' }
  ).catch(async () => {
    serverProc.kill('SIGKILL');
    await delay(250);
  });
}

async function runHarness() {
  const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-branch-review-harness-'));
  const dataDir = path.join(tmpRoot, 'atlas-data');
  const dbPath = path.join(tmpRoot, 'atlas.sqlite');
  const port = Number(process.env.BR_HARNESS_PORT || DEFAULT_PORT);

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    ATLAS_DESKTOP_MODE: 'true',
    ATLAS_BIND_HOST: '127.0.0.1',
    ATLAS_DISABLE_CLI_PROVIDER_DETECTION: '1',
    ATLAS_REVIEW_TEST_PROVIDER: '1',
    ATLAS_REVIEW_TEST_PROVIDER_DELAY_MS: '1200',
    ATLAS_DB_TYPE: 'sqlite',
    ATLAS_DB_PATH: dbPath,
    ATLAS_DATA_DIR: dataDir,
  };

  let backend = null;
  let projectId = null;

  try {
    log(`[INFO] temp root: ${tmpRoot}`);
    const { repoDir, collabDir } = await createFixtureRepo(tmpRoot);
    log(`[INFO] fixture repo: ${repoDir}`);

    backend = await startBackendServer(workspaceRoot, env);
    const { apiBaseUrl } = backend;
    log(`[INFO] backend: ${apiBaseUrl}`);

    logStep('Import local repo as project and ensure watcher is running');
    const openLocal = await api(apiBaseUrl, 'POST', '/projects/open-local', {
      localPath: repoDir,
      name: 'BR Harness Project',
    });
    projectId = openLocal.payload?.project?.id;
    assert.ok(projectId, 'project id missing from /open-local');
    assert.equal(openLocal.payload?.project?.watching, true, 'watcher should start for git repo');

    const watcherStatus = await api(apiBaseUrl, 'GET', `/projects/${projectId}/watcher/status`);
    assert.equal(watcherStatus.payload?.watching, true, 'watcher status should be active');

    // Ensure auto-review starts disabled for deterministic setup.
    await api(apiBaseUrl, 'PUT', '/settings/auto_review_enabled', { value: 'false' });

    logStep('Switch to a new topic branch with zero diff (no BR should be created)');
    await git(repoDir, 'checkout', '-b', 'feature/empty');
    await syncWatcher(apiBaseUrl, projectId);
    await delay(300);
    let reviews = await listBranchReviews(apiBaseUrl, projectId);
    assert.equal(reviews.length, 0, 'no branch review expected for zero-diff branch');

    logStep('Commit on topic branch should create BR and set it current');
    await fs.writeFile(path.join(repoDir, 'src', 'feature.js'), "export const feature = 'a1';\n", 'utf8');
    await fs.appendFile(path.join(repoDir, 'src', 'app.js'), "\nexport const branchA = true;\n", 'utf8');
    await git(repoDir, 'add', 'src/app.js', 'src/feature.js');
    await git(repoDir, 'commit', '-m', 'feat: add feature branch changes');
    await syncWatcher(apiBaseUrl, projectId);

    const br1 = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = findByBranch(list, 'feature/empty');
      return found?.isCurrent ? found : null;
    }, { label: 'branch review creation on first commit' });

    assert.equal(br1.status, 'active');
    assert.ok(br1.fileCount > 0, 'branch review file_count should be > 0');

    logStep('Local uncommitted changes should not trigger BR update');
    const previousHeadSha = br1.headSha;
    await fs.appendFile(path.join(repoDir, 'src', 'feature.js'), '\n// local uncommitted edit\n', 'utf8');
    await syncWatcher(apiBaseUrl, projectId);
    await delay(500);
    reviews = await listBranchReviews(apiBaseUrl, projectId);
    const brAfterUncommitted = findByBranch(reviews, 'feature/empty');
    assert.equal(brAfterUncommitted?.headSha, previousHeadSha, 'head_sha should not change for uncommitted edits');

    logStep('Enable auto-review and verify first completed review establishes a full baseline');
    await api(apiBaseUrl, 'PUT', '/settings/auto_review_enabled', { value: 'true' });
    await git(repoDir, 'add', 'src/feature.js');
    await git(repoDir, 'commit', '-m', 'feat: committed after local edits');
    await syncWatcher(apiBaseUrl, projectId);

    let lastObservedStatus = null;
    const reachedLifecycle = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = findByBranch(list, 'feature/empty');
      lastObservedStatus = found?.reviewStatus || null;
      return found && ['queued', 'reviewing', 'failed', 'reviewed'].includes(found.reviewStatus) ? found : null;
    }, { timeoutMs: 12_000, label: 'branch review auto-review lifecycle start' });

    assert.ok(
      ['queued', 'reviewing', 'failed', 'reviewed'].includes(reachedLifecycle.reviewStatus),
      `unexpected auto-review lifecycle status: ${reachedLifecycle.reviewStatus}`
    );

    const autoReviewed = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = findByBranch(list, 'feature/empty');
      lastObservedStatus = found?.reviewStatus || null;
      return found && found.reviewStatus === 'reviewed' ? found : null;
    }, { timeoutMs: 60_000, label: 'branch review auto-review terminal state' }).catch((error) => {
      throw new Error(`${error.message}; last observed reviewStatus=${lastObservedStatus}`);
    });
    assert.equal(autoReviewed.reviewStatus, 'reviewed', `unexpected auto-review status: ${autoReviewed.reviewStatus}`);
    const firstReviewedAt = autoReviewed.reviewedAt;
    const firstReviewedHeadSha = autoReviewed.reviewHeadSha;
    assert.ok(firstReviewedAt, 'first completed review should set reviewedAt');
    assert.ok(firstReviewedHeadSha, 'first completed review should persist review head SHA');

    const firstReviewDetails = await getBranchReview(apiBaseUrl, projectId, autoReviewed.id);
    assert.equal(firstReviewDetails?.reviewJson?.stats?.diffScopeMode, 'full');
    assert.equal(firstReviewDetails?.reviewJson?.stats?.diffBaseSha, firstReviewDetails.mergeBaseSha);
    assert.equal(firstReviewDetails?.reviewJson?.stats?.diffHeadSha, firstReviewedHeadSha);

    logStep('Switching away and back without new commits should not auto-review again');
    await git(repoDir, 'checkout', 'main');
    await syncWatcher(apiBaseUrl, projectId);
    await git(repoDir, 'checkout', 'feature/empty');
    await syncWatcher(apiBaseUrl, projectId);
    await delay(1500);

    const restoredWithoutRerun = await getBranchReview(apiBaseUrl, projectId, autoReviewed.id);
    assert.equal(
      restoredWithoutRerun.reviewedAt,
      firstReviewedAt,
      'restoring a branch without new commits should not trigger another auto-review'
    );
    assert.equal(
      restoredWithoutRerun.reviewHeadSha,
      firstReviewedHeadSha,
      'review baseline should remain unchanged when no new commits exist'
    );

    logStep('A commit that lands during an in-flight auto-review should queue a catch-up rerun');
    await fs.appendFile(path.join(repoDir, 'src', 'feature.js'), '\nexport const branchRaceA = true;\n', 'utf8');
    await git(repoDir, 'add', 'src/feature.js');
    await git(repoDir, 'commit', '-m', 'fix: start in-flight auto review');
    const inFlightHeadSha = (await git(repoDir, 'rev-parse', 'HEAD')).stdout;
    await syncWatcher(apiBaseUrl, projectId);

    await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = findByBranch(list, 'feature/empty');
      return found?.reviewStatus === 'reviewing' ? found : null;
    }, { timeoutMs: 20_000, label: 'in-flight auto-review start' });

    await fs.appendFile(path.join(repoDir, 'src', 'feature.js'), '\nexport const branchRaceB = true;\n', 'utf8');
    await git(repoDir, 'add', 'src/feature.js');
    await git(repoDir, 'commit', '-m', 'fix: queue catch-up auto review');
    const catchUpHeadSha = (await git(repoDir, 'rev-parse', 'HEAD')).stdout;
    await syncWatcher(apiBaseUrl, projectId);

    const catchUpReviewed = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = findByBranch(list, 'feature/empty');
      if (!found || found.reviewStatus !== 'reviewed') return null;
      return found.reviewHeadSha === catchUpHeadSha ? found : null;
    }, { timeoutMs: 90_000, label: 'catch-up auto-review terminal state' });
    assert.equal(catchUpReviewed.reviewHeadSha, catchUpHeadSha);

    const catchUpDetails = await getBranchReview(apiBaseUrl, projectId, catchUpReviewed.id);
    assert.equal(catchUpDetails?.reviewJson?.stats?.diffScopeMode, 'delta');
    assert.equal(catchUpDetails?.reviewJson?.stats?.diffBaseSha, inFlightHeadSha);
    assert.equal(catchUpDetails?.reviewJson?.stats?.diffHeadSha, catchUpHeadSha);

    const firstCatchUpReviewedAt = catchUpReviewed.reviewedAt;
    const firstCatchUpReviewedHeadSha = catchUpReviewed.reviewHeadSha;

    logStep('A new commit should auto-review only the unreviewed delta');
    await fs.appendFile(path.join(repoDir, 'src', 'feature.js'), '\nexport const branchB = true;\n', 'utf8');
    await git(repoDir, 'add', 'src/feature.js');
    await git(repoDir, 'commit', '-m', 'fix: incremental follow-up');
    await syncWatcher(apiBaseUrl, projectId);

    const deltaReviewed = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = findByBranch(list, 'feature/empty');
      if (!found || found.reviewStatus !== 'reviewed') return null;
      return found.reviewedAt && found.reviewedAt !== firstCatchUpReviewedAt ? found : null;
    }, { timeoutMs: 60_000, label: 'incremental branch review terminal state' });
    assert.ok(deltaReviewed.reviewHeadSha && deltaReviewed.reviewHeadSha !== firstCatchUpReviewedHeadSha);

    const deltaReviewDetails = await getBranchReview(apiBaseUrl, projectId, deltaReviewed.id);
    assert.equal(deltaReviewDetails?.reviewJson?.stats?.diffScopeMode, 'delta');
    assert.equal(deltaReviewDetails?.reviewJson?.stats?.diffBaseSha, firstCatchUpReviewedHeadSha);
    assert.equal(deltaReviewDetails?.reviewJson?.stats?.diffHeadSha, deltaReviewed.reviewHeadSha);
    assert.equal(deltaReviewDetails?.reviewJson?.stats?.deltaEligible, true);

    logStep('Simulate behind-base branch: remote main advances, local pulls/merges, BR updates');
    await git(collabDir, 'checkout', 'main');
    await fs.appendFile(path.join(collabDir, 'src', 'config.js'), '\nexport const remoteFlag = true;\n', 'utf8');
    await git(collabDir, 'add', 'src/config.js');
    await git(collabDir, 'commit', '-m', 'feat: remote main update');
    await git(collabDir, 'push', 'origin', 'main');

    await git(repoDir, 'checkout', 'main');
    await git(repoDir, 'pull', 'origin', 'main');
    await git(repoDir, 'checkout', 'feature/empty');
    await git(repoDir, 'merge', 'main', '--no-edit');
    await syncWatcher(apiBaseUrl, projectId);

    const mergedState = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = findByBranch(list, 'feature/empty');
      return found && found.headSha !== deltaReviewed.headSha ? found : null;
    }, { label: 'branch review update after pulling/merging base' });
    assert.ok(mergedState.commitCount >= 1, 'commit_count should remain valid after merge');

    logStep('Commit rename + delete changes and verify BR diff status content');
    await git(repoDir, 'mv', 'src/feature.js', 'src/feature-renamed.js');
    await git(repoDir, 'rm', 'src/temp.txt');
    await git(repoDir, 'commit', '-m', 'refactor: rename feature file and delete temp');
    await syncWatcher(apiBaseUrl, projectId);

    const renameDeleteState = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = findByBranch(list, 'feature/empty');
      return found && found.headSha !== mergedState.headSha ? found : null;
    }, { label: 'branch review update after rename/delete commit' });

    const brDetails = await getBranchReview(apiBaseUrl, projectId, renameDeleteState.id);
    assert.ok(Array.isArray(brDetails?.files), 'branch review details must include files');
    assert.ok(
      brDetails.files.some((f) => f.status === 'D'),
      'expected at least one deleted file in BR detail'
    );
    assert.ok(
      brDetails.files.some((f) => f.status === 'R' || !!f.oldPath || f.path.includes('feature-renamed.js')),
      'expected rename info in BR detail'
    );

    logStep('Queue endpoint duplicate request should remain stable');
    const q1 = await api(apiBaseUrl, 'POST', `/projects/${projectId}/branch-reviews/${renameDeleteState.id}/review/queue`, {});
    const q2 = await api(apiBaseUrl, 'POST', `/projects/${projectId}/branch-reviews/${renameDeleteState.id}/review/queue`, {});
    assert.equal(q1.payload?.success, true);
    assert.equal(q2.payload?.success, true);

    logStep('Manual review endpoint should return a terminal BR review state');
    const manualReview = await api(
      apiBaseUrl,
      'POST',
      `/projects/${projectId}/branch-reviews/${renameDeleteState.id}/review`,
      {},
      { expectOk: false }
    );
    assert.ok([200, 500].includes(manualReview.response.status), 'manual review should return HTTP 200 or 500');
    const manualState = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const found = list.find((r) => r.id === renameDeleteState.id);
      return found && ['reviewed', 'failed'].includes(found.reviewStatus) ? found : null;
    }, { label: 'manual review terminal persistence' });
    assert.ok(
      ['reviewed', 'failed'].includes(manualState.reviewStatus),
      `unexpected manual-review status: ${manualState.reviewStatus}`
    );

    logStep('Switching topic->topic with zero diff should clear stale current BR');
    await git(repoDir, 'checkout', '-B', 'feature/no-diff', 'main');
    await syncWatcher(apiBaseUrl, projectId);
    const zeroDiffState = await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const noDiffReviewCreated = list.some((r) => r.branchName === 'feature/no-diff');
      const current = currentReview(list);
      if (noDiffReviewCreated || current !== null) {
        return null;
      }
      return list;
    }, { label: 'topic->zero-diff switch clears current BR without creating a new BR' });
    assert.equal(
      zeroDiffState.filter((r) => r.branchName === 'feature/no-diff').length,
      0,
      'zero-diff topic branch should not create a BR'
    );
    assert.equal(currentReview(zeroDiffState), null, 'no BR should remain current after topic->zero-diff switch');

    logStep('Switching back to topic branch should restore existing BR as current');
    await git(repoDir, 'checkout', 'feature/empty');
    await syncWatcher(apiBaseUrl, projectId);
    await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      const current = currentReview(list);
      return current && current.branchName === 'feature/empty' ? current : null;
    }, { label: 'feature/empty restored as current BR' });

    logStep('Switch to base branch should clear current BR selection');
    await git(repoDir, 'checkout', 'main');
    await syncWatcher(apiBaseUrl, projectId);
    await waitFor(async () => {
      const list = await listBranchReviews(apiBaseUrl, projectId);
      return currentReview(list) === null;
    }, { label: 'no current BR on base branch' });

    logStep('Change base branch via API and verify watcher status updates');
    await git(repoDir, 'checkout', 'main');
    await git(repoDir, 'checkout', '-b', 'develop');
    await git(repoDir, 'push', '-u', 'origin', 'develop');
    await git(repoDir, 'checkout', 'feature/empty');

    const changeBase = await api(apiBaseUrl, 'PATCH', `/projects/${projectId}/base-branch`, {
      baseBranch: 'develop',
    });
    assert.equal(changeBase.payload?.baseBranchDisplay, 'develop');

    const watcherAfterBase = await api(apiBaseUrl, 'GET', `/projects/${projectId}/watcher/status`);
    assert.equal(watcherAfterBase.payload?.status?.baseBranch, 'develop');

    log('\n[PASS] Branch review workflow harness completed successfully.');
    log(`[PASS] Project ${projectId} (${ANON_USER})`);
  } finally {
    try {
      if (backend?.apiBaseUrl && projectId) {
        await api(backend.apiBaseUrl, 'DELETE', `/projects/${projectId}`, undefined, { expectOk: false }).catch(() => {});
      }
    } catch {
      // no-op
    }

    if (backend?.process) {
      await stopBackendServer(backend.process);
    }

    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

runHarness().catch((error) => {
  console.error(`\n[FAIL] Branch review workflow harness failed: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
