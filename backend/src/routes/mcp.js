import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const router = express.Router();

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const ROUTES_DIR = path.dirname(CURRENT_FILE_PATH);
const PROJECT_ROOT = path.resolve(ROUTES_DIR, '../../..');
const MCP_SETUP_BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const MCP_SETUP_OUTPUT_LIMIT = 40_000;
const MCP_SETUP_CAPTURE_LIMIT = MCP_SETUP_OUTPUT_LIMIT * 2;
const MCP_SETUP_DEFAULT_BUILD_COOLDOWN_MS = 60_000;
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const IS_WINDOWS = process.platform === 'win32';
const SAFE_COMMAND_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'CI',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_PREFIX',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_userconfig',
  'npm_config_registry',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'OS',
];
const buildInFlightByRoot = new Map();
const buildCooldownByRoot = new Map();
const skippedExternalRootWarnings = new Set();

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function safeTrimOutput(value) {
  const text = String(value || '');
  if (text.length <= MCP_SETUP_OUTPUT_LIMIT) return text;
  return `...${text.slice(-MCP_SETUP_OUTPUT_LIMIT)}`;
}

function appendOutputChunk(target, chunk, limit = MCP_SETUP_CAPTURE_LIMIT) {
  const next = `${target.value}${chunk.toString()}`;
  if (next.length <= limit) {
    target.value = next;
    return;
  }
  target.value = next.slice(-limit);
}

function isDesktopMode() {
  return process.env.ATLAS_DESKTOP_MODE === 'true';
}

function isNonProdMode() {
  return (process.env.NODE_ENV || 'development') !== 'production';
}

function isAuthenticatedRequest(req) {
  const userId = req.user?.id;
  return typeof userId === 'string' && userId !== ANONYMOUS_USER_ID;
}

function normalizeBackendUrl(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error('backendUrl must be a valid http/https URL.');
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('backendUrl must be a valid http/https URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('backendUrl must be a valid http/https URL.');
  }
  return trimmed;
}

function deriveBackendUrlFromRequest(req) {
  const host = String(req?.get?.('host') || req?.headers?.host || '').trim();
  if (!host) return undefined;
  const forwardedProto = String(req?.get?.('x-forwarded-proto') || '').trim();
  const protocol = (forwardedProto || req?.protocol || 'http').replace(/:$/u, '');
  return normalizeBackendUrl(`${protocol}://${host}/api`);
}

function resolveBackendUrl(req, rawValue) {
  const explicit = normalizeBackendUrl(rawValue);
  if (explicit) return explicit;
  return deriveBackendUrlFromRequest(req);
}

function isPathInside(basePath, targetPath) {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (!relative) return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getRestartHint(agentId) {
  const hints = {
    'claude-code': 'Restart Claude Code session or run /mcp reconnect.',
    'claude-desktop': 'Fully quit and reopen Claude Desktop.',
    vscode: 'Reload VS Code window.',
    cursor: 'Reload Cursor window.',
    codex: 'Restart Codex session.',
    gemini: 'Restart Gemini CLI session.',
  };
  return hints[agentId] || 'Restart your agent client.';
}

function buildMcpServerPaths(rootPath) {
  return {
    rootPath,
    packagePath: path.join(rootPath, 'package.json'),
    binaryPath: path.join(rootPath, 'dist', 'bin', 'atlas-review-mcp.js'),
    setupModulePath: path.join(rootPath, 'dist', 'src', 'setup', 'publicApi.js'),
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getMcpRootCandidates() {
  const explicitRoot = String(process.env.ATLAS_MCP_SERVER_ROOT || '').trim();
  const candidates = [];
  if (explicitRoot) {
    const resolvedExplicitRoot = path.resolve(explicitRoot);
    const allowExternalRoot = toBoolean(process.env.ATLAS_MCP_ALLOW_EXTERNAL_SERVER_ROOT, false);
    const isScopedRoot = isPathInside(PROJECT_ROOT, resolvedExplicitRoot);
    if (allowExternalRoot || isScopedRoot) {
      candidates.push(resolvedExplicitRoot);
    } else if (!skippedExternalRootWarnings.has(resolvedExplicitRoot)) {
      skippedExternalRootWarnings.add(resolvedExplicitRoot);
      console.warn(
        '[mcp] Ignoring ATLAS_MCP_SERVER_ROOT outside project root. ' +
        'Set ATLAS_MCP_ALLOW_EXTERNAL_SERVER_ROOT=true to allow trusted external paths.',
        { requestedRoot: resolvedExplicitRoot }
      );
    }
  }
  candidates.push(path.join(PROJECT_ROOT, 'mcp-review-server'));
  candidates.push(path.resolve(process.cwd(), 'mcp-review-server'));
  return [...new Set(candidates)];
}

async function resolveMcpServerPaths() {
  const candidates = getMcpRootCandidates();
  for (const candidate of candidates) {
    const packagePath = path.join(candidate, 'package.json');
    if (await fileExists(packagePath)) {
      return buildMcpServerPaths(candidate);
    }
  }
  return buildMcpServerPaths(candidates[0]);
}

async function getBuildStatus(paths) {
  const [packageExists, binaryExists, setupModuleExists] = await Promise.all([
    fileExists(paths.packagePath),
    fileExists(paths.binaryPath),
    fileExists(paths.setupModulePath),
  ]);
  return {
    packageExists,
    binaryExists,
    setupModuleExists,
    buildReady: binaryExists && setupModuleExists,
  };
}

function runCommand(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : MCP_SETUP_BUILD_TIMEOUT_MS;
  const cwd = options.cwd || process.cwd();
  const env = buildSafeCommandEnv(options.env || process.env);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });
    let timedOut = false;

    const onData = (target) => (chunk) => appendOutputChunk(target, chunk);
    const stdoutRef = { value: '' };
    const stderrRef = { value: '' };

    child.stdout?.on('data', onData(stdoutRef));
    child.stderr?.on('data', onData(stderrRef));

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1500).unref();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        stdout: safeTrimOutput(stdoutRef.value),
        stderr: safeTrimOutput(`${stderrRef.value}${stderrRef.value ? '\n' : ''}${String(error.message || error)}`),
      });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeoutId);
      const stdout = safeTrimOutput(stdoutRef.value);
      const stderr = safeTrimOutput(stderrRef.value);
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function buildSafeCommandEnv(sourceEnv = process.env) {
  const next = {};
  for (const key of SAFE_COMMAND_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) {
      next[key] = String(sourceEnv[key]);
    }
  }
  return next;
}

async function ensureBuildReadyInternal(paths) {
  const before = await getBuildStatus(paths);
  if (before.buildReady) {
    return {
      ...before,
      attempted: false,
      command: null,
      commandResult: null,
      cooldownRemainingMs: null,
    };
  }
  if (!before.packageExists) {
    return {
      ...before,
      attempted: false,
      command: null,
      commandResult: null,
      cooldownRemainingMs: null,
      error: 'MCP server package not found.',
    };
  }

  const cooldownMs = toPositiveInteger(
    process.env.ATLAS_MCP_SETUP_BUILD_COOLDOWN_MS,
    MCP_SETUP_DEFAULT_BUILD_COOLDOWN_MS
  );
  const now = Date.now();
  const lastAttemptAt = Number(buildCooldownByRoot.get(paths.rootPath) || 0);
  if (cooldownMs > 0 && lastAttemptAt > 0 && (now - lastAttemptAt) < cooldownMs) {
    const retryAfterMs = Math.max(0, cooldownMs - (now - lastAttemptAt));
    return {
      ...before,
      attempted: false,
      command: null,
      commandResult: null,
      cooldownRemainingMs: retryAfterMs,
      error: `MCP server build cooldown active. Retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`,
    };
  }

  buildCooldownByRoot.set(paths.rootPath, now);
  const command = IS_WINDOWS ? 'npm.cmd' : 'npm';
  const args = ['run', 'build'];
  const commandResult = await runCommand(command, args, {
    cwd: paths.rootPath,
    timeoutMs: MCP_SETUP_BUILD_TIMEOUT_MS,
  });
  const after = await getBuildStatus(paths);
  return {
    ...after,
    attempted: true,
    command: `${command} ${args.join(' ')}`,
    commandResult,
    cooldownRemainingMs: null,
  };
}

async function ensureBuildReady(paths) {
  const key = String(paths?.rootPath || '');
  const existing = buildInFlightByRoot.get(key);
  if (existing) {
    return existing;
  }
  const inFlight = ensureBuildReadyInternal(paths)
    .finally(() => {
      if (buildInFlightByRoot.get(key) === inFlight) {
        buildInFlightByRoot.delete(key);
      }
    });
  buildInFlightByRoot.set(key, inFlight);
  return inFlight;
}

function isTrustedContext() {
  if (process.env.ATLAS_ENABLE_MCP_SETUP_API === 'true') return true;
  if (process.env.ATLAS_DESKTOP_MODE === 'true') return true;
  return false;
}

function normalizeIp(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const withoutScope = trimmed.includes('%') ? trimmed.split('%')[0] : trimmed;
  if (withoutScope.startsWith('::ffff:')) {
    return withoutScope.slice('::ffff:'.length);
  }
  return withoutScope;
}

function isLoopbackIp(value) {
  const normalized = normalizeIp(value);
  return normalized === '127.0.0.1' || normalized === '::1';
}

function getRequestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const trustProxy = typeof req.app?.get === 'function' ? req.app.get('trust proxy') : false;
  if (trustProxy) {
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return String(forwarded[0] || '').trim();
    }
  }
  return req.ip || req.socket?.remoteAddress || '';
}

function isLocalRequest(req) {
  if (isLoopbackIp(getRequestIp(req))) {
    return true;
  }
  return false;
}

function enforceSetupToken(req, res, expectedToken) {
  if (!expectedToken) return true;
  const providedToken = String(req.get('x-atlas-mcp-token') || '').trim();
  if (!providedToken || providedToken !== expectedToken) {
    res.status(403).json({
      success: false,
      error: 'Invalid MCP setup token.',
    });
    return false;
  }
  return true;
}

function ensureTrustedContext(req, res) {
  if (!isTrustedContext()) {
    res.status(403).json({
      success: false,
      error: 'MCP setup API is disabled. Set ATLAS_ENABLE_MCP_SETUP_API=true or run in desktop mode.',
    });
    return false;
  }

  const allowRemote = process.env.ATLAS_MCP_SETUP_ALLOW_REMOTE === 'true';
  const expectedToken = String(process.env.ATLAS_MCP_SETUP_TOKEN || '').trim();

  if (allowRemote) {
    if (!enforceSetupToken(req, res, expectedToken)) {
      return false;
    }
    if (!expectedToken && !isDesktopMode() && !isNonProdMode() && !isAuthenticatedRequest(req)) {
      res.status(401).json({
        success: false,
        error: 'Authentication or ATLAS_MCP_SETUP_TOKEN is required for remote MCP setup API access.',
      });
      return false;
    }
    return true;
  }

  if (isLocalRequest(req)) {
    if (!isDesktopMode() && !isNonProdMode() && !isAuthenticatedRequest(req)) {
      res.status(401).json({
        success: false,
        error: 'Authentication required for MCP setup API in production.',
      });
      return false;
    }

    if (!enforceSetupToken(req, res, expectedToken)) {
      return false;
    }
    return true;
  }

  res.status(403).json({
    success: false,
    error: 'MCP setup API is restricted to local requests. Set ATLAS_MCP_SETUP_ALLOW_REMOTE=true to override.',
  });
  return false;
}

async function loadSetupApiModule(setupModulePath) {
  const exists = await fileExists(setupModulePath);
  if (!exists) {
    throw new Error(`Setup module not found at ${setupModulePath}`);
  }

  const toModuleHref = (mtimeMs) =>
    `${pathToFileURL(setupModulePath).href}?mtimeMs=${Math.trunc(mtimeMs)}`;

  const initialStats = await fs.stat(setupModulePath);
  try {
    return await import(toModuleHref(initialStats.mtimeMs));
  } catch (error) {
    const updatedStats = await fs.stat(setupModulePath).catch(() => null);
    if (!updatedStats || Math.trunc(updatedStats.mtimeMs) === Math.trunc(initialStats.mtimeMs)) {
      throw error;
    }
    return import(toModuleHref(updatedStats.mtimeMs));
  }
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildFallbackSetupCliGuidance(backendUrl) {
  const normalizedBackendUrl = normalizeBackendUrl(backendUrl);
  const backendArg = normalizedBackendUrl
    ? ` --backend-url=${normalizedBackendUrl}`
    : '';
  return {
    list: 'node dist/bin/atlas-review-mcp.js setup --list',
    auto: `node dist/bin/atlas-review-mcp.js setup --auto${backendArg}`,
    autoDryRun: `node dist/bin/atlas-review-mcp.js setup --auto --dry-run${backendArg}`,
  };
}

function buildFallbackRuntimeStatus(paths, build, options = {}) {
  const details = options.details ? getErrorMessage(options.details) : undefined;
  const guidanceSource = options.guidanceSource || 'fallback';

  if (!build.packageExists) {
    return {
      serverNameDefault: 'atlas-review',
      serverBinaryPath: paths.binaryPath,
      recommendedCommands: buildFallbackSetupCliGuidance(options.backendUrl),
      guidanceSource,
      remediation: `Atlas could not find mcp-review-server at ${paths.rootPath}. Restore the project checkout or point ATLAS_MCP_SERVER_ROOT to a trusted MCP server root.`,
      details: details || `Expected package.json at ${paths.packagePath}.`,
    };
  }

  if (!build.binaryExists || !build.setupModuleExists) {
    return {
      serverNameDefault: 'atlas-review',
      serverBinaryPath: paths.binaryPath,
      recommendedCommands: buildFallbackSetupCliGuidance(options.backendUrl),
      guidanceSource,
      remediation: 'Build mcp-review-server first, then re-run setup guidance from Settings > MCP, the desktop setup wizard, or the setup CLI.',
      details: details || `Build ready = ${String(build.buildReady)} (binary: ${String(build.binaryExists)}, setup module: ${String(build.setupModuleExists)}).`,
    };
  }

  return {
    serverNameDefault: 'atlas-review',
    serverBinaryPath: paths.binaryPath,
    recommendedCommands: buildFallbackSetupCliGuidance(options.backendUrl),
    guidanceSource,
    remediation: 'Shared MCP setup guidance is temporarily unavailable. Rebuild mcp-review-server and retry. If the problem persists, use the setup CLI directly.',
    details,
  };
}

router.get('/status', async (req, res) => {
  if (!ensureTrustedContext(req, res)) return;

  let backendUrl;
  try {
    backendUrl = resolveBackendUrl(req, req.query.backendUrl);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const paths = await resolveMcpServerPaths();
  const build = await getBuildStatus(paths);
  let setupRuntime = null;
  let setupRuntimeError = null;
  if (build.setupModuleExists) {
    try {
      const setupApi = await loadSetupApiModule(paths.setupModulePath);
      if (typeof setupApi.getSetupRuntimeStatus === 'function') {
        setupRuntime = setupApi.getSetupRuntimeStatus({
          backendUrl,
          cwd: PROJECT_ROOT,
        });
      }
    } catch (error) {
      setupRuntimeError = error;
    }
  }
  const runtime = setupRuntime || buildFallbackRuntimeStatus(paths, build, {
    backendUrl,
    details: setupRuntimeError,
    guidanceSource: setupRuntime ? 'shared' : 'fallback',
  });

  res.json({
    success: true,
    trustedContext: isTrustedContext(),
    mcpServer: {
      ...build,
      ...runtime,
    },
  });
});

router.get('/agents', async (req, res) => {
  if (!ensureTrustedContext(req, res)) return;

  let backendUrl;
  try {
    backendUrl = resolveBackendUrl(req, req.query.backendUrl);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      remediation: 'Use a full http/https Atlas backend URL such as `http://127.0.0.1:3000/api`, or leave backendUrl unset to use the current Atlas backend.',
    });
  }

  const paths = await resolveMcpServerPaths();
  const build = await getBuildStatus(paths);
  let setupApi;
  try {
    setupApi = await loadSetupApiModule(paths.setupModulePath);
  } catch (error) {
    return res.status(503).json({
      success: false,
      error: 'MCP setup module is not available. Build mcp-review-server first.',
      details: getErrorMessage(error),
      remediation: 'Use Settings > MCP, the desktop setup wizard, or run `cd mcp-review-server && npm run build`.',
      mcpServer: buildFallbackRuntimeStatus(paths, build, {
        backendUrl,
        details: error,
      }),
    });
  }

  try {
    const [supported, detected] = await Promise.all([
      setupApi.listSupportedAgentMetadata({
        backendUrl,
        cwd: PROJECT_ROOT,
      }),
      setupApi.listAgentDetection({
        backendUrl,
        cwd: PROJECT_ROOT,
      }),
    ]);

    res.json({
      success: true,
      supportedAgents: supported,
      detectedAgents: detected,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      remediation: 'Refresh MCP status and retry. If agent detection still fails, rebuild mcp-review-server and use `setup --list` to inspect the current support state.',
    });
  }
});

router.get('/config', async (req, res) => {
  if (!ensureTrustedContext(req, res)) return;

  const agent = String(req.query.agent || '').trim();
  let backendUrl;
  try {
    backendUrl = resolveBackendUrl(req, req.query.backendUrl);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      remediation: 'Use a full http/https Atlas backend URL such as `http://127.0.0.1:3000/api`, or leave backendUrl unset to use the current Atlas backend.',
    });
  }

  if (!agent) {
    return res.status(400).json({
      success: false,
      error: 'Query parameter "agent" is required.',
    });
  }

  const paths = await resolveMcpServerPaths();
  const build = await getBuildStatus(paths);
  let setupApi;
  try {
    setupApi = await loadSetupApiModule(paths.setupModulePath);
  } catch (error) {
    return res.status(503).json({
      success: false,
      error: 'MCP setup module is not available. Build mcp-review-server first.',
      details: getErrorMessage(error),
      remediation: 'Use Settings > MCP, the desktop setup wizard, or run `cd mcp-review-server && npm run build`.',
      mcpServer: buildFallbackRuntimeStatus(paths, build, {
        backendUrl,
        details: error,
      }),
    });
  }

  if (!setupApi.isAgentSupported(agent)) {
    return res.status(400).json({
      success: false,
      error: `Unsupported agent "${agent}".`,
      remediation: 'Run `node dist/bin/atlas-review-mcp.js setup --list` to inspect shipped and manual-only agents, then request a generated snippet for one of those supported IDs.',
    });
  }

  try {
    const config = await setupApi.getAgentConfigSnippet(agent, {
      backendUrl,
      cwd: PROJECT_ROOT,
    });
    res.json({
      success: true,
      ...config,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      remediation: 'Refresh MCP status and retry snippet generation. If the MCP build is stale, rebuild mcp-review-server first.',
    });
  }
});

router.post('/setup/sync', async (req, res) => {
  if (!ensureTrustedContext(req, res)) return;

  let backendUrl;
  try {
    backendUrl = resolveBackendUrl(req, req.body?.backendUrl);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      remediation: 'Use a full http/https Atlas backend URL such as `http://127.0.0.1:3000/api`, or leave backendUrl unset to use the current Atlas backend.',
    });
  }

  const selectedAgentIds = Array.isArray(req.body?.selectedAgentIds)
    ? req.body.selectedAgentIds
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
    : [];
  const removeUnselected = toBoolean(req.body?.removeUnselected, false);
  const dryRun = toBoolean(req.body?.dryRun, false);
  const buildIfNeeded = toBoolean(req.body?.buildIfNeeded, true);

  const paths = await resolveMcpServerPaths();
  let build = await getBuildStatus(paths);
  let buildAttempt = {
    attempted: false,
    command: null,
    commandResult: null,
    cooldownRemainingMs: null,
    error: null,
  };

  if (!build.buildReady && buildIfNeeded) {
    const ensured = await ensureBuildReady(paths);
    build = {
      packageExists: ensured.packageExists,
      binaryExists: ensured.binaryExists,
      setupModuleExists: ensured.setupModuleExists,
      buildReady: ensured.buildReady,
    };
    buildAttempt = {
      attempted: !!ensured.attempted,
      command: ensured.command || null,
      commandResult: ensured.commandResult || null,
      cooldownRemainingMs: Number.isFinite(ensured.cooldownRemainingMs) ? ensured.cooldownRemainingMs : null,
      error: ensured.error || null,
    };
  }

  if (!build.buildReady) {
    return res.status(503).json({
      success: false,
      error: 'MCP server build is not ready.',
      build,
      buildAttempt,
      remediation: 'Build mcp-review-server first, then retry MCP sync from Settings > MCP, the desktop setup wizard, or the setup CLI.',
    });
  }

  let setupApi;
  try {
    setupApi = await loadSetupApiModule(paths.setupModulePath);
  } catch (error) {
    return res.status(503).json({
      success: false,
      error: 'MCP setup module is not available. Build mcp-review-server first.',
      details: getErrorMessage(error),
      remediation: 'Use Settings > MCP, the desktop setup wizard, or run `cd mcp-review-server && npm run build`.',
    });
  }

  if (typeof setupApi.syncAgentSetup !== 'function') {
    return res.status(500).json({
      success: false,
      error: 'MCP setup module does not support syncAgentSetup(). Please rebuild mcp-review-server.',
    });
  }

  try {
    const syncResult = await setupApi.syncAgentSetup({
      backendUrl,
      selectedAgentIds,
      removeUnselected,
      dryRun,
      cwd: PROJECT_ROOT,
    });
    const appliedAgentIds = Array.isArray(syncResult?.appliedResults)
      ? syncResult.appliedResults.map((entry) => entry.agentId)
      : [];
    const removedAgentIds = Array.isArray(syncResult?.removedResults)
      ? syncResult.removedResults.filter((entry) => entry.changed).map((entry) => entry.agentId)
      : [];
    const failures = Array.isArray(syncResult?.failures) ? syncResult.failures : [];
    const restartHintAgentIds = [...new Set([...appliedAgentIds, ...removedAgentIds])];

    return res.status(failures.length > 0 ? 207 : 200).json({
      success: failures.length === 0,
      mode: 'sync',
      backendUrl: syncResult?.backendUrl || backendUrl || null,
      serverName: syncResult?.serverName || null,
      selectedAgentIds: Array.isArray(syncResult?.selectedAgentIds) ? syncResult.selectedAgentIds : selectedAgentIds,
      supportedAgentIds: Array.isArray(syncResult?.supportedAgentIds) ? syncResult.supportedAgentIds : [],
      removeUnselected,
      dryRun,
      build,
      buildAttempt,
      appliedResults: Array.isArray(syncResult?.appliedResults) ? syncResult.appliedResults : [],
      removedResults: Array.isArray(syncResult?.removedResults) ? syncResult.removedResults : [],
      failures,
      restartHints: restartHintAgentIds.map((agentId) => ({
        agentId,
        hint: getRestartHint(agentId),
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      build,
      buildAttempt,
      remediation: 'Retry MCP sync. If the problem persists, use the setup CLI directly and review the generated agent config snippets.',
    });
  }
});

router.post('/setup/workflow-guidance', async (req, res) => {
  if (!ensureTrustedContext(req, res)) return;

  const agentId = String(req.body?.agentId || '').trim();
  const dryRun = toBoolean(req.body?.dryRun, false);
  const buildIfNeeded = toBoolean(req.body?.buildIfNeeded, true);

  if (!agentId) {
    return res.status(400).json({
      success: false,
      error: 'Request body field "agentId" is required.',
    });
  }

  const paths = await resolveMcpServerPaths();
  let build = await getBuildStatus(paths);
  let buildAttempt = {
    attempted: false,
    command: null,
    commandResult: null,
    cooldownRemainingMs: null,
    error: null,
  };

  if (!build.buildReady && buildIfNeeded) {
    const ensured = await ensureBuildReady(paths);
    build = {
      packageExists: ensured.packageExists,
      binaryExists: ensured.binaryExists,
      setupModuleExists: ensured.setupModuleExists,
      buildReady: ensured.buildReady,
    };
    buildAttempt = {
      attempted: !!ensured.attempted,
      command: ensured.command || null,
      commandResult: ensured.commandResult || null,
      cooldownRemainingMs: Number.isFinite(ensured.cooldownRemainingMs) ? ensured.cooldownRemainingMs : null,
      error: ensured.error || null,
    };
  }

  if (!build.buildReady) {
    return res.status(503).json({
      success: false,
      error: 'MCP server build is not ready.',
      build,
      buildAttempt,
      remediation: 'Build mcp-review-server first, then retry workflow guidance install from Settings > MCP or the setup CLI.',
    });
  }

  let setupApi;
  try {
    setupApi = await loadSetupApiModule(paths.setupModulePath);
  } catch (error) {
    return res.status(503).json({
      success: false,
      error: 'MCP setup module is not available. Build mcp-review-server first.',
      details: getErrorMessage(error),
      remediation: 'Use Settings > MCP, the desktop setup wizard, or run `cd mcp-review-server && npm run build`.',
    });
  }

  if (typeof setupApi.installWorkflowGuidance !== 'function') {
    return res.status(500).json({
      success: false,
      error: 'MCP setup module does not support installWorkflowGuidance(). Please rebuild mcp-review-server.',
    });
  }

  try {
    const result = await setupApi.installWorkflowGuidance(agentId, {
      dryRun,
      cwd: PROJECT_ROOT,
    });
    return res.json({
      success: true,
      mode: 'workflow_guidance_install',
      dryRun,
      build,
      buildAttempt,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      build,
      buildAttempt,
      remediation: 'Retry workflow guidance install. If the canonical path is already occupied by another file, resolve that conflict manually and retry.',
    });
  }
});

router.post('/setup/remove-integrations', async (req, res) => {
  if (!ensureTrustedContext(req, res)) return;

  const dryRun = toBoolean(req.body?.dryRun, false);
  const buildIfNeeded = toBoolean(req.body?.buildIfNeeded, true);

  const paths = await resolveMcpServerPaths();
  let build = await getBuildStatus(paths);
  let buildAttempt = {
    attempted: false,
    command: null,
    commandResult: null,
    cooldownRemainingMs: null,
    error: null,
  };

  if (!build.buildReady && buildIfNeeded) {
    const ensured = await ensureBuildReady(paths);
    build = {
      packageExists: ensured.packageExists,
      binaryExists: ensured.binaryExists,
      setupModuleExists: ensured.setupModuleExists,
      buildReady: ensured.buildReady,
    };
    buildAttempt = {
      attempted: !!ensured.attempted,
      command: ensured.command || null,
      commandResult: ensured.commandResult || null,
      cooldownRemainingMs: Number.isFinite(ensured.cooldownRemainingMs) ? ensured.cooldownRemainingMs : null,
      error: ensured.error || null,
    };
  }

  if (!build.buildReady) {
    return res.status(503).json({
      success: false,
      error: 'MCP server build is not ready.',
      build,
      buildAttempt,
      remediation: 'Build mcp-review-server first, then retry removing Atlas integrations from Settings > General.',
    });
  }

  let setupApi;
  try {
    setupApi = await loadSetupApiModule(paths.setupModulePath);
  } catch (error) {
    return res.status(503).json({
      success: false,
      error: 'MCP setup module is not available. Build mcp-review-server first.',
      details: getErrorMessage(error),
      remediation: 'Use Settings > General, or run `cd mcp-review-server && npm run build`.',
    });
  }

  if (typeof setupApi.removeManagedIntegrations !== 'function') {
    return res.status(500).json({
      success: false,
      error: 'MCP setup module does not support removeManagedIntegrations(). Please rebuild mcp-review-server.',
    });
  }

  try {
    const result = await setupApi.removeManagedIntegrations({
      dryRun,
      cwd: PROJECT_ROOT,
    });
    const restartHintAgentIds = new Set([
      ...(Array.isArray(result?.removedResults) ? result.removedResults.filter((entry) => entry.changed).map((entry) => entry.agentId) : []),
      ...(Array.isArray(result?.workflowGuidanceResults) ? result.workflowGuidanceResults.filter((entry) => entry.changed).map((entry) => entry.agentId) : []),
    ]);

    return res.status(result?.failures?.length > 0 ? 207 : 200).json({
      success: !result?.failures?.length,
      mode: 'remove_integrations',
      dryRun,
      build,
      buildAttempt,
      targetAgentIds: Array.isArray(result?.targetAgentIds) ? result.targetAgentIds : [],
      removedResults: Array.isArray(result?.removedResults) ? result.removedResults : [],
      workflowGuidanceResults: Array.isArray(result?.workflowGuidanceResults) ? result.workflowGuidanceResults : [],
      failures: Array.isArray(result?.failures) ? result.failures : [],
      restartHints: Array.from(restartHintAgentIds).map((agentId) => ({
        agentId,
        hint: getRestartHint(agentId),
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      build,
      buildAttempt,
      remediation: 'Retry removing Atlas integrations. If a config file is malformed, fix it manually and retry.',
    });
  }
});

export default router;

export const __testing = {
  normalizeBackendUrl,
  deriveBackendUrlFromRequest,
  resolveBackendUrl,
};
