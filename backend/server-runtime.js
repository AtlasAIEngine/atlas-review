/**
 * AtlasEngine MVP - Main Server
 * Express server with all routes and middleware
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { createHash, randomUUID } from 'crypto';
import { resolveTrackedBranchReviewStatus } from './src/utils/branchReviewStatus.js';
import {
  classifyToolOperation,
  isSnapshotEligibleFileMutationTool,
} from '../shared/toolOperationClassifier.js';

const execFileAsync = promisify(execFile);
const cliRunExecutor = createCliRunExecutor();

/**
 * Find the Claude CLI path
 * Tries common locations and falls back to PATH lookup
 */
function findClaudePath() {
  const homeDir = process.env.HOME || os.homedir();
  const isWindows = process.platform === 'win32';
  const candidates = [
    path.join(homeDir, '.local', 'bin', 'claude'), // User local installation (most reliable)
    '/opt/homebrew/bin/claude',               // Homebrew on Apple Silicon
    '/usr/local/bin/claude',                  // Homebrew on Intel or manual install
  ];

  // On Windows, also check for .exe variants
  if (isWindows) {
    candidates.unshift(
      path.join(homeDir, '.local', 'bin', 'claude.exe'),
    );
  }

  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable, try next
    }
  }

  // Try 'where' on Windows, 'which' on Unix
  const lookupCmd = isWindows ? 'where claude' : 'which claude';
  try {
    const result = execSync(lookupCmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (result) return result;
  } catch {
    // lookup failed
  }

  throw new Error('Claude CLI not found. Please install Claude Code CLI.');
}

let cachedClaudePath = null;
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
let authCache = null;

function getClaudePath() {
  if (process.env.CLAUDE_CLI_PATH) {
    return process.env.CLAUDE_CLI_PATH;
  }

  if (cachedClaudePath) {
    return cachedClaudePath;
  }

  cachedClaudePath = findClaudePath();
  return cachedClaudePath;
}

function getCachedAuthStatus() {
  if (authCache && Date.now() - authCache.timestamp < AUTH_CACHE_TTL_MS) {
    return { authenticated: authCache.authenticated, error: authCache.error };
  }
  return null;
}

async function checkClaudeAuth(skipCache = false) {
  if (!skipCache) {
    const cached = getCachedAuthStatus();
    if (cached) {
      return cached;
    }
  }

  try {
    const claudePath = getClaudePath();
    await execFileAsync(claudePath, ['--version'], { timeout: 10000 });
    const result = { authenticated: true };
    authCache = { ...result, timestamp: Date.now() };
    return result;
  } catch (error) {
    const message = error?.message || 'Claude CLI not available.';
    const result = { authenticated: false, error: message };
    authCache = { ...result, timestamp: Date.now() };
    return result;
  }
}

async function buildProviderSpawnEnv(providerType, baseEnv) {
  if (providerType === 'anthropic') {
    return buildClaudeCliEnv(baseEnv);
  }

  if (providerType === 'google') {
    // Gemini CLI refuses to run in untrusted workspaces by default (exit 55).
    // Atlas only invokes Gemini in projects the user has explicitly selected,
    // so trust the workspace to enable headless execution. Caller-set value wins.
    return {
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      ...baseEnv,
    };
  }

  return baseEnv;
}

async function resolveProviderLaunchCommand(cliAdapter, cliArgs) {
  if (cliAdapter.getType() === 'anthropic') {
    const { binary, args } = await findClaudeBinary();
    return {
      binaryPath: binary,
      args: [...args, ...cliArgs],
    };
  }

  return {
    binaryPath: await cliAdapter.findBinary(),
    args: cliArgs,
  };
}

function shouldIncludeBuildSummaryPath(filePath) {
  return typeof filePath === 'string'
    && !filePath.startsWith('.claude/')
    && !filePath.startsWith('.claude\\')
    && !filePath.startsWith('.atlas/')
    && !filePath.startsWith('.atlas\\')
    && filePath !== 'CLAUDE.md';
}

function collectStatusFileSets(status) {
  const newFiles = new Set([
    ...(status.not_added || []),
    ...(status.created || []),
  ]);
  const modifiedFiles = new Set([
    ...(status.modified || []),
    ...(status.deleted || []),
    ...((status.renamed || []).flatMap((r) => [r.from, r.to])),
  ]);

  return { newFiles, modifiedFiles };
}

async function hashFileContent(absolutePath) {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    const content = await fs.readFile(absolutePath);
    return createHash('sha1').update(content).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function captureGitStatusSnapshot(projectPath) {
  const isGitRepo = await gitService.isGitRepository(projectPath);
  if (!isGitRepo) {
    return null;
  }

  const simpleGit = (await import('simple-git')).default;
  const git = simpleGit(projectPath);
  const status = await git.status();
  const { newFiles, modifiedFiles } = collectStatusFileSets(status);

  const allPaths = Array.from(new Set([
    ...newFiles,
    ...modifiedFiles,
  ]))
    .filter(shouldIncludeBuildSummaryPath)
    .sort();

  const files = {};
  for (const filePath of allPaths) {
    const absolutePath = path.join(projectPath, filePath);
    const hash = await hashFileContent(absolutePath);
    files[filePath] = {
      category: newFiles.has(filePath) ? 'new' : 'modified',
      hash,
    };
  }

  return { files };
}

function buildGitStatusDeltaSummary(beforeSnapshot, afterSnapshot) {
  if (!beforeSnapshot || !afterSnapshot) {
    return null;
  }

  const beforeFiles = beforeSnapshot.files || {};
  const afterFiles = afterSnapshot.files || {};
  const changedPaths = new Set([
    ...Object.keys(beforeFiles),
    ...Object.keys(afterFiles),
  ]);
  const newFiles = new Set();
  const modifiedFiles = new Set();

  for (const filePath of changedPaths) {
    const before = beforeFiles[filePath] || null;
    const after = afterFiles[filePath] || null;
    // We only summarize files that remain dirty after the request.
    // If a file was dirty before but is now clean (committed/reverted),
    // it should not be reported as a new request-side change.
    if (!after) {
      continue;
    }

    const changed =
      !before
      || before.hash !== after.hash
      || before.category !== after.category;

    if (!changed) {
      continue;
    }

    if (after?.category === 'new') {
      newFiles.add(filePath);
    } else {
      modifiedFiles.add(filePath);
    }
  }

  for (const filePath of newFiles) {
    modifiedFiles.delete(filePath);
  }

  const filePaths = Array.from(new Set([
    ...newFiles,
    ...modifiedFiles,
  ])).sort();

  if (filePaths.length === 0) {
    return null;
  }

  return {
    filesChanged: filePaths.length,
    filePaths,
    newFiles: Array.from(newFiles).sort(),
    modifiedFiles: Array.from(modifiedFiles).sort(),
  };
}

function emitProjectSocketEvent(socket, projectId, eventName, payload) {
  socket.emit(eventName, payload);
  socket.to(`project-${projectId}`).emit(eventName, payload);
}

async function snapshotToolUseFileChange({ toolEvent, projectPath, fileSnapshots }) {
  if (!toolEvent || !isSnapshotEligibleFileMutationTool(toolEvent.name, toolEvent.input)) {
    return;
  }

  const toolClassification = classifyToolOperation(toolEvent.name, toolEvent.input);
  const rawFilePath = toolClassification.filePath;
  if (!rawFilePath || isBinaryFile(rawFilePath)) {
    return;
  }

  const fullPath = path.isAbsolute(rawFilePath)
    ? rawFilePath
    : path.join(projectPath, rawFilePath);
  const filePath = path.isAbsolute(rawFilePath)
    ? path.relative(projectPath, rawFilePath)
    : rawFilePath;

  try {
    const beforeContent = await fs.readFile(fullPath, 'utf-8');
    fileSnapshots.set(toolEvent.id, { filePath, beforeContent, fullPath });
  } catch (error) {
    fileSnapshots.set(toolEvent.id, { filePath, beforeContent: null, fullPath });
  }
}

function normalizeReviewFixCoverageFilePath(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
  return normalized || null;
}

function buildReviewFixFindingFilePathMap(rawFindings = []) {
  if (!Array.isArray(rawFindings)) {
    return {};
  }

  return rawFindings.reduce((acc, finding) => {
    if (!finding || typeof finding !== 'object') {
      return acc;
    }

    const recommendationKey = String(finding.recommendationKey || '').trim().toLowerCase();
    if (!recommendationKey) {
      return acc;
    }

    const filePaths = Array.from(new Set(
      (Array.isArray(finding.filePaths) ? finding.filePaths : [])
        .map((value) => normalizeReviewFixCoverageFilePath(value))
        .filter(Boolean)
    )).sort();

    if (filePaths.length === 0) {
      return acc;
    }

    acc[recommendationKey] = filePaths;
    return acc;
  }, {});
}

async function resolveReviewFixProjectPath(project, reviewType, reviewId) {
  const defaultPath = project?.path || project?.projectPath || null;
  if (!defaultPath || reviewType !== 'branch_review' || !reviewId) {
    return defaultPath;
  }

  try {
    const review = await branchReviewService.getById(reviewId);
    const branchName = String(review?.branchName || review?.branch_name || '').trim();
    if (!branchName) {
      return defaultPath;
    }

    const worktrees = await gitService.listWorktrees(defaultPath);
    const matchingWorktree = Array.isArray(worktrees)
      ? worktrees.find((entry) => String(entry?.branch || '').trim() === branchName)
      : null;
    const worktreePath = String(matchingWorktree?.path || '').trim();
    if (worktreePath) {
      return worktreePath;
    }
  } catch (error) {
    console.warn('[FixRun] Failed to resolve branch worktree path:', error.message);
  }

  return defaultPath;
}

async function computeToolSnapshotDiffs({ fileSnapshots, socket, projectId, eventFactory }) {
  const changesetFilesMap = new Map();

  for (const [toolId, snapshot] of fileSnapshots.entries()) {
    const { filePath, beforeContent, fullPath } = snapshot;

    try {
      const afterContent = await fs.readFile(fullPath, 'utf-8');
      const stats = computeDiffStats(beforeContent, afterContent);
      const language = detectLanguage(filePath);

      changesetFilesMap.set(filePath, {
        path: filePath,
        before: changesetFilesMap.get(filePath)?.before ?? beforeContent,
        after: afterContent,
      });

      emitProjectSocketEvent(socket, projectId, eventFactory.event, eventFactory.build({
        toolCallId: toolId,
        filePath,
        beforeContent,
        afterContent,
        isNewFile: beforeContent === null,
        language,
        stats,
      }));
    } catch (error) {
      console.error(`Failed to compute review-fix diff for ${filePath}:`, error.message);
    }
  }

  return changesetFilesMap;
}

function buildFixSummaryFromChanges({ changesetFilesMap, gitStatusSummary, createdChangeset }) {
  const summaryNewFiles = new Set(
    Array.from(changesetFilesMap.entries())
      .filter(([_, file]) => file.before === null)
      .map(([filePath]) => filePath)
  );
  const summaryModifiedFiles = new Set(
    Array.from(changesetFilesMap.entries())
      .filter(([_, file]) => file.before !== null)
      .map(([filePath]) => filePath)
  );

  if (gitStatusSummary) {
    for (const filePath of gitStatusSummary.newFiles) {
      summaryNewFiles.add(filePath);
    }
    for (const filePath of gitStatusSummary.modifiedFiles) {
      summaryModifiedFiles.add(filePath);
    }
  }

  for (const filePath of summaryNewFiles) {
    summaryModifiedFiles.delete(filePath);
  }

  const filePaths = Array.from(new Set([
    ...summaryNewFiles,
    ...summaryModifiedFiles,
  ])).sort();

  if (filePaths.length === 0) {
    return null;
  }

  return {
    filesChanged: filePaths.length,
    filePaths,
    newFiles: Array.from(summaryNewFiles).sort(),
    modifiedFiles: Array.from(summaryModifiedFiles).sort(),
    changesetId: createdChangeset?.id || null,
    changesetTitle: createdChangeset?.title || null,
  };
}

const PROJECT_NAMING_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'htm',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'java',
  'kt',
  'go',
  'rs',
  'php',
  'css',
  'scss',
  'sql',
]);
const PROJECT_NAMING_MAX_ATTACHMENT_BYTES = 96 * 1024;
const PROJECT_NAMING_MAX_ATTACHMENT_CHARS = 1800;

function normalizeAttachmentSnippet(content) {
  const collapsed = String(content || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= PROJECT_NAMING_MAX_ATTACHMENT_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, PROJECT_NAMING_MAX_ATTACHMENT_CHARS - 3).trim()}...`;
}

function isTextAttachment(filePath, meta) {
  const mimeType = String(meta?.mimetype || meta?.mimeType || '').toLowerCase();
  if (mimeType.startsWith('text/')) return true;
  if (mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('yaml')) return true;

  const extension = path.extname(String(filePath || '')).replace('.', '').toLowerCase();
  return PROJECT_NAMING_TEXT_EXTENSIONS.has(extension);
}

async function buildAttachmentNamingSummaries(attachmentMeta, attachmentPaths) {
  const paths = Array.isArray(attachmentPaths) ? attachmentPaths : [];
  const metaList = Array.isArray(attachmentMeta) ? attachmentMeta : [];
  const summaries = [];

  for (let index = 0; index < paths.length && summaries.length < 4; index += 1) {
    const filePath = paths[index];
    const meta = metaList[index] || {};
    if (!filePath || !isTextAttachment(filePath, meta)) {
      continue;
    }

    try {
      const stat = await fs.stat(filePath);
      if (stat.size > PROJECT_NAMING_MAX_ATTACHMENT_BYTES) {
        continue;
      }

      const content = await fs.readFile(filePath, 'utf8');
      const snippet = normalizeAttachmentSnippet(content);
      if (!snippet) {
        continue;
      }

      const label = meta.originalName || meta.filename || meta.name || path.basename(filePath);
      summaries.push(`${label}: ${snippet}`);
    } catch (error) {
      console.warn(`Failed to read attachment for project naming (${filePath}): ${error.message}`);
    }
  }

  return summaries;
}

async function maybeAutoNameProjectFromContext({
  projectId,
  userPrompt,
  assistantResponse,
  attachmentMeta,
  attachmentPaths,
  socket,
}) {
  try {
    const latestProject = await getProjectById(projectId);
    if (!latestProject || !isPlaceholderProjectName(latestProject.name)) {
      return;
    }

    const generatedName = await generateProjectName({
      userPrompt,
      projectDescription: latestProject.description || '',
      assistantResponse,
      attachmentNames: Array.isArray(attachmentMeta)
        ? attachmentMeta.map((item) => item?.originalName || item?.filename || item?.name || item).filter(Boolean)
        : [],
      attachmentSummaries: await buildAttachmentNamingSummaries(attachmentMeta, attachmentPaths),
    });

    if (!generatedName || generatedName === latestProject.name || isPlaceholderProjectName(generatedName)) {
      return;
    }

    const reloadedProject = await getProjectById(projectId);
    if (!reloadedProject || !isPlaceholderProjectName(reloadedProject.name)) {
      return;
    }

    await updateProject(projectId, { name: generatedName });

    const payload = { projectId, name: generatedName };
    socket.emit('project-updated', payload);
    socket.to(`project-${projectId}`).emit('project-updated', payload);
  } catch (error) {
    console.warn(`Failed to auto-name project ${projectId}: ${error.message}`);
  }
}

// Import database
import db from './src/db/connection.js';
import {
  getProjectById,
  getActivePreview,
  saveChatMessage,
  getChatHistory,
  updateProject,
  upsertChatStreamState,
  getChatStreamState,
  clearChatStreamState,
  clearAllChatStreamStates,
  updateMessageFileDiff,
  updateChatMessageContent,
} from './src/db/queries.js';

// Import services
import dockerService from './src/services/dockerService.js';
import portRegistry from './src/services/portRegistry.js';
import claudeService from './src/services/claudeService.js';
import providerService from './src/services/providerService.js';
import { buildProjectSystemPrompt, buildReviewAgentSystemPrompt } from './src/services/systemPromptService.js';
import memoryService from './src/services/memoryService.js';
import { generateProjectName, isPlaceholderProjectName } from './src/services/projectNamingService.js';
import previewStateService from './src/services/previewStateService.js';
import syncWorker from './src/services/syncWorker.js';
import { resolveSlashCommand } from './src/services/slashCommandService.js';
import devServerService from './src/services/devServerService.js';
import { buildClaudeCliEnv } from './src/services/claudeTokenService.js';
import { injectUiSelectionScript } from './src/utils/uiSelectionScript.js';
import { injectTestRunnerScript } from './src/utils/testRunnerScript.js';
import { injectRecorderScript } from './src/utils/recorderScript.js';
import { findClaudeBinary } from './src/utils/claudeBinary.js';
import { canAccessProjectFromSocket } from './src/utils/projectSocketAuthorization.js';
import {
  formatUiEditsContext,
  formatUiSelectionContext,
  normalizeUiEdits,
  normalizeUiSelection,
} from './src/utils/uiSelection.js';
import { computeDiffStats, detectLanguage, isBinaryFile } from './src/services/diffService.js';
import changesetService from './src/services/changesetService.js';
import gitService from './src/services/gitService.js';
import gitWatcherService from './src/services/gitWatcherService.js';
import prReviewSyncService from './src/services/prReviewSyncService.js';
import prReviewRefreshService from './src/services/prReviewRefreshService.js';
import branchReviewService from './src/services/branchReviewService.js';
import {
  resolvePreservedForkPointSha,
  resolveEffectiveDiffStats,
} from './src/services/review/branchReviewReconcileHelpers.js';
import { isBranchAutoReviewSuppressedForSnapshot } from './src/services/review/branchAutoReviewSuppression.js';
import prReviewService from './src/services/prReviewService.js';
import {
  BUILDER_RUN_POLICY,
  REVIEW_FIX_RUN_POLICY,
  REVIEW_AGENT_RUN_POLICY,
  CLI_RUN_EVENT_TYPES,
  CLI_RUN_TYPES,
  buildReviewFixPrompt,
  selectReviewFixRecommendations,
  createCliRunExecutor,
} from './src/services/review/reviewFixExecutor.js';
import {
  buildFixCompletionStatusEvents,
  buildFixRecommendationStatusEvents,
  resolveReviewFixObservedChanges,
  createFixCompleteEvent,
  createFixErrorEvent,
  createFixFileDiffEvent,
  createFixStartedEvent,
  createFixStatusEvent,
  createFixStoppedEvent,
  createFixStreamEvent,
  createFixToolUseEvent,
  buildReviewFixRunStatus,
  REVIEW_FIX_RECOMMENDATION_STATUSES,
} from './src/services/review/reviewFixEvents.js';
import reviewFixRunStore from './src/services/review/reviewFixRunStore.js';
import reviewAgentStore from './src/services/review/reviewAgentStore.js';
import reviewAgentContextService from './src/services/review/reviewAgentContextService.js';
import { inferReviewAgentActionsFromRequest, parseReviewAgentActions } from './src/services/review/reviewAgentActionParser.js';
import {
  getCachedAuthStatusForReviewAgent,
  resolveCachedReviewAgentLaunchCommand,
} from './src/services/review/reviewAgentCliCache.js';
import atlasHostingService from './src/services/atlasHostingService.js';
import { buildReviewLifecycle } from './src/utils/reviewLifecycle.js';
import { shouldRotateBranchReviewOnHeadChange } from './src/utils/branchReviewIncarnation.js';
import { getClearedBranchReviewSnapshotFields, hasPersistedBranchReviewSnapshot } from './src/utils/branchReviewSnapshot.js';
import { shouldContinueWithoutDocker } from './src/utils/dockerStartup.js';
import { buildCliExitErrorMessage } from './src/utils/cliExitError.js';
import { getAdapter, hasAdapter, getAvailableAdapters, getSupportedAdapters } from './src/services/cliAdapters/index.js';
import { resolveOpenCodeDirectApiParams } from './src/services/openCodeConfigResolver.js';

// Import middleware
import { enforceQuotas, getQuotaSummary } from './src/middleware/quotas.js';
import reviewSyncService from './src/services/reviewSyncService.js';
import {
  authenticateJWT,
  extractBearerToken,
  requireAuth,
  requireAdmin,
  verifyJWTToken,
} from './src/middleware/auth.js';
const app = globalThis.__ATLAS_BOOT_APP;
const io = globalThis.__ATLAS_BOOT_IO;

if (!app || !io) {
  throw new Error('Atlas runtime bootstrap globals are missing.');
}

// Server configuration
const NODE_ENV = process.env.NODE_ENV || 'development';
const SERVER_BOOT_STARTED_AT = globalThis.__ATLAS_SERVER_BOOT_STARTED_AT || Date.now();
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // Tauri app origins (desktop mode)
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];
// In desktop mode, allow all origins since the backend is bound to 127.0.0.1 only.
// Tauri WebView origins vary by platform/version and can't be reliably enumerated.
const IS_DESKTOP = process.env.ATLAS_DESKTOP_MODE === 'true';
const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1):\d+$/i;
const CORS_ORIGINS = IS_DESKTOP
  ? true
  : (process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_CORS_ORIGINS);

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (CORS_ORIGINS === true) return true;
  if (Array.isArray(CORS_ORIGINS) && CORS_ORIGINS.includes(origin)) return true;
  return NODE_ENV !== 'production' && LOCAL_DEV_ORIGIN_RE.test(origin);
}

function buildCorsOriginHandler() {
  if (CORS_ORIGINS === true) {
    return true;
  }

  return (origin, callback) => {
    if (isAllowedCorsOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed by CORS'));
  };
}

const corsOriginHandler = buildCorsOriginHandler();

let _reviewServicePromise = null;
let _reviewServiceEventBridgePromise = null;
let _reviewServiceEventBridgeAttached = false;

async function getReviewService() {
  if (_reviewServicePromise) {
    return _reviewServicePromise;
  }

  const importStartedAt = Date.now();
  _reviewServicePromise = import('./src/services/reviewService.js')
    .then((module) => {
      console.log(`[startup] reviewService imported lazily in ${Date.now() - importStartedAt}ms`);
      return module.default;
    })
    .catch((error) => {
      _reviewServicePromise = null;
      throw error;
    });

  return _reviewServicePromise;
}

async function ensureReviewServiceEventBridge() {
  if (_reviewServiceEventBridgeAttached) {
    return getReviewService();
  }

  if (_reviewServiceEventBridgePromise) {
    return _reviewServiceEventBridgePromise;
  }

  _reviewServiceEventBridgePromise = getReviewService()
    .then((reviewService) => {
      if (!_reviewServiceEventBridgeAttached) {
        attachReviewServiceEventBridge(reviewService);
        _reviewServiceEventBridgeAttached = true;
      }
      return reviewService;
    })
    .catch((error) => {
      _reviewServiceEventBridgePromise = null;
      throw error;
    });

  return _reviewServiceEventBridgePromise;
}

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const ADMIN_ONLY_IN_PRODUCTION_MIDDLEWARE = NODE_ENV === 'production'
  ? [authenticateJWT, requireAuth, requireAdmin]
  : [];

function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

function getSocketHandshakeToken(socket) {
  const authToken = socket?.handshake?.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }

  return extractBearerToken(socket?.handshake?.headers?.authorization);
}

async function requireSocketProjectAccess(socket, projectId, options = {}) {
  const normalizedProjectId = String(projectId || '').trim();
  const eventName = options.eventName || 'project-access-denied';
  const extraPayload = options.payload && typeof options.payload === 'object' ? options.payload : {};

  const deny = (error) => {
    socket.emit(eventName, {
      projectId: normalizedProjectId || null,
      error,
      ...extraPayload,
    });
    if (typeof options.ack === 'function') {
      options.ack({ success: false, error });
    }
    return null;
  };

  if (!normalizedProjectId) {
    return deny('projectId is required');
  }

  let project;
  try {
    project = await getProjectById(normalizedProjectId);
  } catch {
    return deny('Project access check failed');
  }

  if (!project) {
    return deny('Project not found');
  }

  if (!canAccessProjectFromSocket(project, socket)) {
    return deny('Forbidden');
  }

  return { project, projectId: normalizedProjectId };
}

// Connect SyncWorker to Socket.IO for WebSocket events
syncWorker.setIo(io);
app.set('io', io);

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Security headers
// In development and desktop mode, disable helmet to avoid CORS/CSP issues.
// Desktop mode is bound to 127.0.0.1 so there's no external attack surface.
if (NODE_ENV === 'production' && !IS_DESKTOP) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", ...(Array.isArray(CORS_ORIGINS) ? CORS_ORIGINS : [])],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  }));
} else {
  // Development/Desktop: Disable helmet entirely
  if (NODE_ENV !== 'production') {
    console.log('⚠️  Running in development mode - Helmet security headers disabled');
  }
}

// CORS - Enhanced configuration for development
app.use(cors({
  origin: corsOriginHandler,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Request-Id'],
  maxAge: 86400 // 24 hours
}));

// Body parsers
// Store raw body for webhook signature verification
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    // Store raw body for GitHub webhook signature verification
    if (req.url === '/api/github/webhook') {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging (development only)
if (NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`\n=== Incoming Request ===`);
    console.log(`${req.method} ${req.path}`);
    console.log(`Origin: ${req.headers.origin || 'none'}`);
    console.log(`Authorization: ${req.headers.authorization ? 'present' : 'none'}`);
    console.log(`Content-Type: ${req.headers['content-type'] || 'none'}`);

    // Capture response
    const originalSend = res.send;
    res.send = function(data) {
      console.log(`Response Status: ${res.statusCode}`);
      console.log(`======================\n`);
      originalSend.call(this, data);
    };

    next();
  });
}

// Mock authentication middleware (replace with real JWT auth)
app.use((req, res, next) => {
  // For MVP, we use anonymous user by default (no auth required)
  // In production, this would verify JWT tokens and set req.user
  if (req.headers.authorization) {
    req.user = {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'anonymous@atlasengine.local'
    };
  }
  next();
});

// ============================================================================
// ROUTES
// ============================================================================

export async function handleRuntimeHealth(req, res) {
  try {
    const dbHealth = await db.healthCheck();

    // Skip Docker health check in desktop mode (Docker may not be running)
    const isDesktopMode = process.env.ATLAS_DESKTOP_MODE === 'true';
    const dockerHealth = isDesktopMode
      ? { healthy: true, skipped: true }
      : await dockerService.healthCheck();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: dbHealth.healthy ? 'connected' : 'disconnected',
      docker: dockerHealth.healthy ? 'connected' : 'disconnected',
      portRegistry: {
        available: portRegistry.getStats().available,
        allocated: portRegistry.getStats().allocated,
        utilization: portRegistry.getStats().utilizationPercent + '%'
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
}

// Serve the test runner script as a static file
// This is used by the preview proxy to inject test automation into iframes
app.get('/atlas-test-runner.js', async (req, res) => {
  try {
    const scriptPath = path.join(import.meta.dirname, 'public', 'atlas-test-runner.js');
    const scriptContent = await fs.readFile(scriptPath, 'utf8');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // Don't cache during dev
    res.send(scriptContent);
  } catch (error) {
    console.error('Failed to serve test runner script:', error);
    res.status(500).send('// Failed to load test runner script');
  }
});

// Serve the recorder script as a static file
// This is used by the preview proxy to inject test recording into iframes
app.get('/atlas-recorder.js', async (req, res) => {
  try {
    const scriptPath = path.join(import.meta.dirname, 'public', 'atlas-recorder.js');
    const scriptContent = await fs.readFile(scriptPath, 'utf8');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // Don't cache during dev
    res.send(scriptContent);
  } catch (error) {
    console.error('Failed to serve recorder script:', error);
    res.status(500).send('// Failed to load recorder script');
  }
});

// Serve html2canvas library for screenshot capture (used by atlas-ui-selection.js and atlas-test-runner.js)
app.get('/html2canvas.min.js', async (req, res) => {
  try {
    const scriptPath = path.join(import.meta.dirname, 'public', 'html2canvas.min.js');
    const scriptContent = await fs.readFile(scriptPath, 'utf8');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(scriptContent);
  } catch (error) {
    console.error('Failed to serve html2canvas:', error);
    res.status(500).send('// Failed to load html2canvas');
  }
});

// Serve the UI selection script as a static file
// This is used by the preview proxy to inject UI selection into iframes
app.get('/atlas-ui-selection.js', async (req, res) => {
  try {
    const scriptPath = path.join(import.meta.dirname, 'public', 'atlas-ui-selection.js');
    const scriptContent = await fs.readFile(scriptPath, 'utf8');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(scriptContent);
  } catch (error) {
    console.error('Failed to serve UI selection script:', error);
    res.status(500).send('// Failed to load UI selection script');
  }
});

function createLazyRouter(importer, label) {
  let routerPromise = null;

  return async (req, res, next) => {
    try {
      if (!routerPromise) {
        const importStartedAt = Date.now();
        routerPromise = importer()
          .then((module) => {
            console.log(`[startup] Lazy route ${label} loaded in ${Date.now() - importStartedAt}ms`);
            return module.default;
          });
      }

      const router = await routerPromise;
      return router(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
}

// API routes
app.use('/api/projects', createLazyRouter(() => import('./src/routes/projects.js'), 'projects'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/agentInstructions.js'), 'agentInstructions'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/memory.js'), 'memory'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/reviewPolicy.js'), 'reviewPolicy'));
app.use('/api/builds', createLazyRouter(() => import('./src/routes/builds.js'), 'builds'));
app.use('/api/previews', createLazyRouter(() => import('./src/routes/previews.js'), 'previews'));
app.use('/api/chat', createLazyRouter(() => import('./src/routes/chat.js'), 'chat'));
app.use('/api/devservers', createLazyRouter(() => import('./src/routes/devServers.js'), 'devServers'));
app.use('/api/github', createLazyRouter(() => import('./src/routes/github.js'), 'github'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/tests.js'), 'tests'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/changesets.js'), 'changesets'));
app.use('/api', createLazyRouter(() => import('./src/routes/atlasHosting.js'), 'atlasHosting'));
app.use('/api', createLazyRouter(() => import('./src/routes/secrets.js'), 'secrets'));
app.use('/api/claude', createLazyRouter(() => import('./src/routes/claude.js'), 'claude'));
app.use('/api/settings', createLazyRouter(() => import('./src/routes/settings.js'), 'settings'));
app.use('/api/providers', createLazyRouter(() => import('./src/routes/providers.js'), 'providers'));
app.use('/api', createLazyRouter(() => import('./src/routes/reviews.js'), 'reviews'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/branchReviews.js'), 'branchReviews'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/workspaceReviews.js'), 'workspaceReviews'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/prReviews.js'), 'prReviews'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/reviewAgent.js'), 'reviewAgent'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/walkthroughs.js'), 'walkthroughs'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/codegraph.js'), 'codegraph'));
app.use('/api/projects', createLazyRouter(() => import('./src/routes/trustAnalytics.js'), 'trustAnalytics'));
app.use('/api/usage', createLazyRouter(() => import('./src/routes/usage.js'), 'usage'));
app.use('/api/supabase', createLazyRouter(() => import('./src/routes/supabase.js'), 'supabase'));
app.use('/api/templates', createLazyRouter(() => import('./src/routes/templates.js'), 'templates'));
app.use('/api/mcp', createLazyRouter(() => import('./src/routes/mcp.js'), 'mcp'));
app.use('/api/review-sync', createLazyRouter(() => import('./src/routes/reviewSync.js'), 'reviewSync'));
app.use('/api/auth', createLazyRouter(() => import('./src/routes/auth.js'), 'auth'));
app.use('/api/admin', createLazyRouter(() => import('./src/routes/admin.js'), 'admin'));

app.get('/api/chat/sessions/:projectId/runtime-status', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    if (project.user_id !== getEffectiveUserId(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const activeProcess = activeProjectProcesses.get(projectId);
    const streamState = chatStreamCache.get(projectId);

    res.json({
      success: true,
      active: Boolean(activeProcess),
      startedAt: activeProcess ? new Date(activeProcess.startedAt).toISOString() : null,
      hasStreamContent: Boolean(streamState?.content),
      streamStartedAt: streamState?.startedAt || null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/projects/:projectId/preview-state', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

     if (project.user_id !== getEffectiveUserId(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const activeProcess = activeProjectProcesses.get(projectId);
    const streamState = chatStreamCache.get(projectId);
    const preview = await previewStateService.getProjectPreviewState({
      projectId,
      projectPath: project.path,
      hasActiveAiRun: Boolean(activeProcess),
      hasStreamContent: Boolean(streamState?.content),
    });

    res.json({
      success: true,
      preview,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CLI adapter discovery endpoint — returns available CLI tools for build mode
app.get('/api/cli-adapters', async (req, res) => {
  try {
    const available = await getAvailableAdapters();
    res.json({ success: true, adapters: available });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Quota summary endpoint
app.get('/api/quotas/summary', enforceQuotas, getQuotaSummary);

// Port registry stats (admin only in production)
app.get('/api/admin/ports', ...ADMIN_ONLY_IN_PRODUCTION_MIDDLEWARE, (req, res) => {
  const stats = portRegistry.getStats();
  const allocations = portRegistry.getAllocations();

  res.json({
    stats,
    allocations
  });
});

// Docker stats (admin only in production)
app.get('/api/admin/docker', ...ADMIN_ONLY_IN_PRODUCTION_MIDDLEWARE, async (req, res) => {
  try {
    const containers = await dockerService.listContainers();
    const health = await dockerService.healthCheck();

    res.json({
      health,
      containers
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Claude sessions stats (admin only in production)
app.get('/api/admin/claude-sessions', ...ADMIN_ONLY_IN_PRODUCTION_MIDDLEWARE, (req, res) => {
  try {
    const sessions = claudeService.getAllSessions();

    res.json({
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.isActive).length,
      sessions: sessions.map(s => ({
        ...s,
        uptimeFormatted: formatUptime(s.uptime),
        lastActivityRelative: formatRelativeTime(s.lastActivity),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper functions for formatting
function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatRelativeTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'just now';
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

const PREVIEW_PROXY_COOKIE = 'atlas_preview_proxy';

// Server-side active preview tracking for desktop mode.
// In Tauri production builds, both Set-Cookie headers AND document.cookie are
// blocked by WebKit ITP (the iframe at http://127.0.0.1:PORT is third-party
// relative to the main window at tauri://localhost). The Referer fallback only
// works one level deep (HTML → scripts), but not for nested ES module imports
// (script → module) because the Referer becomes the importing script's URL.
// Track active previews per requester instead of process-wide to avoid routing
// one user's asset requests into another user's project preview.
const desktopActivePreviewByClient = new Map();

function getPreviewClientKey(req) {
  const remoteAddress = req.socket?.remoteAddress || req.ip || 'unknown';
  const userId = req.user?.id || ANONYMOUS_USER_ID;
  return `${userId}::${remoteAddress}`;
}

const PREVIEW_PROXY_HEADERS_BLOCKLIST = new Set([
  'content-length',
  'content-encoding',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
]);

function parsePreviewProxyCookie(cookieHeader) {
  const raw = getCookieValue(cookieHeader, PREVIEW_PROXY_COOKIE);
  if (!raw) return null;
  const [mode, projectId] = raw.split(':');
  if (!mode || !projectId) return null;
  if (mode !== 'dev' && mode !== 'docker') return null;
  return { mode, projectId };
}

async function resolveAuthorizedProject(projectId, req, res) {
  const project = await getProjectById(projectId);

  if (!project) {
    res.status(404).send('Project not found');
    return null;
  }

  if (project.user_id !== getEffectiveUserId(req)) {
    res.status(403).send('Forbidden');
    return null;
  }

  return project;
}

async function proxyRequestWithPort({ projectId, port, req, res, pathOverride, cookieValue, testMode }) {
  if (!port) {
    res.status(502).send('Preview not running');
    return true;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('Method not allowed');
    return true;
  }

  const targetPath = pathOverride || req.url || '/';
  const targetUrl = `http://localhost:${port}${targetPath}`;
  let response;

  try {
    response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'user-agent': req.headers['user-agent'] || 'AtlasEngine-Preview-Proxy',
        accept: req.headers.accept || '*/*',
      },
    });
  } catch (error) {
    console.error('Preview proxy fetch error:', error);
    res.status(502).send('Error loading preview');
    return true;
  }

  const contentType = response.headers.get('content-type') || '';
  res.status(response.status);

  response.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (PREVIEW_PROXY_HEADERS_BLOCKLIST.has(normalized)) {
      return;
    }
    res.setHeader(key, value);
  });

  if (cookieValue) {
    res.append(
      'set-cookie',
      `${PREVIEW_PROXY_COOKIE}=${encodeURIComponent(cookieValue)}; Path=/; SameSite=Lax`
    );
  }

  if (contentType.includes('text/html')) {
    let html = await response.text();

    // Track the active preview server-side.
    // Third-party cookie restrictions in modern browsers (and Tauri/WebKit ITP)
    // prevent cookies set via document.cookie in cross-origin iframes from being
    // sent with sub-resource requests. This server-side tracking ensures all
    // asset requests are routed correctly regardless of cookie availability.
    if (cookieValue) {
      const sepIdx = cookieValue.indexOf(':');
      if (sepIdx !== -1) {
        desktopActivePreviewByClient.set(getPreviewClientKey(req), {
          mode: cookieValue.slice(0, sepIdx),
          projectId: cookieValue.slice(sepIdx + 1),
        });
      }
    }

    // Also inject cookie via inline script for same-origin contexts (dev mode, browser).
    if (cookieValue) {
      const cookieScript = `<script>document.cookie="${PREVIEW_PROXY_COOKIE}=${encodeURIComponent(cookieValue)};path=/;samesite=lax";</script>`;
      const headIdx = html.indexOf('<head>');
      if (headIdx !== -1) {
        html = html.slice(0, headIdx + 6) + cookieScript + html.slice(headIdx + 6);
      } else {
        html = cookieScript + html;
      }
    }

    // Rewrite the browser path to strip the /preview-proxy/... prefix so that
    // client-side routers (React Router, Vue Router, etc.) see the correct path.
    // Asset and navigation requests still work via the cookie/desktop catch-all.
    const pathRewriteScript = `<script>(function(){var m=window.location.pathname.match(/^\\/preview-proxy\\/(?:dev|docker)\\/[^/]+(\\/.*)$/);if(m)window.history.replaceState(null,"",m[1]+window.location.search+window.location.hash);})()</script>`;
    const headIdx2 = html.indexOf('<head>');
    if (headIdx2 !== -1) {
      html = html.slice(0, headIdx2 + 6) + pathRewriteScript + html.slice(headIdx2 + 6);
    } else {
      html = pathRewriteScript + html;
    }

    // Always inject UI selection script
    html = injectUiSelectionScript(html);
    // Always inject test runner script (so tests can run without page reload)
    html = injectTestRunnerScript(html);
    // Always inject recorder script (so recording can start without page reload)
    html = injectRecorderScript(html);
    res.setHeader('content-type', contentType);
    res.send(html);
    return true;
  }

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
  return true;
}

async function proxyDevServerRequest(projectId, req, res, pathOverride, testMode = false) {
  const project = await resolveAuthorizedProject(projectId, req, res);
  if (!project) {
    return true;
  }
  const status = await devServerService.getDevServerStatus(projectId, project?.path || null);

  if (!status.running || !status.port) {
    res.status(502).send('Dev server not running');
    return true;
  }

  return proxyRequestWithPort({
    projectId,
    port: status.port,
    req,
    res,
    pathOverride,
    cookieValue: `dev:${projectId}`,
    testMode,
  });
}

async function proxyDockerPreviewRequest(projectId, req, res, pathOverride, testMode = false) {
  const project = await resolveAuthorizedProject(projectId, req, res);
  if (!project) {
    return true;
  }
  const preview = await getActivePreview(projectId);

  if (!preview || !preview.port) {
    res.status(502).send('Preview not running');
    return true;
  }

  return proxyRequestWithPort({
    projectId,
    port: preview.port,
    req,
    res,
    pathOverride,
    cookieValue: `docker:${projectId}`,
    testMode,
  });
}

// Proxy dev server previews to inject UI selection tooling
app.use('/preview-proxy/dev/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const testMode = req.query.atlasTest === '1';
    await proxyDevServerRequest(projectId, req, res, req.url, testMode);
  } catch (error) {
    console.error('Preview proxy error:', error);
    res.status(502).send('Error loading preview');
  }
});

// Proxy docker previews to inject UI selection tooling
app.use('/preview-proxy/docker/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const testMode = req.query.atlasTest === '1';
    await proxyDockerPreviewRequest(projectId, req, res, req.url, testMode);
  } catch (error) {
    console.error('Docker preview proxy error:', error);
    res.status(502).send('Error loading preview');
  }
});

// Proxy asset requests when the preview cookie is set (supports absolute paths from dev servers)
app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }

  if (
    req.path.startsWith('/preview-proxy/dev/') ||
    req.path.startsWith('/preview-proxy/docker/') ||
    req.path.startsWith('/preview/') ||
    req.path.startsWith('/api') ||
    req.path.startsWith('/socket.io') ||
    req.path === '/health' ||
    // Atlas injected scripts served from backend/public/ — must not be proxied
    req.path.startsWith('/atlas-') ||
    req.path === '/html2canvas.min.js'
  ) {
    return next();
  }

  let proxyInfo = parsePreviewProxyCookie(req.headers.cookie);

  // Fallback 1: extract project info from Referer header (handles first-level sub-resources).
  if (!proxyInfo && req.headers.referer) {
    const match = req.headers.referer.match(/\/preview-proxy\/(dev|docker)\/([^/?#]+)/);
    if (match) {
      proxyInfo = { mode: match[1], projectId: match[2] };
    }
  }

  // Fallback 2: use server-side active preview for desktop mode.
  // Handles nested ES module imports where both cookies and Referer are unavailable.
  if (!proxyInfo) {
    proxyInfo = desktopActivePreviewByClient.get(getPreviewClientKey(req)) || null;
  }

  if (!proxyInfo) {
    return next();
  }

  try {
    const handled =
      proxyInfo.mode === 'docker'
        ? await proxyDockerPreviewRequest(proxyInfo.projectId, req, res, req.originalUrl)
        : await proxyDevServerRequest(proxyInfo.projectId, req, res, req.originalUrl);
    if (!handled) {
      return next();
    }
  } catch (error) {
    console.error('Preview proxy asset error:', error);
    res.status(502).send('Error loading preview asset');
  }
});

// Static file server for project previews
app.use('/preview/:projectId', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const project = await resolveAuthorizedProject(projectId, req, res);
    if (!project) return;

    const express = await import('express');
    const fs = await import('fs/promises');
    const pathModule = await import('path');

    const selectionEnabled = req.query.atlasSelect === '1';
    const testMode = req.query.atlasTest === '1';

    // Check if public folder exists
    const publicPath = pathModule.default.join(project.path, 'public');
    let hasPublicFolder = false;
    try {
      const stat = await fs.stat(publicPath);
      hasPublicFolder = stat.isDirectory();
    } catch (err) {
      // public folder doesn't exist, that's fine
    }

    const requestedPath = req.path === '/' ? '/index.html' : req.path;
    const isHtmlRequest = requestedPath.endsWith('.html');

    if ((selectionEnabled || testMode) && req.method === 'GET' && isHtmlRequest) {
      const candidatePaths = [];
      if (hasPublicFolder) {
        candidatePaths.push(pathModule.default.join(publicPath, requestedPath));
      }
      candidatePaths.push(pathModule.default.join(project.path, requestedPath));

      for (const candidate of candidatePaths) {
        try {
          let html = await fs.readFile(candidate, 'utf8');
          // Always inject all scripts for consistency with proxy routes
          // This ensures tests, recording, and UI selection work without page reload
          html = injectUiSelectionScript(html);
          html = injectTestRunnerScript(html);
          html = injectRecorderScript(html);
          res.setHeader('content-type', 'text/html');
          return res.send(html);
        } catch (err) {
          // Continue to next candidate
        }
      }
    }

    // If public folder exists, serve from there first (for CSS, JS, images)
    if (hasPublicFolder) {
      const publicMiddleware = express.default.static(publicPath);
      publicMiddleware(req, res, (err) => {
        if (err) return next(err);

        // If file not found in public, try serving from root (for index.html)
        const rootMiddleware = express.default.static(project.path, {
          index: ['index.html', 'index.htm'],
          extensions: ['html', 'htm'],
        });
        rootMiddleware(req, res, next);
      });
    } else {
      // No public folder - serve from root only
      const staticMiddleware = express.default.static(project.path, {
        index: ['index.html', 'index.htm'],
        extensions: ['html', 'htm'],
      });
      staticMiddleware(req, res, next);
    }
  } catch (error) {
    console.error('Static file server error:', error);
    res.status(500).send('Error serving preview');
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ============================================================================
// WEBSOCKET
// ============================================================================

// Track active Claude processes per project to prevent concurrent access
const activeProjectProcesses = new Map(); // projectId -> { process, startedAt }
// Track in-progress chat stream content for recovery
const chatStreamCache = new Map(); // projectId -> { content, startedAt }
const chatStreamLastPersist = new Map(); // projectId -> timestamp
const CHAT_STREAM_PERSIST_DEBOUNCE_MS = 1000;
// Kill CLI process if no stdout data received within this window (prevents indefinite hangs on cold-start timeouts)
const CLI_INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

async function persistChatStreamState(projectId, force = false) {
  const cache = chatStreamCache.get(projectId);
  if (!cache) return;

  const now = Date.now();
  const lastPersist = chatStreamLastPersist.get(projectId) || 0;

  if (!force && now - lastPersist < CHAT_STREAM_PERSIST_DEBOUNCE_MS) {
    return;
  }

  try {
    await upsertChatStreamState(projectId, cache.content, cache.startedAt);
    chatStreamLastPersist.set(projectId, now);
  } catch (error) {
    console.warn('Failed to persist chat stream state:', error.message);
  }
}

async function clearChatStream(projectId) {
  chatStreamCache.delete(projectId);
  chatStreamLastPersist.delete(projectId);

  try {
    await clearChatStreamState(projectId);
  } catch (error) {
    console.warn('Failed to clear chat stream state:', error.message);
  }
}

function createAssistantSegmentTracker({ projectId, userId }) {
  const segments = [];
  let currentSegment = null;

  const startSegment = (initialText = '') => {
    const segment = {
      id: null,
      content: initialText,
      insertPromise: null,
    };

    segments.push(segment);
    currentSegment = segment;

    segment.insertPromise = saveChatMessage({
      projectId,
      userId,
      role: 'assistant',
      content: segment.content || '',
      tokensUsed: 0,
      model: null,
      meta: null,
    })
      .then((saved) => {
        segment.id = saved?.id || null;
      })
      .catch((error) => {
        console.error('Failed to save assistant segment:', error.message);
      });

    return segment;
  };

  const appendText = (text) => {
    if (!text) return;
    if (!currentSegment) {
      startSegment(text);
    } else {
      currentSegment.content += text;
    }
    return currentSegment?.content || '';
  };

  const closeSegment = () => {
    currentSegment = null;
  };

  const finalize = async ({ tokensUsed, model }) => {
    if (segments.length === 0) return false;
    const finalTokens = Number.isFinite(tokensUsed) ? tokensUsed : null;
    const finalModel = model || null;
    let anySaved = false;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.insertPromise) {
        await segment.insertPromise;
      }
      if (!segment.id) continue;
      anySaved = true;
      const isLast = i === segments.length - 1;
      try {
        await updateChatMessageContent(
          segment.id,
          segment.content,
          isLast ? finalTokens : null,
          isLast ? finalModel : null
        );
      } catch (error) {
        console.error('Failed to update assistant segment:', error.message);
      }
    }

    return anySaved;
  };

  return { appendText, closeSegment, finalize };
}

/**
 * Resolve the default chat provider when none is explicitly requested.
 * Priority: DEFAULT_CHAT_PROVIDER env var → OpenCode (if installed) → anthropic fallback.
 * @returns {Promise<string>} Provider type key (e.g. 'opencode', 'anthropic')
 */
let _cachedDefaultChatProvider = null;
async function resolveDefaultChatProvider() {
  if (_cachedDefaultChatProvider) return _cachedDefaultChatProvider;

  const envDefault = process.env.DEFAULT_CHAT_PROVIDER;
  if (envDefault && hasAdapter(envDefault)) {
    _cachedDefaultChatProvider = envDefault;
    return envDefault;
  }
  // Prefer OpenCode when the binary is actually installed (not just registered)
  if (hasAdapter('opencode')) {
    try {
      await getAdapter('opencode').findBinary();
      _cachedDefaultChatProvider = 'opencode';
      return 'opencode';
    } catch {
      // Binary not found — fall through to anthropic
    }
  }
  _cachedDefaultChatProvider = 'anthropic';
  return 'anthropic';
}

async function resolvePreferredReviewCliProvider({ requestedProvider, requestedModel } = {}) {
  const normalizedRequestedProvider = typeof requestedProvider === 'string'
    ? requestedProvider.trim().toLowerCase()
    : '';
  const normalizedRequestedModel = typeof requestedModel === 'string'
    ? requestedModel.trim()
    : '';

  if (normalizedRequestedProvider && hasAdapter(normalizedRequestedProvider)) {
    return {
      providerType: normalizedRequestedProvider,
      model: normalizedRequestedModel || null,
    };
  }

  try {
    const contextActive = await providerService.getContextActiveProvider('review');
    if (contextActive?.providerId) {
      const providerSnapshot = await providerService.getProviders();
      const matchedProvider = Array.isArray(providerSnapshot?.providers)
        ? providerSnapshot.providers.find((provider) => provider?.id === contextActive.providerId)
        : null;
      const matchedProviderType = typeof matchedProvider?.type === 'string'
        ? matchedProvider.type.trim().toLowerCase()
        : '';
      if (matchedProviderType && hasAdapter(matchedProviderType)) {
        return {
          providerType: matchedProviderType,
          model:
            normalizedRequestedModel
            || (typeof contextActive.model === 'string' ? contextActive.model.trim() : '')
            || null,
        };
      }
    }
  } catch {
    // Fall through to the default resolver.
  }

  return {
    providerType: await resolveDefaultChatProvider(),
    model: normalizedRequestedModel || null,
  };
}

function buildReviewAgentAdapterArgs({
  cliAdapter,
  message,
  sessionId,
  model,
  projectPath,
  systemPrompt,
  resumeSession,
}) {
  if (cliAdapter.getType() === 'anthropic' && typeof cliAdapter.buildAgenticArgs === 'function') {
    return cliAdapter.buildAgenticArgs({
      message,
      sessionId,
      model,
      projectPath,
      systemPrompt,
      resumeSession,
      permissionStrategy: 'allowedTools',
      maxTurns: 8,
    });
  }

  return cliAdapter.buildArgs({
    message,
    sessionId,
    model,
    projectPath,
    systemPrompt,
    resumeSession,
    readOnly: true,
  });
}

io.use((socket, next) => {
  const user = verifyJWTToken(getSocketHandshakeToken(socket));
  if (user) {
    socket.user = user;
    socket.request.user = user;
  }
  next();
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  const joinedProjectIds = new Set();

  // Join project room
  socket.on('join-project', async (projectId) => {
    const access = await requireSocketProjectAccess(socket, projectId);
    if (!access) return;

    socket.join(`project-${access.projectId}`);
    console.log(`Socket ${socket.id} joined project ${access.projectId}`);
    if (!joinedProjectIds.has(access.projectId)) {
      joinedProjectIds.add(access.projectId);
      prReviewRefreshService.trackProject(access.projectId);
    }

    // Auto-start git watcher for this project (non-blocking)
    if (!gitWatcherService.isWatching(access.projectId)) {
      try {
        if (access.project?.path) {
          await gitWatcherService.startWatching(access.projectId, access.project.path, {
            baseBranch: access.project.base_branch_display || null,
          });
        }
      } catch (watchError) {
        // Non-critical — watcher just won't be active
        console.warn(`[GitWatcher] Auto-start failed for ${access.projectId}:`, watchError.message);
      }
    }

    if (!prReviewRefreshService.isWatching(access.projectId)) {
      try {
        await prReviewRefreshService.startWatching(access.projectId);
      } catch (refreshError) {
        console.warn(`[PrRefresh] Auto-start failed for ${access.projectId}:`, refreshError.message);
      }
    }

    if (!activeProjectProcesses.has(access.projectId)) {
      return;
    }

    let streamState = chatStreamCache.get(access.projectId);

    if (!streamState) {
      try {
        const dbState = await getChatStreamState(access.projectId);
        if (dbState && dbState.content) {
          streamState = {
            content: dbState.content,
            startedAt: dbState.started_at ? new Date(dbState.started_at).toISOString() : null,
          };
          chatStreamCache.set(access.projectId, streamState);
        }
      } catch (error) {
        console.warn('Failed to load chat stream state:', error.message);
      }
    }

    const recoveryContent = streamState?.content || '';
    socket.emit('ai-chat-recovery', {
      projectId: access.projectId,
      content: recoveryContent,
      startedAt: streamState?.startedAt || new Date().toISOString(),
    });
  });

  // Leave project room
  socket.on('leave-project', (projectId) => {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) return;

    socket.leave(`project-${normalizedProjectId}`);
    console.log(`Socket ${socket.id} left project ${normalizedProjectId}`);
    if (joinedProjectIds.delete(normalizedProjectId)) {
      prReviewRefreshService.releaseProject(normalizedProjectId);
    }
  });

  // Check CLI availability/auth status (provider-aware)
  socket.on('ai-check-auth', async (data) => {
    const requestedProvider = data?.cliProvider;

    // If a specific provider was requested, use its adapter
    if (requestedProvider && hasAdapter(requestedProvider)) {
      try {
        const adapter = getAdapter(requestedProvider);
        if (!adapter.isSupported()) {
          socket.emit('ai-auth-status', { authenticated: false, error: `${adapter.getName()} is not yet supported.` });
          return;
        }
        socket.emit('ai-auth-status', { authenticated: true, checking: true });
        const result = await adapter.checkAuth();
        socket.emit('ai-auth-status', result);
      } catch (err) {
        socket.emit('ai-auth-status', { authenticated: false, error: err.message });
      }
      return;
    }

    // Default: try all supported adapters — succeed if ANY is authenticated
    socket.emit('ai-auth-status', { authenticated: true, checking: true });
    const adapters = getSupportedAdapters();
    for (const adapter of adapters) {
      try {
        const result = await adapter.checkAuth();
        if (result.authenticated) {
          socket.emit('ai-auth-status', {
            authenticated: true,
            provider: adapter.getType(),
            source: result.source || null,
          });
          return;
        }
      } catch {
        // Try next adapter
      }
    }

    const cliStatus = await providerService.getCliAuthStatus().catch(() => null);
    const claudePrerequisite = cliStatus?.['claude-code']?.prerequisite;
    if (claudePrerequisite?.status && claudePrerequisite.status !== 'ok') {
      socket.emit('ai-auth-status', {
        authenticated: false,
        error: claudePrerequisite.message || 'Claude Code requires Git Bash on Windows.',
      });
      return;
    }

    // None authenticated — fall back to Claude error for backward compat
    const result = await checkClaudeAuth(true);
    socket.emit('ai-auth-status', result);
  });

  // Stop current AI processing
  socket.on('ai-stop', async (data) => {
    const projectId = String(data?.projectId || '').trim();
    const access = await requireSocketProjectAccess(socket, projectId, { eventName: 'ai-error' });
    if (!access) return;

    console.log(`Stop requested for socket ${socket.id}, project ${projectId}`);

    const processInfo = activeProjectProcesses.get(projectId);
    if (processInfo && typeof processInfo.stop === 'function') {
      const isBuilderRun = processInfo.runType !== CLI_RUN_TYPES.reviewFix;
      console.log(`Stopping shared CLI run for socket ${socket.id}, project ${projectId}`);
      await processInfo.stop();
      activeProjectProcesses.delete(projectId);
      claudeService.setRunActive(projectId, false);

      if (!isBuilderRun) {
        if (typeof processInfo.emitStopped === 'function') {
          processInfo.emitStopped();
        }
        return;
      }

      await persistChatStreamState(projectId, true);
      await clearChatStream(projectId);

      socket.emit('ai-stopped', { projectId });
      socket.to(`project-${projectId}`).emit('ai-stopped', { projectId });
    } else if (processInfo && processInfo.process) {
      console.log(`Killing CLI process for socket ${socket.id}, project ${projectId}`);
      await persistChatStreamState(projectId, true);
      processInfo.process.kill('SIGTERM');
      activeProjectProcesses.delete(projectId);
      claudeService.setRunActive(projectId, false);
      await clearChatStream(projectId);

      socket.emit('ai-stopped', { projectId });
      socket.to(`project-${projectId}`).emit('ai-stopped', { projectId });
    } else if (processInfo && processInfo.abortController) {
      // Abort-signal-based streaming — no child process, abort via signal
      console.log(`Aborting stream for socket ${socket.id}, project ${projectId}`);
      await persistChatStreamState(projectId, true);
      processInfo.abortController.abort();
      claudeService.setRunActive(projectId, false);
      // Cleanup happens in the bypass's finally block

      socket.emit('ai-stopped', { projectId });
      socket.to(`project-${projectId}`).emit('ai-stopped', { projectId });
    } else {
      claudeService.setRunActive(projectId, false);
      await clearChatStream(projectId);
    }
  });

  socket.on('fix-stop', async (data, ack) => {
    const projectId = String(data?.projectId || '').trim();
    const runId = String(data?.runId || '').trim();
    if (!projectId) {
      if (typeof ack === 'function') {
        ack({ success: false, error: 'projectId is required' });
      }
      return;
    }

    const access = await requireSocketProjectAccess(socket, projectId, {
      ack,
      eventName: 'fix-error',
      payload: { runId: runId || null },
    });
    if (!access) return;

    const markPersistedRunStopped = async (targetRunId) => {
      if (!targetRunId) return false;
      try {
        const existingRun = await reviewFixRunStore.getRunById(targetRunId);
        if (!existingRun || existingRun.projectId !== projectId || existingRun.status !== 'running') {
          return false;
        }

        const terminalTimestamp = new Date().toISOString();
        const stoppedRecommendationStatuses = buildFixCompletionStatusEvents({
          projectId,
          runId: targetRunId,
          recommendationKeys: existingRun.selectedRecommendationKeys || [],
          recommendationFilePathsByKey: Object.fromEntries(
            Object.entries(existingRun.recommendationStatuses || {}).map(([recommendationKey, statusEntry]) => [
              recommendationKey,
              Array.isArray(statusEntry?.filePaths) ? statusEntry.filePaths : [],
            ])
          ),
          observedFilePaths: [],
          hasFileChanges: false,
          wasStopped: true,
        }).reduce((acc, statusEvent) => {
          const recommendationKey = String(statusEvent?.data?.recommendationKey || '').trim().toLowerCase();
          const status = String(statusEvent?.data?.status || '').trim().toLowerCase();
          if (!recommendationKey || !status) {
            return acc;
          }
          acc[recommendationKey] = {
            recommendationKey,
            status,
            updatedAt: terminalTimestamp,
            filePaths: Array.isArray(statusEvent?.data?.filePaths)
              ? statusEvent.data.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
              : [],
            error: String(statusEvent?.data?.error || '').trim() || null,
          };
          return acc;
        }, {});

        await reviewFixRunStore.updateRun(targetRunId, {
          status: buildReviewFixRunStatus({
            recommendationKeys: existingRun.selectedRecommendationKeys || [],
            hasFileChanges: false,
            wasStopped: true,
          }),
          recommendationStatuses: stoppedRecommendationStatuses,
          stoppedAt: terminalTimestamp,
          completedAt: null,
          failedAt: null,
        });

        socket.emit('fix-stopped', {
          projectId,
          runId: targetRunId,
          reviewType: existingRun.reviewType,
          reviewId: existingRun.reviewId,
          buildSummary: existingRun.buildSummary || null,
        });
        socket.to(`project-${projectId}`).emit('fix-stopped', {
          projectId,
          runId: targetRunId,
          reviewType: existingRun.reviewType,
          reviewId: existingRun.reviewId,
          buildSummary: existingRun.buildSummary || null,
        });
        return true;
      } catch (error) {
        console.warn('Failed to reconcile persisted fix run stop state:', error.message);
        return false;
      }
    };

    const processInfo = activeProjectProcesses.get(projectId);
    if (!processInfo || processInfo.runType !== CLI_RUN_TYPES.reviewFix || typeof processInfo.stop !== 'function') {
      const reconciled = await markPersistedRunStopped(runId);
      if (typeof ack === 'function') {
        ack(reconciled ? { success: true } : { success: false, error: 'No active fix run for this project' });
      }
      return;
    }

    try {
      const activeRunId = String(processInfo.runId || runId || '').trim();
      await processInfo.stop();
      const persistedStopEmitted = await markPersistedRunStopped(activeRunId);
      activeProjectProcesses.delete(projectId);
      claudeService.setRunActive(projectId, false);
      if (!persistedStopEmitted && typeof processInfo.emitStopped === 'function') {
        processInfo.emitStopped();
      }
      if (typeof ack === 'function') {
        ack({ success: true });
      }
    } catch (error) {
      if (typeof ack === 'function') {
        ack({ success: false, error: error.message });
      }
    }
  });

  socket.on('fix-issues', async (data, ack) => {
    const projectId = String(data?.projectId || '').trim();
    const prompt = String(data?.prompt || '').trim();
    const reviewType = String(data?.reviewType || '').trim().toLowerCase();
    const reviewId = String(data?.reviewId || '').trim();
    const recommendationKeys = Array.from(new Set(
      (Array.isArray(data?.recommendationKeys) ? data.recommendationKeys : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
    const selectedModel = typeof data?.model === 'string' ? data.model.trim() : '';
    const rawCliProvider = typeof data?.cliProvider === 'string' ? data.cliProvider.trim() : '';
    const recommendationFilePathsByKey = buildReviewFixFindingFilePathMap(data?.findings);

    if (!projectId) {
      const error = 'projectId is required';
      socket.emit('fix-error', { projectId: null, error });
      if (typeof ack === 'function') {
        ack({ success: false, error });
      }
      return;
    }

    const access = await requireSocketProjectAccess(socket, projectId, {
      ack,
      eventName: 'fix-error',
    });
    if (!access) return;

    if (!prompt || !reviewType || !reviewId || recommendationKeys.length === 0) {
      const error = 'projectId, reviewType, reviewId, prompt, and recommendationKeys are required to run Fix Issues.';
      const errorEvent = createFixErrorEvent({
        projectId,
        error,
      });
      emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
      if (typeof ack === 'function') {
        ack({ success: false, error });
      }
      return;
    }

    if (activeProjectProcesses.has(projectId)) {
      const error = 'Another request is already being processed for this project. Please wait for it to complete.';
      const errorEvent = createFixErrorEvent({ projectId, error });
      emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
      if (typeof ack === 'function') {
        ack({ success: false, error });
      }
      return;
    }

    const preferredProvider = await resolvePreferredReviewCliProvider({
      requestedProvider: rawCliProvider,
      requestedModel: selectedModel,
    });
    const cliProvider = preferredProvider.providerType;
    const effectiveSelectedModel = preferredProvider.model || '';

    let cliAdapter;
    try {
      cliAdapter = getAdapter(cliProvider);
    } catch (adapterError) {
      const errorEvent = createFixErrorEvent({ projectId, error: adapterError.message });
      emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
      if (typeof ack === 'function') {
        ack({ success: false, error: adapterError.message });
      }
      return;
    }

    if (!cliAdapter.isSupported()) {
      const error = `${cliAdapter.getName()} is not yet supported for Fix Issues.`;
      const errorEvent = createFixErrorEvent({ projectId, error });
      emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
      if (typeof ack === 'function') {
        ack({ success: false, error });
      }
      return;
    }

    let persistedFixRunId = null;

    try {
      const authStatus = await cliAdapter.checkAuth();
      if (!authStatus.authenticated) {
        const error = authStatus.error || `${cliAdapter.getName()} CLI not available.`;
        const errorEvent = createFixErrorEvent({ projectId, error });
        emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
        if (typeof ack === 'function') {
          ack({ success: false, error });
        }
        return;
      }

      const { project } = access;

      const projectPath = project.path || project.projectPath || `/var/atlasengine/projects/${projectId}`;
      const runProjectPath = await resolveReviewFixProjectPath(project, reviewType, reviewId) || projectPath;
      if (!claudeService.isSessionActive(projectId)) {
        await claudeService.initializeSession(projectId, projectPath, project.user_id, project);
      }
      const session = claudeService.getSession(projectId);
      if (!session) {
        const errorEvent = createFixErrorEvent({ projectId, error: 'Session not initialized' });
        emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
        if (typeof ack === 'function') {
          ack({ success: false, error: 'Session not initialized' });
        }
        return;
      }

      let devServer = null;
      try {
        devServer = await devServerService.getDevServerStatus(projectId, runProjectPath);
      } catch {
        devServer = null;
      }

      const systemPrompt = buildProjectSystemPrompt({
        projectPath: runProjectPath,
        projectName: project.name || path.basename(runProjectPath),
        chatMode: 'build',
        devServer,
      });

      const providerType = cliAdapter.getType();
      const sessionId = providerType === 'anthropic' ? randomUUID() : null;
      const adapterResult = cliAdapter.buildArgs({
        message: prompt,
        sessionId,
        model: effectiveSelectedModel || undefined,
        projectPath: runProjectPath,
        systemPrompt,
        resumeSession: false,
      });
      const cliArgs = adapterResult.args;

      let cliBinaryPath;
      let cliLaunchArgs = cliArgs;
      try {
        const launchCommand = await resolveProviderLaunchCommand(cliAdapter, cliArgs);
        cliBinaryPath = launchCommand.binaryPath;
        cliLaunchArgs = launchCommand.args;
      } catch (error) {
        const errorEvent = createFixErrorEvent({
          projectId,
          error: error.message || `${cliAdapter.getName()} CLI not available.`,
        });
        emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
        if (typeof ack === 'function') {
          ack({ success: false, error: errorEvent.data.error });
        }
        return;
      }

      const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...sanitizedEnv } = process.env;
      const extraEnv = {};
      if (providerType === 'opencode') {
        try {
          const resolved = await resolveOpenCodeDirectApiParams();
          if (resolved?.provider === 'nvidia' && resolved?.apiKey) {
            extraEnv.NVIDIA_API_KEY = resolved.apiKey;
          }
        } catch {
          // Best effort only.
        }
      }

      const spawnEnv = await buildProviderSpawnEnv(providerType, {
        ...sanitizedEnv,
        ...extraEnv,
        NO_COLOR: '1',
      });

      let cliTimeoutMs = CLI_INACTIVITY_TIMEOUT_MS;
      try {
        const timeoutRow = await db.query('SELECT value FROM settings WHERE id = $1', ['build_cli_timeout']);
        if (timeoutRow.rows.length > 0) {
          const parsed = parseInt(timeoutRow.rows[0].value, 10);
          if (Number.isFinite(parsed) && parsed >= 30 && parsed <= 600) {
            cliTimeoutMs = parsed * 1000;
          }
        }
      } catch {
        // Use default.
      }
      const cliTimeoutLabel = `${Math.round(cliTimeoutMs / 1000)}s`;
      const gitStatusBaseline = await captureGitStatusSnapshot(runProjectPath).catch(() => null);
      const runId = randomUUID();
      persistedFixRunId = runId;
      const fileSnapshots = new Map();
      const startedAt = new Date().toISOString();
      const providerModel = effectiveSelectedModel || cliAdapter.getDefaultModel?.() || null;
      await reviewFixRunStore.createRun({
        runId,
        projectId,
        reviewType,
        reviewId,
        selectedRecommendationKeys: recommendationKeys,
        providerType,
        providerModel,
        startedAt,
      });
      const emitFixEvent = (event) => {
        emitProjectSocketEvent(socket, projectId, event.event, event.data);
      };
      const persistFixRunUpdate = async (patch) => {
        try {
          await reviewFixRunStore.updateRun(runId, patch);
        } catch (error) {
          console.error('Failed to persist review-fix run artifact:', error.message);
        }
      };
      let stopNotificationSent = false;
      const emitFixStoppedOnce = (buildSummary = null) => {
        if (stopNotificationSent) {
          return false;
        }
        stopNotificationSent = true;
        emitFixEvent(createFixStoppedEvent({
          projectId,
          runId,
          buildSummary,
        }));
        return true;
      };

      const { controller, done } = cliRunExecutor.start({
        projectId,
        projectPath: runProjectPath,
        runType: CLI_RUN_TYPES.reviewFix,
        cliAdapter,
        providerType,
        adapterResult,
        cliBinaryPath,
        cliLaunchArgs,
        spawnEnv,
        inactivityTimeoutMs: cliTimeoutMs,
        inactivityTimeoutLabel: cliTimeoutLabel,
        policy: REVIEW_FIX_RUN_POLICY,
        onEvent: async (event) => {
          switch (event.type) {
            case CLI_RUN_EVENT_TYPES.started:
              emitFixEvent(createFixStartedEvent({
                projectId,
                runId,
                reviewType,
                reviewId,
                startedAt,
                providerType,
                recommendationKeys,
                policy: REVIEW_FIX_RUN_POLICY,
              }));
              for (const statusEvent of buildFixRecommendationStatusEvents({
                projectId,
                runId,
                recommendationKeys,
                status: REVIEW_FIX_RECOMMENDATION_STATUSES.running,
              })) {
                emitFixEvent(statusEvent);
              }
              break;
            case CLI_RUN_EVENT_TYPES.system:
              emitFixEvent(createFixStreamEvent({
                projectId,
                runId,
                kind: 'system',
                payload: event.data,
              }));
              break;
            case CLI_RUN_EVENT_TYPES.assistantText:
              emitFixEvent(createFixStreamEvent({
                projectId,
                runId,
                kind: 'text',
                text: event.data?.text || '',
              }));
              break;
            case CLI_RUN_EVENT_TYPES.toolUse:
              await snapshotToolUseFileChange({
                toolEvent: event.data,
                projectPath: runProjectPath,
                fileSnapshots,
              });
              emitFixEvent(createFixToolUseEvent({
                projectId,
                runId,
                tool: event.data,
              }));
              break;
            case CLI_RUN_EVENT_TYPES.taskStatus:
              emitFixEvent(createFixStatusEvent({
                projectId,
                runId,
                status: String(event.data?.status || '').trim() || REVIEW_FIX_RECOMMENDATION_STATUSES.running,
                taskId: event.data?.taskId || null,
                timestamp: event.data?.timestamp || new Date().toISOString(),
              }));
              break;
            case CLI_RUN_EVENT_TYPES.error:
              emitFixEvent(createFixStreamEvent({
                projectId,
                runId,
                kind: 'error',
                text: event.data?.error || 'Fix run provider warning',
                payload: event.data,
              }));
              break;
            case CLI_RUN_EVENT_TYPES.processError:
              emitFixEvent(createFixErrorEvent({
                projectId,
                runId,
                error: event.data?.error || 'Fix run failed',
              }));
              break;
            default:
              break;
          }
        },
      });

      activeProjectProcesses.set(projectId, {
        ...controller,
        runType: CLI_RUN_TYPES.reviewFix,
        runId,
        stop: controller.stop,
        emitStopped: (buildSummary = null) => {
          emitFixStoppedOnce(buildSummary);
        },
      });
      claudeService.setRunActive(projectId, true, controller.startedAt);

      if (typeof ack === 'function') {
        ack({ success: true, runId });
      }

      void done.then(async (result) => {
        activeProjectProcesses.delete(projectId);
        claudeService.setRunActive(projectId, false);

        const wasStopped = result.status === 'stopped' || result.exitCode === 143 || result.exitCode === null;
        const success = !wasStopped && result.exitCode === 0;

        let createdChangeset = null;
        let buildSummary = null;
        let hasFileChanges = false;
        let observedFixFilePaths = [];

        if (success || wasStopped) {
          const changesetFilesMap = await computeToolSnapshotDiffs({
            fileSnapshots,
            socket,
            projectId,
            eventFactory: {
              event: createFixFileDiffEvent({}).event,
              build: (data) => createFixFileDiffEvent({
                projectId,
                runId,
                ...data,
              }).data,
            },
          });

          const changesetFiles = Array.from(changesetFilesMap.values())
            .filter((file) => !file.path.startsWith('.claude/') && !file.path.startsWith('.claude\\'));
          hasFileChanges = changesetFiles.length > 0;

          if (hasFileChanges && REVIEW_FIX_RUN_POLICY.createChangeset) {
            try {
              createdChangeset = await changesetService.createChangeSet(runProjectPath, {
                source: 'agent',
                files: changesetFiles,
              });
            } catch (error) {
              console.error('Failed to create review-fix changeset:', error.message);
            }
          }

          const gitStatusSummary = await captureGitStatusSnapshot(runProjectPath)
            .then((snapshot) => buildGitStatusDeltaSummary(gitStatusBaseline, snapshot))
            .catch(() => null);

          buildSummary = buildFixSummaryFromChanges({
            changesetFilesMap,
            gitStatusSummary,
            createdChangeset,
          });

          const resolvedObservedChanges = resolveReviewFixObservedChanges({
            buildSummary,
            observedFilePaths: Array.from(changesetFilesMap.keys()),
          });
          hasFileChanges = resolvedObservedChanges.hasFileChanges;
          observedFixFilePaths = resolvedObservedChanges.observedFilePaths;

          if (hasFileChanges) {
            emitFixEvent(createFixStatusEvent({
              projectId,
              runId,
              status: REVIEW_FIX_RECOMMENDATION_STATUSES.patchApplied,
              buildSummary,
            }));
          }
        }

        const finalError = !success && !wasStopped
          ? buildCliExitErrorMessage({
              providerType,
              cliName: cliAdapter.getName(),
              exitCode: result.exitCode,
              stderrBuffer: result.stderrBuffer,
              streamErrorMessage: result.lastStreamError,
            })
          : null;

        const completionStatusEvents = buildFixCompletionStatusEvents({
          projectId,
          runId,
          recommendationKeys,
          recommendationFilePathsByKey,
          observedFilePaths: observedFixFilePaths,
          hasFileChanges,
          wasStopped,
          failed: !success && !wasStopped,
          error: finalError,
        });
        for (const statusEvent of completionStatusEvents) {
          emitFixEvent(statusEvent);
        }

        const completionRecommendationStatuses = completionStatusEvents.reduce((acc, statusEvent) => {
          const recommendationKey = String(statusEvent?.data?.recommendationKey || '').trim().toLowerCase();
          const status = String(statusEvent?.data?.status || '').trim().toLowerCase();
          if (!recommendationKey || !status) {
            return acc;
          }
          acc[recommendationKey] = {
            recommendationKey,
            status,
            updatedAt: new Date().toISOString(),
            filePaths: Array.isArray(statusEvent?.data?.filePaths)
              ? statusEvent.data.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
              : [],
            error: String(statusEvent?.data?.error || '').trim() || null,
          };
          return acc;
        }, {});

        const runStatus = buildReviewFixRunStatus({
          recommendationKeys,
          hasFileChanges,
          wasStopped,
          failed: !success && !wasStopped,
        });
        const terminalTimestamp = new Date().toISOString();

        await persistFixRunUpdate({
          status: runStatus,
          buildSummary,
          recommendationStatuses: completionRecommendationStatuses,
          error: finalError,
          completedAt: success ? terminalTimestamp : null,
          stoppedAt: wasStopped ? terminalTimestamp : null,
          failedAt: !success && !wasStopped ? terminalTimestamp : null,
        });

        // Queue sync event for admin dashboard analytics on every terminal
        // state (success, failure, stopped) so desktop devices contribute all
        // outcomes — not just successful runs.
        void (async () => {
          try {
            const patchedCount = Object.values(completionRecommendationStatuses)
              .filter((s) => s.status === 'patch_applied' || s.status === 'verification_pending').length;
            const failedCount = Object.values(completionRecommendationStatuses)
              .filter((s) => s.status === 'failed' || s.status === 'skipped').length;
            let repoRemoteUrl = null;
            try { repoRemoteUrl = await gitService.getRemoteUrl(runProjectPath); } catch { /* no git remote */ }
            await reviewSyncService.queueEvent(
              reviewSyncService.buildFixRunCompletedEvent({
                userId: project?.user_id || null,
                projectId,
                projectName: project?.name || null,
                projectPath: runProjectPath,
                reviewType,
                reviewId,
                runId,
                runStatus,
                providerType,
                providerModel: effectiveSelectedModel || null,
                completedAt: terminalTimestamp,
                findingsSelected: recommendationKeys.length,
                findingsPatched: patchedCount,
                findingsFailed: failedCount,
                filesChanged: buildSummary?.filesChanged || 0,
                repoRemoteUrl,
              })
            );
          } catch (syncError) {
            console.error('[FixRun] Failed to queue sync event:', syncError.message);
          }
        })();

        if (wasStopped) {
          emitFixStoppedOnce(buildSummary);
          return;
        }

        if (!success) {
          emitFixEvent(createFixErrorEvent({
            projectId,
            runId,
            error: finalError,
          }));
          return;
        }

        emitFixEvent(createFixCompleteEvent({
          projectId,
          runId,
          reviewType,
          reviewId,
          recommendationKeys,
          buildSummary,
          changesetId: createdChangeset?.id || null,
          changesetTitle: createdChangeset?.title || null,
          status: runStatus,
        }));
      }).catch((error) => {
        activeProjectProcesses.delete(projectId);
        claudeService.setRunActive(projectId, false);
        const failureMessage = error.message || 'Fix run failed';
        void persistFixRunUpdate({
          status: buildReviewFixRunStatus({
            recommendationKeys,
            failed: true,
          }),
          recommendationStatuses: buildFixCompletionStatusEvents({
            projectId,
            runId,
            recommendationKeys,
            recommendationFilePathsByKey,
            failed: true,
            error: failureMessage,
          }).reduce((acc, statusEvent) => {
            const recommendationKey = String(statusEvent?.data?.recommendationKey || '').trim().toLowerCase();
            const status = String(statusEvent?.data?.status || '').trim().toLowerCase();
            if (!recommendationKey || !status) {
              return acc;
            }
            acc[recommendationKey] = {
              recommendationKey,
              status,
              updatedAt: new Date().toISOString(),
              filePaths: Array.isArray(statusEvent?.data?.filePaths)
                ? statusEvent.data.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
                : [],
              error: String(statusEvent?.data?.error || '').trim() || null,
            };
            return acc;
          }, {}),
          error: failureMessage,
          failedAt: new Date().toISOString(),
        });
        const errorEvent = createFixErrorEvent({
          projectId,
          runId,
          error: failureMessage,
        });
        emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
      });
    } catch (error) {
      if (persistedFixRunId) {
        try {
          await reviewFixRunStore.updateRun(persistedFixRunId, {
            status: buildReviewFixRunStatus({
              recommendationKeys,
              failed: true,
            }),
            recommendationStatuses: buildFixCompletionStatusEvents({
              projectId,
              runId: persistedFixRunId,
              recommendationKeys,
              recommendationFilePathsByKey,
              failed: true,
              error: error.message || 'Fix run failed',
            }).reduce((acc, statusEvent) => {
              const recommendationKey = String(statusEvent?.data?.recommendationKey || '').trim().toLowerCase();
              const status = String(statusEvent?.data?.status || '').trim().toLowerCase();
              if (!recommendationKey || !status) {
                return acc;
              }
              acc[recommendationKey] = {
                recommendationKey,
                status,
                updatedAt: new Date().toISOString(),
                filePaths: Array.isArray(statusEvent?.data?.filePaths)
                  ? statusEvent.data.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
                  : [],
                error: String(statusEvent?.data?.error || '').trim() || null,
              };
              return acc;
            }, {}),
            error: error.message || 'Fix run failed',
            failedAt: new Date().toISOString(),
          });
        } catch (persistError) {
          console.error('Failed to persist review-fix startup failure:', persistError.message);
        }
      }
      const errorEvent = createFixErrorEvent({
        projectId,
        runId: persistedFixRunId,
        error: error.message || 'Fix run failed',
      });
      emitProjectSocketEvent(socket, projectId, errorEvent.event, errorEvent.data);
      if (typeof ack === 'function') {
        ack({ success: false, error: errorEvent.data.error });
      }
    }
  });

  socket.on('review-agent-stop', async (data, ack) => {
    const projectId = String(data?.projectId || '').trim();
    const reviewType = String(data?.reviewType || '').trim().toLowerCase();
    const reviewId = String(data?.reviewId || '').trim();
    if (!projectId) {
      if (typeof ack === 'function') ack({ success: false, error: 'projectId is required' });
      return;
    }

    const access = await requireSocketProjectAccess(socket, projectId, {
      ack,
      eventName: 'review-agent-error',
    });
    if (!access) return;

    const processInfo = activeProjectProcesses.get(projectId);
    if (!processInfo || processInfo.runType !== CLI_RUN_TYPES.reviewAgent) {
      if (typeof ack === 'function') ack({ success: true, stopped: false });
      return;
    }

    try {
      await processInfo.stop?.();
      activeProjectProcesses.delete(projectId);
      emitProjectSocketEvent(socket, projectId, 'review-agent-complete', {
        projectId,
        reviewType: reviewType || processInfo.reviewType || null,
        reviewId: reviewId || processInfo.reviewId || null,
        sessionId: processInfo.sessionId || null,
        stopped: true,
      });
      if (typeof ack === 'function') ack({ success: true, stopped: true });
    } catch (error) {
      if (typeof ack === 'function') ack({ success: false, error: error.message });
    }
  });

  socket.on('review-agent-message', async (data, ack) => {
    const __askAtlasT0 = Date.now();
    const projectId = String(data?.projectId || '').trim();
    const reviewType = String(data?.reviewType || '').trim().toLowerCase();
    const reviewId = String(data?.reviewId || '').trim();
    const sessionId = String(data?.sessionId || '').trim();
    const message = String(data?.message || '').trim();
    console.log(`[ask-atlas-timing] received project=${projectId} session=${sessionId}`);
    const attachments = Array.isArray(data?.attachments) ? data.attachments : [];
    const selectedModel = typeof data?.model === 'string' ? data.model.trim() : '';
    const rawCliProvider = typeof data?.cliProvider === 'string' ? data.cliProvider.trim() : '';

    if (!projectId) {
      const error = 'projectId is required';
      socket.emit('review-agent-error', {
        projectId: null,
        sessionId: sessionId || null,
        error,
      });
      if (typeof ack === 'function') ack({ success: false, error });
      return;
    }

    const access = await requireSocketProjectAccess(socket, projectId, {
      ack,
      eventName: 'review-agent-error',
      payload: { sessionId: sessionId || null },
    });
    if (!access) return;

    if (!reviewType || !reviewId || !sessionId || !message) {
      const error = 'projectId, reviewType, reviewId, sessionId, and message are required.';
      emitProjectSocketEvent(socket, projectId, 'review-agent-error', {
        projectId,
        sessionId: sessionId || null,
        error,
      });
      if (typeof ack === 'function') ack({ success: false, error });
      return;
    }

    const scope = { projectId, reviewType, reviewId };

    try {
      const { project } = access;

      if (activeProjectProcesses.has(projectId)) {
        const error = 'Another request is already being processed for this project. Please wait for it to complete.';
        emitProjectSocketEvent(socket, projectId, 'review-agent-error', { projectId, sessionId, error });
        if (typeof ack === 'function') ack({ success: false, error });
        return;
      }

      const session = await reviewAgentStore.getSession(sessionId, scope);
      if (!session || session.status !== 'active') {
        const error = 'Review assistant session not found';
        emitProjectSocketEvent(socket, projectId, 'review-agent-error', { projectId, sessionId, error });
        if (typeof ack === 'function') ack({ success: false, error });
        return;
      }

      const preferredProvider = await resolvePreferredReviewCliProvider({
        requestedProvider: rawCliProvider,
        requestedModel: selectedModel,
      });
      const cliProvider = preferredProvider.providerType;
      const effectiveSelectedModel = preferredProvider.model || '';
      const cliAdapter = getAdapter(cliProvider);
      if (!cliAdapter.isSupported()) {
        const error = `${cliAdapter.getName()} is not yet supported for review assistant chat.`;
        emitProjectSocketEvent(socket, projectId, 'review-agent-error', { projectId, sessionId, error });
        if (typeof ack === 'function') ack({ success: false, error });
        return;
      }

      const authStatus = await getCachedAuthStatusForReviewAgent(cliAdapter);
      if (!authStatus.authenticated) {
        const error = authStatus.error || `${cliAdapter.getName()} CLI not available.`;
        emitProjectSocketEvent(socket, projectId, 'review-agent-error', { projectId, sessionId, error });
        if (typeof ack === 'function') ack({ success: false, error });
        return;
      }

      const projectPath = project.path || project.projectPath || `/var/atlasengine/projects/${projectId}`;
      const __hydrateStart = Date.now();
      const context = await reviewAgentContextService.hydrateContext({
        ...scope,
        attachments,
      });
      console.log(`[ask-atlas-timing] hydrate-context=${Date.now() - __hydrateStart}ms`);
      const contextBlock = reviewAgentContextService.formatReviewAgentContext(context);
      const finalPrompt = `${message}\n\n${contextBlock}`;
      const systemPrompt = buildReviewAgentSystemPrompt({
        projectPath,
        projectName: project.name || path.basename(projectPath),
        reviewType,
        reviewId,
      });

      const providerType = cliAdapter.getType();
      let providerSessionId = session.providerSessionId;
      let resumeSession = Boolean(providerSessionId);
      const reviewAgentProviderSwitched = Boolean(session.providerType && session.providerType !== providerType);
      if (reviewAgentProviderSwitched || (providerType === 'openai' && providerSessionId)) {
        if (reviewAgentProviderSwitched) {
          console.log(`Review agent provider switch detected: ${session.providerType} → ${providerType}; starting fresh provider session`);
        } else {
          console.warn(`Bypassing persisted Codex review-agent session for ${sessionId}; starting fresh to avoid stale rollout resume`);
        }
        providerSessionId = null;
        resumeSession = false;
        await reviewAgentStore.updateSession(sessionId, { providerSessionId: null });
      }
      if (!providerSessionId && providerType === 'anthropic') {
        providerSessionId = randomUUID();
        resumeSession = false;
      }

      const adapterResult = buildReviewAgentAdapterArgs({
        cliAdapter,
        message: finalPrompt,
        sessionId: providerSessionId,
        model: effectiveSelectedModel || undefined,
        projectPath,
        systemPrompt,
        resumeSession,
      });

      let cliBinaryPath;
      let cliLaunchArgs = adapterResult.args;
      try {
        const launchCommand = await resolveCachedReviewAgentLaunchCommand(cliAdapter, adapterResult.args);
        cliBinaryPath = launchCommand.binaryPath;
        cliLaunchArgs = launchCommand.args;
      } catch (error) {
        emitProjectSocketEvent(socket, projectId, 'review-agent-error', {
          projectId,
          sessionId,
          error: error.message || `${cliAdapter.getName()} CLI not available.`,
        });
        if (typeof ack === 'function') ack({ success: false, error: error.message });
        return;
      }

      await reviewAgentStore.updateSession(sessionId, {
        providerType,
        providerModel: effectiveSelectedModel || cliAdapter.getDefaultModel?.() || null,
        providerSessionId,
        title: session.title || message.slice(0, 80),
      });
      await reviewAgentStore.saveMessage({
        sessionId,
        role: 'user',
        content: message,
        meta: { attachments, contextSummary: context.review },
      });

      // Fire-and-forget analytics event for admin dashboard (Builder Chat metrics).
      // Mirrors the 'ai-message' handler — Ask Atlas is the live chat surface
      // when ENABLE_BUILDER is false.
      void (async () => {
        try {
          let repoRemoteUrl = null;
          try { repoRemoteUrl = await gitService.getRemoteUrl(projectPath); } catch { /* no git remote */ }
          await reviewSyncService.queueEvent(
            reviewSyncService.buildChatMessageSentEvent({
              userId: project.user_id,
              projectId,
              projectName: project.name || null,
              projectPath,
              providerType,
              providerModel: effectiveSelectedModel || null,
              messageLength: typeof message === 'string' ? message.length : 0,
              attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
              hasUiSelection: false,
              hasUiEdits: false,
              isSlashCommand: false,
              repoRemoteUrl,
            })
          );
        } catch (syncError) {
          console.error('[ChatAnalytics] Failed to queue chat_message_sent (review-agent):', syncError.message);
        }
      })();

      const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...sanitizedEnv } = process.env;
      const spawnEnv = await buildProviderSpawnEnv(providerType, {
        ...sanitizedEnv,
        NO_COLOR: '1',
      });
      const cliTimeoutMs = CLI_INACTIVITY_TIMEOUT_MS;
      const cliTimeoutLabel = `${Math.round(cliTimeoutMs / 1000)}s`;
      let assistantMessage = '';
      let tokensUsed = 0;
      let model = effectiveSelectedModel || cliAdapter.getDefaultModel?.() || null;

      const __askAtlasPreSpawnMs = Date.now() - __askAtlasT0;
      const __askAtlasSpawnAt = Date.now();
      let __askAtlasFirstChunkLogged = false;
      console.log(`[ask-atlas-timing] pre-spawn=${__askAtlasPreSpawnMs}ms (provider=${providerType}, resume=${resumeSession})`);

      const { controller, done } = cliRunExecutor.start({
        projectId,
        projectPath,
        runType: CLI_RUN_TYPES.reviewAgent,
        cliAdapter,
        providerType,
        adapterResult,
        cliBinaryPath,
        cliLaunchArgs,
        spawnEnv,
        inactivityTimeoutMs: cliTimeoutMs,
        inactivityTimeoutLabel: cliTimeoutLabel,
        policy: REVIEW_AGENT_RUN_POLICY,
        onEvent: async ({ type, data: eventData }) => {
          if (!__askAtlasFirstChunkLogged) {
            // Skip the 'started' lifecycle event — it fires immediately when
            // cliRunExecutor.start() returns, before the CLI has done any
            // real work. We want the first substantive event (system message
            // from the CLI, or first assistant token).
            if (type !== CLI_RUN_EVENT_TYPES.started) {
              __askAtlasFirstChunkLogged = true;
              const spawnToFirstMs = Date.now() - __askAtlasSpawnAt;
              const totalMs = Date.now() - __askAtlasT0;
              console.log(`[ask-atlas-timing] first-content: spawn->first=${spawnToFirstMs}ms total=${totalMs}ms type=${type}`);
            }
          }
          switch (type) {
            case CLI_RUN_EVENT_TYPES.started:
              emitProjectSocketEvent(socket, projectId, 'review-agent-started', {
                projectId,
                reviewType,
                reviewId,
                sessionId,
                providerType,
                model,
              });
              break;
            case CLI_RUN_EVENT_TYPES.system:
              if (eventData?.sessionId) {
                providerSessionId = eventData.sessionId;
                await reviewAgentStore.updateSession(sessionId, { providerSessionId });
              }
              break;
            case CLI_RUN_EVENT_TYPES.assistantText:
              assistantMessage += eventData.text || '';
              emitProjectSocketEvent(socket, projectId, 'review-agent-stream', {
                projectId,
                reviewType,
                reviewId,
                sessionId,
                text: eventData.text || '',
              });
              break;
            case CLI_RUN_EVENT_TYPES.toolUse:
              emitProjectSocketEvent(socket, projectId, 'review-agent-tool-use', {
                projectId,
                reviewType,
                reviewId,
                sessionId,
                tool: eventData,
              });
              break;
            case CLI_RUN_EVENT_TYPES.error:
              emitProjectSocketEvent(socket, projectId, 'review-agent-error', {
                projectId,
                reviewType,
                reviewId,
                sessionId,
                error: eventData.error || 'Review assistant stream error',
              });
              break;
            default:
              break;
          }
        },
      });

      activeProjectProcesses.set(projectId, {
        ...controller,
        sessionId,
        reviewType,
        reviewId,
      });

      if (typeof ack === 'function') {
        ack({ success: true });
      }

      void done.then(async (result) => {
        activeProjectProcesses.delete(projectId);
        tokensUsed = result.tokensUsed || tokensUsed;
        model = result.model || model;
        assistantMessage = assistantMessage || result.assistantMessage || '';
        if (result.exitCode === 0 || result.exitCode === null || result.exitCode === 143) {
          const parsedAssistant = parseReviewAgentActions(assistantMessage, context);
          assistantMessage = parsedAssistant.content;
          const parsedActions = parsedAssistant.actions || [];
          const inferredActions = parsedActions.length === 0
            ? inferReviewAgentActionsFromRequest(message, context)
            : [];
          const reviewAgentActions = parsedActions.length > 0 ? parsedActions : inferredActions;
          if (!assistantMessage.trim() && reviewAgentActions.length === 0 && parsedAssistant.strippedActionPayload) {
            assistantMessage = 'I could not match that assistant action to a current review target. Select the finding in the review panel or refer to the visible finding ID, then ask again.';
          }
          let savedAssistantMessage = null;
          if (assistantMessage.trim() || reviewAgentActions.length > 0) {
            savedAssistantMessage = await reviewAgentStore.saveMessage({
              sessionId,
              role: 'assistant',
              content: assistantMessage,
              tokensUsed,
              model,
              meta: {
                providerType,
                readOnly: true,
                actions: reviewAgentActions,
              },
            }).catch((error) => {
              console.error('Failed to save review assistant response:', error.message);
              return null;
            });
          }
          if (reviewAgentActions.length > 0) {
            emitProjectSocketEvent(socket, projectId, 'review-agent-action', {
              projectId,
              reviewType,
              reviewId,
              sessionId,
              actions: reviewAgentActions,
            });
          }
          emitProjectSocketEvent(socket, projectId, 'review-agent-complete', {
            projectId,
            reviewType,
            reviewId,
            sessionId,
            tokensUsed,
            model,
            messageId: savedAssistantMessage?.id || null,
            content: assistantMessage,
            actions: reviewAgentActions,
            exitCode: result.exitCode,
            stopped: result.status === 'stopped',
          });
          return;
        }

        const error = buildCliExitErrorMessage({
          providerType,
          cliName: cliAdapter.getName(),
          exitCode: result.exitCode,
          stderrBuffer: result.stderrBuffer,
          streamErrorMessage: result.lastStreamError,
        });
        emitProjectSocketEvent(socket, projectId, 'review-agent-error', {
          projectId,
          reviewType,
          reviewId,
          sessionId,
          error,
        });
      }).catch((error) => {
        activeProjectProcesses.delete(projectId);
        emitProjectSocketEvent(socket, projectId, 'review-agent-error', {
          projectId,
          reviewType,
          reviewId,
          sessionId,
          error: error.message,
        });
      });
    } catch (error) {
      activeProjectProcesses.delete(projectId);
      emitProjectSocketEvent(socket, projectId, 'review-agent-error', {
        projectId,
        reviewType,
        reviewId,
        sessionId,
        error: error.message,
      });
      if (typeof ack === 'function') ack({ success: false, error: error.message });
    }
  });

  // Reset CLI session (new conversation)
  socket.on('ai-new-conversation', async (data, ack) => {
    const projectId = String(data?.projectId || '').trim();
    console.log(`New conversation requested for project ${projectId}`);
    try {
      const access = await requireSocketProjectAccess(socket, projectId, {
        ack,
        eventName: 'ai-error',
      });
      if (!access) return;

      await claudeService.resetCliSession(projectId);
      console.log(`CLI sessions reset for project ${projectId}`);
      if (typeof ack === 'function') {
        ack({ success: true });
      }
    } catch (error) {
      console.error(`Failed to reset CLI session: ${error.message}`);
      if (typeof ack === 'function') {
        ack({ success: false, error: error.message });
      }
    }
  });

  // AI chat message handler with streaming support
  socket.on('ai-message', async (data) => {
    const __chatT0 = Date.now();
    const {
      projectId,
      message,
      attachments,
      attachmentsMeta,
      uiSelection,
      uiEdits,
      model: selectedModel,
      chatMode,
      cliProvider: rawCliProvider,
      clientRequestId,
    } = data;
    console.log(`Chat mode: ${chatMode || 'build (default)'}`);
    console.log(`[chat-timing] received project=${projectId} provider=${rawCliProvider || '(default)'}`);
    const isPlanModeRequest = chatMode === 'plan';

    const access = await requireSocketProjectAccess(socket, projectId, { eventName: 'ai-error' });
    if (!access) return;

    // Resolve CLI adapter: use requested provider, or configured default, or detected default
    const cliProvider = (rawCliProvider && hasAdapter(rawCliProvider))
      ? rawCliProvider
      : await resolveDefaultChatProvider();
    let cliAdapter;
    try {
      cliAdapter = getAdapter(cliProvider);
    } catch (adapterErr) {
      socket.emit('ai-error', { error: adapterErr.message });
      return;
    }

    // Check if the selected adapter is actually supported for build mode
    if (!cliAdapter.isSupported()) {
      socket.emit('ai-error', { error: `${cliAdapter.getName()} is not yet supported for build mode.` });
      return;
    }

    try {
      const authStatus = await cliAdapter.checkAuth();
      if (!authStatus.authenticated) {
        socket.emit('ai-auth-status', authStatus);
        socket.emit('ai-error', { error: authStatus.error || `${cliAdapter.getName()} CLI not available.` });
        return;
      }

      // Forward typing event
      socket.emit('ai-typing', { projectId });
      socket.to(`project-${projectId}`).emit('ai-typing', { projectId });

      const { project } = access;

      const projectPath = project.path || project.projectPath || `/var/atlasengine/projects/${projectId}`;

      // Initialize session if needed (pass project row for cli_session_id)
      if (!claudeService.isSessionActive(projectId)) {
        await claudeService.initializeSession(projectId, projectPath, project.user_id, project);
      }
      claudeService.markSessionActivity(projectId);

      const commandResolution = await resolveSlashCommand({ input: message, projectPath });
      if (commandResolution.isCommand && commandResolution.type === 'builtin') {
        socket.emit('ai-error', {
          error: `Built-in command ${commandResolution.command} is not supported in AtlasEngine chat yet.`,
        });
        socket.to(`project-${projectId}`).emit('ai-error', {
          error: `Built-in command ${commandResolution.command} is not supported in AtlasEngine chat yet.`,
        });
        return;
      }

      const resolvedMessage = commandResolution.isCommand ? commandResolution.prompt : message;
      const normalizedSelection = normalizeUiSelection(uiSelection);
      const normalizedEdits = normalizeUiEdits(uiEdits);
      const selectionContext = formatUiSelectionContext(normalizedSelection);
      const editsContext = formatUiEditsContext(normalizedEdits);
      const contextBlocks = [selectionContext, editsContext].filter(Boolean);
      const messageWithSelection =
        contextBlocks.length > 0
          ? `${resolvedMessage}\n\n${contextBlocks.join('\n\n')}`
          : resolvedMessage;

      // Get session for project path (holds persistent cliSessionId)
      const session = claudeService.getSession(projectId);
      if (!session) {
        socket.emit('ai-error', { error: 'Session not initialized' });
        return;
      }

      // Check if another CLI process is already running for this project
      if (activeProjectProcesses.has(projectId)) {
        const existingProcess = activeProjectProcesses.get(projectId);
        console.log(`${cliAdapter.getName()} process already running for project ${projectId} (started ${Date.now() - existingProcess.startedAt}ms ago)`);
        socket.emit('ai-error', {
          error: 'Another request is already being processed for this project. Please wait for it to complete.'
        });
        return;
      }

      // Capture working-tree baseline for this request to avoid leaking
      // pre-existing dirty files into the completion summary.
      let gitStatusBaseline = null;
      try {
        gitStatusBaseline = await captureGitStatusSnapshot(session.projectPath);
      } catch (statusErr) {
        console.warn(`Failed to collect git status baseline: ${statusErr.message}`);
      }

      const streamStartedAt = new Date().toISOString();
      chatStreamCache.set(projectId, { content: '', startedAt: streamStartedAt });
      chatStreamLastPersist.set(projectId, 0);

      // Resolve provider type from adapter (e.g., 'anthropic', 'openai')
      const providerType = cliAdapter.getType();
      const previousProvider = session.lastCliProvider;
      const providerSwitched = Boolean(previousProvider && previousProvider !== providerType);

      if (providerSwitched) {
        console.log(`Provider switch detected: ${previousProvider} → ${providerType}; starting a fresh ${providerType} CLI session`);
        await claudeService.clearProviderSession(projectId, providerType);
      }

      // Get or create session ID for this specific provider
      let sessionId = claudeService.getOrCreateSessionId(projectId, providerType);
      let resumeSession = claudeService.isProviderSessionReady(projectId, providerType);
      let forcedFreshProviderSession = false;
      if (resumeSession) {
        try {
          const recentMessages = await getChatHistory(projectId, 20);
          const hasCompletedTurn = recentMessages.some((entry) => entry.role === 'assistant' || entry.role === 'system');
          if (!hasCompletedTurn) {
            console.warn(`Discarding stale ${providerType} session for project ${projectId} because no completed turn was found`);
            await claudeService.resetCliSession(projectId, providerType);
            sessionId = claudeService.getOrCreateSessionId(projectId, providerType);
            resumeSession = false;
          }
        } catch (historyErr) {
          console.warn(`Failed to validate ${providerType} resume state: ${historyErr.message}`);
        }
      }
      if (providerType === 'openai' && resumeSession) {
        console.warn(`Bypassing persisted Codex resume session for project ${projectId}; starting fresh with Atlas chat context`);
        await claudeService.clearProviderSession(projectId, providerType);
        sessionId = claudeService.getOrCreateSessionId(projectId, providerType);
        resumeSession = false;
        forcedFreshProviderSession = true;
      }
      console.log(`Provider: ${providerType}, sessionId: ${sessionId || '(provider-managed)'}, resume: ${resumeSession}`);

      // Fetch dev server status so the CLI agent knows the preview port
      let devServer = null;
      try {
        devServer = await devServerService.getDevServerStatus(projectId, session.projectPath);
      } catch {
        // Non-critical — proceed without dev server context
      }

      // Build system prompt via dedicated service (safety restrictions, plan mode, preview port)
      const systemPrompt = buildProjectSystemPrompt({
        projectPath: session.projectPath,
        projectName: project.name || path.basename(session.projectPath),
        chatMode,
        devServer,
      });

      // Detect provider switch and build cross-provider context
      // NOTE: This must happen BEFORE saving the user message to DB, otherwise
      // getChatHistory would include the current message (duplicating it in the prompt)
      const PROVIDER_DISPLAY_NAMES = { anthropic: 'Claude', openai: 'Codex', google: 'Gemini', opencode: 'OpenCode' };
      let crossProviderContext = '';
      if (providerSwitched || forcedFreshProviderSession) {
        try {
          const recentMessages = await getChatHistory(projectId, 10);
          if (recentMessages.length > 0) {
            const contextLines = recentMessages.map(msg => {
              const truncated = msg.content.length > 300
                ? msg.content.slice(0, 300) + '...'
                : msg.content;
              return `[${msg.role}]: ${truncated}`;
            });
            const prevName = PROVIDER_DISPLAY_NAMES[previousProvider] || previousProvider;
            const contextHeading = providerSwitched
              ? `[Context from previous conversation with ${prevName}]`
              : '[Recent Atlas chat context before starting a fresh Codex session]';
            crossProviderContext = `${contextHeading}\n${contextLines.join('\n')}\n\n---\n\n`;
          }
        } catch (error) {
          console.warn(`Failed to load provider handoff context: ${error.message}`);
        }
      }

      // Save user message to database (after cross-provider context is built)
      try {
        const meta = {};
        if (attachments && attachments.length > 0) {
          // Store rich metadata (originalName, mimetype, size) if available, otherwise just paths
          meta.attachments = Array.isArray(attachmentsMeta) && attachmentsMeta.length > 0
            ? attachmentsMeta
            : attachments;
        }
        if (commandResolution.isCommand) {
          meta.slashCommand = commandResolution.meta;
        }
        if (clientRequestId) {
          meta.clientRequestId = clientRequestId;
        }
        if (normalizedSelection) {
          meta.uiSelection = normalizedSelection;
        }
        if (normalizedEdits) {
          meta.uiEdits = normalizedEdits;
        }

        await saveChatMessage({
          projectId,
          userId: project.user_id,
          role: 'user',
          content: message,
          tokensUsed: 0,
          model: null,
          meta: Object.keys(meta).length > 0 ? meta : null,
        });
      } catch (error) {
        console.error('Failed to save user message:', error.message);
      }

      // Fire-and-forget analytics event for admin dashboard (Builder Chat metrics)
      void (async () => {
        try {
          let repoRemoteUrl = null;
          try { repoRemoteUrl = await gitService.getRemoteUrl(session.projectPath); } catch { /* no git remote */ }
          await reviewSyncService.queueEvent(
            reviewSyncService.buildChatMessageSentEvent({
              userId: project.user_id,
              projectId,
              projectName: project.name || null,
              projectPath: session.projectPath,
              providerType,
              providerModel: selectedModel || null,
              messageLength: typeof message === 'string' ? message.length : 0,
              attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
              hasUiSelection: Boolean(normalizedSelection),
              hasUiEdits: Boolean(normalizedEdits),
              isSlashCommand: Boolean(commandResolution.isCommand),
              repoRemoteUrl,
            })
          );
        } catch (syncError) {
          console.error('[ChatAnalytics] Failed to queue chat_message_sent:', syncError.message);
        }
      })();

      // Build user message: just the user's actual request + context
      const hasAttachments = attachments && attachments.length > 0;
      let finalPrompt = crossProviderContext + messageWithSelection;

      if (hasAttachments) {
        console.log(`Processing ${attachments.length} attachment(s)`);
        const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'html', 'css', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'yaml', 'yml', 'toml', 'xml', 'sh', 'bash', 'sql']);
        const MAX_INLINE_ATTACHMENT_BYTES = 64 * 1024;
        const inlinedParts = [];
        const readToolFiles = [];

        for (const filePath of attachments) {
          const ext = path.extname(filePath).replace('.', '').toLowerCase();
          const fileName = path.basename(filePath);
          if (TEXT_EXTENSIONS.has(ext)) {
            try {
              const stat = await fs.stat(filePath);
              if (stat.size <= MAX_INLINE_ATTACHMENT_BYTES) {
                const content = await fs.readFile(filePath, 'utf-8');
                inlinedParts.push(`--- Attached file: ${fileName} ---\n${content}\n--- End of ${fileName} ---`);
              } else {
                readToolFiles.push(filePath);
              }
            } catch (err) {
              console.warn(`Failed to read attachment ${filePath}: ${err.message}`);
              readToolFiles.push(filePath);
            }
          } else {
            readToolFiles.push(filePath);
          }
        }

        if (inlinedParts.length > 0) {
          finalPrompt = `${finalPrompt}\n\nThe user has attached the following file(s):\n\n${inlinedParts.join('\n\n')}`;
        }
        if (readToolFiles.length > 0) {
          const fileList = readToolFiles.map((p, i) => `${i + 1}. ${p}`).join('\n');
          finalPrompt = `${finalPrompt}\n\nThe user has also attached these file(s). Use the Read tool to view them:\n${fileList}`;
        }
      }

      // Build CLI arguments via the adapter
      // Claude: --session-id (new) or --resume (continue)
      // Codex: exec (new) or exec resume <id> (continue)
      const adapterResult = cliAdapter.buildArgs({
        message: finalPrompt,
        sessionId,
        model: selectedModel || undefined,
        projectPath: session.projectPath,
        systemPrompt,
        resumeSession,
      });
      const cliArgs = adapterResult.args;

      if (selectedModel) {
        console.log(`Using model: ${selectedModel}`);
      }

      let cliBinaryPath;
      let cliLaunchArgs = cliArgs;
      try {
        const launchCommand = await resolveProviderLaunchCommand(cliAdapter, cliArgs);
        cliBinaryPath = launchCommand.binaryPath;
        cliLaunchArgs = launchCommand.args;
      } catch (error) {
        await clearChatStream(projectId);
        socket.emit('ai-error', { error: error.message || `${cliAdapter.getName()} CLI not available.` });
        return;
      }
      console.log(`Using ${cliAdapter.getName()} CLI at: ${cliBinaryPath}`);
      console.log(`CLI args:`, cliLaunchArgs.join(' '));

      // Strip CLAUDECODE/CLAUDE_CODE_ENTRYPOINT to prevent "nested session"
      // errors when the dev server runs inside a Claude Code session.
      const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...sanitizedEnv } = process.env;

      // For OpenCode with NVIDIA models, inject NVIDIA_API_KEY from auth.json
      // (the OpenCode config uses {env:NVIDIA_API_KEY} for the @ai-sdk/openai-compatible SDK)
      // Check both the per-message selectedModel and the config's active model
      const extraEnv = {};
      const isNvidiaModel = selectedModel?.startsWith('nvidia/');
      if (providerType === 'opencode' && !sanitizedEnv.NVIDIA_API_KEY) {
        try {
          const resolved = await resolveOpenCodeDirectApiParams();
          if ((isNvidiaModel || resolved?.providerType === 'nvidia') && resolved?.apiKey) {
            extraEnv.NVIDIA_API_KEY = resolved.apiKey;
          }
        } catch { /* best-effort */ }
      }

      const spawnEnv = await buildProviderSpawnEnv(providerType, {
        ...sanitizedEnv,
        ...extraEnv,
        NO_COLOR: '1',
      });
      let cliTimeoutMs = CLI_INACTIVITY_TIMEOUT_MS;
      try {
        const timeoutRow = await db.query('SELECT value FROM settings WHERE id = $1', ['build_cli_timeout']);
        if (timeoutRow.rows.length > 0) {
          const parsed = parseInt(timeoutRow.rows[0].value, 10);
          if (Number.isFinite(parsed) && parsed >= 30 && parsed <= 600) {
            cliTimeoutMs = parsed * 1000;
          }
        }
      } catch { /* fallback to default */ }
      const cliTimeoutLabel = `${Math.round(cliTimeoutMs / 1000)}s`;

      let assistantMessage = '';
      let tokensUsed = 0;
      let model = cliAdapter.getDefaultModel();
      const toolUseEvents = [];
      const assistantSegmentTracker = createAssistantSegmentTracker({
        projectId,
        userId: project.user_id,
      });
      const fileSnapshots = new Map();
      const emitClaudeStreamEvent = (event) => {
        socket.emit('claude-stream-event', event);
        socket.to(`project-${projectId}`).emit('claude-stream-event', event);
      };
      const emitTaskStatusUpdate = (payload) => {
        socket.emit('task-status-update', payload);
        socket.to(`project-${projectId}`).emit('task-status-update', payload);
      };

      const __chatPreSpawnElapsedMs = Date.now() - __chatT0;
      const __chatSpawnAt = Date.now();
      let __chatFirstChunkLogged = false;
      console.log(`[chat-timing] pre-spawn=${__chatPreSpawnElapsedMs}ms (provider=${providerType}, resume=${resumeSession})`);

      const { controller, done } = cliRunExecutor.start({
        projectId,
        projectPath: session.projectPath,
        runType: CLI_RUN_TYPES.builder,
        cliAdapter,
        providerType,
        adapterResult,
        cliBinaryPath,
        cliLaunchArgs,
        spawnEnv,
        inactivityTimeoutMs: cliTimeoutMs,
        inactivityTimeoutLabel: cliTimeoutLabel,
        policy: BUILDER_RUN_POLICY,
        onEvent: async ({ type, data }) => {
          if (!__chatFirstChunkLogged) {
            __chatFirstChunkLogged = true;
            const spawnToFirstMs = Date.now() - __chatSpawnAt;
            const totalMs = Date.now() - __chatT0;
            console.log(`[chat-timing] first-chunk: spawn->first=${spawnToFirstMs}ms total=${totalMs}ms type=${type}`);
          }
          try {
            switch (type) {
              case CLI_RUN_EVENT_TYPES.system:
                if (data?.sessionId) {
                  console.log(`Captured ${providerType} session ID: ${data.sessionId}`);
                  claudeService.setProviderSessionId(projectId, providerType, data.sessionId);
                }
                emitClaudeStreamEvent({ type: 'system', data });
                break;
              case CLI_RUN_EVENT_TYPES.assistantText: {
                assistantMessage += data.text;
                const segmentContent = assistantSegmentTracker.appendText(data.text);
                const streamState = chatStreamCache.get(projectId);
                if (streamState) {
                  streamState.content = segmentContent || assistantMessage;
                } else {
                  chatStreamCache.set(projectId, {
                    content: segmentContent || assistantMessage,
                    startedAt: new Date().toISOString(),
                  });
                }
                void persistChatStreamState(projectId);
                emitClaudeStreamEvent({ type: 'text', data: { text: data.text } });
                break;
              }
              case CLI_RUN_EVENT_TYPES.toolUse: {
                assistantSegmentTracker.closeSegment();
                const streamState = chatStreamCache.get(projectId);
                if (streamState && streamState.content) {
                  streamState.content = '';
                  void persistChatStreamState(projectId);
                }

                const toolEvent = data;
                toolUseEvents.push(toolEvent);
                claudeService.recordToolUseEvent(projectId, toolEvent);

                const toolClassification = classifyToolOperation(toolEvent.name, toolEvent.input);
                if (BUILDER_RUN_POLICY.persistChatMessages && isSnapshotEligibleFileMutationTool(toolEvent.name, toolEvent.input)) {
                  const rawFilePath = toolClassification.filePath;
                  if (rawFilePath && !isBinaryFile(rawFilePath)) {
                    const fullPath = path.isAbsolute(rawFilePath) ? rawFilePath : path.join(session.projectPath, rawFilePath);
                    const filePath = path.isAbsolute(rawFilePath) ? path.relative(session.projectPath, rawFilePath) : rawFilePath;
                    let messageId = null;
                    try {
                      const savedMessage = await saveChatMessage({
                        projectId,
                        userId: project.user_id,
                        role: 'system',
                        content: '',
                        tokensUsed: 0,
                        model: null,
                        meta: { toolUseEvents: [toolEvent] },
                      });
                      messageId = savedMessage?.id;
                    } catch (error) {
                      console.error('Failed to save tool use message:', error.message);
                    }

                    try {
                      const beforeContent = await fs.readFile(fullPath, 'utf-8');
                      fileSnapshots.set(toolEvent.id, { filePath, beforeContent, fullPath, messageId });
                    } catch {
                      fileSnapshots.set(toolEvent.id, { filePath, beforeContent: null, fullPath, messageId });
                    }
                  } else {
                    void saveChatMessage({
                      projectId,
                      userId: project.user_id,
                      role: 'system',
                      content: '',
                      tokensUsed: 0,
                      model: null,
                      meta: { toolUseEvents: [toolEvent] },
                    }).catch((error) => {
                      console.error('Failed to save tool use message:', error.message);
                    });
                  }
                } else if (BUILDER_RUN_POLICY.persistChatMessages) {
                  void saveChatMessage({
                    projectId,
                    userId: project.user_id,
                    role: 'system',
                    content: '',
                    tokensUsed: 0,
                    model: null,
                    meta: { toolUseEvents: [toolEvent] },
                  }).catch((error) => {
                    console.error('Failed to save tool use message:', error.message);
                  });
                }

                emitClaudeStreamEvent({ type: 'tool_use', data: toolEvent });
                break;
              }
              case CLI_RUN_EVENT_TYPES.taskStatus:
                emitTaskStatusUpdate(data);
                break;
              case CLI_RUN_EVENT_TYPES.error:
                emitClaudeStreamEvent({ type: 'error', data: { error: data.error } });
                break;
              default:
                break;
            }
          } catch (handlerError) {
            console.error(`[${cliAdapter.getName()}] Uncaught error in run handler:`, handlerError);
            emitClaudeStreamEvent({
              type: 'error',
              data: { error: `Stream processing error: ${handlerError.message}` },
            });
          }
        },
      });

      activeProjectProcesses.set(projectId, controller);
      claudeService.setRunActive(projectId, true, controller.startedAt);

      if (isPlaceholderProjectName(project.name)) {
        setTimeout(() => {
          void maybeAutoNameProjectFromContext({
            projectId,
            userPrompt: message,
            assistantResponse: '',
            attachmentMeta: attachmentsMeta,
            attachmentPaths: attachments,
            socket,
          });
        }, 0);
      }

      void done.then(async (result) => {
        const exitCode = result.exitCode;
        tokensUsed = result.tokensUsed || tokensUsed;
        model = result.model || model;
        assistantMessage = assistantMessage || result.assistantMessage || '';

        activeProjectProcesses.delete(projectId);
        claudeService.setRunActive(projectId, false);
        console.log(`${cliAdapter.getName()} process completed for project ${projectId} with code ${exitCode}`);
        console.log(`📊 Final state: assistantMessage length=${assistantMessage.length}, tokensUsed=${tokensUsed}, toolUseEvents=${toolUseEvents.length}`);

        if (exitCode === 0 || exitCode === null || exitCode === 143) {
          const changesetFilesMap = new Map();
          let createdChangeset = null;

          if (fileSnapshots.size > 0) {
            for (const [toolId, snapshot] of fileSnapshots) {
              const { filePath, beforeContent, fullPath, messageId } = snapshot;

              try {
                const afterContent = await fs.readFile(fullPath, 'utf-8');
                const stats = computeDiffStats(beforeContent, afterContent);
                const language = detectLanguage(filePath);
                const diffData = {
                  toolCallId: toolId,
                  filePath,
                  beforeContent,
                  afterContent,
                  isNewFile: beforeContent === null,
                  language,
                  stats,
                };

                if (!changesetFilesMap.has(filePath)) {
                  changesetFilesMap.set(filePath, {
                    path: filePath,
                    before: beforeContent,
                    after: afterContent,
                  });
                } else {
                  const existing = changesetFilesMap.get(filePath);
                  existing.after = afterContent;
                }

                if (messageId) {
                  try {
                    await updateMessageFileDiff(messageId, diffData);
                  } catch (dbErr) {
                    console.error('Failed to save diff to database:', dbErr.message);
                  }
                }

                emitClaudeStreamEvent({ type: 'file_diff', data: diffData });
              } catch (err) {
                console.error(`Failed to compute diff for ${filePath}:`, err.message);
              }
            }

            const changesetFiles = Array.from(changesetFilesMap.values())
              .filter((file) => !file.path.startsWith('.claude/') && !file.path.startsWith('.claude\\'));
            if (BUILDER_RUN_POLICY.createChangeset && changesetFiles.length > 0 && exitCode === 0) {
              try {
                const changeset = createdChangeset = await changesetService.createChangeSet(session.projectPath, {
                  source: 'agent',
                  files: changesetFiles,
                });

                emitClaudeStreamEvent({
                  type: 'changeset_created',
                  data: {
                    id: changeset.id,
                    title: changeset.title,
                    source: changeset.source,
                    fileCount: changeset.files.length,
                    filePaths: changeset.files.map((file) => file.path),
                  },
                });
              } catch (changesetErr) {
                console.error('Failed to create changeset:', changesetErr.message);
              }
            }
          }

          const segmentsSaved = await assistantSegmentTracker.finalize({ tokensUsed, model });

          if (BUILDER_RUN_POLICY.persistChatMessages && exitCode === 0 && assistantMessage && !segmentsSaved) {
            try {
              await saveChatMessage({
                projectId,
                userId: project.user_id,
                role: 'assistant',
                content: assistantMessage || 'No response',
                tokensUsed: tokensUsed || 0,
                model,
                meta: null,
              });
            } catch (error) {
              console.error('Failed to save assistant message:', error.message);
            }
          }

          if (exitCode === 0 && assistantMessage && isPlaceholderProjectName(project.name)) {
            void maybeAutoNameProjectFromContext({
              projectId,
              userPrompt: message,
              assistantResponse: assistantMessage,
              attachmentMeta: attachmentsMeta,
              attachmentPaths: attachments,
              socket,
            });
          }

          if (BUILDER_RUN_POLICY.updateMemory && exitCode === 0 && assistantMessage && toolUseEvents.length > 0) {
            try {
              const memoryUpdate = await memoryService.analyzeAndUpdateFromToolUse(
                projectId,
                session.projectPath,
                project.user_id,
                toolUseEvents,
                message,
                assistantMessage,
              );

              if (memoryUpdate.updated) {
                console.log(`✅ Memory updated for project ${projectId}:`, memoryUpdate.insights);
              }
            } catch (error) {
              console.error('Failed to update memory from tool use:', error.message);
            }
          }

          let gitStatusSummary = null;
          try {
            const gitStatusAfter = await captureGitStatusSnapshot(session.projectPath);
            gitStatusSummary = buildGitStatusDeltaSummary(gitStatusBaseline, gitStatusAfter);
            if (!gitStatusBaseline && gitStatusAfter) {
              console.warn('Git status baseline unavailable; skipping git delta summary for this run');
            }
          } catch (statusErr) {
            console.warn(`Failed to collect git status summary: ${statusErr.message}`);
          }

          if (createdChangeset && BUILDER_RUN_POLICY.autoCommit) {
            try {
              const isGitRepo = await gitService.isGitRepository(session.projectPath);
              if (isGitRepo) {
                const commitResult = await gitService.commitChanges(
                  session.projectPath,
                  createdChangeset.title || `Changeset ${createdChangeset.displayId}`,
                );
                if (commitResult.commit) {
                  await changesetService.updateChangeSetCommit(
                    session.projectPath,
                    createdChangeset.id,
                    commitResult.commit,
                    createdChangeset.title || `Changeset ${createdChangeset.displayId}`,
                  );
                  await changesetService.updateChangeSetStatus(session.projectPath, createdChangeset.id, 'committed');
                }
              }
            } catch (commitErr) {
              console.error(`⚠️ Auto-commit failed for changeset ${createdChangeset.displayId}:`, commitErr.message);
            }
          }

          if (BUILDER_RUN_POLICY.autoPush && !isPlanModeRequest && project.github_sync_enabled && project.github_repo_owner && project.github_repo_name) {
            try {
              const simpleGit = (await import('simple-git')).default;
              const git = simpleGit(session.projectPath);
              const status = await git.status();
              if (status.modified.length > 0 || status.created.length > 0 || status.not_added.length > 0) {
                const changedFiles = [...status.modified, ...status.created, ...status.not_added];
                await db.query(
                  `INSERT INTO github_sync_queue (project_id, sync_type, commit_message, status)
                   VALUES ($1, 'push', $2, 'pending')`,
                  [
                    projectId,
                    `Update from Claude Code: ${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? ` and ${changedFiles.length - 3} more` : ''}`,
                  ],
                );
              }
            } catch (syncError) {
              console.error('Failed to auto-queue GitHub sync:', syncError.message);
            }
          }

          if (session) {
            session.messageCount++;
            session.tokensUsed += tokensUsed || 0;
            claudeService.markSessionActivity(projectId);
            claudeService.markProviderSessionReady(projectId, providerType);
            session.lastCliProvider = providerType;
            updateProject(projectId, { last_cli_provider: providerType }).catch((err) => {
              console.warn(`Failed to update last_cli_provider: ${err.message}`);
            });
          }

          const summaryNewFiles = new Set(
            Array.from(changesetFilesMap.entries())
              .filter(([_, file]) => file.before === null)
              .map(([filePath]) => filePath),
          );
          const summaryModifiedFiles = new Set(
            Array.from(changesetFilesMap.entries())
              .filter(([_, file]) => file.before !== null)
              .map(([filePath]) => filePath),
          );

          if (gitStatusSummary) {
            for (const filePath of gitStatusSummary.newFiles) {
              summaryNewFiles.add(filePath);
            }
            for (const filePath of gitStatusSummary.modifiedFiles) {
              summaryModifiedFiles.add(filePath);
            }
          }

          for (const filePath of summaryNewFiles) {
            summaryModifiedFiles.delete(filePath);
          }

          const summaryFilePaths = Array.from(new Set([
            ...summaryNewFiles,
            ...summaryModifiedFiles,
          ])).sort();

          const buildSummary = summaryFilePaths.length > 0
            ? {
              filesChanged: summaryFilePaths.length,
              filePaths: summaryFilePaths,
              newFiles: Array.from(summaryNewFiles).sort(),
              modifiedFiles: Array.from(summaryModifiedFiles).sort(),
              changesetId: createdChangeset?.id || null,
              changesetTitle: createdChangeset?.title || null,
            }
            : null;

          if (!assistantMessage && fileSnapshots.size === 0 && toolUseEvents.length > 0) {
            const emptyOutputMsg = 'The AI started processing but did not produce any output. This can happen when a tool expansion fails internally. Please try sending your message again.';
            if (BUILDER_RUN_POLICY.persistChatMessages) {
              try {
                await saveChatMessage({
                  projectId,
                  userId: project.user_id,
                  role: 'system',
                  content: emptyOutputMsg,
                  tokensUsed: 0,
                  model: null,
                  meta: { tone: 'warning' },
                });
              } catch (saveErr) {
                console.error('Failed to save empty-output warning:', saveErr.message);
              }
            }
            emitClaudeStreamEvent({ type: 'error', data: { error: emptyOutputMsg } });
          }

          const sessionMessageCount = session ? session.messageCount : 0;
          socket.emit('claude-complete', {
            tokensUsed,
            model,
            exitCode,
            sessionMessageCount,
            buildSummary,
          });
          socket.to(`project-${projectId}`).emit('claude-complete', {
            tokensUsed,
            model,
            exitCode,
            sessionMessageCount,
            buildSummary,
          });
        } else {
          if (resumeSession) {
            console.warn(`Resume failed for ${providerType} (exit ${exitCode}), clearing stale session`);
            claudeService.resetCliSession(projectId, providerType).catch((err) => {
              console.warn(`Failed to clear stale session: ${err.message}`);
            });
          }

          const errorMsg = buildCliExitErrorMessage({
            providerType,
            cliName: cliAdapter.getName(),
            exitCode,
            stderrBuffer: result.stderrBuffer,
            streamErrorMessage: result.lastStreamError,
          });

          if (BUILDER_RUN_POLICY.persistChatMessages) {
            try {
              await saveChatMessage({
                projectId,
                userId: project.user_id,
                role: 'system',
                content: `Error: ${errorMsg}`,
                tokensUsed: 0,
                model: null,
                meta: {
                  tone: 'error',
                  exitCode,
                  providerType,
                },
              });
            } catch (saveError) {
              console.error('Failed to save CLI error message:', saveError.message);
            }
          }

          socket.emit('ai-error', { error: errorMsg });
        }

        await clearChatStream(projectId);
      }).catch(async (error) => {
        console.error(`${cliAdapter.getName()} process error:`, error);
        activeProjectProcesses.delete(projectId);
        claudeService.setRunActive(projectId, false);
        await clearChatStream(projectId);
        socket.emit('ai-error', { error: error.message });
      });

    } catch (error) {
      console.error('AI message error:', error);
      claudeService.setRunActive(projectId, false);
      await clearChatStream(projectId);
      socket.emit('ai-error', { error: error.message });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    for (const projectId of joinedProjectIds) {
      prReviewRefreshService.releaseProject(projectId);
    }
    joinedProjectIds.clear();
    console.log('Client disconnected:', socket.id);
  });
});

// Emit build events (to be called from build service)
export function emitBuildEvent(projectId, event, data) {
  io.to(`project-${projectId}`).emit(`build-${event}`, data);
}

// Emit deployment events
export function emitDeployEvent(projectId, event, data) {
  io.to(`project-${projectId}`).emit(`deploy-${event}`, data);
}

// ============================================================================
// GIT WATCHER → AUTO CHANGESET CREATION
// ============================================================================

gitWatcherService.on('new-commits', async (event) => {
  const { projectId, projectPath, previousHead, currentHead, commits, diffSummary, fileChanges } = event;

  try {
    // Build title from commit messages
    const commitMessages = commits.map(c => c.message).filter(Boolean);
    const title = commits.length === 1
      ? commitMessages[0] || 'External commit'
      : `${commits.length} external commits`;

    // Create changeset with source: 'git_watcher'
    const changeset = await changesetService.createChangeSet(projectPath, {
      source: 'git_watcher',
      title,
      summary: commits.length > 1
        ? commitMessages.map((m, i) => `• ${m}`).join('\n')
        : null,
      files: fileChanges,
    });

    // Update commit SHA since these are already committed
    await changesetService.updateChangeSetCommit(projectPath, changeset.id, {
      commitSha: currentHead,
      commitMessage: commitMessages[0] || null,
    });
    await changesetService.updateChangeSetStatus(projectPath, changeset.id, 'committed');

    console.log(`[GitWatcher→CS] Created ${changeset.displayId} for ${commits.length} commit(s) in project ${projectId}`);

    // Notify connected clients
    io.to(`project-${projectId}`).emit('claude-stream-event', {
      type: 'changeset_created',
      data: {
        id: changeset.id,
        title: changeset.title,
        source: 'git_watcher',
        displayId: changeset.displayId,
      }
    });

  } catch (error) {
    console.error(`[GitWatcher→CS] Failed to create changeset for project ${projectId}:`, error.message);
  }
});

// ============================================================================
// GIT WATCHER → BRANCH REVIEW CREATION/UPDATE
// ============================================================================

/**
 * Compute diff stats for a branch review using merge-base.
 * Returns null if merge-base can't be found (e.g. offline, diverged history).
 */
async function computeBranchDiffStats(projectPath, baseBranch, headRef = 'HEAD') {
  try {
    // Resolve the base ref: prefer remote, fall back to local
    let baseRef = `origin/${baseBranch}`;
    if (!(await gitService.refExists(projectPath, `refs/remotes/${baseRef}`))) {
      baseRef = baseBranch;
      if (!(await gitService.refExists(projectPath, `refs/heads/${baseRef}`))) {
        return null;
      }
    }

    const targetRef = headRef || 'HEAD';
    const mergeBaseSha = await gitService.getMergeBase(projectPath, baseRef, targetRef);
    const git = gitService.getGitInstance(projectPath);
    const [
      stats,
      commitCountRaw,
      oldestCommitShaRaw,
      lastCommitAtRaw,
      resolvedHeadSha,
    ] = await Promise.all([
      gitService.getThreeDotDiffStats(projectPath, mergeBaseSha, targetRef),
      git.raw(['rev-list', '--count', `${mergeBaseSha}..${targetRef}`]).catch(() => '0'),
      git.raw(['rev-list', '--max-count=1', '--reverse', `${mergeBaseSha}..${targetRef}`]).catch(() => ''),
      git.raw(['show', '-s', '--format=%cI', targetRef]).catch(() => ''),
      (targetRef === 'HEAD'
        ? gitService.getCurrentSHA(projectPath)
        : gitService.getRevParse(projectPath, targetRef)
      ).catch(() => null),
    ]);

    const commitCount = Math.max(0, Number.parseInt(String(commitCountRaw || '').trim(), 10) || 0);
    const oldestCommitSha = String(oldestCommitShaRaw || '').trim();
    const firstCommitAt = oldestCommitSha
      ? String(await git.raw(['show', '-s', '--format=%cI', oldestCommitSha]).catch(() => '')).trim() || null
      : null;
    const lastCommitAt = String(lastCommitAtRaw || '').trim() || null;
    const headSha = resolvedHeadSha || null;

    return {
      mergeBaseSha,
      headSha,
      fileCount: stats.fileCount,
      totalAdditions: stats.totalAdditions,
      totalDeletions: stats.totalDeletions,
      commitCount,
      firstCommitAt,
      lastCommitAt,
    };
  } catch (error) {
    console.warn(`[GitWatcher→BR] Failed to compute branch diff stats:`, error.message);
    return null;
  }
}

/**
 * Compute diff stats for the last commit only (HEAD vs HEAD~1).
 * Used as a fallback when no base branch can be inferred (e.g. single-branch repos).
 * For root commits (no parent), diffs against the git empty tree.
 */
const GIT_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function computeLastCommitDiffStats(projectPath, headRef = 'HEAD') {
  try {
    const git = gitService.getGitInstance(projectPath);
    const targetRef = headRef || 'HEAD';

    // Resolve HEAD SHA
    const resolvedHeadSha = await (
      targetRef === 'HEAD'
        ? gitService.getCurrentSHA(projectPath)
        : gitService.getRevParse(projectPath, targetRef)
    ).catch(() => null);

    if (!resolvedHeadSha) return null;

    // Try HEAD~1; if it doesn't exist (root commit), use the empty tree
    let parentSha;
    let isRootCommit = false;
    try {
      parentSha = String(await git.raw(['rev-parse', `${targetRef}~1`])).trim();
    } catch {
      parentSha = GIT_EMPTY_TREE_SHA;
      isRootCommit = true;
    }

    // Use two-dot diff (parentSha..HEAD) instead of three-dot (parentSha...HEAD)
    // because the empty tree SHA is a tree object, not a commit, and three-dot
    // requires both sides to be commits.
    const diffRange = `${parentSha}..${targetRef}`;
    const [
      numstatRaw,
      lastCommitAtRaw,
    ] = await Promise.all([
      git.raw(['diff', '--numstat', diffRange]).catch(() => ''),
      git.raw(['show', '-s', '--format=%cI', targetRef]).catch(() => ''),
    ]);

    // Parse numstat output (same logic as gitService.getThreeDotDiffStats)
    let totalAdditions = 0;
    let totalDeletions = 0;
    let fileCount = 0;
    if (numstatRaw.trim()) {
      for (const line of numstatRaw.trim().split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          totalAdditions += parts[0] === '-' ? 0 : parseInt(parts[0], 10);
          totalDeletions += parts[1] === '-' ? 0 : parseInt(parts[1], 10);
          fileCount++;
        }
      }
    }

    const lastCommitAt = String(lastCommitAtRaw || '').trim() || null;

    return {
      mergeBaseSha: parentSha,
      headSha: resolvedHeadSha,
      fileCount,
      totalAdditions,
      totalDeletions,
      commitCount: 1,
      firstCommitAt: lastCommitAt,
      lastCommitAt,
      isLastCommitFallback: true,
      isRootCommit,
    };
  } catch (error) {
    console.warn(`[GitWatcher→BR] Failed to compute last-commit diff stats:`, error.message);
    return null;
  }
}

/**
 * Resolve the fork_point_sha to persist when reconciling a branch review
 * from a git-watcher event. Mirrors the rules in
 * `resolveReconciledForkPointSha` from branchReviews.js:
 *  - Preserve an existing fork point when it is still an ancestor of HEAD
 *    (true for normal commits, merge-commit, squash merge; false for a true
 *     rebase onto a different base).
 *  - Otherwise fall back to the newly-computed merge-base, unless that value
 *    collapses to HEAD (fast-forward merge case) — never store mergeBase == HEAD.
 */
async function resolveWatcherForkPointSha(projectPath, review, diffStats) {
  return resolvePreservedForkPointSha({
    projectPath,
    existingForkPointSha: review?.forkPointSha,
    nextMergeBaseSha: diffStats?.mergeBaseSha,
    nextHeadSha: diffStats?.headSha,
    gitService,
  });
}

/**
 * When creating a fresh branch review whose first computed merge-base equals
 * HEAD (the branch is already merged into the base), try to recover the
 * original fork point from the branch reflog via `git merge-base --fork-point`.
 *
 * Returns `null` when the reflog is unavailable or cannot produce a fork
 * point — callers should proceed with `fork_point_sha = null` so UI and
 * reconcile logic can surface the unrecoverable-merged state explicitly.
 */
async function recoverForkPointForNewReview(projectPath, effectiveBaseBranch, branchName, diffStats) {
  if (!diffStats || !effectiveBaseBranch || !branchName) return null;
  const nextMergeBase = typeof diffStats.mergeBaseSha === 'string' ? diffStats.mergeBaseSha.trim() : '';
  const nextHead = typeof diffStats.headSha === 'string' ? diffStats.headSha.trim() : '';
  if (!nextMergeBase || !nextHead) return null;
  // Only trigger reflog recovery for the collapse case (merge-base == HEAD).
  if (nextMergeBase !== nextHead) return null;

  // Prefer remote base when available so the reflog lookup matches the ref
  // git-watcher uses elsewhere.
  let baseRef = effectiveBaseBranch;
  const hasRemoteRef = await gitService
    .refExists(projectPath, `refs/remotes/origin/${effectiveBaseBranch}`)
    .catch(() => false);
  if (hasRemoteRef) {
    baseRef = `origin/${effectiveBaseBranch}`;
  }

  const recovered = await gitService
    .getForkPointFromReflog(projectPath, baseRef, branchName)
    .catch(() => null);
  if (!recovered) return null;
  // Never return HEAD (that would defeat the whole recovery purpose).
  if (recovered === nextHead) return null;
  return recovered;
}

/**
 * Resolve the diff stats the watcher should persist for a branch review.
 *
 * When `diffStats.fileCount === 0` we may be looking at the fast-forward-
 * merge collapse (merge-base == HEAD) on a branch whose real work is still
 * reachable through the preserved `fork_point_sha`. Retry the three-dot
 * diff against the fork point in that case so the review is not persisted
 * with zero counts — zeroing `file_count`/`commit_count` would hide the
 * branch's commits from the UI and cause `hasPendingAutoReviewWork` to
 * skip reviewing them.
 *
 * Returns the merge-base-based `diffStats` when recovery is not possible.
 */
async function resolveWatcherEffectiveStats(projectPath, branchName, diffStats, resolvedForkPointSha) {
  return resolveEffectiveDiffStats({
    projectPath,
    branchName,
    diffStats,
    forkPointSha: resolvedForkPointSha,
    gitService,
  });
}

function hasPendingAutoReviewWork(review, diffStats) {
  if (!review || !diffStats || Number(diffStats.fileCount || 0) <= 0) {
    return false;
  }

  const currentHeadSha = String(diffStats.headSha || review.headSha || '').trim();
  const currentMergeBaseSha = String(diffStats.mergeBaseSha || review.mergeBaseSha || '').trim();
  const reviewStatus = String(review.reviewStatus || '').trim().toLowerCase();
  const reviewedHeadSha = String(review.reviewHeadSha || '').trim();
  const reviewedMergeBaseSha = String(review.reviewMergeBaseSha || '').trim();
  const hasCompletedBaseline = reviewStatus === 'reviewed' && reviewedHeadSha && reviewedMergeBaseSha;

  if (!hasCompletedBaseline) {
    return true;
  }

  return reviewedHeadSha !== currentHeadSha || reviewedMergeBaseSha !== currentMergeBaseSha;
}

async function shouldAutoQueueBranchReview(review, diffStats) {
  if (!hasPendingAutoReviewWork(review, diffStats)) {
    return false;
  }
  if (await isBranchAutoReviewSuppressedForSnapshot(review, diffStats)) {
    console.log(`[GitWatcher→BR] Skipping auto-review for ${review.displayId || review.id}; user stopped this snapshot`);
    return false;
  }
  return true;
}

function buildAutoReviewSnapshot(review, diffStats) {
  return {
    headSha: String(diffStats?.headSha || review?.headSha || '').trim(),
    mergeBaseSha: String(diffStats?.mergeBaseSha || review?.mergeBaseSha || '').trim(),
    baseBranch: String(review?.baseBranch || '').trim(),
  };
}

function parseAutoReviewSetting(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

async function isAutoReviewEnabledForProject(projectId) {
  const [globalResult, projectResult] = await Promise.all([
    db.query('SELECT value FROM settings WHERE id = $1', ['auto_review_enabled']),
    db.query('SELECT value FROM settings WHERE id = $1', [`project_auto_review_enabled:${projectId}`]),
  ]);
  const globalEnabled = parseAutoReviewSetting(globalResult.rows[0]?.value, true);
  const projectEnabled = parseAutoReviewSetting(projectResult.rows[0]?.value, false);
  return globalEnabled && projectEnabled;
}

async function resolveEffectiveReviewBaseBranch(projectId, projectPath, branchName, fallbackBaseBranch, existingReview = null) {
  const preferredBase = typeof fallbackBaseBranch === 'string' ? fallbackBaseBranch.trim() : '';
  const pinnedBase = existingReview?.baseBranchSource === 'pinned'
    && typeof existingReview?.baseBranch === 'string'
    && existingReview.baseBranch.trim()
    && existingReview.baseBranch.trim() !== branchName
    ? existingReview.baseBranch.trim()
    : '';

  if (pinnedBase) {
    const [localExists, remoteExists] = await Promise.all([
      gitService.refExists(projectPath, `refs/heads/${pinnedBase}`).catch(() => false),
      gitService.refExists(projectPath, `refs/remotes/origin/${pinnedBase}`).catch(() => false),
    ]);
    if (localExists || remoteExists) {
      return pinnedBase;
    }
  }

  const prBase = await prReviewService.findBaseBranchForHead(projectId, branchName);
  if (prBase && prBase !== branchName) {
    return prBase;
  }

  try {
    const inferred = await gitService.inferBaseBranch(projectPath, branchName, {
      preferredBaseBranch: preferredBase || null,
    });
    if (typeof inferred === 'string' && inferred.trim()) {
      return inferred.trim();
    }
  } catch (error) {
    console.warn(`[GitWatcher→BR] Failed to infer base branch for '${branchName}':`, error.message);
  }

  if (preferredBase) {
    const hasRemoteRef = await gitService.refExists(projectPath, `refs/remotes/origin/${preferredBase}`).catch(() => false);
    const hasLocalRef = hasRemoteRef
      ? true
      : await gitService.refExists(projectPath, `refs/heads/${preferredBase}`).catch(() => false);
    if (hasRemoteRef || hasLocalRef) {
      return preferredBase;
    }
  }

  return preferredBase || null;
}

async function resolveAuthoritativeWatcherBaseBranch(projectPath, branchName, fallbackBaseBranch) {
  const preferredBase = typeof fallbackBaseBranch === 'string' ? fallbackBaseBranch.trim() : '';

  if (preferredBase) {
    return preferredBase;
  }

  let remoteDefaultBranch = null;

  try {
    const detected = await gitService.getRemoteDefaultBranch(projectPath);
    if (typeof detected === 'string' && detected.trim()) {
      remoteDefaultBranch = detected.trim();
    }
  } catch {
    remoteDefaultBranch = null;
  }

  if (branchName && remoteDefaultBranch && branchName === remoteDefaultBranch) {
    // If the current branch IS the remote default, check whether other branches
    // exist. If it's the only branch (common in new/forked repos), return null
    // so the handler falls through to last-commit review instead of treating
    // this as "user switched to the base branch, nothing to review."
    const localBranches = await gitService.listBranches(projectPath).catch(() => []);
    const otherBranches = localBranches.filter(
      (entry) => entry?.name && entry.name !== branchName
    );
    if (otherBranches.length === 0) {
      return null;
    }
    return remoteDefaultBranch;
  }

  return preferredBase || remoteDefaultBranch || null;
}

async function retireRecreatedBranchReview(projectId, projectPath, review, nextHeadSha) {
  if (!review) return review;

  const shouldRotate = await shouldRotateBranchReviewOnHeadChange({
    projectPath,
    review,
    nextHeadSha,
    gitService,
  });
  if (!shouldRotate) return review;

  const retired = await branchReviewService.updateReview(review.id, {
    status: 'stale',
    is_current: 0,
  });
  const rotatedReview = retired || {
    ...review,
    status: 'stale',
    isCurrent: false,
  };

  io.to(`project-${projectId}`).emit('branch-review-update', {
    type: 'updated',
    branchReview: rotatedReview,
  });
  io.to(`project-${projectId}`).emit('branch-review-updated', {
    branchReview: rotatedReview,
  });

  console.log(
    `[GitWatcher→BR] Rotated stale review ${review.displayId} for branch '${review.branchName}' `
    + `because HEAD lineage changed (${String(review.headSha || '').slice(0, 7)} → ${String(nextHeadSha || '').slice(0, 7)})`
  );

  return null;
}

async function retirePreviousCurrentBranchReview(projectId, projectPath, nextBranchName, preferredBaseBranch = null) {
  const current = await branchReviewService.getCurrent(projectId);
  if (!current || current.branchName === nextBranchName) return null;

  let updated = current;
  try {
    const branchRef = `refs/heads/${current.branchName}`;
    const branchExists = await gitService.refExists(projectPath, branchRef).catch(() => false);

    if (!branchExists) {
      updated = await branchReviewService.updateReview(current.id, {
        status: 'closed',
        is_current: 0,
      }) || current;
      console.log(`[GitWatcher→BR] Closed ${current.displayId} — branch '${current.branchName}' no longer exists locally`);
    } else {
      const effectiveBaseBranch = await resolveEffectiveReviewBaseBranch(
        projectId,
        projectPath,
        current.branchName,
        current.baseBranch || preferredBaseBranch || null,
        current,
      );
      let diffStats;
      if (effectiveBaseBranch) {
        diffStats = await computeBranchDiffStats(projectPath, effectiveBaseBranch, current.branchName).catch(() => null);
      } else {
        diffStats = await computeLastCommitDiffStats(projectPath, current.branchName).catch(() => null);
      }
      const resolvedBase = effectiveBaseBranch || `${current.branchName}~last-commit`;
      const resolvedForkPointSha = diffStats
        ? await resolveWatcherForkPointSha(projectPath, current, diffStats)
        : current.forkPointSha || null;

      // Before accepting a "no diff" result, retry against the preserved
      // fork point. After a fast-forward merge, merge-base(base, HEAD) ==
      // HEAD so three-dot diff is empty, but fork_point_sha..HEAD still
      // contains the branch's original work and the review must survive.
      const effectiveStats = await resolveEffectiveDiffStats({
        projectPath,
        branchName: current.branchName,
        diffStats,
        forkPointSha: resolvedForkPointSha,
        gitService,
      });
      const forkRecoveredNonEmpty = effectiveStats !== diffStats
        && Number(effectiveStats?.fileCount || 0) > 0;

      if (
        diffStats
        && Number(diffStats.fileCount || 0) === 0
        && !forkRecoveredNonEmpty
      ) {
        updated = await branchReviewService.updateReview(current.id, {
          status: 'merged',
          is_current: 0,
          base_branch: resolvedBase,
          merge_base_sha: diffStats.mergeBaseSha,
          fork_point_sha: resolvedForkPointSha,
          head_sha: diffStats.headSha || current.headSha || null,
          file_count: 0,
          total_additions: 0,
          total_deletions: 0,
          commit_count: diffStats.commitCount,
          first_commit_at: diffStats.firstCommitAt,
          last_commit_at: diffStats.lastCommitAt,
        }) || current;
        console.log(`[GitWatcher→BR] Marked ${current.displayId} as merged (no diff vs '${resolvedBase}')`);
      } else {
        updated = await branchReviewService.updateReview(current.id, {
          status: 'stale',
          is_current: 0,
          ...(resolvedBase ? { base_branch: resolvedBase } : {}),
        }) || current;
        console.log(`[GitWatcher→BR] Retired ${current.displayId} as stale after switching away from '${current.branchName}'`);
      }
    }
  } catch (error) {
    console.warn(`[GitWatcher→BR] Failed to retire previous current BR:`, error.message);
    updated = await branchReviewService.updateReview(current.id, { is_current: 0 }) || current;
  }

  io.to(`project-${projectId}`).emit('branch-review-update', {
    type: 'updated',
    branchReview: updated,
  });
  io.to(`project-${projectId}`).emit('branch-review-updated', {
    branchReview: updated,
  });

  return updated;
}

gitWatcherService.on('branch-switched', async (event) => {
  const { projectId, projectPath, previousBranch, currentBranch, currentHead, baseBranch, isWorktree } = event;

  try {
    const authoritativeBaseBranch = await resolveAuthoritativeWatcherBaseBranch(
      projectPath,
      currentBranch,
      baseBranch,
    );
    if (!isWorktree) {
      await retirePreviousCurrentBranchReview(
        projectId,
        projectPath,
        currentBranch,
        authoritativeBaseBranch,
      );
    }
    // If switching TO the base branch, deactivate current BR and classify lifecycle.
    // (Worktree events never switch to base — filtered upstream.)
    if (authoritativeBaseBranch && currentBranch === authoritativeBaseBranch) {
      const current = await branchReviewService.getCurrent(projectId);
      if (current) {
        let classified = current;
        try {
          const branchRef = `refs/heads/${current.branchName}`;
          const branchExists = await gitService.refExists(projectPath, branchRef);
          if (!branchExists) {
            classified = await branchReviewService.updateReview(current.id, {
              status: 'closed',
              is_current: 0,
            }) || current;
            console.log(`[GitWatcher→BR] Closed ${current.displayId} — branch '${current.branchName}' no longer exists locally`);
          } else {
            const previousStats = await computeBranchDiffStats(projectPath, authoritativeBaseBranch, current.branchName);
            const resolvedForkPointSha = previousStats
              ? await resolveWatcherForkPointSha(projectPath, current, previousStats)
              : current.forkPointSha || null;

            // Retry via the preserved fork point — a fast-forward merge
            // makes merge-base == HEAD (zero diff) but fork_point..HEAD
            // still contains the branch's work and must not be collapsed.
            const effectivePreviousStats = await resolveEffectiveDiffStats({
              projectPath,
              branchName: current.branchName,
              diffStats: previousStats,
              forkPointSha: resolvedForkPointSha,
              gitService,
            });
            const forkRecoveredNonEmpty = effectivePreviousStats !== previousStats
              && Number(effectivePreviousStats?.fileCount || 0) > 0;

            if (
              previousStats
              && previousStats.fileCount === 0
              && !forkRecoveredNonEmpty
            ) {
              classified = await branchReviewService.updateReview(current.id, {
                status: 'merged',
                is_current: 0,
                merge_base_sha: previousStats.mergeBaseSha,
                fork_point_sha: resolvedForkPointSha,
                head_sha: previousStats.headSha || current.headSha || null,
                file_count: 0,
                total_additions: 0,
                total_deletions: 0,
                commit_count: previousStats.commitCount,
                first_commit_at: previousStats.firstCommitAt,
                last_commit_at: previousStats.lastCommitAt,
              }) || current;
              console.log(`[GitWatcher→BR] Marked ${current.displayId} as merged (no diff vs '${authoritativeBaseBranch}')`);
            } else {
              classified = await branchReviewService.updateReview(current.id, { is_current: 0 }) || current;
            }
          }
        } catch (classifyError) {
          console.warn(`[GitWatcher→BR] Failed to classify previous BR lifecycle:`, classifyError.message);
        }

        await branchReviewService.setCurrentBranch(projectId, null);
        console.log(`[GitWatcher→BR] Switched to base branch '${authoritativeBaseBranch}' — deactivated current BR`);
        io.to(`project-${projectId}`).emit('branch-review-updated', {
          branchReview: classified,
        });
      }
      io.to(`project-${projectId}`).emit('branch-switched', {
        projectId,
        previousBranch,
        currentBranch,
        baseBranch: authoritativeBaseBranch,
        isBaseBranch: true,
        isWorktree: Boolean(isWorktree),
      });
      return;
    }

    // Switching to a topic branch — find or create a BR
    let review = await branchReviewService.getByBranch(projectId, currentBranch, {
      statuses: ['active', 'stale'],
    });
    const wasExisting = !!review;

    const effectiveBaseBranch = await resolveEffectiveReviewBaseBranch(
      projectId,
      projectPath,
      currentBranch,
      authoritativeBaseBranch,
      review,
    );

    // Compute diff stats from merge-base, or fall back to last-commit diff
    let diffStats;
    let isLastCommitFallback = false;
    if (effectiveBaseBranch) {
      diffStats = await computeBranchDiffStats(projectPath, effectiveBaseBranch, currentHead || 'HEAD');
    } else {
      diffStats = await computeLastCommitDiffStats(projectPath, currentHead || 'HEAD');
      isLastCommitFallback = !!diffStats;
      if (isLastCommitFallback) {
        console.log(`[GitWatcher→BR] No base branch for '${currentBranch}', falling back to last-commit review`);
      } else {
        await branchReviewService.setCurrentBranch(projectId, null);
        console.log(`[GitWatcher→BR] No effective base branch and no commits for '${currentBranch}', skipping BR creation/update`);
        io.to(`project-${projectId}`).emit('branch-switched', {
          projectId,
          previousBranch,
          currentBranch,
          baseBranch: null,
          isBaseBranch: false,
          isWorktree: Boolean(isWorktree),
        });
        return;
      }
    }
    const resolvedBaseBranch = effectiveBaseBranch || `${currentBranch}~last-commit`;
    const hasNoDiff = diffStats && Number(diffStats.fileCount || 0) === 0;
    review = await retireRecreatedBranchReview(
      projectId,
      projectPath,
      review,
      diffStats?.headSha || currentHead || null,
    );

    // Do not create a brand-new branch review for a topic branch that has no
    // diff against its base yet. Existing reviews are still updated below so a
    // previously-reviewed branch can remain visible when revisited.
    if (!review && hasNoDiff) {
      if (!isWorktree) {
        await branchReviewService.setCurrentBranch(projectId, null);
      }
      console.log(`[GitWatcher→BR] Branch '${currentBranch}' currently has no diff vs '${resolvedBaseBranch}'`);
      io.to(`project-${projectId}`).emit('branch-no-changes', {
        projectId,
        branch: currentBranch,
        baseBranch: resolvedBaseBranch,
      });
      io.to(`project-${projectId}`).emit('branch-switched', {
        projectId,
        previousBranch,
        currentBranch,
        baseBranch: resolvedBaseBranch,
        isBaseBranch: false,
        isLastCommitFallback,
        isWorktree: Boolean(isWorktree),
      });
      return;
    }

    // Resolve fork-point-aware effective diff stats once so the update
    // payload and the downstream auto-review check both see the recovered
    // counts (not the merge-base-collapsed zero counts).
    let effectiveDiffStats = diffStats;
    if (review && diffStats) {
      const resolvedForkPointSha = await resolveWatcherForkPointSha(projectPath, review, diffStats);
      effectiveDiffStats = await resolveWatcherEffectiveStats(
        projectPath,
        currentBranch,
        diffStats,
        resolvedForkPointSha,
      );
      effectiveDiffStats = { ...effectiveDiffStats, resolvedForkPointSha };
    }

    if (review) {
      // Switching onto a topic branch should make that branch visible in the
      // review list even when it currently has no diff yet.
      const updateFields = {
        base_branch: resolvedBaseBranch,
        head_sha: diffStats?.headSha || currentHead,
        status: resolveTrackedBranchReviewStatus({
          currentStatus: review.status,
          fileCount: effectiveDiffStats?.fileCount,
        }),
      };
      // Worktree branches should not claim "current" — that's reserved for the
      // main working directory's checked-out branch.
      if (!isWorktree) {
        updateFields.is_current = 1;
      }

      if (diffStats) {
        updateFields.merge_base_sha = diffStats.mergeBaseSha;
        updateFields.fork_point_sha = effectiveDiffStats.resolvedForkPointSha;
        updateFields.file_count = effectiveDiffStats.fileCount;
        updateFields.total_additions = effectiveDiffStats.totalAdditions;
        updateFields.total_deletions = effectiveDiffStats.totalDeletions;
        updateFields.commit_count = effectiveDiffStats.commitCount;
        updateFields.first_commit_at = effectiveDiffStats.firstCommitAt;
        updateFields.last_commit_at = effectiveDiffStats.lastCommitAt;
        // Gate the snapshot-clear on the *effective* counts. Fork-point
        // recovery can produce non-zero counts from a merge-base-collapsed
        // diff, and in that case we must keep the persisted review snapshot
        // so the branch stays reviewable.
        if (
          Number(effectiveDiffStats.fileCount || 0) === 0
          && Number(effectiveDiffStats.commitCount || 0) === 0
          && hasPersistedBranchReviewSnapshot(review)
        ) {
          Object.assign(updateFields, getClearedBranchReviewSnapshotFields());
        }
      }

      review = await branchReviewService.updateReview(review.id, updateFields);
      if (!isWorktree) {
        await branchReviewService.setCurrentBranch(projectId, review.id);
      }
      console.log(`[GitWatcher→BR] ${isWorktree ? 'Updated worktree' : 'Reactivated'} ${review.displayId} for branch '${currentBranch}' (${updateFields.file_count || 0} files)`);
    } else {
      // Create new BR. If the fork-point resolution fell back to null because
      // merge-base collapsed to HEAD (already-merged branch at creation time),
      // try reflog-based recovery so the branch still has reviewable history.
      let initialForkPointSha = diffStats
        ? await resolveWatcherForkPointSha(projectPath, null, diffStats)
        : null;
      if (!initialForkPointSha && effectiveBaseBranch) {
        initialForkPointSha = await recoverForkPointForNewReview(
          projectPath,
          effectiveBaseBranch,
          currentBranch,
          diffStats,
        );
      }
      // Overlay fork-point-recovered counts on the create payload too.
      // Without this, a new review for an already-merged branch would be
      // persisted with fork_point_sha populated but file_count=0 /
      // commit_count=0 from the collapsed merge-base diff — so the UI
      // and auto-review gating would still miss the branch's real work.
      const initialEffectiveStats = diffStats
        ? await resolveWatcherEffectiveStats(projectPath, currentBranch, diffStats, initialForkPointSha)
        : null;
      review = await branchReviewService.create({
        projectId,
        branchName: currentBranch,
        baseBranch: resolvedBaseBranch,
        mergeBaseSha: diffStats?.mergeBaseSha || null,
        forkPointSha: initialForkPointSha,
        headSha: diffStats?.headSha || currentHead,
        stats: initialEffectiveStats || diffStats || {},
        isCurrent: !isWorktree,
      });
      if (!isWorktree) {
        await branchReviewService.setCurrentBranch(projectId, review.id);
      }
      console.log(`[GitWatcher→BR] Created ${review.displayId} for ${isWorktree ? 'worktree ' : ''}branch '${currentBranch}' (${initialEffectiveStats?.fileCount ?? diffStats?.fileCount ?? 0} files, ${initialEffectiveStats?.commitCount ?? diffStats?.commitCount ?? 0} commits)`);
    }

    if (hasNoDiff) {
      console.log(`[GitWatcher→BR] Branch '${currentBranch}' currently has no diff vs '${resolvedBaseBranch}'`);
      io.to(`project-${projectId}`).emit('branch-no-changes', {
        projectId,
        branch: currentBranch,
        baseBranch: resolvedBaseBranch,
      });
    }

    // Notify connected clients
    io.to(`project-${projectId}`).emit('branch-review-update', {
      type: wasExisting ? 'updated' : 'created',
      branchReview: review,
    });
    io.to(`project-${projectId}`).emit(
      wasExisting ? 'branch-review-updated' : 'branch-review-created',
      { branchReview: review }
    );
    io.to(`project-${projectId}`).emit('branch-switched', {
      projectId,
      previousBranch,
      currentBranch,
      baseBranch: resolvedBaseBranch,
      isBaseBranch: false,
      isLastCommitFallback,
      isWorktree: Boolean(isWorktree),
    });

    // Auto-queue review when the global default is enabled and this project
    // has explicitly opted in from Project Home.
    try {
      const autoReviewEnabled = await isAutoReviewEnabledForProject(projectId);
      if (
        autoReviewEnabled
        && review
        && await shouldAutoQueueBranchReview(review, effectiveDiffStats)
      ) {
        const reviewService = await ensureReviewServiceEventBridge();
        const queueEntry = reviewService.enqueueBranchReview(projectPath, review.id, {
          projectId,
          autoReviewSnapshot: buildAutoReviewSnapshot(review, effectiveDiffStats),
        });
        console.log(`[GitWatcher→BR] Auto-queued review for ${review.displayId} (position: ${queueEntry.position})`);
      }
    } catch (reviewError) {
      console.warn(
        `[GitWatcher→BR] Auto-review failed for ${review?.displayId ?? 'unknown'}:`,
        reviewError.message
      );
    }
  } catch (error) {
    console.error(`[GitWatcher→BR] Failed to handle branch switch for ${projectId}:`, error.message);
  }
});

gitWatcherService.on('branch-updated', async (event) => {
  const { projectId, projectPath, previousHead, currentHead, branch, baseBranch, isWorktree } = event;

  try {
    const authoritativeBaseBranch = await resolveAuthoritativeWatcherBaseBranch(
      projectPath,
      branch,
      baseBranch,
    );
    if (authoritativeBaseBranch && branch === authoritativeBaseBranch) {
      const current = await branchReviewService.getByBranch(projectId, branch);
      if (current) {
        const updated = await branchReviewService.updateReview(current.id, {
          status: 'stale',
          is_current: 0,
        }) || current;
        io.to(`project-${projectId}`).emit('branch-review-update', {
          type: 'updated',
          branchReview: updated,
        });
        io.to(`project-${projectId}`).emit('branch-review-updated', {
          branchReview: updated,
        });
      }
      return;
    }

    const effectiveBaseBranch = await resolveEffectiveReviewBaseBranch(
      projectId,
      projectPath,
      branch,
      authoritativeBaseBranch,
      review,
    );

    // Compute updated diff stats, or fall back to last-commit diff
    let diffStats;
    let isLastCommitFallback = false;
    if (effectiveBaseBranch) {
      diffStats = await computeBranchDiffStats(projectPath, effectiveBaseBranch, currentHead || 'HEAD');
    } else {
      diffStats = await computeLastCommitDiffStats(projectPath, currentHead || 'HEAD');
      isLastCommitFallback = !!diffStats;
      if (!isLastCommitFallback) return;
      console.log(`[GitWatcher→BR] No base branch for '${branch}', falling back to last-commit review`);
    }
    const resolvedBaseBranch = effectiveBaseBranch || `${branch}~last-commit`;

    // Find existing BR for this branch
    let review = await branchReviewService.getByBranch(projectId, branch, {
      statuses: ['active', 'stale'],
    });
    review = await retireRecreatedBranchReview(
      projectId,
      projectPath,
      review,
      currentHead || diffStats?.headSha || null,
    );

    if (!review && diffStats && Number(diffStats.fileCount || 0) === 0) {
      if (!isWorktree) {
        await branchReviewService.setCurrentBranch(projectId, null);
      }
      console.log(`[GitWatcher→BR] Skipped creating BR for '${branch}' because it has no diff vs '${resolvedBaseBranch}'`);
      io.to(`project-${projectId}`).emit('branch-no-changes', {
        projectId,
        branch,
        baseBranch: resolvedBaseBranch,
      });
      return;
    }

    // Resolve fork-point-aware effective stats up front so both the update
    // payload and the auto-review gating below agree on the recovered counts.
    let effectiveDiffStats = diffStats;
    if (review && diffStats) {
      const resolvedForkPointSha = await resolveWatcherForkPointSha(projectPath, review, diffStats);
      effectiveDiffStats = await resolveWatcherEffectiveStats(
        projectPath,
        branch,
        diffStats,
        resolvedForkPointSha,
      );
      effectiveDiffStats = { ...effectiveDiffStats, resolvedForkPointSha };
    }

    if (review) {
      // Commits on a topic branch should keep that branch visible in the
      // review list even if the net diff returns to zero.
      const updateFields = {
        base_branch: resolvedBaseBranch,
        head_sha: currentHead,
        status: resolveTrackedBranchReviewStatus({
          currentStatus: review.status,
          fileCount: effectiveDiffStats?.fileCount,
        }),
      };
      if (!isWorktree) {
        updateFields.is_current = 1;
      }

      if (diffStats) {
        updateFields.merge_base_sha = diffStats.mergeBaseSha;
        updateFields.fork_point_sha = effectiveDiffStats.resolvedForkPointSha;
        updateFields.file_count = effectiveDiffStats.fileCount;
        updateFields.total_additions = effectiveDiffStats.totalAdditions;
        updateFields.total_deletions = effectiveDiffStats.totalDeletions;
        updateFields.commit_count = effectiveDiffStats.commitCount;
        updateFields.first_commit_at = effectiveDiffStats.firstCommitAt;
        updateFields.last_commit_at = effectiveDiffStats.lastCommitAt;
        if (
          Number(effectiveDiffStats.fileCount || 0) === 0
          && Number(effectiveDiffStats.commitCount || 0) === 0
          && hasPersistedBranchReviewSnapshot(review)
        ) {
          Object.assign(updateFields, getClearedBranchReviewSnapshotFields());
        }
      }

      review = await branchReviewService.updateReview(review.id, updateFields);
      if (!isWorktree) {
        await branchReviewService.setCurrentBranch(projectId, review.id);
      }
      console.log(`[GitWatcher→BR] Updated ${review.displayId} on '${branch}': ${updateFields.file_count || 0} files, ${updateFields.commit_count || 0} commits`);
    } else {
      // First commit on topic branch that wasn't detected via branch-switch
      // (e.g., watcher started while already on this branch)
      const initialForkPointSha = diffStats
        ? await resolveWatcherForkPointSha(projectPath, null, diffStats)
        : null;
      const initialEffectiveStats = diffStats
        ? await resolveWatcherEffectiveStats(projectPath, branch, diffStats, initialForkPointSha)
        : null;
      review = await branchReviewService.create({
        projectId,
        branchName: branch,
        baseBranch: resolvedBaseBranch,
        mergeBaseSha: diffStats?.mergeBaseSha || null,
        forkPointSha: initialForkPointSha,
        headSha: currentHead,
        stats: initialEffectiveStats || diffStats || {},
        isCurrent: !isWorktree,
      });
      if (!isWorktree) {
        await branchReviewService.setCurrentBranch(projectId, review.id);
      }
      console.log(`[GitWatcher→BR] Auto-created ${review.displayId} for ${isWorktree ? 'worktree ' : ''}'${branch}': ${diffStats?.fileCount || 0} files`);
    }

    if (diffStats && Number(diffStats.fileCount || 0) === 0) {
      io.to(`project-${projectId}`).emit('branch-no-changes', {
        projectId,
        branch,
        baseBranch: resolvedBaseBranch,
      });
    }

    // Notify connected clients
    io.to(`project-${projectId}`).emit('branch-review-update', {
      type: 'updated',
      branchReview: review,
    });
    io.to(`project-${projectId}`).emit('branch-review-updated', {
      branchReview: review,
    });

    // Auto-queue review on branch update when this project opted in.
    try {
      const autoReviewEnabled = await isAutoReviewEnabledForProject(projectId);
      if (
        autoReviewEnabled
        && review
        && await shouldAutoQueueBranchReview(review, effectiveDiffStats)
      ) {
        const reviewService = await ensureReviewServiceEventBridge();
        const queueEntry = reviewService.enqueueBranchReview(projectPath, review.id, {
          projectId,
          autoReviewSnapshot: buildAutoReviewSnapshot(review, effectiveDiffStats),
        });
        console.log(`[GitWatcher→BR] Auto-queued review for ${review.displayId} on update (position: ${queueEntry.position})`);
      }
    } catch (reviewError) {
      console.warn(`[GitWatcher→BR] Auto-review queue failed for BR on '${branch}':`, reviewError.message);
    }
  } catch (error) {
    console.error(`[GitWatcher→BR] Failed to handle branch update for ${projectId}:`, error.message);
  }
});

gitWatcherService.on('worktree-removed', async (event) => {
  const { projectId, projectPath, branch, head, baseBranch } = event;

  try {
    const review = await branchReviewService.getByBranch(projectId, branch);
    if (!review) return;

    let updated = review;
    const branchExists = await gitService.refExists(projectPath, `refs/heads/${branch}`).catch(() => false);

    if (!branchExists) {
      updated = await branchReviewService.updateReview(review.id, {
        status: 'closed',
        is_current: 0,
      }) || review;
      console.log(`[GitWatcher→BR] Closed ${review.displayId} after worktree removal — branch '${branch}' no longer exists locally`);
    } else {
      const effectiveBaseBranch = await resolveEffectiveReviewBaseBranch(
        projectId,
        projectPath,
        branch,
        baseBranch,
        review,
      );
      const diffStats = effectiveBaseBranch
        ? await computeBranchDiffStats(projectPath, effectiveBaseBranch, branch)
        : null;
      const resolvedForkPointSha = diffStats
        ? await resolveWatcherForkPointSha(projectPath, review, diffStats)
        : review.forkPointSha || null;

      // Retry via the preserved fork point before accepting the merged
      // state; protects against fast-forward-merge collapsing fileCount
      // to 0 when the branch still has reviewable commits relative to
      // its original fork.
      const effectiveStats = await resolveEffectiveDiffStats({
        projectPath,
        branchName: branch,
        diffStats,
        forkPointSha: resolvedForkPointSha,
        gitService,
      });
      const forkRecoveredNonEmpty = effectiveStats !== diffStats
        && Number(effectiveStats?.fileCount || 0) > 0;

      if (
        diffStats
        && Number(diffStats.fileCount || 0) === 0
        && !forkRecoveredNonEmpty
      ) {
        updated = await branchReviewService.updateReview(review.id, {
          status: 'merged',
          is_current: 0,
          base_branch: effectiveBaseBranch,
          merge_base_sha: diffStats.mergeBaseSha,
          fork_point_sha: resolvedForkPointSha,
          head_sha: diffStats.headSha || head || review.headSha || null,
          file_count: 0,
          total_additions: 0,
          total_deletions: 0,
          commit_count: diffStats.commitCount,
          first_commit_at: diffStats.firstCommitAt,
          last_commit_at: diffStats.lastCommitAt,
        }) || review;
        console.log(`[GitWatcher→BR] Marked ${review.displayId} as merged after worktree removal (no diff vs '${effectiveBaseBranch}')`);
      } else {
        updated = await branchReviewService.updateReview(review.id, {
          is_current: 0,
        }) || review;
      }
    }

    io.to(`project-${projectId}`).emit('branch-review-update', {
      type: 'updated',
      branchReview: updated,
    });
    io.to(`project-${projectId}`).emit('branch-review-updated', {
      branchReview: updated,
    });
  } catch (error) {
    console.warn(`[GitWatcher→BR] Failed to handle worktree removal for ${projectId}:`, error.message);
  }
});

gitWatcherService.on('detached-head', (event) => {
  const { projectId, previousBranch } = event;
  io.to(`project-${projectId}`).emit('detached-head', {
    projectId,
    previousBranch,
  });
});

prReviewSyncService.on('sync-started', (data) => {
  if (!data?.projectId) return;
  io.to(`project-${data.projectId}`).emit('pr-sync-started', {
    projectId: data.projectId,
    source: data.source || 'manual',
    startedAt: data.startedAt || new Date().toISOString(),
  });
});

prReviewSyncService.on('sync-completed', (data) => {
  if (!data?.projectId) return;
  io.to(`project-${data.projectId}`).emit('pr-sync-completed', {
    projectId: data.projectId,
    source: data.source || 'manual',
    synced: Number(data.synced || 0),
    deltaCount: Array.isArray(data.deltas) ? data.deltas.length : 0,
    deltas: Array.isArray(data.deltas) ? data.deltas : [],
    completedAt: data.completedAt || new Date().toISOString(),
  });
});

prReviewSyncService.on('sync-failed', (data) => {
  if (!data?.projectId) return;
  io.to(`project-${data.projectId}`).emit('pr-sync-failed', {
    projectId: data.projectId,
    source: data.source || 'manual',
    error: data.error || 'Failed to sync pull requests',
    code: data.code || null,
    connectedLogin: data.connectedLogin || null,
    owner: data.owner || null,
    repo: data.repo || null,
    failedAt: data.failedAt || new Date().toISOString(),
  });
});

// ============================================================================
// REVIEW SERVICE → SOCKET NOTIFICATIONS
// ============================================================================

function buildBranchReviewSocketLifecycle({
  reviewStatus,
  sourceStatus,
  phase = null,
  error = null,
  updatedAt = null,
  reviewedAt = null,
} = {}) {
  const progress = phase
    ? {
      phase,
      updatedAt: updatedAt || new Date().toISOString(),
      error: error || null,
    }
    : null;
  return buildReviewLifecycle({
    reviewStatus: reviewStatus || sourceStatus || 'none',
    sourceStatus: sourceStatus || reviewStatus || null,
    progress,
    errorMessage: error,
    updatedAt: updatedAt || progress?.updatedAt || null,
    reviewedAt: reviewedAt || null,
  });
}

function attachReviewServiceEventBridge(reviewService) {
// Forward reconcile-driven branch review updates from the list route's
// background reconcile task. Emitted from
// `scheduleBranchReviewListReconcile` when a review's persisted state
// actually changed, so connected clients can refresh without navigating
// away and back to the branch.
reviewService.events.on('branch-review-update', (data) => {
  if (!data?.projectId || !data?.branchReview) return;
  io.to(`project-${data.projectId}`).emit('branch-review-update', {
    type: data.type || 'updated',
    branchReview: data.branchReview,
  });
  io.to(`project-${data.projectId}`).emit('branch-review-updated', {
    branchReview: data.branchReview,
  });
});

reviewService.events.on('branch-review-reviewing', (data) => {
  if (data.projectId) {
    const updatedAt = data.updatedAt || new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'reviewing',
      sourceStatus: 'reviewing',
      phase: 'reviewing',
      updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('branch-review-reviewing', {
      projectId: data.projectId,
      branchReviewId: data.branchReviewId,
      reviewStatus: 'reviewing',
      reviewLifecycle,
    });
  }
});

reviewService.events.on('branch-review-reviewed', (data) => {
  if (data.projectId) {
    const reviewedAt = data.reviewedAt || new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'reviewed',
      sourceStatus: 'reviewed',
      phase: 'complete',
      reviewedAt,
      updatedAt: data.updatedAt || reviewedAt,
      error: data.error || null,
    });
    io.to(`project-${data.projectId}`).emit('branch-review-reviewed', {
      projectId: data.projectId,
      branchReviewId: data.branchReviewId,
      riskLevel: data.riskLevel,
      summary: data.summary,
      reviewStatus: 'reviewed',
      reviewLifecycle,
    });
  }
});

reviewService.events.on('branch-review-progress', (data) => {
  if (data.projectId) {
    const updatedAt = data.updatedAt || new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'reviewing',
      sourceStatus: 'reviewing',
      phase: data.phase || 'reviewing',
      error: data.error || null,
      updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('branch-review-progress', {
      projectId: data.projectId,
      branchReviewId: data.branchReviewId,
      phase: data.phase,
      currentChunk: data.currentChunk,
      totalChunks: data.totalChunks,
      filesCompleted: data.filesCompleted,
      totalFiles: data.totalFiles,
      activeChunkFiles: data.activeChunkFiles,
      elapsedSeconds: data.elapsedSeconds,
      splitDepth: data.splitDepth,
      splitParts: data.splitParts,
      retryAttempt: data.retryAttempt,
      retryMaxAttempts: data.retryMaxAttempts,
      retryDelayMs: data.retryDelayMs,
      agenticToolSummary: data.agenticToolSummary || null,
      agentName: data.agentName || null,
      diffScopeMode: data.diffScopeMode === 'delta'
        ? 'delta'
        : data.diffScopeMode === 'full'
          ? 'full'
          : null,
      diffScopeCommitCount: Number(data.diffScopeCommitCount || 0),
      diffBaseSha: data.diffBaseSha || null,
      diffHeadSha: data.diffHeadSha || null,
      error: data.error || null,
      updatedAt,
      reviewStatus: 'reviewing',
      reviewLifecycle,
    });
  }
});

reviewService.events.on('branch-review-review-failed', (data) => {
  if (data.projectId) {
    const updatedAt = data.updatedAt || new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'failed',
      sourceStatus: 'failed',
      phase: 'failed',
      error: data.error || null,
      updatedAt,
      reviewedAt: data.reviewedAt || null,
    });
    io.to(`project-${data.projectId}`).emit('branch-review-review-failed', {
      projectId: data.projectId,
      branchReviewId: data.branchReviewId,
      error: data.error,
      reviewStatus: 'failed',
      reviewLifecycle,
    });
  }
});

reviewService.events.on('branch-review-stopped', (data) => {
  if (data.projectId) {
    const updatedAt = data.updatedAt || new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'none',
      sourceStatus: 'none',
      phase: null,
      error: null,
      updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('branch-review-stopped', {
      projectId: data.projectId,
      branchReviewId: data.branchReviewId,
      reviewStatus: 'none',
      reviewLifecycle,
    });
  }
});

reviewService.events.on('branch-review-queued-cancelled', (data) => {
  if (data.projectId) {
    io.to(`project-${data.projectId}`).emit('branch-review-queued-cancelled', {
      projectId: data.projectId,
      branchReviewId: data.branchReviewId,
      queueId: data.queueId || null,
    });
  }
});

reviewService.events.on('branch-review-queued', (data) => {
  if (data.projectId) {
    const updatedAt = data.updatedAt || new Date().toISOString();
    const phase = Number(data.retryAttempt || 0) > 0 ? 'provider_retry' : 'queued';
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'queued',
      sourceStatus: 'queued',
      phase,
      error: data.retryReason || null,
      updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('branch-review-queued', {
      projectId: data.projectId,
      branchReviewId: data.branchReviewId,
      queueId: data.queueId || null,
      position: data.position,
      retryAttempt: data.retryAttempt,
      retryReason: data.retryReason,
      reviewStatus: 'queued',
      reviewLifecycle,
    });
  }
});

// ── PR Review socket events ──────────────────────────────────────────────────

reviewService.events.on('pr-review-queued', (data) => {
  if (data.projectId) {
    const updatedAt = new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'queued', sourceStatus: 'queued', phase: 'queued', updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('pr-review-queued', {
      projectId: data.projectId, prReviewId: data.prReviewId,
      position: data.position, reviewStatus: 'queued', reviewLifecycle,
    });
  }
});

reviewService.events.on('pr-review-reviewing', (data) => {
  if (data.projectId) {
    const updatedAt = new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'reviewing', sourceStatus: 'reviewing', phase: 'reviewing', updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('pr-review-reviewing', {
      projectId: data.projectId, prReviewId: data.prReviewId,
      reviewStatus: 'reviewing', reviewLifecycle,
    });
  }
});

reviewService.events.on('pr-review-progress', (data) => {
  if (data.projectId) {
    const updatedAt = data.updatedAt || new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'reviewing', sourceStatus: 'reviewing',
      phase: data.phase || 'reviewing', error: data.error || null, updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('pr-review-progress', {
      projectId: data.projectId, prReviewId: data.prReviewId,
      phase: data.phase, currentChunk: data.currentChunk, totalChunks: data.totalChunks,
      filesCompleted: data.filesCompleted, totalFiles: data.totalFiles,
      activeChunkFiles: data.activeChunkFiles,
      elapsedSeconds: data.elapsedSeconds,
      splitDepth: data.splitDepth,
      splitParts: data.splitParts,
      agenticToolSummary: data.agenticToolSummary || null,
      agentName: data.agentName || null,
      diffScopeMode: data.diffScopeMode === 'delta'
        ? 'delta'
        : data.diffScopeMode === 'full'
          ? 'full'
          : null,
      diffScopeCommitCount: Number(data.diffScopeCommitCount || 0),
      diffBaseSha: data.diffBaseSha || null,
      diffHeadSha: data.diffHeadSha || null,
      error: data.error || null,
      updatedAt, reviewStatus: 'reviewing', reviewLifecycle,
    });
  }
});

reviewService.events.on('pr-review-reviewed', (data) => {
  if (data.projectId) {
    const reviewedAt = data.reviewedAt || new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'reviewed', sourceStatus: 'reviewed', phase: 'complete',
      reviewedAt, updatedAt: reviewedAt, error: data.error || null,
    });
    io.to(`project-${data.projectId}`).emit('pr-review-reviewed', {
      projectId: data.projectId, prReviewId: data.prReviewId,
      riskLevel: data.riskLevel, summary: data.summary,
      reviewStatus: 'reviewed', reviewLifecycle,
    });
  }
});

reviewService.events.on('pr-review-review-failed', (data) => {
  if (data.projectId) {
    const updatedAt = new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'failed', sourceStatus: 'failed', phase: 'failed',
      error: data.error || null, updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('pr-review-review-failed', {
      projectId: data.projectId, prReviewId: data.prReviewId,
      error: data.error, reviewStatus: 'failed', reviewLifecycle,
    });
  }
});

reviewService.events.on('pr-review-stopped', (data) => {
  if (data.projectId) {
    const updatedAt = new Date().toISOString();
    const reviewLifecycle = buildBranchReviewSocketLifecycle({
      reviewStatus: 'none', sourceStatus: 'none', phase: null, updatedAt,
    });
    io.to(`project-${data.projectId}`).emit('pr-review-stopped', {
      projectId: data.projectId, prReviewId: data.prReviewId,
      reviewStatus: 'none', reviewLifecycle,
    });
  }
});
}

// ============================================================================
// INITIALIZATION
// ============================================================================

let _startupInitialized = false;
let _deferredStartupPromise = null;

async function runDeferredStartupTasks() {
  if (_deferredStartupPromise) {
    return _deferredStartupPromise;
  }

  const deferredStartedAt = Date.now();
  let completedDeferredStartup = false;
  _deferredStartupPromise = (async () => {
    try {
      void ensureReviewServiceEventBridge().catch((error) => {
        console.error('❌ Failed to initialize review service event bridge:', error);
      });

      try {
        const cleared = await clearAllChatStreamStates();
        if (cleared > 0) {
          console.log(`Cleared ${cleared} stale chat stream state row(s).`);
        }
      } catch (error) {
        console.warn('Failed to clear chat stream state:', error.message);
      }

      try {
        const interruptedReviews = await branchReviewService.markInterruptedReviewsAsFailed();
        if (interruptedReviews > 0) {
          console.log(`Recovered ${interruptedReviews} interrupted branch review(s) to failed status.`);
        }
      } catch (error) {
        console.warn('Failed to reconcile interrupted branch reviews:', error.message);
      }

      try {
        const interruptedPrReviews = await prReviewService.markInterruptedReviewsAsFailed();
        if (interruptedPrReviews > 0) {
          console.log(`Recovered ${interruptedPrReviews} interrupted PR review(s) to failed status.`);
        }
      } catch (error) {
        console.warn('Failed to reconcile interrupted PR reviews:', error.message);
      }

      try {
        const projectsResult = await db.query(
          `SELECT path FROM projects WHERE path IS NOT NULL AND trim(path) <> ''`
        );
        let recoveredChangesetReviews = 0;
        for (const row of projectsResult.rows || []) {
          const projectPath = typeof row?.path === 'string' ? row.path.trim() : '';
          if (!projectPath) continue;
          try {
            recoveredChangesetReviews += await changesetService.markInterruptedReviewsAsFailed(projectPath);
          } catch (error) {
            console.warn(`Failed to reconcile interrupted changeset reviews for ${projectPath}:`, error.message);
          }
        }
        if (recoveredChangesetReviews > 0) {
          console.log(`Recovered ${recoveredChangesetReviews} interrupted changeset review(s) to failed status.`);
        }
      } catch (error) {
        console.warn('Failed to enumerate projects for interrupted changeset review recovery:', error.message);
      }

      try {
        const interruptedPublishes = await atlasHostingService.markInterruptedAttemptsAsFailed();
        if (interruptedPublishes > 0) {
          console.log(`Recovered ${interruptedPublishes} interrupted deployment attempt(s) to failed status.`);
        }
      } catch (error) {
        console.warn('Failed to reconcile interrupted deployment attempts:', error.message);
      }

      // Desktop mode: Skip Docker initialization
      const isDesktopMode = process.env.ATLAS_DESKTOP_MODE === 'true';

      if (!isDesktopMode) {
        try {
          // Initialize Docker network
          console.log('🐳 Initializing Docker network...');
          await dockerService.initializeNetwork();

          // Clean up stopped containers from previous runs
          console.log('🧹 Cleaning up stopped containers...');
          await dockerService.cleanupStoppedContainers();
        } catch (error) {
          if (shouldContinueWithoutDocker({
            nodeEnv: NODE_ENV,
            dockerRequired: process.env.ATLAS_DOCKER_REQUIRED,
            error,
          })) {
            console.warn('⚠️  Docker unavailable; continuing without Docker-backed preview support.');
          } else {
            throw error;
          }
        }
      } else {
        console.log('🖥️  Desktop mode: Skipping Docker initialization');
      }

      console.log('🔄 Starting GitHub sync worker...');
      syncWorker.start();
      if (isDesktopMode && typeof globalThis.__ATLAS_START_DESKTOP_REVIEW_SYNC_SETTINGS__ === 'function') {
        globalThis.__ATLAS_START_DESKTOP_REVIEW_SYNC_SETTINGS__();
      }
      if (isDesktopMode && globalThis.__ATLAS_DESKTOP_REVIEW_SYNC_SETTINGS_PROMISE) {
        console.log('[startup] Waiting for desktop review sync settings before starting review sync worker...');
        await globalThis.__ATLAS_DESKTOP_REVIEW_SYNC_SETTINGS_PROMISE;
      }
      reviewSyncService.startDesktopSyncWorker(io);
      console.log(`[startup] Deferred startup tasks completed in ${Date.now() - deferredStartedAt}ms`);
      completedDeferredStartup = true;
    } catch (error) {
      console.error('❌ Deferred startup tasks failed:', error);
    } finally {
      if (!completedDeferredStartup) {
        _deferredStartupPromise = null;
      }
    }
  })();

  return _deferredStartupPromise;
}

async function initialize() {
  if (_startupInitialized) {
    return;
  }

  console.log(`[startup] initialize() entered at ${Date.now() - SERVER_BOOT_STARTED_AT}ms`);
  console.log('🚀 Initializing AtlasEngine MVP...');

  try {
    // Log database type
    const dbType = db.getDbType ? db.getDbType() : 'postgres';
    console.log(`📊 Database: ${dbType}`);

    // Initialize database
    console.log('📊 Checking database connection...');
    const dbHealthy = await db.initialize();

    if (!dbHealthy) {
      console.error('❌ Database not initialized. Please run: ./backend/scripts/init-db.sh');
      process.exit(1);
    }

    try {
      const interruptedFixRuns = await reviewFixRunStore.markRunningRunsStopped();
      if (interruptedFixRuns > 0) {
        console.log(`Recovered ${interruptedFixRuns} interrupted review fix run(s) to stopped status.`);
      }
    } catch (error) {
      console.warn('Failed to reconcile interrupted review fix runs:', error.message);
    }

    _startupInitialized = true;
    void runDeferredStartupTasks();
    console.log(`[startup] initialize() completed in ${Date.now() - SERVER_BOOT_STARTED_AT}ms`);
    console.log('✅ Core initialization complete!');
  } catch (error) {
    console.error('❌ Initialization failed:', error);
    process.exit(1);
  }
}

export async function initializeRuntime() {
  await initialize();
}

export async function shutdownRuntime() {
  await syncWorker.stop();
  reviewSyncService.stopDesktopSyncWorker();
  gitWatcherService.stopAll();
  prReviewRefreshService.stopAll();
  await db.close();
}

export { app, io };
