import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

const tempDirs = [];

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.ATLAS_REVIEW_LINTER_ENABLED;
  vi.clearAllMocks();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

beforeEach(() => {
  process.env.ATLAS_REVIEW_LINTER_ENABLED = 'true';
  execFileSyncMock.mockImplementation((binary, args) => {
    if (binary === 'which' && Array.isArray(args) && args[0] === 'semgrep') {
      return '/usr/local/bin/semgrep\n';
    }
    throw new Error('missing binary');
  });
});

async function importRunner() {
  return import('../linter/linterRunner.js');
}

describe('runLinterPrePass fallback mode', () => {
  it('keeps Semgrep disabled in project-only mode when the repo has no Semgrep config', async () => {
    const { runLinterPrePass } = await importRunner();
    const projectPath = await makeTempDir('atlas-linter-runner-');
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'app.ts'), 'eval(userInput)\n', 'utf8');

    const result = await runLinterPrePass(projectPath, ['src/app.ts'], [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -0,0 +1 @@',
      '+eval(userInput)',
      '',
    ].join('\n'));

    expect(result.stats.toolsAttempted).toEqual([]);
    expect(result.stats.toolsSkipped).toContain('semgrep');
    expect(result.findings).toEqual([]);
  });

  it('runs Semgrep with Atlas-managed fallback when fallback mode is enabled', async () => {
    const { runLinterPrePass } = await importRunner();
    const projectPath = await makeTempDir('atlas-linter-runner-');
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'app.ts'), 'eval(userInput)\n', 'utf8');
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('findings present'), { code: 1 }),
        JSON.stringify({
          results: [{
            path: path.join(projectPath, 'src', 'app.ts'),
            check_id: 'atlas.javascript.avoid-eval',
            start: { line: 1, col: 1 },
            extra: { message: 'Avoid eval()', severity: 'WARNING' },
          }],
        }),
        '',
      );
      return { kill() {} };
    });

    const result = await runLinterPrePass(
      projectPath,
      ['src/app.ts'],
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -0,0 +1 @@',
        '+eval(userInput)',
        '',
      ].join('\n'),
      {
        linterPolicy: {
          enabled: true,
          mode: 'fallback_if_missing',
          semgrep: {
            enabled: true,
            allowAtlasManagedFallback: true,
          },
        },
      }
    );

    expect(result.stats.toolsSucceeded).toEqual(['semgrep']);
    expect(result.findings).toEqual([
      expect.objectContaining({
        file: 'src/app.ts',
        line: 1,
        source: 'semgrep',
        ruleId: 'atlas.javascript.avoid-eval',
      }),
    ]);
  });
});
