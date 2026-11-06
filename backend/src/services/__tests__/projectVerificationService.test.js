import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({
  default: {
    query: vi.fn(),
    getDbType: vi.fn(() => 'postgres'),
  },
}));

vi.mock('../verificationService.js', () => ({
  default: {
    detectProjectType: vi.fn(),
    detectSuggestedChecks: vi.fn(),
    runConfiguredCheck: vi.fn(),
  },
}));

import db from '../../db/connection.js';
import projectVerificationService from '../projectVerificationService.js';
import verificationService from '../verificationService.js';

describe('projectVerificationService', () => {
  function createCheck(id, kind, command, overrides = {}) {
    return {
      id,
      label: overrides.label || id,
      kind,
      command,
      workdir: overrides.workdir || '',
      enabled: overrides.enabled ?? true,
      source: overrides.source || 'detected',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    verificationService.detectProjectType.mockResolvedValue({ type: 'node', configFile: 'package.json' });
    verificationService.detectSuggestedChecks.mockResolvedValue([
      createCheck('lint', 'lint', 'npm run lint'),
      createCheck('typecheck', 'typecheck', 'npx tsc --noEmit'),
      createCheck('unit', 'unit', 'npm test'),
      createCheck('e2e', 'e2e', 'npm run test:e2e', { enabled: false }),
    ]);
    db.query.mockResolvedValue({ rows: [] });
  });

  it('returns detected defaults when no stored config exists', async () => {
    const config = await projectVerificationService.getProjectVerifyConfig('proj-1', '/tmp/project');

    expect(config).toEqual({
      version: 2,
      projectType: 'node',
      autoRun: 'on_changeset',
      checks: [
        createCheck('lint', 'lint', 'npm run lint'),
        createCheck('typecheck', 'typecheck', 'npx tsc --noEmit'),
        createCheck('unit', 'unit', 'npm test'),
        createCheck('e2e', 'e2e', 'npm run test:e2e', { enabled: false }),
      ],
      lint: true,
      unit: true,
      e2e: false,
    });
  });

  it('normalizes legacy stored booleans while preserving newly detected checks', async () => {
    db.query.mockResolvedValue({
      rows: [{
        value: JSON.stringify({
          lint: false,
          unit: true,
          e2e: false,
          autoRun: 'never',
        }),
      }],
    });

    const config = await projectVerificationService.getProjectVerifyConfig('proj-1', '/tmp/project');

    expect(config.autoRun).toBe('never');
    expect(config.checks).toEqual([
      expect.objectContaining({ id: 'lint', kind: 'lint', enabled: false }),
      expect.objectContaining({ id: 'typecheck', kind: 'typecheck', enabled: true }),
      expect.objectContaining({ id: 'unit', kind: 'unit', enabled: true }),
      expect.objectContaining({ id: 'e2e', kind: 'e2e', enabled: false }),
    ]);
    expect(config.lint).toBe(false);
    expect(config.unit).toBe(true);
    expect(config.e2e).toBe(false);
  });

  it('updates and persists project verify config', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const updated = await projectVerificationService.updateProjectVerifyConfig('proj-1', '/tmp/project', {
      autoRun: 'never',
      checks: [
        createCheck('lint', 'lint', 'pnpm lint', { label: 'Lint' }),
        {
          id: 'build',
          label: 'Build',
          kind: 'build',
          command: 'pnpm build',
          enabled: true,
          source: 'custom',
        },
      ],
    });

    expect(updated.autoRun).toBe('never');
    expect(updated.checks).toEqual([
      expect.objectContaining({ id: 'lint', command: 'pnpm lint', kind: 'lint' }),
      expect.objectContaining({ id: 'typecheck', command: 'npx tsc --noEmit', kind: 'typecheck' }),
      expect.objectContaining({ id: 'build', command: 'pnpm build', kind: 'build', source: 'custom' }),
      expect.objectContaining({ id: 'unit', command: 'npm test', kind: 'unit' }),
      expect.objectContaining({ id: 'e2e', command: 'npm run test:e2e', kind: 'e2e', enabled: false }),
    ]);
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO settings'),
      [
        'verify_config:proj-1',
        expect.stringContaining('"autoRun":"never"'),
      ]
    );
  });

  it('runs only the requested enabled checks by kind or id', async () => {
    verificationService.runConfiguredCheck.mockImplementation(async (_projectPath, check) => ({
      status: 'pass',
      exitCode: 0,
      logs: `ran ${check.id}`,
      duration: 12,
      checkId: check.id,
      kind: check.kind,
      label: check.label,
    }));

    const config = {
      checks: [
        createCheck('lint', 'lint', 'npm run lint'),
        createCheck('typecheck', 'typecheck', 'npx tsc --noEmit'),
        createCheck('unit', 'unit', 'npm test', { enabled: false }),
      ],
    };

    const result = await projectVerificationService.runProjectVerification('/tmp/project', config, ['typecheck', 'lint']);

    expect(result.checksToRun.map((check) => check.id)).toEqual(['typecheck', 'lint']);
    expect(Object.keys(result.results)).toEqual(['typecheck', 'lint']);
    expect(verificationService.runConfiguredCheck).toHaveBeenCalledTimes(2);
  });

  it('evaluates publish gates against custom check results', () => {
    const config = {
      checks: [
        createCheck('lint', 'lint', 'npm run lint'),
        createCheck('typecheck', 'typecheck', 'npx tsc --noEmit'),
      ],
    };
    const verification = {
      lint: 'pass',
      checks: {
        typecheck: {
          id: 'typecheck',
          status: 'fail',
        },
      },
    };

    const gate = projectVerificationService.evaluateVerificationGate(config, verification);

    expect(gate.enabledChecks.map((check) => check.id)).toEqual(['lint', 'typecheck']);
    expect(gate.failedChecks.map((check) => check.id)).toEqual(['typecheck']);
    expect(gate.notRunChecks).toEqual([]);
  });

  it('supports auto-run mode decisions', () => {
    expect(projectVerificationService.shouldAutoRunVerification({ autoRun: 'on_changeset' })).toBe(true);
    expect(projectVerificationService.shouldAutoRunVerification({ autoRun: 'never' })).toBe(false);
    expect(projectVerificationService.shouldAutoRunVerification({ autoRun: 'invalid' })).toBe(true);
  });
});
