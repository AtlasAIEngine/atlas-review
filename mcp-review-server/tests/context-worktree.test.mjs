import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveProjectContext } from '../dist/src/context.js';

async function setupWorktreeRepo() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-worktree-'));
  const mainRepo = path.join(tempRoot, 'main-repo');
  const worktreeDir = path.join(tempRoot, 'worktree-feature');

  await fs.mkdir(mainRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: mainRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: mainRepo, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-b', 'feature', worktreeDir], { cwd: mainRepo, stdio: 'ignore' });

  return {
    tempRoot,
    mainRepo: await fs.realpath(mainRepo),
    worktreeDir: await fs.realpath(worktreeDir),
  };
}

const baseConfig = {
  backendUrl: 'http://127.0.0.1:3000/api',
  apiToken: null,
  autoImport: false,
  requestTimeoutMs: 1000,
  enableWatcherSync: false,
};

test('resolveProjectContext matches the main repo when cwd is inside a worktree', async (t) => {
  const { tempRoot, mainRepo, worktreeDir } = await setupWorktreeRepo();
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const client = {
    async getProjects() {
      return [{ id: 'project-1', name: 'Main Project', path: mainRepo }];
    },
    async openLocal() {
      throw new Error('openLocal should not be called when main repo is already registered');
    },
  };

  const resolved = await resolveProjectContext(client, baseConfig, worktreeDir);

  assert.equal(resolved.project.id, 'project-1');
  // gitRoot stays at the worktree so downstream git commands operate on the worktree checkout.
  assert.equal(resolved.gitRoot, worktreeDir);
});

test('resolveProjectContext still matches the main repo by its own path', async (t) => {
  const { tempRoot, mainRepo } = await setupWorktreeRepo();
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const client = {
    async getProjects() {
      return [{ id: 'project-1', name: 'Main Project', path: mainRepo }];
    },
    async openLocal() {
      throw new Error('openLocal should not be called');
    },
  };

  const resolved = await resolveProjectContext(client, baseConfig, mainRepo);
  assert.equal(resolved.project.id, 'project-1');
  assert.equal(resolved.gitRoot, mainRepo);
});

test('auto-import from a worktree imports the main repo path, not the worktree path', async (t) => {
  const { tempRoot, mainRepo, worktreeDir } = await setupWorktreeRepo();
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  let openLocalArg = null;
  const client = {
    async getProjects() {
      return [];
    },
    async openLocal(localPath) {
      openLocalArg = localPath;
      return { id: 'imported-1', name: 'Imported', path: localPath };
    },
  };

  const resolved = await resolveProjectContext(
    client,
    { ...baseConfig, autoImport: true },
    worktreeDir
  );

  assert.equal(openLocalArg, mainRepo);
  assert.equal(resolved.project.id, 'imported-1');
  assert.equal(resolved.gitRoot, worktreeDir);
});

test('PROJECT_NOT_FOUND error mentions the worktree and its main repo', async (t) => {
  const { tempRoot, mainRepo, worktreeDir } = await setupWorktreeRepo();
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const client = {
    async getProjects() {
      return [];
    },
    async openLocal() {
      return null;
    },
  };

  await assert.rejects(
    () => resolveProjectContext(client, baseConfig, worktreeDir),
    (err) => {
      assert.equal(err.code, 'PROJECT_NOT_FOUND');
      assert.match(err.message, new RegExp(worktreeDir.replace(/\\/g, '\\\\')));
      assert.match(err.message, new RegExp(mainRepo.replace(/\\/g, '\\\\')));
      return true;
    }
  );
});
