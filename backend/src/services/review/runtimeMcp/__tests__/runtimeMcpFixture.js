import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

async function gitInRepo(repoPath, args, env = {}) {
  return execFileAsync('git', args, {
    cwd: repoPath,
    env: { ...process.env, ...env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

/**
 * Build a tiny synthetic git repo with two commits:
 *   - base commit:  src/foo.js with 5 lines
 *   - head commit:  src/foo.js modified line 3, src/bar.js added (10 lines)
 *
 * Returns { repoPath, baseSha, headSha, cleanup() }.
 */
export async function createRuntimeMcpFixture() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-rt-mcp-fixture-'));
  await gitInRepo(repoPath, ['init', '--initial-branch=main']);
  await gitInRepo(repoPath, ['config', 'commit.gpgsign', 'false']);

  const fooPath = path.join(repoPath, 'src', 'foo.js');
  await fs.mkdir(path.dirname(fooPath), { recursive: true });
  const fooBase = [
    'export function foo() {',
    '  const x = 1;',
    '  const y = 2;',
    '  return x + y;',
    '}',
    '',
  ].join('\n');
  await fs.writeFile(fooPath, fooBase, 'utf8');
  await gitInRepo(repoPath, ['add', '.']);
  await gitInRepo(repoPath, ['commit', '-m', 'base']);
  const baseSha = (await gitInRepo(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

  const fooHead = [
    'export function foo() {',
    '  const x = 1;',
    '  const y = 99;',
    '  return x + y;',
    '}',
    '',
  ].join('\n');
  await fs.writeFile(fooPath, fooHead, 'utf8');
  const barPath = path.join(repoPath, 'src', 'bar.js');
  const bar = [
    'export function bar(n) {',
    '  let total = 0;',
    '  for (let i = 0; i < n; i += 1) {',
    '    total += i;',
    '  }',
    '  return total;',
    '}',
    'export const VERSION = 1;',
    'export const NAME = "bar";',
    '',
  ].join('\n');
  await fs.writeFile(barPath, bar, 'utf8');
  await gitInRepo(repoPath, ['add', '.']);
  await gitInRepo(repoPath, ['commit', '-m', 'head']);
  const headSha = (await gitInRepo(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

  return {
    repoPath,
    baseSha,
    headSha,
    async cleanup() {
      await fs.rm(repoPath, { recursive: true, force: true });
    },
  };
}
