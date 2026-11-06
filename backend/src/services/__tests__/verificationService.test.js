/**
 * Verification Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import verificationService from '../verificationService.js';

describe('verificationService', () => {
  let testProjectPath;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-verification-test-'));
  });

  afterEach(async () => {
    // Clean up the temp directory
    try {
      await fs.rm(testProjectPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('readPackageJson', () => {
    it('should return null when package.json does not exist', async () => {
      const result = await verificationService.readPackageJson(testProjectPath);
      expect(result).toBeNull();
    });

    it('should parse package.json correctly', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          lint: 'eslint .',
          test: 'vitest',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const result = await verificationService.readPackageJson(testProjectPath);
      expect(result).toEqual(packageJson);
    });
  });

  describe('detectAvailableChecks', () => {
    it('should return all false when no package.json exists', async () => {
      const checks = await verificationService.detectAvailableChecks(testProjectPath);
      expect(checks).toEqual({
        lint: false,
        unit: false,
        e2e: false,
        projectType: null,
      });
    });

    it('should detect lint script', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          lint: 'eslint .',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const checks = await verificationService.detectAvailableChecks(testProjectPath);
      expect(checks.lint).toBe(true);
      expect(checks.unit).toBe(false);
      expect(checks.e2e).toBe(false);
    });

    it('should detect test script for unit tests', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          test: 'vitest run',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const checks = await verificationService.detectAvailableChecks(testProjectPath);
      expect(checks.lint).toBe(false);
      expect(checks.unit).toBe(true);
      expect(checks.e2e).toBe(false);
    });

    it('should detect test:e2e script for e2e tests', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          'test:e2e': 'playwright test',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const checks = await verificationService.detectAvailableChecks(testProjectPath);
      expect(checks.lint).toBe(false);
      expect(checks.unit).toBe(false);
      expect(checks.e2e).toBe(true);
    });

    it('should detect e2e script as alternative', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          e2e: 'cypress run',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const checks = await verificationService.detectAvailableChecks(testProjectPath);
      expect(checks.e2e).toBe(true);
    });

    it('should detect all scripts when present', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          lint: 'eslint .',
          test: 'vitest run',
          'test:e2e': 'playwright test',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const checks = await verificationService.detectAvailableChecks(testProjectPath);
      expect(checks).toEqual({
        lint: true,
        unit: true,
        e2e: true,
        projectType: 'node',
      });
    });
  });

  describe('detectSuggestedChecks', () => {
    it('should infer a typecheck command for TypeScript projects without a dedicated script', async () => {
      const packageJson = {
        name: 'test-project',
        devDependencies: {
          typescript: '^5.8.0',
        },
        scripts: {
          lint: 'eslint .',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );
      await fs.writeFile(path.join(testProjectPath, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));

      const checks = await verificationService.detectSuggestedChecks(testProjectPath);

      expect(checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'typecheck',
          kind: 'typecheck',
          command: 'npx tsc --noEmit',
          enabled: true,
        }),
      ]));
    });
  });

  describe('summarizeReviewVerificationStatus', () => {
    it('includes bounded fail excerpts for failing checks when logs are present', () => {
      const summary = verificationService.summarizeReviewVerificationStatus({
        lint: 'fail',
        unit: 'pass',
        e2e: 'not_run',
        lastRunAt: '2026-02-22T18:00:00.000Z',
        logs: {
          lint: 'src/auth.ts:42 error Missing auth guard in route',
        },
      }, {
        maxFailExcerptChars: 80,
      });

      expect(summary.overallStatus).toBe('fail');
      expect(summary.lines).toContain('Checks: lint=fail, unit=pass, e2e=not_run');
      expect(summary.lines).toContain('Overall status: fail');
      expect(summary.lines).toContain('Last run: 2026-02-22T18:00:00.000Z');
      expect(summary.lines.some((line) => line.startsWith('Fail excerpt (lint):'))).toBe(true);
      expect(summary.failExcerptLines).toEqual([
        'Fail excerpt (lint): src/auth.ts:42 error Missing auth guard in route',
      ]);
    });

    it('truncates fail excerpts deterministically when logs exceed bounds', () => {
      const summary = verificationService.summarizeReviewVerificationStatus({
        lint: 'not_run',
        unit: 'fail',
        e2e: 'not_run',
        logs: {
          unit: `Error: ${'x'.repeat(200)}`,
        },
      }, {
        maxFailExcerptChars: 36,
      });

      expect(summary.failExcerptLines).toHaveLength(1);
      expect(summary.failExcerptLines[0]).toContain('Fail excerpt (unit):');
      expect(summary.failExcerptLines[0].endsWith('...')).toBe(true);
      expect(summary.lines).toContain(summary.failExcerptLines[0]);
    });

    it('redacts sensitive tokens and credentials in fail excerpts', () => {
      const summary = verificationService.summarizeReviewVerificationStatus({
        lint: 'fail',
        unit: 'not_run',
        e2e: 'not_run',
        logs: {
          lint: 'Error Authorization: Bearer sk_test_1234567890 API_KEY=supersecret https://atlas:password@example.com/auth',
        },
      }, {
        maxFailExcerptChars: 240,
      });

      expect(summary.failExcerptLines).toHaveLength(1);
      const excerpt = summary.failExcerptLines[0];
      expect(excerpt).toContain('Authorization: Bearer [REDACTED]');
      expect(excerpt).toContain('API_KEY=[REDACTED]');
      expect(excerpt).toContain('https://atlas:[REDACTED]@example.com/auth');
      expect(excerpt).not.toContain('sk_test_1234567890');
      expect(excerpt).not.toContain('supersecret');
      expect(excerpt).not.toContain('atlas:password@');
    });
  });

  describe('runCheck', () => {
    it('should throw error when package.json does not exist', async () => {
      await expect(
        verificationService.runCheck(testProjectPath, 'lint')
      ).rejects.toThrow('Check "lint" is not configured for this project');
    });

    it('should throw error when script does not exist', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {},
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      await expect(
        verificationService.runCheck(testProjectPath, 'lint')
      ).rejects.toThrow('Check "lint" is not configured for this project');
    });

    it('should run a passing check', async () => {
      // Create a simple package.json with a script that always passes
      const packageJson = {
        name: 'test-project',
        scripts: {
          lint: 'echo "lint passed"',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const result = await verificationService.runCheck(testProjectPath, 'lint');

      expect(result.status).toBe('pass');
      expect(result.exitCode).toBe(0);
      expect(result.logs).toContain('lint passed');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should run a failing check', async () => {
      // Create a package.json with a script that always fails
      const packageJson = {
        name: 'test-project',
        scripts: {
          test: 'exit 1',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const result = await verificationService.runCheck(testProjectPath, 'unit');

      expect(result.status).toBe('fail');
      expect(result.exitCode).not.toBe(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should fall back to e2e script when test:e2e does not exist', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          e2e: 'echo "e2e passed"',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const result = await verificationService.runCheck(testProjectPath, 'e2e');

      expect(result.status).toBe('pass');
      expect(result.logs).toContain('e2e passed');
    });
  });

  describe('runChecks', () => {
    it('should run multiple checks sequentially', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          lint: 'echo "lint passed"',
          test: 'echo "test passed"',
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const results = await verificationService.runChecks(testProjectPath, ['lint', 'unit']);

      expect(results.lint.status).toBe('pass');
      expect(results.unit.status).toBe('pass');
    });

    it('should handle errors for individual checks', async () => {
      const packageJson = {
        name: 'test-project',
        scripts: {
          lint: 'echo "lint passed"',
          // no test script
        },
      };

      await fs.writeFile(
        path.join(testProjectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const results = await verificationService.runChecks(testProjectPath, ['lint', 'unit']);

      expect(results.lint.status).toBe('pass');
      expect(results.unit.status).toBe('fail');
      expect(results.unit.logs).toContain('Check "unit" is not configured for this project');
    });
  });

  describe('runConfiguredCheck', () => {
    it('runs commands without a shell and preserves quoted arguments', async () => {
      const result = await verificationService.runConfiguredCheck(testProjectPath, {
        id: 'quoted',
        label: 'Quoted',
        kind: 'custom',
        command: 'node -e "console.log(\'quoted ok\')"',
      });

      expect(result.status).toBe('pass');
      expect(result.logs).toContain('quoted ok');
    });

    it('rejects shell operator syntax in configured commands', async () => {
      await expect(
        verificationService.runConfiguredCheck(testProjectPath, {
          id: 'custom',
          label: 'Custom',
          kind: 'custom',
          command: 'npm run lint && npm test',
        })
      ).rejects.toThrow('Shell operators are not supported in verification commands');
    });

    it('rejects workdirs that escape the project root', async () => {
      await expect(
        verificationService.runConfiguredCheck(testProjectPath, {
          id: 'custom',
          label: 'Custom',
          kind: 'custom',
          command: 'node -e "console.log(\'hi\')"',
          workdir: '../outside',
        })
      ).rejects.toThrow('Check workdir must stay within the project root');
    });
  });
});
