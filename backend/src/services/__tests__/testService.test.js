import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import testService from '../testService.js';
import { getProjectStoragePath } from '../atlasProjectStorageService.js';

describe('testService', () => {
  let testProjectPath;
  let testDataDir;
  const originalDataDir = process.env.ATLAS_DATA_DIR;

  beforeEach(async () => {
    testProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-test-service-project-'));
    testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-test-service-data-'));
    process.env.ATLAS_DATA_DIR = testDataDir;
  });

  afterEach(async () => {
    await fs.rm(testProjectPath, { recursive: true, force: true }).catch(() => {});
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
    if (originalDataDir) {
      process.env.ATLAS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.ATLAS_DATA_DIR;
    }
  });

  it('migrates legacy repo-local tests into app data on read', async () => {
    const legacyTestsDir = path.join(testProjectPath, '.atlas', 'tests');
    await fs.mkdir(legacyTestsDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyTestsDir, 'legacy-test.json'),
      JSON.stringify({
        id: 'legacy-test',
        name: 'Legacy test',
        steps: [{ action: 'click' }],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }, null, 2),
      'utf8'
    );

    const tests = await testService.getTests(testProjectPath);

    expect(tests).toHaveLength(1);
    expect(tests[0].id).toBe('legacy-test');
    await expect(
      fs.access(getProjectStoragePath(testProjectPath, 'tests', 'legacy-test.json'))
    ).resolves.toBeUndefined();
  });

  it('migrates legacy repo-local test results into app data on read', async () => {
    const legacyResultsDir = path.join(testProjectPath, '.atlas', 'test-results');
    await fs.mkdir(legacyResultsDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyResultsDir, 'legacy-test_2026-04-01T00-00-00-000Z.json'),
      JSON.stringify({
        id: 'legacy-test_2026-04-01T00-00-00-000Z',
        testId: 'legacy-test',
        status: 'passed',
        steps: [],
        duration: 120,
        timestamp: '2026-04-01T00:00:00.000Z',
      }, null, 2),
      'utf8'
    );

    const results = await testService.getResults(testProjectPath, 'legacy-test');

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('passed');
    await expect(
      fs.access(getProjectStoragePath(testProjectPath, 'test-results', 'legacy-test_2026-04-01T00-00-00-000Z.json'))
    ).resolves.toBeUndefined();
  });

  it('reads mixed app-data and legacy tests/results during incremental migration', async () => {
    const appDataTestsDir = getProjectStoragePath(testProjectPath, 'tests');
    const appDataResultsDir = getProjectStoragePath(testProjectPath, 'test-results');
    const legacyTestsDir = path.join(testProjectPath, '.atlas', 'tests');
    const legacyResultsDir = path.join(testProjectPath, '.atlas', 'test-results');
    await fs.mkdir(appDataTestsDir, { recursive: true });
    await fs.mkdir(appDataResultsDir, { recursive: true });
    await fs.mkdir(legacyTestsDir, { recursive: true });
    await fs.mkdir(legacyResultsDir, { recursive: true });

    await fs.writeFile(
      path.join(appDataTestsDir, 'new-test.json'),
      JSON.stringify({
        id: 'new-test',
        name: 'New test',
        steps: [],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(legacyTestsDir, 'legacy-test.json'),
      JSON.stringify({
        id: 'legacy-test',
        name: 'Legacy test',
        steps: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(appDataResultsDir, 'shared-test_2026-04-02T00-00-00-000Z.json'),
      JSON.stringify({
        id: 'shared-test_2026-04-02T00-00-00-000Z',
        testId: 'shared-test',
        status: 'passed',
        steps: [],
        duration: 10,
        timestamp: '2026-04-02T00:00:00.000Z',
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(legacyResultsDir, 'shared-test_2026-04-01T00-00-00-000Z.json'),
      JSON.stringify({
        id: 'shared-test_2026-04-01T00-00-00-000Z',
        testId: 'shared-test',
        status: 'failed',
        steps: [],
        duration: 20,
        timestamp: '2026-04-01T00:00:00.000Z',
      }),
      'utf8'
    );

    const tests = await testService.getTests(testProjectPath);
    const results = await testService.getResults(testProjectPath, 'shared-test');

    expect(tests.map((test) => test.id)).toEqual(['new-test', 'legacy-test']);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.id)).toEqual([
      'shared-test_2026-04-02T00-00-00-000Z',
      'shared-test_2026-04-01T00-00-00-000Z',
    ]);
    await expect(
      fs.access(getProjectStoragePath(testProjectPath, 'tests', 'legacy-test.json'))
    ).resolves.toBeUndefined();
    await expect(
      fs.access(getProjectStoragePath(testProjectPath, 'test-results', 'shared-test_2026-04-01T00-00-00-000Z.json'))
    ).resolves.toBeUndefined();
  });

  it('falls back to legacy files when matching app-data files are unreadable', async () => {
    const appDataTestsDir = getProjectStoragePath(testProjectPath, 'tests');
    const appDataResultsDir = getProjectStoragePath(testProjectPath, 'test-results');
    const legacyTestsDir = path.join(testProjectPath, '.atlas', 'tests');
    const legacyResultsDir = path.join(testProjectPath, '.atlas', 'test-results');
    await fs.mkdir(appDataTestsDir, { recursive: true });
    await fs.mkdir(appDataResultsDir, { recursive: true });
    await fs.mkdir(legacyTestsDir, { recursive: true });
    await fs.mkdir(legacyResultsDir, { recursive: true });

    await fs.writeFile(path.join(appDataTestsDir, 'legacy-test.json'), '{"broken":', 'utf8');
    await fs.writeFile(
      path.join(legacyTestsDir, 'legacy-test.json'),
      JSON.stringify({
        id: 'legacy-test',
        name: 'Legacy fallback test',
        steps: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(appDataResultsDir, 'shared-test_2026-04-01T00-00-00-000Z.json'),
      '{"broken":',
      'utf8'
    );
    await fs.writeFile(
      path.join(legacyResultsDir, 'shared-test_2026-04-01T00-00-00-000Z.json'),
      JSON.stringify({
        id: 'shared-test_2026-04-01T00-00-00-000Z',
        testId: 'shared-test',
        status: 'passed',
        steps: [],
        duration: 20,
        timestamp: '2026-04-01T00:00:00.000Z',
      }),
      'utf8'
    );

    const tests = await testService.getTests(testProjectPath);
    const results = await testService.getResults(testProjectPath, 'shared-test');

    expect(tests).toHaveLength(1);
    expect(tests[0].id).toBe('legacy-test');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('shared-test_2026-04-01T00-00-00-000Z');
  });

  it('falls back to the legacy file when a matching app-data test file is malformed', async () => {
    const appDataTestsDir = getProjectStoragePath(testProjectPath, 'tests');
    const legacyTestsDir = path.join(testProjectPath, '.atlas', 'tests');
    await fs.mkdir(appDataTestsDir, { recursive: true });
    await fs.mkdir(legacyTestsDir, { recursive: true });

    await fs.writeFile(path.join(appDataTestsDir, 'legacy-test.json'), '{"broken":', 'utf8');
    await fs.writeFile(
      path.join(legacyTestsDir, 'legacy-test.json'),
      JSON.stringify({
        id: 'legacy-test',
        name: 'Legacy fallback test',
        steps: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }),
      'utf8'
    );

    const test = await testService.getTest(testProjectPath, 'legacy-test');

    expect(test).not.toBeNull();
    expect(test.id).toBe('legacy-test');
    expect(test.name).toBe('Legacy fallback test');
  });

  it('throws when the app-data test file is malformed and no legacy copy exists', async () => {
    const appDataTestsDir = getProjectStoragePath(testProjectPath, 'tests');
    await fs.mkdir(appDataTestsDir, { recursive: true });
    await fs.writeFile(path.join(appDataTestsDir, 'broken-test.json'), '{"broken":', 'utf8');

    await expect(testService.getTest(testProjectPath, 'broken-test')).rejects.toThrow('Unexpected end of JSON input');
  });
});
