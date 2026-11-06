import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveProjectContext } from '../dist/src/context.js';

test('resolveProjectContext reuses in-memory cache before re-fetching projects', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-context-'));
  const repoDir = path.join(tempRoot, 'repo');
  await fs.mkdir(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  const repoRealPath = await fs.realpath(repoDir);

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  let getProjectsCalls = 0;
  const client = {
    async getProjects() {
      getProjectsCalls += 1;
      return [
        {
          id: 'project-1',
          name: 'Project 1',
          path: repoRealPath,
        },
      ];
    },
    async openLocal() {
      return null;
    },
  };

  const config = {
    backendUrl: 'http://127.0.0.1:3000/api',
    apiToken: null,
    autoImport: false,
    requestTimeoutMs: 1000,
    enableWatcherSync: false,
  };

  const first = await resolveProjectContext(client, config, repoDir);
  const second = await resolveProjectContext(client, config, repoDir);

  assert.equal(first.project.id, 'project-1');
  assert.equal(second.project.id, 'project-1');
  assert.equal(getProjectsCalls, 1);
});
