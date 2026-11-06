/**
 * Screenshot Service
 * Manages screenshot storage, baselines, and visual comparison
 * Screenshots are stored in Atlas app data per project.
 */

import fs from 'fs/promises';
import path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { getProjectStoragePath } from './atlasProjectStorageService.js';

/**
 * Ensure the screenshots directory exists for a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<string>} - Path to the screenshots directory
 */
async function ensureScreenshotsDir(projectPath) {
  const screenshotsDir = getProjectStoragePath(projectPath, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });
  return screenshotsDir;
}

/**
 * Get the screenshot path for a specific test step
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} stepIndex - Step index
 * @param {string} type - 'current' or 'baseline'
 * @returns {string} - Path to the screenshot file
 */
function getScreenshotPath(projectPath, testId, stepIndex, type) {
  return getProjectStoragePath(projectPath, 'screenshots', `${testId}_step${stepIndex}_${type}.png`);
}

/**
 * Get the diff image path for a specific test step
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} stepIndex - Step index
 * @returns {string} - Path to the diff image file
 */
function getDiffPath(projectPath, testId, stepIndex) {
  return getProjectStoragePath(projectPath, 'screenshots', `${testId}_step${stepIndex}_diff.png`);
}

function getLegacyScreenshotPath(projectPath, testId, stepIndex, type) {
  return path.join(projectPath, '.atlas', 'screenshots', `${testId}_step${stepIndex}_${type}.png`);
}

/**
 * Convert base64 image data to PNG buffer
 * @param {string} base64Data - Base64 encoded PNG data (with or without data URL prefix)
 * @returns {Buffer} - PNG buffer
 */
function base64ToBuffer(base64Data) {
  // Remove data URL prefix if present
  const base64Clean = base64Data.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(base64Clean, 'base64');
}

/**
 * Convert buffer to base64 data URL
 * @param {Buffer} buffer - PNG buffer
 * @returns {string} - Base64 data URL
 */
function bufferToBase64(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

/**
 * Save a screenshot
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} stepIndex - Step index
 * @param {string} imageData - Base64 encoded PNG data
 * @param {string} type - 'current' or 'baseline'
 * @returns {Promise<{path: string, size: number}>} - Saved file info
 */
async function saveScreenshot(projectPath, testId, stepIndex, imageData, type = 'current') {
  await ensureScreenshotsDir(projectPath);

  const screenshotPath = getScreenshotPath(projectPath, testId, stepIndex, type);
  const buffer = base64ToBuffer(imageData);

  await fs.writeFile(screenshotPath, buffer);

  const stats = await fs.stat(screenshotPath);
  return {
    path: screenshotPath,
    size: stats.size,
  };
}

/**
 * Get baseline screenshot
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} stepIndex - Step index
 * @returns {Promise<{exists: boolean, imageData?: string, path?: string}>} - Baseline info
 */
async function getBaseline(projectPath, testId, stepIndex) {
  const baselinePath = getScreenshotPath(projectPath, testId, stepIndex, 'baseline');
  const legacyBaselinePath = getLegacyScreenshotPath(projectPath, testId, stepIndex, 'baseline');

  try {
    const buffer = await fs.readFile(baselinePath);
    return {
      exists: true,
      imageData: bufferToBase64(buffer),
      path: baselinePath,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    const buffer = await fs.readFile(legacyBaselinePath);
    await ensureScreenshotsDir(projectPath);
    await fs.copyFile(legacyBaselinePath, baselinePath).catch(() => {});
    return {
      exists: true,
      imageData: bufferToBase64(buffer),
      path: baselinePath,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
}

/**
 * Set current screenshot as baseline
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} stepIndex - Step index
 * @returns {Promise<{success: boolean, path: string}>} - Result
 */
async function setBaseline(projectPath, testId, stepIndex) {
  const currentPath = getScreenshotPath(projectPath, testId, stepIndex, 'current');
  const baselinePath = getScreenshotPath(projectPath, testId, stepIndex, 'baseline');

  try {
    await fs.copyFile(currentPath, baselinePath);
    return {
      success: true,
      path: baselinePath,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Current screenshot not found. Run the test first to capture a screenshot.');
    }
    throw error;
  }
}

/**
 * Set screenshot directly from image data as baseline
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} stepIndex - Step index
 * @param {string} imageData - Base64 encoded PNG data
 * @returns {Promise<{success: boolean, path: string}>} - Result
 */
async function setBaselineFromData(projectPath, testId, stepIndex, imageData) {
  await ensureScreenshotsDir(projectPath);

  const baselinePath = getScreenshotPath(projectPath, testId, stepIndex, 'baseline');
  const buffer = base64ToBuffer(imageData);

  await fs.writeFile(baselinePath, buffer);

  return {
    success: true,
    path: baselinePath,
  };
}

/**
 * Compare two screenshots using pixelmatch
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} stepIndex - Step index
 * @param {string} currentImageData - Base64 encoded PNG data of current screenshot
 * @param {number} threshold - Pixel difference threshold (0-1, default 0.1)
 * @returns {Promise<{match: boolean, matchPercentage: number, diffImageData?: string, totalPixels: number, diffPixels: number}>}
 */
async function compareScreenshots(projectPath, testId, stepIndex, currentImageData, threshold = 0.001) {
  // Get baseline
  const baseline = await getBaseline(projectPath, testId, stepIndex);
  if (!baseline.exists) {
    return {
      match: false,
      matchPercentage: 0,
      totalPixels: 0,
      diffPixels: 0,
      error: 'No baseline found',
      noBaseline: true,
    };
  }

  try {
    // Parse both images
    const currentBuffer = base64ToBuffer(currentImageData);
    const baselineBuffer = base64ToBuffer(baseline.imageData);

    const currentPng = PNG.sync.read(currentBuffer);
    const baselinePng = PNG.sync.read(baselineBuffer);

    // Check dimensions match
    if (currentPng.width !== baselinePng.width || currentPng.height !== baselinePng.height) {
      // Dimensions don't match - resize or report as diff
      return {
        match: false,
        matchPercentage: 0,
        totalPixels: currentPng.width * currentPng.height,
        diffPixels: currentPng.width * currentPng.height,
        error: `Dimensions differ: current ${currentPng.width}x${currentPng.height} vs baseline ${baselinePng.width}x${baselinePng.height}`,
      };
    }

    const { width, height } = currentPng;
    const diff = new PNG({ width, height });

    // Compare pixels
    const diffPixels = pixelmatch(
      baselinePng.data,
      currentPng.data,
      diff.data,
      width,
      height,
      { threshold } // Sensitivity threshold (0-1, lower = more strict)
    );

    const totalPixels = width * height;
    const diffPercentage = (diffPixels / totalPixels) * 100;
    const matchPercentage = 100 - diffPercentage;

    // Encode diff image
    const diffBuffer = PNG.sync.write(diff);
    const diffImageData = bufferToBase64(diffBuffer);

    // Save diff image
    await ensureScreenshotsDir(projectPath);
    const diffPath = getDiffPath(projectPath, testId, stepIndex);
    await fs.writeFile(diffPath, diffBuffer);

    return {
      match: diffPixels === 0,
      matchPercentage: parseFloat(matchPercentage.toFixed(2)),
      diffImageData,
      totalPixels,
      diffPixels,
      baselineImageData: baseline.imageData,
    };
  } catch (error) {
    return {
      match: false,
      matchPercentage: 0,
      totalPixels: 0,
      diffPixels: 0,
      error: `Comparison failed: ${error.message}`,
    };
  }
}

/**
 * Delete all screenshots for a test
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @returns {Promise<{deleted: number}>} - Number of files deleted
 */
async function deleteTestScreenshots(projectPath, testId) {
  const screenshotsDir = getProjectStoragePath(projectPath, 'screenshots');

  try {
    const files = await fs.readdir(screenshotsDir);
    let deleted = 0;

    for (const file of files) {
      if (file.startsWith(`${testId}_`)) {
        await fs.unlink(path.join(screenshotsDir, file));
        deleted++;
      }
    }

    return { deleted };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { deleted: 0 };
    }
    throw error;
  }
}

/**
 * Get current screenshot
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} stepIndex - Step index
 * @returns {Promise<{exists: boolean, imageData?: string, path?: string}>} - Current screenshot info
 */
async function getCurrent(projectPath, testId, stepIndex) {
  const currentPath = getScreenshotPath(projectPath, testId, stepIndex, 'current');

  try {
    const buffer = await fs.readFile(currentPath);
    return {
      exists: true,
      imageData: bufferToBase64(buffer),
      path: currentPath,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
}

export default {
  saveScreenshot,
  getBaseline,
  getCurrent,
  setBaseline,
  setBaselineFromData,
  compareScreenshots,
  deleteTestScreenshots,
};
