import fs from 'fs/promises';
import path from 'path';

const RETRYABLE_PARSE_PATTERNS = [
  /Unexpected end of JSON input/i,
  /Unterminated string in JSON/i,
  /Expected ',' or '}' after property value/i,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableParseError(error) {
  if (!(error instanceof SyntaxError)) return false;
  const message = String(error.message || '');
  return RETRYABLE_PARSE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Read and parse a JSON file, retrying briefly for transient parse failures
 * caused by concurrent writers.
 *
 * @param {string} filePath
 * @param {{ maxAttempts?: number, retryDelayMs?: number, encoding?: BufferEncoding }} [options]
 * @returns {Promise<any>}
 */
export async function readJsonFileWithRetry(filePath, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 4));
  const retryDelayMs = Math.max(1, Number(options.retryDelayMs || 10));
  const encoding = options.encoding || 'utf8';

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const content = await fs.readFile(filePath, encoding);
      return JSON.parse(content);
    } catch (error) {
      lastError = error;
      if (error?.code === 'ENOENT') {
        throw error;
      }
      const canRetry = isRetryableParseError(error) && attempt < maxAttempts;
      if (!canRetry) {
        throw error;
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError;
}

/**
 * Atomically write JSON to disk using temp-file + rename.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ space?: number, encoding?: BufferEncoding }} [options]
 * @returns {Promise<void>}
 */
export async function writeJsonFileAtomic(filePath, value, options = {}) {
  const space = Number.isInteger(options.space) ? options.space : 2;
  const encoding = options.encoding || 'utf8';
  const serialized = JSON.stringify(value, null, space);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, serialized, encoding);

  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}
