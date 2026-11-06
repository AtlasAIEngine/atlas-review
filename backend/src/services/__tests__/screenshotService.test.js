import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import screenshotService from '../screenshotService.js';
import { getProjectStoragePath } from '../atlasProjectStorageService.js';

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0mQAAAAASUVORK5CYII=';

describe('screenshotService', () => {
  let testProjectPath;
  let testDataDir;
  const originalDataDir = process.env.ATLAS_DATA_DIR;

  beforeEach(async () => {
    testProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-screenshot-project-'));
    testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-screenshot-data-'));
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

  it('migrates a legacy repo-local baseline into app data on read', async () => {
    const legacyScreenshotsDir = path.join(testProjectPath, '.atlas', 'screenshots');
    await fs.mkdir(legacyScreenshotsDir, { recursive: true });
    const legacyBaselinePath = path.join(legacyScreenshotsDir, 'legacy-test_step0_baseline.png');
    await fs.writeFile(legacyBaselinePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'));

    const baseline = await screenshotService.getBaseline(testProjectPath, 'legacy-test', 0);

    expect(baseline.exists).toBe(true);
    expect(baseline.imageData).toBe(`data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`);
    await expect(
      fs.access(getProjectStoragePath(testProjectPath, 'screenshots', 'legacy-test_step0_baseline.png'))
    ).resolves.toBeUndefined();
  });
});
