import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempDirs = [];
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ATLAS_DATA_DIR = process.env.ATLAS_DATA_DIR;

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importCapture() {
  return import('../reviewDebugCapture.js');
}

describe('reviewDebugCapture', () => {
  beforeEach(() => {
    delete process.env.ATLAS_REVIEW_DEBUG_CAPTURE;
    delete process.env.ATLAS_REVIEW_DEBUG_CAPTURE_PROJECTS;
    delete process.env.ATLAS_REVIEW_DEBUG_CAPTURE_DIR;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ATLAS_DATA_DIR == null) {
      delete process.env.ATLAS_DATA_DIR;
    } else {
      process.env.ATLAS_DATA_DIR = ORIGINAL_ATLAS_DATA_DIR;
    }
  });

  afterEach(async () => {
    vi.resetModules();
    delete process.env.ATLAS_REVIEW_DEBUG_CAPTURE;
    delete process.env.ATLAS_REVIEW_DEBUG_CAPTURE_PROJECTS;
    delete process.env.ATLAS_REVIEW_DEBUG_CAPTURE_DIR;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ATLAS_DATA_DIR == null) {
      delete process.env.ATLAS_DATA_DIR;
    } else {
      process.env.ATLAS_DATA_DIR = ORIGINAL_ATLAS_DATA_DIR;
    }
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }));
  });

  it('writes artifacts only when capture is enabled and the project filter matches', async () => {
    const outputDir = await makeTempDir('atlas-review-debug-');
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE = 'true';
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE_PROJECTS = 'ExampleProject';
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE_DIR = outputDir;

    const { isReviewDebugCaptureEnabled, writeReviewDebugJson, writeReviewDebugText } = await importCapture();
    const context = {
      projectId: '243fdf78-0f14-4243-9547-babd9c9dc353',
      projectPath: '/tmp/example-developer/Projects/LILAGames/ExampleProject',
      reviewType: 'branch_review',
      reviewId: 'br-123',
    };

    expect(isReviewDebugCaptureEnabled(context)).toBe(true);

    const jsonPath = await writeReviewDebugJson(context, 'linter-prepass', { findings: [{ ruleId: 'CA2000' }] });
    const textPath = await writeReviewDebugText(context, 'prompt-standard', 'full prompt text');

    expect(jsonPath).toBeTruthy();
    expect(textPath).toBeTruthy();
    await expect(fs.readFile(jsonPath, 'utf8')).resolves.toContain('"CA2000"');
    await expect(fs.readFile(textPath, 'utf8')).resolves.toBe('full prompt text');
  });

  it('does not write artifacts when the project filter does not match', async () => {
    const outputDir = await makeTempDir('atlas-review-debug-');
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE = 'true';
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE_PROJECTS = 'AtlasEngineMVP';
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE_DIR = outputDir;

    const { isReviewDebugCaptureEnabled, writeReviewDebugText } = await importCapture();
    const context = {
      projectPath: '/tmp/example-developer/Projects/LILAGames/ExampleProject',
      reviewType: 'branch_review',
      reviewId: 'br-123',
    };

    expect(isReviewDebugCaptureEnabled(context)).toBe(false);
    const result = await writeReviewDebugText(context, 'prompt-standard', 'should not exist');
    expect(result).toBeNull();
    await expect(fs.readdir(outputDir)).resolves.toEqual([]);
  });

  it('ignores capture when running on a production server build', async () => {
    const outputDir = await makeTempDir('atlas-review-debug-');
    process.env.NODE_ENV = 'production';
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE = 'true';
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE_DIR = outputDir;

    const { isReviewDebugCaptureEnabled, writeReviewDebugText } = await importCapture();
    const context = {
      projectPath: '/tmp/example-developer/Projects/LILAGames/ExampleProject',
      reviewType: 'branch_review',
      reviewId: 'br-456',
    };

    expect(isReviewDebugCaptureEnabled(context)).toBe(false);
    const result = await writeReviewDebugText(context, 'prompt-standard', 'should not exist');
    expect(result).toBeNull();
    await expect(fs.readdir(outputDir)).resolves.toEqual([]);
  });

  it('still allows capture in desktop production mode', async () => {
    const outputDir = await makeTempDir('atlas-review-debug-');
    process.env.NODE_ENV = 'production';
    process.env.ATLAS_DATA_DIR = '/tmp/atlas-desktop-appdata';
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE = 'true';
    process.env.ATLAS_REVIEW_DEBUG_CAPTURE_DIR = outputDir;

    const { isReviewDebugCaptureEnabled, writeReviewDebugText } = await importCapture();
    const context = {
      projectPath: '/tmp/example-developer/Projects/LILAGames/ExampleProject',
      reviewType: 'branch_review',
      reviewId: 'br-789',
    };

    expect(isReviewDebugCaptureEnabled(context)).toBe(true);
    const result = await writeReviewDebugText(context, 'prompt-standard', 'desktop debug prompt');
    expect(result).toBeTruthy();
    await expect(fs.readFile(result, 'utf8')).resolves.toBe('desktop debug prompt');
  });
});
