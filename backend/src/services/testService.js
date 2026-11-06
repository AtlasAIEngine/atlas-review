/**
 * Test Service
 * Manages test cases and results stored in Atlas app data per project.
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getProjectStoragePath } from './atlasProjectStorageService.js';

function getLegacyTestsDir(projectPath) {
  return path.join(projectPath, '.atlas', 'tests');
}

function getLegacyResultsDir(projectPath) {
  return path.join(projectPath, '.atlas', 'test-results');
}

/**
 * Ensure the tests directory exists for a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<string>} - Path to the tests directory
 */
async function ensureTestsDir(projectPath) {
  const testsDir = getProjectStoragePath(projectPath, 'tests');
  await fs.mkdir(testsDir, { recursive: true });
  return testsDir;
}

/**
 * Ensure the results directory exists for a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<string>} - Path to the results directory
 */
async function ensureResultsDir(projectPath) {
  const resultsDir = getProjectStoragePath(projectPath, 'test-results');
  await fs.mkdir(resultsDir, { recursive: true });
  return resultsDir;
}

/**
 * Save a test case
 * @param {string} projectPath - Path to the project
 * @param {Object} test - Test case data
 * @param {string} [test.id] - Test ID (generated if not provided)
 * @param {string} test.name - Test name
 * @param {Array} test.steps - Test steps
 * @returns {Promise<Object>} - Saved test case with id
 */
async function saveTest(projectPath, test) {
  const testsDir = await ensureTestsDir(projectPath);
  const testId = test.id || uuidv4();
  const now = new Date().toISOString();

  const testCase = {
    id: testId,
    name: test.name,
    steps: test.steps || [],
    createdAt: test.createdAt || now,
    updatedAt: now,
  };

  const testPath = path.join(testsDir, `${testId}.json`);
  await fs.writeFile(testPath, JSON.stringify(testCase, null, 2), 'utf8');

  return testCase;
}

/**
 * Get all tests for a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - Array of test cases
 */
async function getTests(projectPath) {
  const testsDir = getProjectStoragePath(projectPath, 'tests');
  const legacyTestsDir = getLegacyTestsDir(projectPath);
  const candidateDirs = [testsDir, legacyTestsDir];
  const tests = [];
  const seenFiles = new Set();

  for (const dir of candidateDirs) {
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    for (const file of files) {
      if (!file.endsWith('.json') || seenFiles.has(file)) continue;

      try {
        const sourcePath = path.join(dir, file);
        const content = await fs.readFile(sourcePath, 'utf8');
        const test = JSON.parse(content);
        seenFiles.add(file);
        tests.push(test);
        if (dir === legacyTestsDir) {
          await ensureTestsDir(projectPath);
          await fs.copyFile(sourcePath, path.join(testsDir, file)).catch(() => {});
        }
      } catch (error) {
        console.error(`Failed to read test file ${file}:`, error.message);
      }
    }
  }

  tests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return tests;
}

/**
 * Get a single test by ID
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @returns {Promise<Object|null>} - Test case or null if not found
 */
async function getTest(projectPath, testId) {
  const testPath = getProjectStoragePath(projectPath, 'tests', `${testId}.json`);
  const legacyTestPath = path.join(getLegacyTestsDir(projectPath), `${testId}.json`);

  try {
    const content = await fs.readFile(testPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Fall through to legacy lookup.
    } else if (error.name === 'SyntaxError') {
      try {
        await fs.access(legacyTestPath);
      } catch (legacyError) {
        if (legacyError.code === 'ENOENT') {
          throw error;
        }
        throw legacyError;
      }
    } else {
      throw error;
    }
  }

  try {
    const content = await fs.readFile(legacyTestPath, 'utf8');
    await ensureTestsDir(projectPath);
    await fs.copyFile(legacyTestPath, testPath).catch(() => {});
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Delete a test by ID
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @returns {Promise<boolean>} - True if deleted, false if not found
 */
async function deleteTest(projectPath, testId) {
  const testPath = getProjectStoragePath(projectPath, 'tests', `${testId}.json`);

  try {
    await fs.unlink(testPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Save a test result
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {Object} result - Test result data
 * @returns {Promise<Object>} - Saved test result
 */
async function saveResult(projectPath, testId, result) {
  const resultsDir = await ensureResultsDir(projectPath);
  const timestamp = new Date().toISOString();
  const resultId = `${testId}_${timestamp.replace(/[:.]/g, '-')}`;

  const testResult = {
    id: resultId,
    testId,
    status: result.status,
    steps: result.steps || [],
    duration: result.duration || 0,
    timestamp,
  };

  const resultPath = path.join(resultsDir, `${resultId}.json`);
  await fs.writeFile(resultPath, JSON.stringify(testResult, null, 2), 'utf8');

  return testResult;
}

/**
 * Get test results for a test
 * @param {string} projectPath - Path to the project
 * @param {string} testId - Test ID
 * @param {number} [limit=10] - Maximum number of results to return
 * @returns {Promise<Array>} - Array of test results
 */
async function getResults(projectPath, testId, limit = 10) {
  const resultsDir = getProjectStoragePath(projectPath, 'test-results');
  const legacyResultsDir = getLegacyResultsDir(projectPath);
  const candidateDirs = [resultsDir, legacyResultsDir];
  const results = [];
  const seenFiles = new Set();

  for (const dir of candidateDirs) {
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    for (const file of files) {
      if (!file.startsWith(testId) || !file.endsWith('.json') || seenFiles.has(file)) continue;

      try {
        const sourcePath = path.join(dir, file);
        const content = await fs.readFile(sourcePath, 'utf8');
        const result = JSON.parse(content);
        seenFiles.add(file);
        results.push(result);
        if (dir === legacyResultsDir) {
          await ensureResultsDir(projectPath);
          await fs.copyFile(sourcePath, path.join(resultsDir, file)).catch(() => {});
        }
      } catch (error) {
        console.error(`Failed to read result file ${file}:`, error.message);
      }
    }
  }

  results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return results.slice(0, limit);
}

export default {
  saveTest,
  getTests,
  getTest,
  deleteTest,
  saveResult,
  getResults,
};
