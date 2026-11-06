import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const execFileMock = vi.fn();

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

describe('eslintAdapter.run', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    execFileMock.mockReset();
    existsSyncMock.mockImplementation((filePath) => String(filePath).includes('node_modules/.bin/eslint') || String(filePath).endsWith('eslint.config.js'));
    readFileSyncMock.mockReturnValue('{}');
  });

  it('rejects non-abort execution failures that do not emit parseable JSON', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(Object.assign(new Error('bad config'), { code: 2 }), '', 'Parsing error');
      return { kill() {} };
    });

    const { run } = await import('../linter/eslintAdapter.js');

    await expect(run('/repo', ['src/file.ts'])).rejects.toThrow('ESLint failed: Parsing error');
  });

  it('accepts non-zero exits when ESLint still produced findings JSON', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('lint errors'), { code: 1 }),
        JSON.stringify([{
          filePath: '/repo/src/file.ts',
          messages: [{
            ruleId: 'no-console',
            severity: 2,
            message: 'Unexpected console statement.',
            line: 4,
            column: 3,
          }],
        }]),
        '',
      );
      return { kill() {} };
    });

    const { run } = await import('../linter/eslintAdapter.js');
    const findings = await run('/repo', ['src/file.ts']);

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'src/file.ts',
        line: 4,
        ruleId: 'no-console',
      }),
    ]);
  });
});
