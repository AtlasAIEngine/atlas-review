import fs from 'fs/promises';
import path from 'path';

function parseEnvBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

const SESSION_DIRS = new Map();
const ANNOUNCED_SESSIONS = new Set();
let warnedAboutIgnoredCaptureEnv = false;

function isLiveProductionServer() {
  const nodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
  return nodeEnv === 'production' && !process.env.ATLAS_DATA_DIR;
}

function getReviewDebugCaptureEnabled() {
  const enabled = parseEnvBoolean('ATLAS_REVIEW_DEBUG_CAPTURE', false);
  if (!enabled) return false;
  if (!isLiveProductionServer()) return true;

  if (!warnedAboutIgnoredCaptureEnv) {
    warnedAboutIgnoredCaptureEnv = true;
    console.warn(
      '[ReviewDebugCapture] Ignoring ATLAS_REVIEW_DEBUG_CAPTURE in production server environment.'
    );
  }
  return false;
}

function getReviewDebugCaptureFilter() {
  return String(process.env.ATLAS_REVIEW_DEBUG_CAPTURE_PROJECTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getDefaultCaptureRoot() {
  return path.resolve(process.cwd(), '.artifacts', 'review-debug');
}

function sanitizePathSegment(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function makeTimestampStamp(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function normalizeCaptureContext(context = {}) {
  const projectPath = typeof context.projectPath === 'string' ? context.projectPath : '';
  const projectId = context.projectId != null ? String(context.projectId) : '';
  const reviewType = context.reviewType != null ? String(context.reviewType) : 'review';
  const reviewId = context.reviewId != null ? String(context.reviewId) : 'unknown';
  const projectName = typeof context.projectName === 'string' && context.projectName.trim()
    ? context.projectName.trim()
    : (projectPath ? path.basename(projectPath) : 'unknown-project');
  return {
    projectPath,
    projectId,
    projectName,
    reviewType,
    reviewId,
  };
}

function matchesProjectFilter({ projectId, projectName, projectPath }) {
  const reviewDebugCaptureFilter = getReviewDebugCaptureFilter();
  if (reviewDebugCaptureFilter.length === 0) return true;
  const haystacks = [
    projectId,
    projectName,
    projectPath,
    projectPath ? path.basename(projectPath) : '',
  ].map((entry) => String(entry || '').toLowerCase());
  return reviewDebugCaptureFilter.some((needle) => {
    const normalizedNeedle = needle.toLowerCase();
    return haystacks.some((haystack) => haystack.includes(normalizedNeedle));
  });
}

export function isReviewDebugCaptureEnabled(context = {}) {
  if (!getReviewDebugCaptureEnabled()) return false;
  return matchesProjectFilter(normalizeCaptureContext(context));
}

async function ensureSessionDir(context = {}) {
  const normalized = normalizeCaptureContext(context);
  const sessionKey = [
    normalized.projectId || normalized.projectPath || normalized.projectName,
    normalized.reviewType,
    normalized.reviewId,
  ].join('|');

  if (!SESSION_DIRS.has(sessionKey)) {
    const rootDir = process.env.ATLAS_REVIEW_DEBUG_CAPTURE_DIR
      ? path.resolve(process.env.ATLAS_REVIEW_DEBUG_CAPTURE_DIR)
      : getDefaultCaptureRoot();
    const projectSegment = sanitizePathSegment(normalized.projectName, 'project');
    const reviewSegment = sanitizePathSegment(normalized.reviewType, 'review');
    const reviewIdSegment = sanitizePathSegment(normalized.reviewId, 'unknown');
    const dir = path.join(
      rootDir,
      projectSegment,
      `${reviewSegment}-${reviewIdSegment}-${makeTimestampStamp()}`
    );
    SESSION_DIRS.set(sessionKey, dir);
  }

  const dir = SESSION_DIRS.get(sessionKey);
  await fs.mkdir(dir, { recursive: true });
  if (!ANNOUNCED_SESSIONS.has(dir)) {
    ANNOUNCED_SESSIONS.add(dir);
    console.info(`[ReviewDebugCapture] Writing review debug artifacts to ${dir}`);
  }
  return dir;
}

export async function writeReviewDebugText(context = {}, fileName, text) {
  if (!isReviewDebugCaptureEnabled(context)) return null;
  try {
    const dir = await ensureSessionDir(context);
    const filePath = path.join(dir, sanitizePathSegment(fileName, 'artifact') + '.txt');
    await fs.writeFile(filePath, String(text || ''), 'utf8');
    return filePath;
  } catch (error) {
    console.warn(`[ReviewDebugCapture] Failed to write text artifact ${fileName}: ${error?.message || error}`);
    return null;
  }
}

export async function writeReviewDebugJson(context = {}, fileName, data) {
  if (!isReviewDebugCaptureEnabled(context)) return null;
  try {
    const dir = await ensureSessionDir(context);
    const filePath = path.join(dir, sanitizePathSegment(fileName, 'artifact') + '.json');
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    return filePath;
  } catch (error) {
    console.warn(`[ReviewDebugCapture] Failed to write JSON artifact ${fileName}: ${error?.message || error}`);
    return null;
  }
}
