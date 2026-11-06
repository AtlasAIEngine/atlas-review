/**
 * Atlas-review BR-107 F2: oversized git output errors before truncation
 * runs. Pinned regression test — large diffs must come back as truncated
 * output, not as an MCP tool error.
 *
 * The fixture is a real (tiny) git repo with a synthetic file padded out
 * to multiple MB. We then ask `runGit` for `git show <sha>:<path>` and
 * assert it returns truncated content rather than throwing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { runGit, MAX_OUTPUT_BYTES, EXEC_BUFFER_BYTES, isValidSha, classifyMaxBufferError } from '../gitOps.js';

const exec = promisify(execFile);

async function gitInRepo(repoPath, args) {
  return exec('git', args, {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

describe('runGit truncation behavior (BR-107 F2 regression)', () => {
  let repoPath;
  let headSha;
  // Padding well past MAX_OUTPUT_BYTES (256 KiB) but well under
  // EXEC_BUFFER_BYTES (16 MiB), so we exercise the post-await truncation
  // path rather than the maxBuffer-rejected path.
  const PAD_BYTES = 600 * 1024; // 600 KiB

  beforeAll(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-rt-mcp-gitops-'));
    await gitInRepo(repoPath, ['init', '--initial-branch=main']);
    await gitInRepo(repoPath, ['config', 'commit.gpgsign', 'false']);
    const big = path.join(repoPath, 'big.txt');
    await fs.writeFile(big, 'a'.repeat(PAD_BYTES), 'utf8');
    await gitInRepo(repoPath, ['add', '.']);
    await gitInRepo(repoPath, ['commit', '-m', 'big']);
    headSha = (await gitInRepo(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
  });

  afterAll(async () => {
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('returns truncated output instead of throwing when git output exceeds MAX_OUTPUT_BYTES', async () => {
    const { stdout, truncated } = await runGit(repoPath, ['show', `${headSha}:big.txt`]);
    expect(truncated).toBe(true);
    expect(stdout.length).toBe(MAX_OUTPUT_BYTES);
    expect(stdout[0]).toBe('a');
    expect(stdout[stdout.length - 1]).toBe('a');
  });

  it('returns full output for small command results without truncation', async () => {
    const { stdout, truncated } = await runGit(repoPath, ['rev-parse', 'HEAD']);
    expect(truncated).toBe(false);
    expect(stdout.trim()).toBe(headSha);
  });

  it('exposes EXEC_BUFFER_BYTES > MAX_OUTPUT_BYTES so post-await slicing is reachable', () => {
    expect(EXEC_BUFFER_BYTES).toBeGreaterThan(MAX_OUTPUT_BYTES);
  });
});

describe('classifyMaxBufferError (BR-107 follow-up: stderr-overflow must not masquerade as success)', () => {
  function makeMaxBufferError({ message, stdout, stderr }) {
    const err = new Error(message);
    err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    if (stdout !== undefined) err.stdout = stdout;
    if (stderr !== undefined) err.stderr = stderr;
    return err;
  }

  it('returns null for unrelated errors so caller re-throws', () => {
    const err = new Error('git: command not found');
    err.code = 'ENOENT';
    expect(classifyMaxBufferError(err)).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(classifyMaxBufferError(null)).toBeNull();
    expect(classifyMaxBufferError(undefined)).toBeNull();
  });

  it('treats "stdout maxBuffer" overflow as truncation success', () => {
    const result = classifyMaxBufferError(makeMaxBufferError({
      message: 'stdout maxBuffer length exceeded',
      stdout: Buffer.from('a'.repeat(MAX_OUTPUT_BYTES + 100)),
      stderr: Buffer.alloc(0),
    }));
    expect(result).not.toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(MAX_OUTPUT_BYTES);
  });

  it('treats "stderr maxBuffer" overflow as failure (returns null so caller re-throws)', () => {
    const result = classifyMaxBufferError(makeMaxBufferError({
      message: 'stderr maxBuffer length exceeded',
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('fatal: '.repeat(1000)),
    }));
    expect(result).toBeNull();
  });

  it('falls back to buffer presence when message lacks stream tag', () => {
    // Some Node versions emit a generic "maxBuffer length exceeded"
    // without naming the stream. Use which buffer has data as the tiebreak.
    const stdoutOnly = classifyMaxBufferError(makeMaxBufferError({
      message: 'maxBuffer length exceeded',
      stdout: Buffer.from('x'.repeat(100)),
      stderr: Buffer.alloc(0),
    }));
    expect(stdoutOnly).not.toBeNull();
    expect(stdoutOnly.truncated).toBe(true);

    const stderrOnly = classifyMaxBufferError(makeMaxBufferError({
      message: 'maxBuffer length exceeded',
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('e'.repeat(100)),
    }));
    expect(stderrOnly).toBeNull();
  });

  it('re-throws when both buffers are empty and the message is ambiguous', () => {
    // Conservative: if we cannot tell which stream overflowed, treat as
    // failure rather than risk a false-success.
    const result = classifyMaxBufferError(makeMaxBufferError({
      message: 'maxBuffer length exceeded',
    }));
    expect(result).toBeNull();
  });

  it('returns empty truncated stdout when stdout was overflowed but err.stdout is missing', () => {
    // Some Node versions don't attach the partial buffer.
    const result = classifyMaxBufferError(makeMaxBufferError({
      message: 'stdout maxBuffer length exceeded',
    }));
    expect(result).not.toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('');
  });
});

describe('isValidSha', () => {
  it('accepts 40-char hex', () => expect(isValidSha('a'.repeat(40))).toBe(true));
  it('accepts 4-char hex', () => expect(isValidSha('abcd')).toBe(true));
  it('rejects shorter', () => expect(isValidSha('abc')).toBe(false));
  it('rejects non-hex', () => expect(isValidSha('zzzz')).toBe(false));
  it('rejects branch names', () => expect(isValidSha('main')).toBe(false));
  it('rejects empty', () => expect(isValidSha('')).toBe(false));
  it('rejects non-string', () => expect(isValidSha(123)).toBe(false));
});
