import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { AtlasMcpError } from '../dist/src/errors.js';
import { resolveToolContext } from '../dist/src/tools/projectContext.js';

const baseConfig = {
  backendUrl: 'http://127.0.0.1:3000/api',
  apiToken: null,
  autoImport: false,
  requestTimeoutMs: 1000,
  enableWatcherSync: false,
};

test('resolveToolContext accepts a guessed repo-name projectId when it matches the current project', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-project-alias-'));
  const repoDir = path.join(tempRoot, 'AtlasEngineMVP');
  await fs.mkdir(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  const repoRealPath = await fs.realpath(repoDir);

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const client = {
    async getProjects() {
      return [{ id: 'project-1', name: 'AtlasEngineMVP', path: repoRealPath }];
    },
    async listBranchReviews() {
      return [{ id: 'br-1', projectId: 'project-1', status: 'active', isCurrent: true }];
    },
    async openLocal() {
      throw new Error('openLocal should not be needed for an existing current project');
    },
  };

  const context = await resolveToolContext(
    client,
    baseConfig,
    { projectId: 'AtlasEngineMVP', reviewType: 'branch_review' },
    repoDir
  );

  assert.equal(context.project.id, 'project-1');
  assert.equal(context.gitRoot, repoRealPath);
  assert.equal(context.branchReview.id, 'br-1');
});

test('resolveToolContext gives an actionable error for unknown projectId overrides', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-project-alias-miss-'));
  const repoDir = path.join(tempRoot, 'repo');
  await fs.mkdir(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });

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
    () => resolveToolContext(
      client,
      baseConfig,
      { projectId: 'AtlasEngineMVP', reviewType: 'branch_review' },
      repoDir
    ),
    (error) => {
      assert.ok(error instanceof AtlasMcpError);
      assert.equal(error.code, 'PROJECT_NOT_FOUND');
      assert.match(error.message, /omit projectId/u);
      assert.match(error.message, /auto-resolve/u);
      return true;
    }
  );
});

test('resolveToolContext rejects a unique project-name alias when it is not the current project', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-project-alias-wrong-'));
  const repoDir = path.join(tempRoot, 'current-repo');
  const otherDir = path.join(tempRoot, 'AtlasEngineMVP');
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(otherDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  const repoRealPath = await fs.realpath(repoDir);
  const otherRealPath = await fs.realpath(otherDir);

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const client = {
    async getProjects() {
      return [
        { id: 'current-project', name: 'Current', path: repoRealPath },
        { id: 'other-project', name: 'AtlasEngineMVP', path: otherRealPath },
      ];
    },
    async openLocal() {
      return null;
    },
  };

  await assert.rejects(
    () => resolveToolContext(
      client,
      baseConfig,
      { projectId: 'AtlasEngineMVP', reviewType: 'branch_review' },
      repoDir
    ),
    (error) => {
      assert.ok(error instanceof AtlasMcpError);
      assert.equal(error.code, 'PROJECT_NOT_FOUND');
      assert.match(error.message, /exact Atlas project id/u);
      assert.match(error.message, /omit projectId/u);
      return true;
    }
  );
});
