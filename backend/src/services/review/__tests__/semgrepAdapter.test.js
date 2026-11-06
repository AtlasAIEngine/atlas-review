import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { detect, findLocalConfig, getDetectionMetadata, run } from '../linter/semgrepAdapter.js';

const tempDirs = [];

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

beforeEach(() => {
  execFileMock.mockReset();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue('/usr/local/bin/semgrep\n');
});

describe('findLocalConfig', () => {
  it('prefers project-owned Semgrep config', async () => {
    const projectPath = await makeTempDir('atlas-semgrep-project-');
    const repoConfigPath = path.join(projectPath, '.semgrep.yml');
    await fs.writeFile(repoConfigPath, 'rules: []\n');

    expect(findLocalConfig(projectPath)).toBe(repoConfigPath);
  });

  it('resolves vendored Atlas config relative to Atlas repo root, not the reviewed project', async () => {
    const projectPath = await makeTempDir('atlas-semgrep-project-');
    const atlasRepoRoot = await makeTempDir('atlas-semgrep-root-');
    const vendoredDir = path.join(atlasRepoRoot, '.atlas', 'semgrep-rules');
    await fs.mkdir(vendoredDir, { recursive: true });

    expect(findLocalConfig(projectPath, {
      adapterDir: path.join(projectPath, 'missing-adapter-dir'),
      atlasRepoRoot,
    })).toBe(vendoredDir);
  });
});

describe('semgrepAdapter.run', () => {
  it('rejects non-abort failures when semgrep does not emit parseable JSON', async () => {
    const projectPath = await makeTempDir('atlas-semgrep-run-');
    await fs.writeFile(path.join(projectPath, '.semgrep.yml'), 'rules: []\n');
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(Object.assign(new Error('semgrep config error'), { code: 2 }), '', 'invalid rules');
      return { kill() {} };
    });

    await expect(run(projectPath, ['src/file.ts'])).rejects.toThrow('Semgrep failed: invalid rules');
  });

  it('accepts non-zero exits when semgrep still produced findings JSON', async () => {
    const projectPath = await makeTempDir('atlas-semgrep-run-');
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, '.semgrep.yml'), 'rules: []\n');
    await fs.writeFile(path.join(projectPath, 'src', 'file.ts'), 'const x = 1;\n');
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('findings present'), { code: 1 }),
        JSON.stringify({
          results: [{
            path: path.join(projectPath, 'src', 'file.ts'),
            check_id: 'test.rule',
            start: { line: 8, col: 2 },
            extra: { message: 'Example finding', severity: 'WARNING' },
          }],
        }),
        '',
      );
      return { kill() {} };
    });

    const findings = await run(projectPath, ['src/file.ts']);

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'src/file.ts',
        line: 8,
        ruleId: 'test.rule',
      }),
    ]);
  });

  it('normalizes and deduplicates include paths relative to the project root', async () => {
    const projectPath = await makeTempDir('atlas-semgrep-run-');
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, '.semgrep.yml'), 'rules: []\n');
    await fs.writeFile(path.join(projectPath, 'src', 'file.ts'), 'const x = 1;\n');
    execFileMock.mockImplementation((_binary, args, _options, callback) => {
      callback(null, JSON.stringify({ results: [] }), '');
      return { kill() {} };
    });

    await run(projectPath, [
      path.join(projectPath, 'src', 'file.ts'),
      './src/file.ts',
      'src/file.ts',
    ]);

    const [, args] = execFileMock.mock.calls[0];
    const includeArgs = args.filter((value, index) => args[index - 1] === '--include');
    expect(includeArgs).toEqual(['src/file.ts']);
  });

  it('exposes Atlas-managed fallback metadata for supported repos without repo config', async () => {
    const projectPath = await makeTempDir('atlas-semgrep-run-');
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'file.ts'), 'const x = 1;\n');

    expect(getDetectionMetadata(projectPath)).toEqual(expect.objectContaining({
      policyDefaultEligible: false,
      atlasManagedEligible: true,
      runtimeReady: true,
      effectiveMode: 'atlas_managed',
      hasConfig: false,
      hasBinary: true,
      configLabel: 'Atlas vendored rules',
    }));
  });

  it('only detects fallback mode when Atlas-managed fallback is allowed', async () => {
    const projectPath = await makeTempDir('atlas-semgrep-run-');
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'file.ts'), 'const x = 1;\n');

    expect(detect(projectPath, ['src/file.ts'])).toBe(false);
    expect(detect(projectPath, ['src/file.ts'], { allowAtlasManagedFallback: true })).toBe(true);
  });

  it('uses the vendored Atlas config when fallback mode is allowed', async () => {
    const projectPath = await makeTempDir('atlas-semgrep-run-');
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'file.ts'), 'const x = 1;\n');
    execFileMock.mockImplementation((_binary, args, _options, callback) => {
      callback(null, JSON.stringify({ results: [] }), '');
      return { kill() {} };
    });

    await run(projectPath, ['src/file.ts'], { allowAtlasManagedFallback: true });

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain('--config');
    const configIndex = args.indexOf('--config');
    expect(String(args[configIndex + 1] || '')).toContain('semgrep-rules');
  });
});
