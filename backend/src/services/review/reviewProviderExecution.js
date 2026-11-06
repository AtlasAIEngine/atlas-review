/** Review Provider Execution — Provider calls, retry logic, and failover chain. */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PROVIDER_REQUEST_TIMEOUT_API_MS,
  PROVIDER_REQUEST_TIMEOUT_CLAUDE_CLI_MS,
  PROVIDER_REQUEST_TIMEOUT_CODEX_CLI_MS,
  PROVIDER_REQUEST_TIMEOUT_GEMINI_CLI_MS,
  PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS,
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS,
  CLI_AGENTIC_MAX_TURNS,
  CLI_AGENTIC_MIN_TURNS,
  CLI_AGENTIC_TIMEOUT_PER_TURN_MS,
  CLI_AGENTIC_TIMEOUT_BASE_MS,
  CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT,
  CLI_AGENTIC_TIER_LARGE_FILE_COUNT,
  CLI_AGENTIC_MAX_TURNS_MEDIUM,
  CLI_AGENTIC_MAX_TURNS_LARGE,
  CLI_AGENTIC_TIMEOUT_PER_TURN_MS_MEDIUM,
  CLI_AGENTIC_TIMEOUT_PER_TURN_MS_LARGE,
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_MEDIUM,
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_LARGE,
  CLI_AGENTIC_PARALLEL_MIN_FILES_PER_SHARD,
  CLI_AGENTIC_PARALLEL_TARGET_FILES_PER_SHARD,
  CLI_AGENTIC_PARALLEL_MAX_SHARDS,
  CLI_AGENTIC_LIVENESS_THRESHOLD_MS,
  CLI_AGENTIC_LIVENESS_CHECK_INTERVAL_MS,
  CLI_AGENTIC_ABSOLUTE_CEILING_MS,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  REVIEW_TOTAL_DEADLINE_MS,
  REVIEW_DEADLINE_START_BUFFER_MS,
  ReviewDeadlineError,
  DEFAULT_CODEX_REASONING_EFFORT,
  VALID_CODEX_REASONING_EFFORTS,
  DEFAULT_REVIEW_MODEL_CONFIG,
  REVIEW_EXECUTION_MODE_ORDER_SETTING_KEY,
  REVIEW_EXECUTION_MODE_ORDER_CACHE_TTL_MS,
  VALID_EXECUTION_MODES,
} from './reviewConstants.js';

import {
  normalizeProviderIdentity,
} from './reviewHelpers.js';

import {
  createOperationAbort,
  getAbortReasonError,
  throwIfDeadlineExceeded,
  resolveTimeoutForRemainingBudget,
  sleep,
} from './reviewDeadline.js';

import {
  createReviewRuntimeError,
  isLikelyNetworkError,
  isLikelyContextWindowError,
  isLikelyTransientProviderError,
  isLikelyModelUnavailableError,
  isLikelyAuthError,
  classifyProviderError,
  classifyReviewRuntimeError,
  computeRetryDelayMs,
} from './reviewErrorClassification.js';

import {
  describeProviderCandidate,
  recordProviderAttempt,
} from './reviewTiming.js';

import {
  toNonNegativeInteger,
} from './reviewPromptBuilder.js';

import {
  resolveEffectiveReviewModel,
} from './reviewModelConfig.js';
import { createSettingsReadError } from './reviewErrors.js';
import { isReviewTestProviderEnabled } from '../../utils/reviewTestProvider.js';
import providerService from '../providerService.js';
import cliInstallService from '../cliInstallService.js';
import { buildClaudeCliEnv, hasStoredClaudeOAuthTokenRecord, clearStoredClaudeOAuthToken } from '../claudeTokenService.js';
import { getChangeSetFilePath, updateChangeSetReviewIndex } from '../changesetService.js';

import {
  resolve as pathResolve,
  sep as pathSep,
  dirname as pathDirname,
  basename as pathBasename,
  extname as pathExtname,
} from 'path';
import { realpathSync } from 'fs';
import { homedir } from 'os';
import branchReviewService from '../branchReviewService.js';
import { findClaudeBinary } from '../../utils/claudeBinary.js';
import { resolveWindowsCliExecutablePath } from '../../utils/windowsCliPaths.js';
import { getAdapterForProvider } from '../cliAdapters/index.js';
import { readJsonFileWithRetry, writeJsonFileAtomic } from '../../utils/jsonFile.js';
import { readFile } from 'fs/promises';
import { join as pathJoin } from 'path';
import { spawnSync } from 'child_process';
import { resolveOpenCodeDirectApiParams } from '../openCodeConfigResolver.js';
import {
  classifyToolOperation,
  extractToolPathFromToolInput,
  isFileMutationTool,
} from '../../../../shared/toolOperationClassifier.js';

// ---------------------------------------------------------------------------
// Out-of-scope read tolerance — the agent may harmlessly read from e.g. the
// Tauri app bundle.  Only kill after repeated out-of-scope reads.
// ---------------------------------------------------------------------------
const OOS_READ_LIMIT = 3;

// ---------------------------------------------------------------------------
// JSON output reinforcement for CLI agentic reviews
// ---------------------------------------------------------------------------
// In long multi-turn sessions the model can lose track of the original JSON
// output requirement and return conversational prose instead.  This system
// prompt is appended via --append-system-prompt to keep the constraint active.
const CLI_REVIEW_JSON_SYSTEM_PROMPT =
  'You MUST respond with ONLY a single JSON object conforming to the review schema. '
  + 'No markdown fences, no conversational text, no explanations outside the JSON. '
  + 'Once you have reviewed the changed files, output the JSON review object immediately — do not keep exploring. '
  + 'ALWAYS prioritize producing the JSON review output over exploring additional files.';

function shouldRetryGoogleCliWithFallback(error, attemptedModel, fallbackModel) {
  if (!attemptedModel || !fallbackModel || attemptedModel === fallbackModel) {
    return false;
  }
  const runtimeClass = classifyReviewRuntimeError(error)?.runtimeClass;
  const message = String(error?.message || '').toLowerCase();
  const attemptedModelLower = String(attemptedModel).toLowerCase();
  const hasKnownUnavailablePhrase =
    message.includes('404')
    || message.includes('model not found')
    || message.includes('model is not supported')
    || message.includes('unknown model')
    || (message.includes('provider request was rejected') && message.includes(attemptedModelLower));
  return (
    (runtimeClass === 'invalid_request' || isLikelyModelUnavailableError(error))
    && hasKnownUnavailablePhrase
  );
}

function shouldRetryOpenAICliWithFallback(error, attemptedModel, fallbackModel) {
  if (!attemptedModel || !fallbackModel || attemptedModel === fallbackModel) {
    return false;
  }
  const runtimeClass = classifyReviewRuntimeError(error)?.runtimeClass;
  const message = String(error?.message || '').toLowerCase();
  const attemptedModelLower = String(attemptedModel).toLowerCase();
  const hasKnownUnavailablePhrase =
    message.includes('model not found')
    || message.includes('invalid model')
    || message.includes('unsupported model')
    || message.includes('model is not supported')
    || message.includes('selected model is not enabled')
    || message.includes('model is not enabled')
    || message.includes('not enabled for this account')
    || message.includes('no last agent message')
    || message.includes('wrote empty content')
    || (message.includes('provider request was rejected') && message.includes(attemptedModelLower));
  return (
    (runtimeClass === 'invalid_request' || isLikelyModelUnavailableError(error))
    && hasKnownUnavailablePhrase
  );
}

function resolveOpenAICliFallbackModel(attemptedModel = null) {
  const attempted = String(attemptedModel || '').trim().toLowerCase();
  const preferredOrder = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex'];
  const attemptedIndex = preferredOrder.findIndex((candidate) => candidate.toLowerCase() === attempted);
  if (attemptedIndex >= 0) {
    const codexDefault = 'gpt-5.3-codex';
    if (attempted !== codexDefault) return codexDefault;
    return 'gpt-5.4-mini';
  }
  return 'gpt-5.3-codex';
}

function resolveProviderTimeoutForExecutionAttempt(providerData, mode = null, requestContext = null, deadline = null) {
  return resolveTimeoutForRemainingBudget(
    resolveProviderRequestTimeoutMs(providerData, mode, requestContext),
    deadline,
  );
}

function buildReviewTestStubResponse(prompt, providerData, requestContext = null) {
  const reviewType = typeof requestContext?.reviewType === 'string'
    ? requestContext.reviewType.trim()
    : 'review';
  const promptText = String(prompt || '');
  const summary = promptText.includes('Incremental review note:')
    ? 'Stub incremental review completed.'
    : 'Stub full review completed.';

  return {
    text: JSON.stringify({
      summary,
      riskLevel: 'low',
      recommendations: [],
      stats: {
        reviewType,
        stubbed: true,
        providerType: providerData?.provider?.type || 'unknown',
      },
    }),
    tokensUsed: {
      input: Math.max(1, Math.ceil(promptText.length / 200)),
      output: 32,
    },
  };
}

function getReviewTestStubDelayMs() {
  const raw = Number.parseInt(String(process.env.ATLAS_REVIEW_TEST_PROVIDER_DELAY_MS || '').trim(), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(0, raw);
}

// ---------------------------------------------------------------------------
// Env sanitization for child CLI processes
// ---------------------------------------------------------------------------

/** Env vars that must never leak into child CLI subprocesses.
 *  - Dynamic linker injection (LD_PRELOAD, DYLD_*): code injection via shared libs
 *  - Runtime flags (NODE_OPTIONS, PYTHONPATH, etc.): arbitrary module loading
 *  - Shell startup (BASH_ENV, ENV, CDPATH): command injection via shell init
 *  - Claude session vars: prevent "nested session" errors in dev */
const DANGEROUS_ENV_VARS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'PERL5OPT',
  'BASH_ENV', 'ENV', 'CDPATH',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
]);

/** Build a clean env object for spawning CLI subprocesses.
 *  Filters out dangerous vars (injection vectors, nested-session markers)
 *  and strips empty API key vars that would shadow the CLI's own
 *  credential discovery (keychain, OAuth). */
function buildCliSpawnEnv(extra = {}) {
  const env = { NO_COLOR: '1' };
  for (const [key, value] of Object.entries(process.env)) {
    if (!DANGEROUS_ENV_VARS.has(key)) {
      env[key] = value;
    }
  }
  Object.assign(env, extra);
  // Remove empty API key env vars that would shadow the CLI's auth discovery.
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']) {
    if (key in env && !env[key]) {
      delete env[key];
    }
  }
  return env;
}

function quoteWindowsShellArg(value) {
  const text = String(value ?? '');
  if (!text) {
    return '""';
  }
  if (!/[\s"&|<>^()%!]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function resolveCliSpawnInvocation(binaryPath, args = []) {
  const command = String(binaryPath || '').trim();
  const normalizedArgs = Array.isArray(args)
    ? args.filter((value) => value != null).map((value) => String(value))
    : [];

  if (process.platform !== 'win32') {
    return { command, args: normalizedArgs, shell: false };
  }

  const ext = pathExtname(command).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    // Node cannot spawn batch shims directly on Windows. Wrap the exact
    // command line in the system shell so npm-installed CLI shims work.
    return {
      command: [command, ...normalizedArgs].map(quoteWindowsShellArg).join(' '),
      args: [],
      shell: true,
    };
  }

  if (ext === '.ps1') {
    const powershellPath = pathJoin(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    return {
      command: powershellPath,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        command,
        ...normalizedArgs,
      ],
      shell: false,
    };
  }

  return { command, args: normalizedArgs, shell: false };
}

function resolveCliSpawnCwd(requestContext = null) {
  const projectPath = typeof requestContext?.projectPath === 'string'
    ? requestContext.projectPath.trim()
    : '';
  if (!projectPath) return process.cwd();
  return pathResolve(projectPath);
}

async function resolveTccSafeCliSpawnInvocation(binaryPath, args = [], requestContext = null) {
  const projectPath = typeof requestContext?.projectPath === 'string'
    ? requestContext.projectPath.trim()
    : '';
  if (process.platform !== 'darwin' || !projectPath) {
    return { ...resolveCliSpawnInvocation(binaryPath, args), sandboxProfilePath: null };
  }

  const spawnInvocation = resolveCliSpawnInvocation(binaryPath, args);
  const sandboxProfilePath = await generateSandboxProfile(projectPath, spawnInvocation.command);
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-f', sandboxProfilePath, spawnInvocation.command, ...spawnInvocation.args],
    shell: false,
    sandboxProfilePath,
  };
}

async function cleanupTccSandboxProfile(sandboxProfilePath) {
  if (!sandboxProfilePath) return;
  try {
    const fsP = await import('fs/promises');
    await fsP.default.rm(pathDirname(sandboxProfilePath), { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup.
  }
}

async function buildProviderCliSpawnEnv(providerType, extra = {}) {
  const baseEnv = buildCliSpawnEnv(extra);
  if (providerType === 'anthropic') {
    return buildClaudeCliEnv(baseEnv);
  }
  if (providerType === 'google') {
    // Gemini CLI refuses to run in untrusted workspaces by default (exit 55,
    // or — once a trust prompt fires in headless mode — silent empty stdout).
    // Atlas only invokes Gemini in projects the user has explicitly selected,
    // so trust the workspace to enable headless review execution. Caller-set
    // value still wins via `extra` since `buildCliSpawnEnv` applies extras after process.env.
    if (!('GEMINI_CLI_TRUST_WORKSPACE' in baseEnv)) {
      baseEnv.GEMINI_CLI_TRUST_WORKSPACE = 'true';
    }
    return baseEnv;
  }
  return baseEnv;
}

function buildIsolatedHomeEnv(homePath) {
  const home = pathResolve(String(homePath || '').trim() || '.');
  return {
    HOME: home,
    XDG_CONFIG_HOME: pathResolve(home, '.config'),
    XDG_CACHE_HOME: pathResolve(home, '.cache'),
    XDG_DATA_HOME: pathResolve(home, '.local', 'share'),
    XDG_STATE_HOME: pathResolve(home, '.local', 'state'),
    ZDOTDIR: home,
  };
}

// ---------------------------------------------------------------------------
// Provider request timeout resolution
// ---------------------------------------------------------------------------

function resolveProviderRequestTimeoutMs(providerData, mode = null, requestContext = null) {
  if (mode === 'cli-agentic') {
    return computeAgenticTimeoutMs(requestContext?.maxTurns, requestContext?.agenticTier);
  }
  if (!providerData) return PROVIDER_REQUEST_TIMEOUT_API_MS;
  if (providerData.useCodexCLI) return PROVIDER_REQUEST_TIMEOUT_CODEX_CLI_MS;
  if (providerData.useClaudeCLI) return PROVIDER_REQUEST_TIMEOUT_CLAUDE_CLI_MS;
  if (providerData.useGeminiCLI) return PROVIDER_REQUEST_TIMEOUT_GEMINI_CLI_MS;
  if (providerData.useOpenCodeCLI) return PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS;
  return PROVIDER_REQUEST_TIMEOUT_API_MS;
}

// ---------------------------------------------------------------------------
// Execution mode order cache (DB-backed with 30s TTL)
// ---------------------------------------------------------------------------

let _executionModeOrderCache = null;
let _executionModeOrderCacheExpiry = 0;

async function getExecutionModeOrder() {
  if (_executionModeOrderCache !== null && Date.now() < _executionModeOrderCacheExpiry) {
    return _executionModeOrderCache;
  }
  try {
    const db = (await import('../../db/connection.js')).default;
    const result = await db.query(
      'SELECT value FROM settings WHERE id = $1',
      [REVIEW_EXECUTION_MODE_ORDER_SETTING_KEY]
    );
    if (result.rows.length > 0 && result.rows[0].value) {
      let parsed = null;
      try {
        parsed = JSON.parse(result.rows[0].value);
      } catch (error) {
        throw createSettingsReadError({
          settingKey: REVIEW_EXECUTION_MODE_ORDER_SETTING_KEY,
          settingLabel: 'review execution mode order',
          operation: 'parse review execution mode order',
          cause: error,
        });
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        const validSet = new Set(VALID_EXECUTION_MODES);
        const filtered = parsed.filter((m) => validSet.has(m));
        if (filtered.length > 0) {
          _executionModeOrderCache = filtered;
          _executionModeOrderCacheExpiry = Date.now() + REVIEW_EXECUTION_MODE_ORDER_CACHE_TTL_MS;
          return _executionModeOrderCache;
        }
      }
    }
  } catch (error) {
    if (error?.runtimeCode === 'settings_read_failed') {
      throw error;
    }
    throw createSettingsReadError({
      settingKey: REVIEW_EXECUTION_MODE_ORDER_SETTING_KEY,
      settingLabel: 'review execution mode order',
      operation: 'read review execution mode order',
      cause: error,
    });
  }
  _executionModeOrderCache = [];
  _executionModeOrderCacheExpiry = Date.now() + REVIEW_EXECUTION_MODE_ORDER_CACHE_TTL_MS;
  return _executionModeOrderCache;
}

function invalidateExecutionModeOrderCache() {
  _executionModeOrderCache = null;
  _executionModeOrderCacheExpiry = 0;
}

// ---------------------------------------------------------------------------
// Execution mode resolution
// ---------------------------------------------------------------------------

/** @deprecated Env-var gates retained as stubs for backward compatibility. Always returns true. */
function isCliAgentExecutionEnabled() {
  return true;
}

/** @deprecated Env-var gates retained as stubs for backward compatibility. Always returns true. */
function isCliAgenticExecutionEnabled() {
  return true;
}

/**
 * Resolve the ordered list of execution modes for a provider.
 * @param {Object|null} providerData - Provider configuration
 * @param {string[]|null} userModeOrder - User-configured mode order (from settings). Empty/null = computed default.
 * @returns {string[]} Ordered execution modes filtered to what's available
 */
function resolveProviderExecutionModes(providerData = null, userModeOrder = null) {
  const providerType = providerData?.provider?.type || null;
  const supportsCli = providerType === 'anthropic' || providerType === 'openai' || providerType === 'google' || providerType === 'opencode';
  const forcedCli = Boolean(providerData?.useClaudeCLI || providerData?.useCodexCLI || providerData?.useGeminiCLI || providerData?.useOpenCodeCLI);
  const hasApi = Boolean(providerData?.apiKey) && !forcedCli;
  const hasCliRuntime = supportsCli
    && (forcedCli || providerData?.provider?.source === 'cli_detected');
  const adapter = getAdapterForProvider(providerData);
  const adapterModes = typeof adapter?.getExecutionModes === 'function'
    ? adapter.getExecutionModes({
      providerData,
      hasCliRuntime,
      hasApi,
      forcedCli,
    })
    : [];

  // Build the set of available modes for this provider
  const available = new Set();
  if (hasApi) available.add('api');
  if (Array.isArray(adapterModes) && adapterModes.length > 0) {
    for (const mode of adapterModes) {
      if (VALID_EXECUTION_MODES.includes(mode)) {
        available.add(mode);
      }
    }
  } else if (hasCliRuntime) {
    // Legacy fallback for adapters without mode declarations.
    available.add('cli-agent');
    available.add('cli-pipe');
  }
  // For forced-CLI providers WITHOUT an explicit adapter mode list, ensure cli-pipe is available.
  // If the adapter declares its own modes, respect that list (e.g. OpenCode omits cli-pipe).
  if (forcedCli && !(Array.isArray(adapterModes) && adapterModes.length > 0)) {
    available.add('cli-pipe');
  }

  const isOpenCodeAdapter = providerType === 'opencode';

  // If user provided a non-empty order, use it (filtered to available modes),
  // then append any available modes not in the user list.
  // OpenCode owns its own default ordering so CLI review stays primary.
  if (Array.isArray(userModeOrder) && userModeOrder.length > 0 && !isOpenCodeAdapter) {
    const ordered = [];
    const seen = new Set();
    for (const mode of userModeOrder) {
      if (available.has(mode) && !seen.has(mode)) {
        ordered.push(mode);
        seen.add(mode);
      }
    }
    // Append available modes the user didn't list
    for (const mode of available) {
      if (!seen.has(mode)) {
        ordered.push(mode);
        seen.add(mode);
      }
    }
    if (ordered.length > 0) return ordered;
  }

  // Preserve OpenCode's adapter-declared order. This keeps `opencode run`
  // review primary and only falls back to Atlas's direct provider API path
  // after CLI review paths have been attempted.
  if (isOpenCodeAdapter && Array.isArray(adapterModes) && adapterModes.length > 0) {
    const ordered = [];
    const seen = new Set();
    for (const mode of adapterModes) {
      if (available.has(mode) && !seen.has(mode)) {
        ordered.push(mode);
        seen.add(mode);
      }
    }
    for (const mode of available) {
      if (!seen.has(mode)) {
        ordered.push(mode);
        seen.add(mode);
      }
    }
    if (ordered.length > 0) return ordered;
  }

  // Default order: cli-agentic, api, cli-agent, cli-pipe (all available, no env-var gating)
  const standardOrder = ['cli-agentic', 'api', 'cli-agent', 'cli-pipe'];
  const ordered = standardOrder.filter((m) => available.has(m));

  if (ordered.length === 0 && forcedCli) {
    ordered.push('cli-pipe');
  }
  if (ordered.length === 0 && hasApi) {
    ordered.push('api');
  }

  return ordered;
}

function filterExecutionModesForRequest(executionModes = [], requestContext = null) {
  if (!Array.isArray(executionModes)) return [];
  // Default to restrictive: strip cli-agentic unless explicitly allowed.
  // Without this, a missing/null requestContext would grant agentic mode.
  if (!requestContext || typeof requestContext !== 'object') {
    return executionModes.filter((mode) => mode !== 'cli-agentic');
  }
  const isWalkthrough = requestContext.reviewSurface === 'walkthrough';
  const allowAgentic = requestContext.reviewExecutionMode === 'cli-agentic';
  return executionModes.filter((mode) => {
    if (mode === 'cli-agentic') return allowAgentic && !isWalkthrough;
    // Phase 11: walkthrough has its own prompt schema (`changeGroups`).
    // `cli-agent` mode wraps prompts in `buildCliAgentReviewRequest`, which
    // hardcodes review-specific `requiredTopLevelKeys` (summary/riskLevel/
    // recommendations/...) and confuses providers into emitting review-shaped
    // JSON instead of walkthrough JSON. Force walkthrough to fall through
    // to `api` or `cli-pipe`, both of which pass the prompt verbatim.
    if (mode === 'cli-agent' && isWalkthrough) return false;
    return true;
  });
}

function shouldFallbackToNextExecutionMode(error) {
  if (error?.isDeadline) return false;
  // Non-transient errors (auth, context_limit, invalid_request, scope) should
  // not trigger fallback — they will fail identically on the next mode.
  const { retryable } = classifyReviewRuntimeError(error);
  return retryable !== false;
}

function resolveProviderExecutionMode(providerData, requestContext = null) {
  if (!providerData) return 'unknown';
  const providerType = providerData?.provider?.type || 'unknown';
  const modes = filterExecutionModesForRequest(
    resolveProviderExecutionModes(providerData),
    requestContext
  );
  const primaryMode = modes[0] || null;
  if (!primaryMode) return `${providerType}_unknown`;
  if (primaryMode === 'api') return `${providerType}_api`;
  if (primaryMode === 'cli-agentic') return `${providerType}_cli_agentic`;
  if (primaryMode === 'cli-agent') return `${providerType}_cli_agent`;
  if (primaryMode === 'cli-pipe') return `${providerType}_cli`;
  return `${providerType}_${primaryMode.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// API provider calls
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic API for a review
 * @param {string} prompt - The review prompt
 * @param {string} apiKey - Anthropic API key
 * @param {string} model - Model to use
 * @returns {Promise<Object>} Parsed review result + token usage
 */
async function callAnthropic(
  prompt,
  apiKey,
  model,
  authType,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_API_MS,
  deadlineSignal = null
) {
  // Build auth headers: OAuth uses Bearer token, direct API keys use x-api-key
  const authHeaders = authType === 'oauth'
    ? { 'Authorization': `Bearer ${apiKey}` }
    : { 'x-api-key': apiKey };

  const opAbort = createOperationAbort(timeoutMs, deadlineSignal);
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: opAbort.signal,
    });
  } catch (error) {
    if (deadlineSignal?.aborted) {
      throw getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS));
    }
    if (opAbort.signal.aborted) {
      throw createReviewRuntimeError(
        `Anthropic request timed out after ${Math.round(timeoutMs / 1000)} seconds`,
        'timeout'
      );
    }
    if (isLikelyNetworkError(error)) {
      throw createReviewRuntimeError(error?.message || 'Anthropic network error', 'network', { cause: error });
    }
    throw createReviewRuntimeError(error?.message || 'Anthropic request failed', 'unknown', { cause: error });
  } finally {
    opAbort.clear();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const msg = body.error?.message || `HTTP ${response.status}`;
    if (response.status === 401) {
      throw createReviewRuntimeError('Invalid API key', 'auth');
    }
    if (response.status === 429) {
      throw createReviewRuntimeError('Rate limited — try again in a moment', 'rate_limit');
    }
    if (response.status === 529) {
      throw createReviewRuntimeError('API overloaded — try again shortly', 'rate_limit');
    }
    if (isLikelyContextWindowError({ message: msg })) {
      throw createReviewRuntimeError(`Anthropic API error: ${msg}`, 'context_limit');
    }
    if (response.status >= 500) {
      throw createReviewRuntimeError(`Anthropic API error: ${msg}`, 'transient');
    }
    throw createReviewRuntimeError(`Anthropic API error: ${msg}`, 'invalid_request');
  }

  const body = await response.json();
  const text = body.content?.[0]?.text || '';
  const usage = body.usage || {};

  return {
    text,
    tokensUsed: {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
    },
  };
}

/**
 * Call the OpenAI API for a review
 * @param {string} prompt - The review prompt
 * @param {string} apiKey - OpenAI API key
 * @param {string} model - Model to use
 * @returns {Promise<Object>} Parsed review result + token usage
 */
async function callOpenAI(
  prompt,
  apiKey,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_API_MS,
  deadlineSignal = null
) {
  const opAbort = createOperationAbort(timeoutMs, deadlineSignal);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...(model.startsWith('gpt-6') ? { max_completion_tokens: 16384 } : { max_tokens: 16384 }),
        messages: [
          { role: 'system', content: 'You are a code review assistant. Return only valid JSON, no markdown fences.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: opAbort.signal,
    });
  } catch (error) {
    if (deadlineSignal?.aborted) {
      throw getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS));
    }
    if (opAbort.signal.aborted) {
      throw createReviewRuntimeError(
        `OpenAI request timed out after ${Math.round(timeoutMs / 1000)} seconds`,
        'timeout'
      );
    }
    if (isLikelyNetworkError(error)) {
      throw createReviewRuntimeError(error?.message || 'OpenAI network error', 'network', { cause: error });
    }
    throw createReviewRuntimeError(error?.message || 'OpenAI request failed', 'unknown', { cause: error });
  } finally {
    opAbort.clear();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const msg = body.error?.message || `HTTP ${response.status}`;
    if (response.status === 401) {
      throw createReviewRuntimeError('Invalid API key', 'auth');
    }
    if (response.status === 429) {
      throw createReviewRuntimeError('Rate limited — try again in a moment', 'rate_limit');
    }
    if (isLikelyContextWindowError({ message: msg })) {
      throw createReviewRuntimeError(`OpenAI API error: ${msg}`, 'context_limit');
    }
    if (response.status >= 500) {
      throw createReviewRuntimeError(`OpenAI API error: ${msg}`, 'transient');
    }
    throw createReviewRuntimeError(`OpenAI API error: ${msg}`, 'invalid_request');
  }

  const body = await response.json();
  const text = body.choices?.[0]?.message?.content || '';
  const usage = body.usage || {};

  return {
    text,
    tokensUsed: {
      input: usage.prompt_tokens || 0,
      output: usage.completion_tokens || 0,
    },
  };
}

/**
 * Call the NVIDIA NIM API (OpenAI-compatible) for a review.
 * @param {string} prompt - The review prompt
 * @param {string} apiKey - NVIDIA API key
 * @param {string} model - Model to use (e.g. 'meta/llama-3.1-8b-instruct')
 * @returns {Promise<Object>} Parsed review result + token usage
 */
async function callNvidiaAPI(
  prompt,
  apiKey,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_API_MS,
  deadlineSignal = null
) {
  const opAbort = createOperationAbort(timeoutMs, deadlineSignal);
  let response;
  try {
    response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        messages: [
          { role: 'system', content: 'You are a code review assistant. Return only valid JSON, no markdown fences.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: opAbort.signal,
    });
  } catch (error) {
    if (deadlineSignal?.aborted) {
      throw getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS));
    }
    if (opAbort.signal.aborted) {
      throw createReviewRuntimeError(
        `NVIDIA NIM request timed out after ${Math.round(timeoutMs / 1000)} seconds`,
        'timeout'
      );
    }
    if (isLikelyNetworkError(error)) {
      throw createReviewRuntimeError(error?.message || 'NVIDIA NIM network error', 'network', { cause: error });
    }
    throw createReviewRuntimeError(error?.message || 'NVIDIA NIM request failed', 'unknown', { cause: error });
  } finally {
    opAbort.clear();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const msg = body.error?.message || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw createReviewRuntimeError(`NVIDIA NIM auth error: ${msg}`, 'auth');
    }
    if (response.status === 429) {
      throw createReviewRuntimeError(`NVIDIA NIM rate limited: ${msg}`, 'rate_limit');
    }
    if (isLikelyContextWindowError({ message: msg })) {
      throw createReviewRuntimeError(`NVIDIA NIM error: ${msg}`, 'context_limit');
    }
    if (response.status >= 500) {
      throw createReviewRuntimeError(`NVIDIA NIM server error: ${msg}`, 'transient');
    }
    throw createReviewRuntimeError(`NVIDIA NIM error: ${msg}`, 'invalid_request');
  }

  const body = await response.json();
  const text = body.choices?.[0]?.message?.content || '';
  const usage = body.usage || {};

  return {
    text,
    tokensUsed: {
      input: usage.prompt_tokens || 0,
      output: usage.completion_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI pipe provider calls
// ---------------------------------------------------------------------------

/**
 * Call Claude CLI (claude -p) for a review using the user's subscription.
 * Used when the user has a Claude Max/Pro subscription but no direct API key.
 * @param {string} prompt - The review prompt
 * @param {string} model - Model to use (e.g. 'claude-sonnet-4-6')
 * @returns {Promise<Object>} Parsed review result + token usage
 */
async function callClaudeCLI(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_CLAUDE_CLI_MS,
  deadlineSignal = null,
  requestContext = null
) {
  const { spawn } = await import('child_process');

  const { binary, args: baseArgs } = await findClaudeBinary();

  const cliArgs = buildClaudeCliPipeArgs(baseArgs, model);

  let stdout;
  let sandboxProfilePath = null;
  try {
    throwIfDeadlineExceeded(deadlineSignal);
    const spawnEnv = await buildProviderCliSpawnEnv('anthropic');
    stdout = await new Promise(async (resolve, reject) => {
      let spawnInvocation;
      try {
        spawnInvocation = await resolveTccSafeCliSpawnInvocation(binary, cliArgs, requestContext);
        sandboxProfilePath = spawnInvocation.sandboxProfilePath;
      } catch (error) {
        reject(createReviewRuntimeError(`Failed to prepare Claude CLI sandbox: ${error.message}`, 'invalid_request', { cause: error }));
        return;
      }
      const child = spawn(spawnInvocation.command, spawnInvocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        cwd: resolveCliSpawnCwd(requestContext),
        windowsHide: true,
        shell: spawnInvocation.shell,
      });
      let settled = false;
      let timer = null;

      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (deadlineSignal && onDeadlineAbort) {
          try {
            deadlineSignal.removeEventListener('abort', onDeadlineAbort);
          } catch {
            // noop
          }
        }
        fn(value);
      };

      let onDeadlineAbort = null;
      if (deadlineSignal) {
        onDeadlineAbort = () => {
          try { child.kill('SIGTERM'); } catch {}
          finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
        };
        if (deadlineSignal.aborted) {
          onDeadlineAbort();
          return;
        }
        deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
      }

      // Write prompt to stdin and close it
      child.stdin.on('error', () => {}); // Prevent unhandled stream error if child exits early
      child.stdin.write(prompt);
      child.stdin.end();

      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        finish(
          reject,
          createReviewRuntimeError(
            `Claude CLI timed out after ${Math.round(timeoutMs / 1000)} seconds`,
            'timeout'
          )
        );
      }, timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();

      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          // Try to parse structured JSON error from CLI output
          let errorMsg = err.trim() || out.trim();
          try {
            const errJson = JSON.parse(out.trim() || err.trim());
            if (errJson.result) errorMsg = errJson.result;
          } catch {
            // Not JSON, use raw output
          }
          const combined = `${errorMsg} ${err}`.toLowerCase();
          if (combined.includes('auth') || combined.includes('login') || combined.includes('unauthorized')) {
            finish(
              reject,
              createReviewRuntimeError(
                'Claude CLI authentication failed. Please run `claude login` to re-authenticate.',
                'auth'
              )
            );
          } else if (combined.includes('too long') || combined.includes('too large')) {
            finish(
              reject,
              createReviewRuntimeError(
                'Diff is too large for a single review. Try reviewing individual files or smaller changesets.',
                'context_limit'
              )
            );
          } else {
            finish(reject, createReviewRuntimeError(`Claude CLI error: ${errorMsg}`, 'invalid_request'));
          }
        } else {
          finish(resolve, out);
        }
      });

      child.on('error', (e) => {
        finish(reject, createReviewRuntimeError(`Claude CLI error: ${e.message}`, 'unknown', { cause: e }));
      });
    });
  } catch (error) {
    throw error;
  } finally {
    await cleanupTccSandboxProfile(sandboxProfilePath);
  }

  // Parse the JSON output from claude -p --output-format json
  // Format: { result: "...", session_id: "...", model: "...", ... }
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // If JSON parsing fails, the raw stdout is the text response
    // (happens if --output-format json isn't supported in older versions)
    const extracted = stdout.trim();
    const runtimeTextError = classifyCliRuntimeTextError('anthropic', extracted);
    if (runtimeTextError) throw runtimeTextError;
    return {
      text: extracted,
      tokensUsed: { input: 0, output: 0 },
    };
  }

  const text = parsed.result || parsed.content || stdout.trim();
  const runtimeTextError = classifyCliRuntimeTextError('anthropic', text);
  if (runtimeTextError) throw runtimeTextError;
  const meta = extractClaudeCliPipeResultMeta(parsed);

  return {
    text,
    tokensUsed: meta.tokensUsed,
    ...(meta.costUsd != null ? { costUsd: meta.costUsd } : {}),
  };
}

function resolveClaudeCliModelArg(model = null) {
  return providerService.resolveAnthropicCliModelArg(model);
}

function buildClaudeCliPipeArgs(baseArgs = [], model = null) {
  // cli-pipe must stay single-turn and non-agentic; explicit empty tools
  // prevents modern Claude Code print mode from escalating into tool_use.
  const cliArgs = [
    ...baseArgs,
    '-p', '-',
    '--output-format', 'json',
    '--max-turns', '1',
    '--tools', '',
  ];

  const cliModel = resolveClaudeCliModelArg(model);
  if (cliModel) {
    cliArgs.push('--model', cliModel);
  }

  return cliArgs;
}

async function findCodexCliBinary() {
  const adapter = getAdapterForProvider('openai');
  if (typeof adapter?.findBinary === 'function') {
    try {
      return await adapter.findBinary();
    } catch {
      // Fall back to PATH lookup below for compatibility with older adapters.
    }
  }

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout: whichOut } = await execFileAsync(cmd, ['codex'], { timeout: 5000 });
    const candidate = whichOut.trim().split(/\r?\n/)[0]?.trim();
    if (candidate) {
      return cliInstallService.resolveWindowsCodexExecutablePath(candidate);
    }
  } catch {
    // Report a stable review runtime error below.
  }

  throw createReviewRuntimeError('Codex CLI not found in PATH', 'invalid_request');
}

async function findGeminiCliBinary() {
  const adapter = getAdapterForProvider('google');
  if (typeof adapter?.findBinary === 'function') {
    try {
      return await adapter.findBinary();
    } catch {
      // Fall back to PATH lookup below for compatibility with older adapters.
    }
  }

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout: whichOut } = await execFileAsync(cmd, ['gemini'], { timeout: 5000 });
    const candidate = whichOut.trim().split(/\r?\n/)[0]?.trim();
    if (candidate) {
      return resolveWindowsCliExecutablePath(candidate);
    }
  } catch {
    // Report a stable review runtime error below.
  }

  throw createReviewRuntimeError('Gemini CLI not found in PATH', 'invalid_request');
}

/**
 * Call Codex CLI (codex exec) for a review using the user's ChatGPT subscription.
 * Used when the user has a ChatGPT Pro/Plus subscription but no direct OpenAI API key.
 * @param {string} prompt - The review prompt
 * @param {string} model - Model to use (e.g. 'gpt-4o')
 * @returns {Promise<Object>} Parsed review result + token usage
 */
async function callCodexCLI(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_CODEX_CLI_MS,
  deadlineSignal = null,
  requestContext = null
) {
  const resolveCodexReasoningEffort = () => {
    const normalized = String(process.env.ATLAS_CODEX_REASONING_EFFORT || '').trim().toLowerCase();
    if (!normalized) return DEFAULT_CODEX_REASONING_EFFORT;
    if (VALID_CODEX_REASONING_EFFORTS.has(normalized)) return normalized;
    if (normalized === 'minimal' || normalized === 'xlow') return 'low';
    if (normalized === 'xmedium') return 'medium';
    if (normalized === 'xhigh' || normalized === 'max' || normalized === 'maximum') return 'high';
    return DEFAULT_CODEX_REASONING_EFFORT;
  };

  const { spawn } = await import('child_process');
  const fsP = await import('fs/promises');
  const os = await import('os');
  const pathM = await import('path');

  const codexPath = await findCodexCliBinary();
  if (!codexPath) {
    throw createReviewRuntimeError('Codex CLI not found', 'invalid_request');
  }

  // Use a unique temp directory per invocation to avoid collisions during parallel chunk runs.
  const tmpDir = await fsP.default.mkdtemp(pathM.default.join(os.default.tmpdir(), 'codex-review-'));
  const tmpFile = pathM.default.join(tmpDir, 'output.txt');
  const reasoningEffort = resolveCodexReasoningEffort();

  const cliArgs = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-o', tmpFile,
    '-c', `model_reasoning_effort="${reasoningEffort}"`,
    '-',
  ];
  if (cliInstallService.isWindowsSandboxEnvironment()) {
    cliArgs.push('--dangerously-bypass-approvals-and-sandbox');
  }
  // Only pass --model for Codex-compatible families. Legacy chat models like
  // gpt-4o can be rejected by Codex CLI with ChatGPT subscription accounts.
  // GPT-5 variants are now valid here even when they do not use a "-codex" suffix.
  const isCodexModel = model && (
    model.includes('codex')
    || model.startsWith('gpt-5')
    || model.startsWith('gpt-6')
    || model.startsWith('o3')
    || model.startsWith('o4')
  );
  if (isCodexModel) cliArgs.push('--model', model);

  throwIfDeadlineExceeded(deadlineSignal);
  let sandboxProfilePath = null;
  let stdout;
  try {
    stdout = await new Promise(async (resolve, reject) => {
      let spawnInvocation;
      try {
        spawnInvocation = await resolveTccSafeCliSpawnInvocation(codexPath, cliArgs, requestContext);
        sandboxProfilePath = spawnInvocation.sandboxProfilePath;
      } catch (error) {
        reject(createReviewRuntimeError(`Failed to prepare Codex CLI sandbox: ${error.message}`, 'invalid_request', { cause: error }));
        return;
      }
    const child = spawn(spawnInvocation.command, spawnInvocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCliSpawnEnv(),
      cwd: resolveCliSpawnCwd(requestContext),
      windowsHide: true,
      shell: spawnInvocation.shell,
    });
    let settled = false;
    let timer = null;

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (deadlineSignal && onDeadlineAbort) {
        try {
          deadlineSignal.removeEventListener('abort', onDeadlineAbort);
        } catch {
          // noop
        }
      }
      fn(value);
    };

    let onDeadlineAbort = null;
    if (deadlineSignal) {
      onDeadlineAbort = () => {
        try { child.kill('SIGTERM'); } catch {}
        finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
      };
      if (deadlineSignal.aborted) {
        onDeadlineAbort();
        return;
      }
      deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
    }

    // Write prompt to stdin and close it
    child.stdin.on('error', () => {}); // Prevent unhandled stream error if child exits early
    child.stdin.write(prompt);
    child.stdin.end();

    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(
        reject,
        createReviewRuntimeError(
          `Codex CLI timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          'timeout'
        )
      );
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        // Only check the LAST part of stderr for error messages (after the echoed prompt).
        // Codex CLI echoes the full prompt in stderr header, so checking the full
        // combined output causes false positives when the diff contains "auth"/"login".
        const errTail = err.slice(-500).toLowerCase();
        const outLower = out.toLowerCase();
        console.error(`[callCodexCLI] exit ${code} | stderr tail: ${err.slice(-200).trim()}`);
        // Check for auth errors only in the tail of stderr (actual error output)
        // and use specific patterns to avoid false positives from echoed prompt content
        const isAuthError = errTail.includes('not authenticated') ||
          errTail.includes('authentication failed') ||
          errTail.includes('please log in') ||
          errTail.includes('please login') ||
          errTail.includes('unauthorized') ||
          errTail.includes('invalid token') ||
          errTail.includes('token expired') ||
          (errTail.includes('error') && errTail.includes('auth'));
        if (isAuthError) {
          finish(
            reject,
            createReviewRuntimeError(
              'Codex CLI authentication failed. Please run `codex login` to re-authenticate.',
              'auth'
            )
          );
        } else if (errTail.includes('reasoning.effort') && errTail.includes('unsupported_value')) {
          finish(
            reject,
            createReviewRuntimeError(
              'Codex CLI rejected reasoning effort from local config. Use low/medium/high (or set ATLAS_CODEX_REASONING_EFFORT).',
              'invalid_request'
            )
          );
        } else if (errTail.includes('too long') || errTail.includes('too large') || errTail.includes('context window') || errTail.includes('ran out of room') || outLower.includes('too long') || outLower.includes('too large')) {
          finish(
            reject,
            createReviewRuntimeError(
              'Diff is too large for Codex CLI context window. Try reviewing smaller changesets or exclude lock files.',
              'context_limit'
            )
          );
        } else {
          finish(
            reject,
            createReviewRuntimeError(
              `Codex CLI error (exit ${code}): ${err.slice(-300).trim() || out.trim()}`,
              'invalid_request'
            )
          );
        }
      } else {
        finish(resolve, out);
      }
    });

    child.on('error', (e) => {
      finish(reject, createReviewRuntimeError(`Codex CLI error: ${e.message}`, 'unknown', { cause: e }));
    });
    });
  } finally {
    await cleanupTccSandboxProfile(sandboxProfilePath);
  }

  // Read response from output file (more reliable than stdout which has metadata)
  let outputFileText = '';
  try {
    outputFileText = await fsP.default.readFile(tmpFile, 'utf8');
  } catch {
    // Fall back to stdout if file wasn't written
    outputFileText = '';
  } finally {
    await fsP.default.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  const adapter = getAdapterForProvider('openai');
  const text = typeof adapter?.extractReviewText === 'function'
    ? adapter.extractReviewText(stdout, outputFileText)
    : String(outputFileText || stdout || '').trim();
  const runtimeTextError = classifyCliRuntimeTextError('openai', text);
  if (runtimeTextError) throw runtimeTextError;
  const codexMeta = extractAgenticResultMeta(stdout) || {};

  return {
    text,
    tokensUsed: codexMeta.tokensUsed || { input: 0, output: 0 },
  };
}

// ---------------------------------------------------------------------------
// CLI agent envelope and execution
// ---------------------------------------------------------------------------

function normalizeScopePatternListForEnvelope(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);
  }
  return [];
}

function buildCliAgentReviewRequest({
  prompt,
  model,
  providerData = null,
  timeoutMs = null,
  requestContext = {},
} = {}) {
  const context = requestContext && typeof requestContext === 'object' ? requestContext : {};
  const revision = {
    projectId: typeof context.projectId === 'string' && context.projectId.trim() ? context.projectId.trim() : null,
    reviewType: typeof context.reviewType === 'string' && context.reviewType.trim() ? context.reviewType.trim() : null,
    reviewId: typeof context.reviewId === 'string' && context.reviewId.trim() ? context.reviewId.trim() : null,
    branchName: typeof context.branchName === 'string' && context.branchName.trim() ? context.branchName.trim() : null,
    baseBranch: typeof context.baseBranch === 'string' && context.baseBranch.trim() ? context.baseBranch.trim() : null,
    headSha: typeof context.headSha === 'string' && context.headSha.trim() ? context.headSha.trim() : null,
    mergeBaseSha: typeof context.mergeBaseSha === 'string' && context.mergeBaseSha.trim() ? context.mergeBaseSha.trim() : null,
  };

  return {
    schemaVersion: 'atlas.cli-agent-review-request.v1',
    provider: {
      id: providerData?.provider?.id || null,
      type: providerData?.provider?.type || null,
      model: typeof model === 'string' && model.trim() ? model.trim() : null,
    },
    revision,
    scope: {
      includePatterns: normalizeScopePatternListForEnvelope(context.includePatterns),
      excludePatterns: normalizeScopePatternListForEnvelope(context.excludePatterns),
      applyGlobalIgnorePatterns: context.applyGlobalIgnorePatterns !== false,
    },
    limits: {
      timeoutMs: toNonNegativeInteger(
        timeoutMs,
        resolveProviderRequestTimeoutMs(providerData)
      ),
      fileCount: toNonNegativeInteger(context.fileCount, 0),
      diffChars: toNonNegativeInteger(context.diffChars, String(prompt || '').length),
    },
    output: {
      mode: 'atlas_review_result',
      format: 'json',
      requiredTopLevelKeys: ['summary', 'riskLevel', 'recommendations', 'candidateFindings', 'stats'],
    },
    prompt: String(prompt || ''),
  };
}

function buildCliAgentEnvelopePrompt(envelope) {
  return [
    'You are Atlas CLI review agent.',
    'Return exactly one JSON object that follows output.requiredTopLevelKeys.',
    'Do not emit markdown fences.',
    'ATLAS_CLI_AGENT_REVIEW_REQUEST_START',
    JSON.stringify(envelope),
    'ATLAS_CLI_AGENT_REVIEW_REQUEST_END',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI-agentic mode: directive prompt, tool summarization, and execution
// ---------------------------------------------------------------------------

/**
 * Build a directive prompt for cli-agentic reviews.
 * Contains ZERO diff content — instructs Claude to explore the repo itself.
 *
 * @param {Object} opts
 * @param {string} opts.branchName - Feature branch name
 * @param {string} opts.baseBranch - Base branch (e.g. 'main')
 * @param {string} opts.mergeBaseSha - Merge-base commit SHA
 * @param {string} opts.headSha - HEAD commit SHA of the feature branch
 * @param {Array<{path: string, status?: string, oldPath?: string, riskScore?: number}>} opts.fileHints - Files sorted by risk
 * @param {string[]} opts.ignorePatterns - Patterns to skip (lock files, etc.)
 * @param {Object} opts.outputSchema - ReviewResult JSON schema to embed
 * @param {number} [opts.fileCount] - Number of changed files in review scope
 * @param {number} [opts.maxTurns] - Approximate turn budget for agentic runtime
 * @param {number} [opts.minimumDeepReviewedFiles] - Minimum target for deeply reviewed files
 * @param {number} [opts.minimumCoverageRate] - Minimum coverage rate target (0..1)
 * @param {boolean} [opts.preferFileListOnly] - Prefer file-list scope over SHA-diff-first scope
 * @param {string} [opts.reviewModelStrategy] - Active review model strategy
 * @returns {string} The directive prompt
 */
function buildAgenticLinterSection(linterFindings) {
  if (!Array.isArray(linterFindings) || linterFindings.length === 0) return '';
  const lines = linterFindings.slice(0, 20).map((f) => {
    const source = String(f.source || 'linter');
    const severity = String(f.severity || 'low');
    const file = String(f.file || 'unknown');
    const line = Number.isFinite(f.line) && f.line > 0 ? `:${f.line}` : '';
    const ruleId = String(f.ruleId || '');
    const message = String(f.message || '').replace(/\s+/g, ' ').trim();
    const evidenceSummary = String(f.promptEvidenceSummary || f.evidenceSummary || '').replace(/\s+/g, ' ').trim();
    const localLabel = evidenceSummary ? ` | local: ${evidenceSummary}` : '';
    return `  - ${source} [${severity}] ${file}${line} ${ruleId}: ${message}${localLabel}`;
  });
  return `
## Deterministic Linter Findings

The following issues were already identified by local analysis tools. Do not duplicate them.
Use them as context and focus on logic, behavioral regressions, architecture, and semantic risk.

${lines.join('\n')}

`;
}

/**
 * M1b — render the intended-exploration-mode bullet for the Performance
 * prompt. Pure: returns a string (possibly empty when mode is unknown).
 *
 * Soft enforcement only. The bullet nudges the agent toward the resolver's
 * decision; it does NOT withhold tools or error on escalation. The drift
 * telemetry from M1a/M1.D is what surfaces when the agent ignores the nudge.
 *
 * Note: only invoked from buildCliAgenticReviewPrompt when
 * performancePromptMode === true; never reaches the Balanced prompt.
 *
 * @param {string|null} mode
 * @param {string[]} reasonCodes
 * @returns {string} a single bullet line (or '' when mode is unrecognized)
 */
function buildIntendedModePromptBullet(mode, reasonCodes) {
  const reasonsArr = Array.isArray(reasonCodes) ? reasonCodes.filter(Boolean) : [];
  const reasonsText = reasonsArr.length > 0 ? ` (signals: ${reasonsArr.join(', ')})` : '';
  switch (mode) {
    case 'none':
      return '- Diff scope assessment: the precomputed diff is sufficient for this review. Emit a verdict from the diff alone unless you find a specific ambiguity that requires inspection.';
    case 'diff_only':
      return '- Diff scope assessment: this change is contained. Use the precomputed diff plus narrow Read slices (offset/limit) around specific lines. Do not request entire files.';
    case 'targeted_context':
      return `- Diff scope assessment: this change has signals worth investigating${reasonsText}. Use targeted Reads and narrow Greps for those specific concerns. Do not sweep the repo or read full files.`;
    case 'broad_agentic':
      return '- Diff scope assessment: this change has high-risk signals. Use the tools you need to verify safety, but stay focused on the changed surface and its direct callers.';
    default:
      return '';
  }
}

/**
 * Section R Phase A — render the per-file-diff retrieval pattern Performance
 * mode should prefer over full-file reads. Wraps the existing Bash + Read
 * primitives ("get_diff_for_file" and "read_file_slice" in the plan) into
 * concrete invocations the agent can copy verbatim.
 *
 * When the merge-base or head SHA is missing (very early in a review, or in
 * synthetic test fixtures), fall back to a placeholder form that still
 * teaches the pattern but signals the agent must substitute the real SHAs.
 *
 * @param {string} mergeBaseSha
 * @param {string} headSha
 * @returns {string}
 */
function buildRetrievalFirstPromptBullet(mergeBaseSha, headSha, runtimeMcpEnabled) {
  if (runtimeMcpEnabled) {
    // Phase B: server-curated MCP tools are wired. Reference them by their
    // canonical CLI-namespaced names so the agent matches against its
    // tool list. Tools are scoped to this review's range/SHAs already, so
    // there are no SHAs to interpolate.
    return [
      '- Retrieval first — prefer these server-curated tools over Read/Bash for diff and file slicing:',
      '  • `mcp__atlas-review-rt__get_diff_for_file(path)` — unified diff for that file across this review\'s range. Use this instead of running `git diff` via Bash.',
      '  • `mcp__atlas-review-rt__read_file_slice(path, startLine, endLine)` — 1-indexed inclusive line range of the head version (cap 500 lines). Use this instead of full-file Read.',
      '  • `mcp__atlas-review-rt__get_hunk_context(path, line, contextLines?)` — N lines on each side of a specific head line (default 20, cap 100). Use this to verify a finding or inspect surrounding code.',
      '  Reach for full-file Read only when the diff is unclear without surrounding context.',
    ].join('\n');
  }
  // Phase A.0 fallback: no MCP tools, so guide the agent to existing Bash
  // and Read primitives with concrete invocations (range interpolated).
  const baseHas = typeof mergeBaseSha === 'string' && mergeBaseSha.trim().length > 0;
  const headHas = typeof headSha === 'string' && headSha.trim().length > 0;
  const range = baseHas && headHas
    ? `${mergeBaseSha}..${headSha}`
    : '<merge-base>..<head>';
  return `- Retrieval first: for a single file's diff, run \`git diff ${range} -- <path>\` via Bash. For a specific range inside a file, use Read with offset/limit instead of pulling the whole file. Avoid full-file reads unless the diff is unclear without surrounding context.`;
}

/**
 * M1b — assemble the Performance soft-enforcement bullet block:
 *   - the intended-mode bullet (may be empty)
 *   - the retrieval-first bullet (Section R Phase A; always present in Performance)
 *   - the anti-shell_heavy bullet (always present in Performance)
 *   - the compact-output bullet (always present in Performance)
 *
 * Each bullet is separated by '\n' and the whole block carries a leading
 * '\n' so it appends cleanly to the previous bullet without producing a
 * blank line. When `intendedModeBullet` is empty (unrecognized mode), the
 * remaining bullets still ship.
 *
 * The retrieval and anti-shell bullets are deliberately ordered so that
 * the recommended `git diff` invocation appears before the "no Bash for
 * enumeration" rule — the rule then references "the targeted invocation
 * above" rather than contradicting it.
 *
 * @param {string} intendedModeBullet
 * @param {string} mergeBaseSha
 * @param {string} headSha
 * @returns {string}
 */
function buildPerformanceSoftEnforcementBullets(intendedModeBullet, mergeBaseSha, headSha, runtimeMcpEnabled, codegraphMcpEnabled) {
  const parts = [];
  if (intendedModeBullet) parts.push(intendedModeBullet);
  parts.push(buildRetrievalFirstPromptBullet(mergeBaseSha, headSha, runtimeMcpEnabled));
  if (codegraphMcpEnabled === true) {
    // CodeGraph experiment: forceful adoption nudge. Pattern adapted
    // from the Tier-0b prompt that achieved reliable adoption on the
    // prior benchmark. CodeGraph is an exploration accelerator — invariant
    // I3: the agent must still read the actual changed hunks, so this
    // does not displace the retrieval-first bullet above.
    parts.push(
      '- CodeGraph is available for this review. PREFER `mcp__codegraph__*` tools over Grep/Glob/Bash for navigation:',
      '  • `mcp__codegraph__codegraph_search(query)` — find symbols by name. Use this BEFORE Grep when you know the symbol you are looking for.',
      '  • `mcp__codegraph__codegraph_callers(symbol)` / `codegraph_callees(symbol)` — trace call relationships. Use these BEFORE grepping for call sites.',
      '  • `mcp__codegraph__codegraph_context(task)` — build context for a specific task in one call. Prefer this over multi-step exploration.',
      '  • `mcp__codegraph__codegraph_impact(symbol)` — find what is affected by changing a symbol. Use this to size the blast radius of a change.',
      '  Reach for Grep/Glob only when the graph returns no useful results. Continue to use Read for the actual changed hunks — CodeGraph is for navigation, not for reading code under review.',
    );
  }
  // Anti-shell wording adapts to whether MCP retrieval tools are available.
  // Without MCP (Phase A.0 path), Bash is still the diff retrieval primitive,
  // so the rule has to permit the targeted git-diff invocation. With MCP,
  // Bash has no diff role at all and the rule can be cleaner.
  if (runtimeMcpEnabled) {
    parts.push(
      '- Do NOT use Bash to enumerate the repository, run grep over many files, or run git for diffs. Use Grep/Glob for content searches and the retrieval tools above for diffs and file slices.',
    );
  } else {
    parts.push(
      '- Do NOT use Bash to enumerate the repository or run grep over many files. Use Grep/Glob for searches. Bash is reserved for the targeted invocation above and similar evidence-gathering, not exploration.',
    );
  }
  // Section R Phase B-3 (softened in B-6): verification rule. Original
  // wording ("downgrade to candidate or drop") combined with B-5's
  // anti-fragmentation pushed the agent to drop plausible findings on
  // U1 (3/3 missed the headline cooldown bug across the strict-rule
  // runs). The softened version keeps the "verify before asserting"
  // principle but is explicit that incomplete evidence on a plausible
  // failure mode should land as a candidate, not be silently dropped.
  parts.push(
    '- Verify before asserting: before surfacing an issue, check the relevant diff or bounded file context. If the evidence is incomplete but the failure mode is plausible and grounded in changed code, keep it as a candidate finding with the exact evidence you have; do not silently drop plausible correctness concerns solely because you did not fully prove them.',
  );
  // Section R Phase B-6: verification effort cap (subsumes B-5
  // anti-fragmentation). U1 Phase B #2 read GruntModule.cs five times,
  // U1 Phase B #3 still read it four times even with the prior anti-
  // fragmentation bullet. The cap below is more direct: per-candidate,
  // not per-file, with a clear contradicts-the-concern escape valve.
  parts.push(
    '- Spend at most one targeted context lookup per candidate unless the first lookup contradicts the concern. Prefer a single bounded slice large enough to cover the changed method or class (typically 80-200 lines) over a sequence of narrow overlapping reads. Avoid repeated reads to prove the same point.',
  );
  parts.push(
    '- Keep your response compact and grounded in evidence you observed. If you did not open any files, do not produce paragraphs of speculative reasoning — list only findings you can ground in the diff or in specific file contents you read.',
  );
  return `\n${parts.join('\n')}`;
}

function buildCliAgenticReviewPrompt({
  branchName = '',
  baseBranch = 'main',
  mergeBaseSha = '',
  headSha = '',
  fileHints = [],
  ignorePatterns = [],
  outputSchema = {},
  fileCount = null,
  maxTurns = null,
  minimumDeepReviewedFiles = null,
  minimumCoverageRate = null,
  preferFileListOnly = false,
  summaryHints = null,
  reviewProfile = null,
  shapedScope = null,
  shardContext = null,
  preComputedDiff = null,
  linterFindings = [],
  behavioralHotspotsSummary = null,
  discoveryMode = false,
  diffMode = 'full',
  reviewModelStrategy = 'smart',
  // M1b: Performance soft-enforcement parameters. Only consulted when
  // performancePromptMode === true; ignored under any other strategy. The
  // resolver result is advisory — the prompt nudges the agent toward the
  // intended mode but does not deny tools or hard-block.
  intendedExplorationMode = null,
  intendedExplorationModeReasons = [],
  // Section R Phase B: when true, the spawned agent will have the
  // atlas-review-rt MCP tools available and the retrieval bullet should
  // reference them by name. When false, the bullet falls back to the
  // Phase A.0 Bash/Read pattern. Always false for Balanced (the call site
  // gates this on Performance + valid SHAs + provider support).
  runtimeMcpEnabled = false,
  // CodeGraph experiment: when true, the spawned agent will have the
  // 9 mcp__codegraph__* tools available. Computed in reviewService.js
  // using the I1 gate (toggle ON + ready index + worktree_sha matches
  // reviewHeadSha). When true we render the CodeGraph-first preference
  // bullet so the agent actually uses the tools — the prior NO-GO
  // benchmark showed that adoption hinges on the prompt.
  codegraphMcpEnabled = false,
} = {}) {
  // Two-dot for delta range (only the unreviewed commits), three-dot for
  // full PR/branch diff against the merge-base.
  const diffSyntax = diffMode === 'delta' ? '..' : '...';
  const safeFileHints = Array.isArray(fileHints) ? fileHints : [];
  const safeIgnorePatterns = Array.isArray(ignorePatterns) ? ignorePatterns : [];
  const normalizedDiscoveryMode = discoveryMode === true;
  const normalizedReviewModelStrategy = typeof reviewModelStrategy === 'string'
    ? reviewModelStrategy.trim().toLowerCase()
    : 'smart';
  const performancePromptMode = normalizedReviewModelStrategy === 'performance';

  // M1b: build the per-intended-mode bullet only when in Performance mode
  // and a resolver decision is available. Balanced never sees these bullets.
  const intendedModePromptBullet = performancePromptMode
    ? buildIntendedModePromptBullet(intendedExplorationMode, intendedExplorationModeReasons)
    : '';
  const performanceSoftEnforcementBullets = performancePromptMode
    ? buildPerformanceSoftEnforcementBullets(intendedModePromptBullet, mergeBaseSha, headSha, runtimeMcpEnabled === true, codegraphMcpEnabled === true)
    : '';

  // Sort file hints by risk score descending (highest risk first)
  const sortedHints = [...safeFileHints].sort(
    (a, b) => (Number(b.riskScore) || 0) - (Number(a.riskScore) || 0)
  );

  const normalizedFileCount = Math.max(0, Math.trunc(Number(fileCount) || 0));
  const normalizedMaxTurns = Number.isFinite(Number(maxTurns))
    ? Math.max(1, Math.trunc(Number(maxTurns)))
    : null;
  const normalizedCoverageRate = Number.isFinite(Number(minimumCoverageRate))
    ? Math.max(0, Math.min(1, Number(minimumCoverageRate)))
    : null;
  const normalizedMinimumDeepReviewedFiles = Number.isFinite(Number(minimumDeepReviewedFiles))
    ? Math.max(0, Math.trunc(Number(minimumDeepReviewedFiles)))
    : (
      normalizedCoverageRate != null && normalizedFileCount > 0
        ? Math.max(1, Math.ceil(normalizedFileCount * normalizedCoverageRate))
        : null
    );

  const fileHintLines = sortedHints.length > 0
    ? sortedHints.map((f) => {
      const normalizedStatus = typeof f?.status === 'string' ? f.status.trim().toUpperCase() : '';
      const statusLabel = normalizedStatus ? `[${normalizedStatus}] ` : '';
      const renameSuffix = normalizedStatus === 'R'
        && typeof f?.oldPath === 'string'
        && f.oldPath.trim()
        ? ` (from ${f.oldPath.trim()})`
        : '';
      const risk = Number(f.riskScore) || 0;
      const classLabel = typeof f?.profileClass === 'string' && f.profileClass.trim()
        ? ` [${f.profileClass.trim()}]`
        : '';
      const memberCount = Array.isArray(f?.memberPaths) ? f.memberPaths.length : 0;
      const memberSuffix = memberCount > 1 ? ` (+${memberCount - 1} paired file${memberCount > 2 ? 's' : ''})` : '';
      const hotspotSuffix = typeof f?.behavioralSummary === 'string' && f.behavioralSummary.trim()
        ? ` — ${f.behavioralSummary.trim()}`
        : '';
      return `  - ${statusLabel}${f.path}${renameSuffix}${classLabel}${memberSuffix}${risk > 0 ? ` (risk: ${risk.toFixed(2)})` : ''}${hotspotSuffix}`;
    }).join('\n')
    : '  (no file hints — discover changed files via git diff)';

  const ignoreSection = safeIgnorePatterns.length > 0
    ? `\nFiles/patterns to SKIP (do not review these):\n${safeIgnorePatterns.map(p => `  - ${p}`).join('\n')}`
    : '';
  const executionBudgetLines = [];
  if (normalizedDiscoveryMode) {
    executionBudgetLines.push(
      '- FAST DISCOVERY FIRST: work like a senior PR reviewer scanning for the most meaningful behavioral risks, not exhaustively reading every changed file.',
      '- Start from the highest-risk runtime files and hotspot hypotheses first. Form likely issues quickly, then confirm the strongest ones.',
      '- Prefer runtime correctness, lifecycle, math, initialization, ownership, localization, and data-flow regressions over style or process notes.',
      '- Ignore low-signal asset/config churn unless the diff ties it directly to a runtime failure mode.',
      '- Once you have the strongest grounded findings, STOP exploring and produce the JSON review immediately.',
    );
  } else {
    executionBudgetLines.push(
      '- OUTPUT FIRST: You MUST produce the JSON review. Exploring files is only useful if it leads to the review output.',
      performancePromptMode
        ? '- Strategy: Review the changed hunks from the pre-computed diff (or run git diff once), then read full files only for risky hunks, hotspot/linter signals, or candidate findings that need surrounding context. Do NOT explore unrelated files.'
        : '- Strategy: Read the pre-computed diff (or run git diff once), then review the changed files. Do NOT explore unrelated files.',
      performancePromptMode
        ? '- If you have reviewed the changed hunks and gathered enough evidence, STOP exploring and produce the JSON review immediately.'
        : '- If you have reviewed the changed files and gathered enough evidence, STOP exploring and produce the JSON review immediately.',
      '- Do not spend turns re-reading files you have already seen or exploring tangential code paths.',
    );
  }
  if (normalizedFileCount > 0) {
    executionBudgetLines.push(`- Total changed files in scope: ${normalizedFileCount}.`);
  }
  if (
    !normalizedDiscoveryMode
    && (
    normalizedMinimumDeepReviewedFiles != null
    && normalizedFileCount > 0
    && normalizedMinimumDeepReviewedFiles > 0
  )) {
    const coveragePct = normalizedCoverageRate == null
      ? Math.round((normalizedMinimumDeepReviewedFiles / Math.max(1, normalizedFileCount)) * 100)
      : Math.round(normalizedCoverageRate * 100);
    executionBudgetLines.push(
      `- Coverage target: deeply review at least ${Math.min(normalizedFileCount, normalizedMinimumDeepReviewedFiles)}/${normalizedFileCount} files (${coveragePct}%+) before finalizing.`
    );
  }
  const executionBudgetSection = executionBudgetLines.join('\n');
  const profileSection = reviewProfile && typeof reviewProfile === 'object'
    ? [
      '## Atlas Review Profile',
      '',
      `- Active profile: ${(reviewProfile.label || reviewProfile.id || 'Generic').trim?.() || 'Generic'} (${reviewProfile.source || 'fallback'})`,
      shapedScope && typeof shapedScope === 'object'
        ? `- Shaped scope: ${Math.max(0, Math.trunc(Number(shapedScope.rawFileCount) || 0))} raw changed files -> ${Math.max(0, Math.trunc(Number(shapedScope.reviewUnitCount) || 0))} review units.`
        : null,
      shapedScope?.classCounts && typeof shapedScope.classCounts === 'object'
        ? `- Unit classes: deep ${Math.max(0, Math.trunc(Number(shapedScope.classCounts.deep) || 0))}, structural ${Math.max(0, Math.trunc(Number(shapedScope.classCounts.structural) || 0))}, shallow ${Math.max(0, Math.trunc(Number(shapedScope.classCounts.shallow) || 0))}, collapsed ${Math.max(0, Math.trunc(Number(shapedScope.classCounts.collapsed) || 0))}, skipped ${Math.max(0, Math.trunc(Number(shapedScope.classCounts.skip) || 0))}.`
        : null,
    ].filter(Boolean).join('\n')
    : '';

  const schemaJson = JSON.stringify(outputSchema, null, 2);

  let reviewScopeSection;
  if (typeof preComputedDiff === 'string' && preComputedDiff.length > 0) {
    const truncationHint = preComputedDiff.length > 100000
      ? '\n\nNote: This diff may be truncated. For files not covered in the diff, read them directly from the repository.'
      : '';
    reviewScopeSection = `## Review Scope

- The full unified diff for this review is provided below. Do NOT run \`git diff\` yourself — use this pre-computed diff.
- ${normalizedDiscoveryMode
    ? 'Start with the highest-risk files from this diff and only read full files when needed to confirm or reject likely issues.'
    : performancePromptMode
      ? 'Review every changed hunk in this diff. Read full files only when a hunk, hotspot, linter signal, or candidate finding needs surrounding context to confirm impact.'
      : 'Read changed files in full (not just diff hunks) before reporting findings.'}
- Use only repository-relative paths; do not access absolute paths or files outside this project.${truncationHint}

<pre-computed-diff>
${preComputedDiff}
</pre-computed-diff>`;
  } else if (preferFileListOnly) {
    reviewScopeSection = `## Review Scope

- The file list below is the authoritative changed-file set from Atlas for this review.
- You may run git commands for extra context, but do NOT block on git history availability.
- If git commands fail, continue the review using the listed files and local source context.
- ${performancePromptMode
    ? 'Review the available changed-file evidence first. Read full files only when needed to establish the concrete failure scenario for a finding.'
    : 'Read changed files in full (not just diff hunks) before reporting findings.'}
- Use only repository-relative paths; do not access absolute paths or files outside this project.`;
  } else {
    reviewScopeSection = `## Review Scope

- Start by running \`git diff ${mergeBaseSha}${diffSyntax}${headSha}\` and focus your review on files in this diff.
- If the exact SHA diff cannot be computed, continue with the provided file list and review those files directly.
- ${normalizedDiscoveryMode
    ? 'Start with the highest-risk files first and only expand to full-file reads when they help confirm or reject a likely issue.'
    : performancePromptMode
      ? 'Review every changed hunk in the diff. Read full files only when a hunk, hotspot, linter signal, or candidate finding needs surrounding context to confirm impact.'
      : 'Read changed files in full (not just diff hunks) before reporting findings.'}
- Use only repository-relative paths; do not access absolute paths or files outside this project.`;
  }

  return `You are an expert code reviewer for the Atlas platform.

## Task

Review the changes on branch \`${branchName}\` compared to \`${baseBranch}\`.

## Branch Context

- **Branch**: \`${branchName}\`
- **Base branch**: \`${baseBranch}\`
- **Merge-base SHA**: \`${mergeBaseSha}\`
- **HEAD SHA**: \`${headSha}\`

## Execution Budget

${executionBudgetSection}

${reviewScopeSection}

${profileSection ? `${profileSection}\n` : ''}${!normalizedDiscoveryMode ? buildAgenticLinterSection(linterFindings) : ''}${typeof behavioralHotspotsSummary === 'string' && behavioralHotspotsSummary.trim() ? `\n${behavioralHotspotsSummary.trim()}\n` : ''}
## Files to prioritize (sorted by estimated risk):

${fileHintLines}
${typeof summaryHints === 'string' && summaryHints.trim() ? `\n${summaryHints}\n` : ''}${ignoreSection}${shardContext && typeof shardContext === 'object' ? `

## Parallel Review Context

This is shard ${shardContext.shardIndex} of ${shardContext.totalShards}. Focus ONLY on the ${sortedHints.length} files listed above.
Other shards are reviewing the remaining files from the total ${shardContext.totalFiles} changed files concurrently.` : ''}

## Output Format

Return ONLY a single JSON object (no markdown fences, no explanation text outside the JSON).
The JSON must conform to this schema:

\`\`\`json
${schemaJson}
\`\`\`

## Quality Standards

- ${normalizedDiscoveryMode
    ? 'Use repository and git tools only where they sharpen the strongest likely findings; do not chase exhaustive coverage.'
    : performancePromptMode
      ? 'Do a breadth pass across all changed hunks first, then deep-dive only risky files or candidate findings that need more context.'
      : 'Do a breadth pass across all changed files first, then deep-dive risky files.'}
- Treat the behavioral hotspot summary as Atlas-generated review hypotheses: inspect those files first and either confirm or reject the hotspot claim before finalizing.
- When a hotspot points at inline user-facing text in a file that otherwise uses localized strings, prefer the localization regression over lower-value caching or style observations.
- When a hotspot points at distance normalization or curve input changes, inspect both the helper and the caller path before deciding whether the issue is real.
- ${normalizedDiscoveryMode
    ? 'Use `candidateFindings` for plausible concerns that are grounded but not yet strong enough for direct surfacing.'
    : 'Use repository and git tools to gather concrete evidence before producing findings.'}
- ${normalizedDiscoveryMode
    ? '`stats.filesAnalyzed` should reflect the files you actually inspected in code, even if you did not review every changed file.'
    : performancePromptMode
      ? 'Do not finalize until you have either met the coverage target above or exhausted relevant changed-hunk evidence.'
      : 'Do not finalize until you have either met the coverage target above or exhausted reachable files.'}
- Every file path you mention MUST exist in the repository.
- Every line number you reference MUST exist in the referenced file.
- Severity must match actual impact: only use "critical" or "high" for genuine security, data loss, or correctness issues.
- Provide a concrete \`suggestedFix\` code snippet for each issue when possible.
- Only provide \`targetSnippet\` when you can name the exact changed code being replaced by \`suggestedFix\`. If unsure, omit it rather than guessing.
- Use \`recommendations\` only for findings you are confident Atlas should surface directly.
- Use \`candidateFindings\` for plausible, grounded concerns that still need verification before promotion. Return an empty array when none apply.
- Do NOT include generic process advice (e.g., "add more tests") unless grounded to specific changed files/lines.${performancePromptMode ? '\n- Do NOT surface formatting, documentation, or member-ordering convention issues unless they create a concrete build, runtime, API, or product correctness impact.\n- Before flagging test runner or test-framework usage, inspect package scripts/config and nearby tests. Do not report a framework mismatch when the repo consistently uses that runner for similar unit tests.' : ''}${performanceSoftEnforcementBullets}
- Do not report tool/sandbox/runtime failures as code findings; continue with available source context.
- For every issue or suggestion, include an \`evidence\` object with: \`file\` (path), \`line\` (number), \`snippet\` (code showing the problem), and \`reasoning\` (concrete failure scenario). Findings without evidence will be filtered out.

IMPORTANT: Your final response MUST be ONLY the JSON object. No conversational text, no markdown fences, no preamble. Output the raw JSON object and nothing else.
`;
}

function buildCliAgenticDiscoveryPrompt({
  branchName = '',
  baseBranch = 'main',
  mergeBaseSha = '',
  headSha = '',
  prTitle = '',
  prBody = '',
  prCommitsSummary = [],
  fileHints = [],
  ignorePatterns = [],
  fileCount = null,
  reviewProfile = null,
  shapedScope = null,
  summaryHints = null,
  preComputedDiff = null,
  behavioralHotspotsSummary = null,
  providerType = null,
  diffMode = 'full',
} = {}) {
  const diffSyntax = diffMode === 'delta' ? '..' : '...';
  const safeFileHints = Array.isArray(fileHints) ? fileHints : [];
  const safeIgnorePatterns = Array.isArray(ignorePatterns) ? ignorePatterns : [];
  const normalizedFileCount = Math.max(0, Math.trunc(Number(fileCount) || 0));

  const fileHintLines = safeFileHints.length > 0
    ? safeFileHints.map((entry) => {
      const status = typeof entry?.status === 'string' && entry.status.trim()
        ? `[${entry.status.trim().toUpperCase()}] `
        : '';
      return `- ${status}${entry.path}`;
    }).join('\n')
    : '- discover changed files from the diff';

  const prSummarySection = [
    prTitle ? `PR title: ${String(prTitle).trim()}` : null,
    prBody
      ? `PR summary/body:\n${String(prBody).trim().slice(0, 2400)}`
      : null,
    Array.isArray(prCommitsSummary) && prCommitsSummary.length > 0
      ? `Recent commits:\n${prCommitsSummary.slice(0, 12).map((entry) => `- ${String(entry || '').trim()}`).join('\n')}`
      : null,
  ].filter(Boolean).join('\n\n');

  const ignoreSection = safeIgnorePatterns.length > 0
    ? `\nSkip these patterns unless directly relevant:\n${safeIgnorePatterns.map((pattern) => `- ${pattern}`).join('\n')}`
    : '';

  const diffSection = typeof preComputedDiff === 'string' && preComputedDiff.length > 0
    ? `Use this pre-computed diff as the starting point. Do not run git diff unless absolutely necessary.\n\n<pre-computed-diff>\n${preComputedDiff}\n</pre-computed-diff>`
    : `Start from \`git diff ${mergeBaseSha}${diffSyntax}${headSha}\` if needed, but stay focused on the highest-signal files first.`;
  const providerSpecificGuidance = providerType === 'openai'
    ? `
Codex-specific guidance:
- Start with changed code files first. Do not inspect prefabs, scenes, localization assets, or other non-code files unless a changed code path points to a concrete binding, serialized-reference, or initialization bug.
- Keep the first pass tight. Prefer identifying 1-3 strong issues over broad repository validation.
- Only expand beyond the listed top files if they do not explain the risky behavior in the diff.`
    : '';

  return `Review this pull request the way you would in a fresh terminal session inside the repository.

Goal: find the most meaningful real issues from the code changes. Prioritize correctness and runtime behavior over exhaustive coverage.

Branch: ${branchName}
Base: ${baseBranch}
Merge-base: ${mergeBaseSha}
Head: ${headSha}
Changed files in scope: ${normalizedFileCount}

${prSummarySection ? `${prSummarySection}\n\n` : ''}Changed files:
${fileHintLines}
${typeof summaryHints === 'string' && summaryHints.trim() ? `\n${summaryHints.trim()}\n` : ''}${ignoreSection}

Start from the actual code changes. Use the diff first, then open nearby files only when a changed file suggests it.

Focus on:
- concrete bugs or regressions
- runtime correctness
- broken assumptions introduced by the diff
- null, math, state, lifecycle, or integration risks when they are real

Avoid:
- generic style advice
- test suggestions
- process comments
- speculative architecture debate

${diffSection}
${providerSpecificGuidance}

Return plain text only. Keep it concise. Use these section headings so the review can be parsed:

Summary:
<1-3 sentences>

Overall risk: <low|medium|high|critical>

Issues:
- [severity] <short title>
  file: <repo-relative path>
  line: <line number or ?>
  why: <concrete failure scenario>
  snippet: <short code snippet or ?>
  fix: <brief actionable fix or ?>

Candidate concerns:
- [severity] <short title>
  file: <repo-relative path>
  line: <line number or ?>
  why: <why it might be a problem>
  snippet: <short code snippet or ?>
  fix: <brief actionable fix or ?>

Positives:
- <optional short positive note>

If a section is empty, write "none". Do not return JSON.`;
}

function buildCliAgenticDiscoveryExtractionPrompt({
  discoveryText = '',
  outputSchema = {},
  filePaths = [],
  fileCount = null,
} = {}) {
  const schemaJson = JSON.stringify(outputSchema, null, 2);
  const safeDiscoveryText = String(discoveryText || '').trim();
  const safeFilePaths = Array.isArray(filePaths)
    ? filePaths
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .slice(0, 120)
    : [];
  const normalizedFileCount = Math.max(0, Math.trunc(Number(fileCount) || safeFilePaths.length || 0));
  const fileListSection = safeFilePaths.length > 0
    ? safeFilePaths.map((entry) => `- ${entry}`).join('\n')
    : '- none provided';

  return `Convert the discovery notes below into the Atlas review JSON schema.

This is an extraction pass, not a fresh code review.

Rules:
- Use ONLY findings that are explicitly present in the discovery notes.
- Do NOT invent new issues, candidates, files, or line numbers.
- If the discovery notes sound uncertain, keep the concern in \`candidateFindings\` instead of \`recommendations\`.
- Preserve file paths, lines, snippets, and fixes when they are present in the discovery notes.
- If a field is missing or unclear, omit it or use null rather than guessing.
- \`stats.filesAnalyzed\` should be a conservative count based on the discovery notes and file list below, not a claim of exhaustive review.
- Return ONLY a single JSON object. No markdown fences, no commentary.

Files in reviewed scope (${normalizedFileCount}):
${fileListSection}

Discovery notes:
<<<DISCOVERY_NOTES
${safeDiscoveryText}
DISCOVERY_NOTES

Return JSON matching this schema:
\`\`\`json
${schemaJson}
\`\`\``;
}

function parseDiscoverySection(text, heading) {
  const pattern = new RegExp(`(?:^|\\n)${heading}:\\s*\\n?([\\s\\S]*?)(?=\\n[A-Z][A-Za-z ]+:|$)`, 'i');
  const match = String(text || '').match(pattern);
  return match?.[1]?.trim() || '';
}

function parseDiscoveryFindings(sectionText, fallbackSeverity = 'medium') {
  const text = String(sectionText || '').trim();
  if (!text || /^none$/i.test(text)) {
    return [];
  }

  const blocks = text
    .split(/\n(?=- \[)/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const header = lines.shift() || '';
    const headerMatch = header.match(/^- \[(critical|high|medium|low)\]\s+(.+)$/i);
    const finding = {
      severity: (headerMatch?.[1] || fallbackSeverity).toLowerCase(),
      title: headerMatch?.[2]?.trim() || header.replace(/^- /, '').trim() || 'Untitled concern',
      file: null,
      line: null,
      why: '',
      snippet: '',
      fix: '',
    };

    for (const line of lines) {
      const kv = line.match(/^([a-zA-Z ]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim().toLowerCase();
      const value = kv[2].trim();
      if (key === 'file') {
        finding.file = value && value !== '?' ? value : null;
      } else if (key === 'line') {
        const parsedLine = Number.parseInt(value, 10);
        finding.line = Number.isFinite(parsedLine) ? parsedLine : null;
      } else if (key === 'why') {
        finding.why = value && value !== '?' ? value : '';
      } else if (key === 'snippet') {
        finding.snippet = value && value !== '?' ? value : '';
      } else if (key === 'fix') {
        finding.fix = value && value !== '?' ? value : '';
      }
    }

    return finding;
  });
}

function parseCliAgenticDiscoveryResponse(rawText) {
  const text = String(rawText || '').trim();
  const summary = parseDiscoverySection(text, 'Summary') || '';
  const overallRiskMatch = text.match(/Overall risk:\s*(low|medium|high|critical)/i);
  const issues = parseDiscoveryFindings(parseDiscoverySection(text, 'Issues'), 'medium');
  const candidateConcerns = parseDiscoveryFindings(parseDiscoverySection(text, 'Candidate concerns'), 'medium');
  const positivesSection = parseDiscoverySection(text, 'Positives');
  const positives = !positivesSection || /^none$/i.test(positivesSection)
    ? []
    : positivesSection
      .split('\n')
      .map((line) => line.replace(/^- /, '').trim())
      .filter(Boolean);

  return {
    summary,
    overallRisk: (overallRiskMatch?.[1] || 'medium').toLowerCase(),
    issues,
    candidateConcerns,
    positives,
  };
}

function convertCliAgenticDiscoveryToReviewPayload(discovery, context = {}) {
  const safeDiscovery = discovery && typeof discovery === 'object' ? discovery : {};
  const toRecommendation = (entry, type = 'issue') => ({
    type,
    severity: entry.severity || 'medium',
    title: entry.title || 'Untitled concern',
    file: entry.file || null,
    line: entry.line || null,
    summary: entry.why || entry.title || '',
    snippet: entry.snippet || '',
    suggestedFix: entry.fix || '',
    evidence: {
      file: entry.file || null,
      line: entry.line || null,
      snippet: entry.snippet || '',
      reasoning: entry.why || entry.title || '',
    },
  });

  const recommendations = Array.isArray(safeDiscovery.issues)
    ? safeDiscovery.issues.map((entry) => toRecommendation(entry, 'issue'))
    : [];
  const candidateFindings = Array.isArray(safeDiscovery.candidateConcerns)
    ? safeDiscovery.candidateConcerns.map((entry) => toRecommendation(entry, 'suggestion'))
    : [];

  return {
    summary: typeof safeDiscovery.summary === 'string' && safeDiscovery.summary.trim()
      ? safeDiscovery.summary.trim()
      : 'Agentic discovery review completed.',
    riskLevel: typeof safeDiscovery.overallRisk === 'string' && safeDiscovery.overallRisk.trim()
      ? safeDiscovery.overallRisk.trim().toLowerCase()
      : 'medium',
    recommendations,
    candidateFindings,
    stats: {
      filesAnalyzed: Math.max(1, Math.min(
        Number(context.fileCount) || recommendations.length + candidateFindings.length || 1,
        recommendations.length + candidateFindings.length || Number(context.fileCount) || 1
      )),
      totalAdditions: Math.max(0, Number(context.totalAdditions) || 0),
      totalDeletions: Math.max(0, Number(context.totalDeletions) || 0),
      positives: Array.isArray(safeDiscovery.positives) ? safeDiscovery.positives : [],
    },
  };
}

/**
 * Summarize a tool_use event into a human-readable progress string.
 * Used for real-time progress reporting during agentic reviews.
 *
 * @param {Object|null} event - A tool_use event with name and input
 * @returns {string} Human-readable summary
 */
function summarizeToolInput(event) {
  if (!event || typeof event !== 'object') return 'Working...';

  const name = typeof event.name === 'string' ? event.name : '';
  const input = event.input && typeof event.input === 'object' ? event.input : {};

  const truncate = (str, maxLen = 120) => {
    const s = String(str || '');
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 3) + '...';
  };

  switch (name) {
    case 'Read':
      return `Reading: ${truncate(input.file_path || 'file')}`;

    case 'Grep':
      return `Searching: ${truncate(input.pattern || '')}${input.path ? ` in ${truncate(input.path, 60)}` : ''}`;

    case 'Glob':
      return `Finding: ${truncate(input.pattern || '**/*')}`;

    case 'Bash': {
      const cmd = truncate(input.command || 'command', 100);
      return `Running: ${cmd}`;
    }

    case 'Edit':
      return `Editing: ${truncate(input.file_path || 'file')}`;

    case 'Write':
      return `Writing: ${truncate(input.file_path || 'file')}`;

    default:
      return `Using tool: ${truncate(name || 'unknown')}`;
  }
}

// ---------------------------------------------------------------------------
// File hint tiering for CLI-agentic prompts
// ---------------------------------------------------------------------------

/**
 * Tier file hints for agentic prompts based on PR size.
 * - <=40 files: all hints with full detail
 * - 41-80 files: top 40 full detail, rest summarized by directory
 * - 81+ files: top 30 full detail, rest summarized by directory
 *
 * @param {Array<{path: string, status?: string, oldPath?: string, riskScore?: number}>} fileHints - Sorted by risk descending
 * @param {number} fileCount - Total number of changed files
 * @returns {{ detailedHints: Array, summaryHints: string|null }}
 */
function tierFileHintsForAgenticPrompt(fileHints, fileCount) {
  const safeHints = Array.isArray(fileHints) ? fileHints : [];
  const count = Math.max(0, Math.trunc(Number(fileCount) || safeHints.length));

  if (count <= 40) {
    return { detailedHints: safeHints, summaryHints: null };
  }

  const detailCap = count <= 80 ? 40 : 30;
  const detailedHints = safeHints.slice(0, detailCap);
  const remainingHints = safeHints.slice(detailCap);

  // Summarize remaining files by directory
  const dirCounts = new Map();
  for (const hint of remainingHints) {
    const path = typeof hint?.path === 'string' ? hint.path : '';
    const lastSlash = path.lastIndexOf('/');
    const dir = lastSlash > 0 ? path.slice(0, lastSlash + 1) : '(root)/';
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
  }

  // Sort directories by file count descending
  const sortedDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);
  const summaryLines = sortedDirs.map(([dir, cnt]) => `  - ${dir} (${cnt} file${cnt !== 1 ? 's' : ''})`);

  const summaryHints = `## Additional changed files (review if turns allow):\n\n${summaryLines.join('\n')}`;

  return { detailedHints, summaryHints };
}

/**
 * Partition file hints for parallel agentic review.
 * Sorts by risk descending and distributes round-robin across shards
 * to ensure each shard gets mixed risk levels.
 *
 * @param {Array<{path: string, riskScore?: number}>} fileHints
 * @param {Object} [config]
 * @param {number} [config.minFilesPerShard]
 * @param {number} [config.maxShards]
 * @returns {Array<Array<{path: string, riskScore?: number}>>} Array of shard arrays
 */
function partitionFilesForParallelAgenticReview(fileHints, config = {}) {
  const safeHints = Array.isArray(fileHints) ? fileHints : [];
  if (safeHints.length === 0) return [[]];

  const minPerShard = Math.max(1, Math.trunc(
    Number(config.minFilesPerShard) || CLI_AGENTIC_PARALLEL_MIN_FILES_PER_SHARD
  ));
  const targetPerShard = Math.max(minPerShard, Math.trunc(
    Number(config.targetFilesPerShard) || CLI_AGENTIC_PARALLEL_TARGET_FILES_PER_SHARD
  ));
  const maxShards = Math.max(2, Math.trunc(
    Number(config.maxShards) || CLI_AGENTIC_PARALLEL_MAX_SHARDS
  ));

  // Aim for ~targetPerShard files per shard; cap at maxShards; never produce shards smaller than minPerShard.
  const desiredShards = Math.max(1, Math.ceil(safeHints.length / targetPerShard));
  const minViableShards = Math.max(1, Math.floor(safeHints.length / minPerShard));
  const shardCount = Math.min(maxShards, Math.max(1, Math.min(desiredShards, minViableShards)));
  if (shardCount <= 1) return [safeHints];

  // Sort by risk descending
  const sorted = [...safeHints].sort(
    (a, b) => (Number(b.riskScore) || 0) - (Number(a.riskScore) || 0)
  );

  // Round-robin distribute
  const shards = Array.from({ length: shardCount }, () => []);
  for (let i = 0; i < sorted.length; i++) {
    shards[i % shardCount].push(sorted[i]);
  }

  return shards.filter(s => s.length > 0);
}

// ---------------------------------------------------------------------------
// Dynamic max-turns & timeout for CLI-agentic (tier-aware)
// ---------------------------------------------------------------------------

/**
 * Resolve the agentic review tier based on file count.
 * @param {number} fileCount
 * @returns {'small'|'medium'|'large'}
 */
function resolveAgenticTier(fileCount) {
  const count = Math.max(0, Math.floor(Number(fileCount) || 0));
  if (count >= CLI_AGENTIC_TIER_LARGE_FILE_COUNT) return 'large';
  if (count >= CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT) return 'medium';
  return 'small';
}

/**
 * Compute dynamic max turns for CLI-agentic review.
 * @param {number} fileCount - Number of files in scope (for 'large' tier, this is per-shard)
 * @param {string} [tier] - Explicit tier override; if omitted, resolved from fileCount
 * @returns {number}
 */
function computeAgenticMaxTurns(fileCount, tier) {
  const count = Math.max(0, Math.floor(Number(fileCount) || 0));
  const resolvedTier = tier || resolveAgenticTier(count);

  switch (resolvedTier) {
    case 'large':
      return Math.min(CLI_AGENTIC_MAX_TURNS_LARGE, Math.max(CLI_AGENTIC_MIN_TURNS, Math.ceil(count * 0.5) + 10));
    case 'medium':
      return Math.min(CLI_AGENTIC_MAX_TURNS_MEDIUM, Math.max(CLI_AGENTIC_MIN_TURNS, count + 1));
    default: // 'small'
      return Math.min(CLI_AGENTIC_MAX_TURNS, Math.max(CLI_AGENTIC_MIN_TURNS, count + 5));
  }
}

/** Clamp a raw maxTurns value to [MIN_TURNS, ceiling], falling back to ceiling for invalid input. */
function normalizeAgenticMaxTurns(raw, tier) {
  const n = Number(raw);
  const ceiling = tier === 'large'
    ? CLI_AGENTIC_MAX_TURNS_LARGE
    : tier === 'medium'
      ? CLI_AGENTIC_MAX_TURNS_MEDIUM
      : CLI_AGENTIC_MAX_TURNS;
  if (!Number.isFinite(n) || n <= 0) return ceiling;
  return Math.min(ceiling, Math.max(CLI_AGENTIC_MIN_TURNS, Math.floor(n)));
}

/**
 * Compute agentic timeout from tier.
 * With no hard turn limit, we use the tier ceiling directly — the timeout
 * is now the only hard safety net for runaway sessions.
 * @param {number} [_maxTurns] - Unused (kept for signature compat)
 * @param {string} [tier]
 * @returns {number} Timeout in milliseconds
 */
function computeAgenticTimeoutMs(_maxTurns, tier) {
  switch (tier) {
    case 'large':
      return PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_LARGE;
    case 'medium':
      return PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_MEDIUM;
    default: // 'small'
      return PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS;
  }
}

const BEHAVIORAL_HOTSPOT_SIGNAL_DEFINITIONS = Object.freeze([
  {
    id: 'lifecycle_signal_handoff',
    score: 260,
    summary: 'lifecycle/init wiring changed; verify signal ordering, setup timing, and teardown symmetry',
    detect: (patchText) => {
      const text = String(patchText || '');
      if (!text) return false;
      const hasLifecycleMarker = /(?:^\+|^-).*(?:\bStart\s*\(|\bAwake\s*\(|\bOnEnable\s*\(|\bOnDisable\s*\(|\bInit(?:ialize)?\s*\(|SubscribeToSignal<|AddListener\s*\(|\+=\s*[A-Za-z_]\w*)/m.test(text);
      const hasMovedOrRemovedCall = /(?:^\+|^-).*(?:\bInit(?:ialize)?\s*\(|SubscribeToSignal<|AddListener\s*\(|-.*\.\s*Init\s*\(|-.*\.\s*Initialize[A-Za-z_]*\s*\()/m.test(text);
      return hasLifecycleMarker && hasMovedOrRemovedCall;
    },
  },
  {
    id: 'runtime_ui_material_mutation',
    score: 230,
    summary: 'runtime UI/material mutation changed; verify batching, shared-instance side effects, and null-safe lifecycle access',
    detect: (patchText) => /(?:^\+|^-).*(?:\.material\b|materialForRendering\b|SetFloat\s*\(|SetVector\s*\(|Shader\.PropertyToID|MaskableGraphic|CanvasGroup|RectTransformUtility)/m.test(String(patchText || '')),
  },
  {
    id: 'distance_normalization_edge',
    score: 210,
    summary: 'distance normalization changed; verify zero-length vectors, infinity paths, and curve inputs before dividing by magnitude',
    detect: (patchText) => {
      const text = String(patchText || '');
      if (!text) return false;
      return (
        /(?:^|\n)[ +\-].*distanceCorrection\s*=\s*[^;\n]+\/\s*[^;\n]*magnitude\b/m.test(text)
        || /(?:^|\n)[ +\-].*Evaluate\s*\(\s*[A-Za-z_]\w*Correction\s*\)/m.test(text)
      );
    },
  },
  {
    id: 'hardcoded_user_facing_text',
    score: 180,
    summary: 'user-facing text changed with inline string literals; verify localization and runtime copy consistency',
    detect: (patchText) => {
      const text = String(patchText || '');
      if (!text) return false;
      const hunkLines = text
        .split('\n')
        .filter((line) => !/^(?:diff --git |index |@@ |\+\+\+|---)/.test(line));
      const changedLines = hunkLines
        .filter((line) => /^(?:\+|-)/.test(line));
      const hasUiTextContext = changedLines.some((line) => (
        /(?:LocalizedString|GetLocalizedString\s*\(|SetText\s*\(|\.text\s*=)/.test(line)
        && !/Log\.(?:Info|Warning|Error)|Debug\.Log/.test(line)
      ));
      if (!hasUiTextContext) return false;
      return hunkLines.some((line) => {
        const normalizedLine = String(line || '').replace(/^[ +\-]/, '');
        return (
          /(?:SetText\s*\(\s*"[^"]*[A-Za-z][^"]*"\s*\)|\.text\s*=\s*"[^"]*[A-Za-z][^"]*")/.test(normalizedLine)
          && !/GetLocalizedString\s*\(/.test(normalizedLine)
          && !/Log\.(?:Info|Warning|Error)|Debug\.Log/.test(normalizedLine)
        );
      });
    },
  },
  {
    id: 'math_edge_behavior',
    score: 170,
    summary: 'math/normalization behavior changed; verify zero, infinity, and boundary handling on runtime paths',
    detect: (patchText) => {
      const text = String(patchText || '');
      if (!text) return false;
      return /(?:^\+|^-).*(?:\/\s*[^;\n]*magnitude\b|Evaluate\s*\(|Mathf\.Max\s*\([^,\n]+,\s*0(?:\.0+)?1f?\s*\)|out var\s+[A-Za-z_]\w*)/m.test(text);
    },
  },
]);

function splitUnifiedDiffByFile(diffText) {
  const text = String(diffText || '');
  if (!text) return new Map();

  const byFile = new Map();
  let currentPath = null;
  let currentLines = [];
  const flush = () => {
    if (!currentPath || currentLines.length === 0) return;
    byFile.set(currentPath, currentLines.join('\n'));
  };

  for (const line of text.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      flush();
      currentPath = diffMatch[2];
      currentLines = [line];
      continue;
    }
    if (currentPath) {
      currentLines.push(line);
    }
  }
  flush();
  return byFile;
}

function collectBehavioralHotspotSignalsFromPatch(patchText) {
  const signals = [];
  for (const definition of BEHAVIORAL_HOTSPOT_SIGNAL_DEFINITIONS) {
    if (!definition.detect(patchText)) continue;
    signals.push({
      id: definition.id,
      score: definition.score,
      summary: definition.summary,
    });
  }
  return signals.sort((left, right) => right.score - left.score);
}

function buildBehavioralHotspotDistillation(preComputedDiff, fileHints = []) {
  const perPath = new Map();
  const normalizedHints = Array.isArray(fileHints) ? fileHints : [];
  const diffByFile = splitUnifiedDiffByFile(preComputedDiff);
  if (diffByFile.size === 0 || normalizedHints.length === 0) {
    return {
      perPath,
      summary: null,
    };
  }

  const hotspotRows = [];
  for (const hint of normalizedHints) {
    const normalizedPath = String(hint?.path || '').trim();
    if (!normalizedPath) continue;
    if (!isBehavioralHotspotCandidatePath(normalizedPath)) continue;
    const patchText = diffByFile.get(normalizedPath);
    if (!patchText) continue;
    const signals = collectBehavioralHotspotSignalsFromPatch(patchText);
    if (signals.length === 0) continue;
    perPath.set(normalizedPath, signals);
    hotspotRows.push({
      path: normalizedPath,
      score: signals.reduce((sum, signal) => sum + Math.max(0, Number(signal.score) || 0), 0),
      summary: signals.slice(0, 2).map((signal) => signal.summary).join('; '),
    });
  }

  if (hotspotRows.length === 0) {
    return {
      perPath,
      summary: null,
    };
  }

  const summaryLines = hotspotRows
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 5)
    .map((entry) => `  - ${entry.path} — ${entry.summary}`);

  return {
    perPath,
    summary: `## Behavioral hotspots from the diff:\n\n${summaryLines.join('\n')}`,
  };
}

function isBehavioralHotspotCandidatePath(filePath) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) return false;
  if (/^ProjectSettings\//.test(normalizedPath)) return true;
  return /\.(?:cs|ts|tsx|js|jsx|java|kt|swift|go|rb|py|php|ex|exs|c|cc|cpp|h|hpp|shader|shadergraph|hlsl|cginc|asmdef|asmref|json|ya?ml)$/i.test(normalizedPath);
}

// ---------------------------------------------------------------------------
// Sandbox helpers for CLI-agentic path enforcement
// ---------------------------------------------------------------------------

/**
 * Extract the file path a tool_use event is targeting.
 * @param {string} toolName - Tool name (Read, Grep, Glob, etc.)
 * @param {Object} input - Tool input object
 * @returns {string|null} The target path, or null if not a file-access tool
 */
function extractToolPath(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  return classifyToolOperation(toolName, input).filePath;
}

function resolveToolPathForAdapter(adapter, toolName, toolInput) {
  if (typeof adapter?.extractToolPathFromToolUse === 'function') {
    const adapterPath = adapter.extractToolPathFromToolUse(toolName, toolInput);
    if (typeof adapterPath === 'string' && adapterPath.trim()) {
      return adapterPath;
    }
  }
  return extractToolPath(toolName, toolInput);
}

/**
 * Check whether a target path is within the allowed scope directory.
 * @param {string} targetPath - Path to check (absolute or relative)
 * @param {string} scopePath - The allowed scope directory (absolute)
 * @returns {boolean}
 */
function isPathWithinScope(targetPath, scopePath) {
  if (!targetPath || !scopePath) return false;

  // Resolve the target relative to scopePath (handles relative paths)
  const resolved = pathResolve(scopePath, targetPath);

  // Try to resolve symlinks for both paths
  let realScope;
  try {
    realScope = realpathSync(scopePath);
  } catch {
    realScope = pathResolve(scopePath);
  }

  let realTarget;
  try {
    realTarget = realpathSync(resolved);
  } catch {
    // Path does not exist yet. Resolve nearest existing ancestor to avoid
    // symlink-escape false negatives (e.g., writing through linked dirs).
    let cursor = resolved;
    const missingSegments = [];
    while (true) {
      try {
        const realAncestor = realpathSync(cursor);
        realTarget = pathResolve(realAncestor, ...missingSegments);
        break;
      } catch {
        const parent = pathDirname(cursor);
        if (parent === cursor) {
          realTarget = resolved;
          break;
        }
        missingSegments.unshift(pathBasename(cursor));
        cursor = parent;
      }
    }
  }

  return realTarget === realScope || realTarget.startsWith(realScope + pathSep);
}

/**
 * Check whether a path is inside Claude Code's own internal directory (~/.claude/).
 * These paths (session data, tool-results, etc.) are legitimate agent-internal
 * file access and should not trigger out-of-scope violations.
 * @param {string} targetPath - Absolute path to check
 * @param {Object} [options]
 * @param {string} [options.homePath] - Optional home path override
 * @param {string[]} [options.homePaths] - Optional list of allowed home paths
 * @returns {boolean}
 */
function isClaudeInternalPath(targetPath, options = {}) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = pathResolve(targetPath);
  const rawHomePaths = Array.isArray(options?.homePaths)
    ? [...options.homePaths, homedir()]
    : [options?.homePath, homedir()];
  const seenHomePaths = new Set();
  for (const rawHomePath of rawHomePaths) {
    const homePath = typeof rawHomePath === 'string' && rawHomePath.trim()
      ? pathResolve(rawHomePath.trim())
      : null;
    if (!homePath || seenHomePaths.has(homePath)) continue;
    seenHomePaths.add(homePath);
    const claudeDir = pathResolve(homePath, '.claude');
    if (resolved === claudeDir || resolved.startsWith(claudeDir + pathSep)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Isolated agent HOME — prevents macOS TCC permission popups
// ---------------------------------------------------------------------------

/**
 * Dotfiles/dirs to symlink into the isolated HOME.
 * Only entries that actually exist in the real HOME are linked.
 *
 * IMPORTANT: `.claude` is NOT symlinked — it is scaffolded as a minimal
 * directory (see scaffoldMinimalClaudeDir) so the spawned CLI does not
 * inherit the user's MCP servers/plugins, which can hang or crash.
 */
const AGENT_HOME_SYMLINK_TARGETS = [
  // NOTE: .codex is NOT symlinked — it is scaffolded (see scaffoldMinimalCodexDir)
  // to avoid inheriting MCP servers/plugins from the user's config.
  '.config/git',   // Git config under XDG
  '.config/npm',   // npm config under XDG
  '.npm',          // npm cache/config
  '.nvm',          // Node version manager
  '.local/bin',    // user-local binaries
  '.local/share',  // user-local share data
  '.gitconfig',    // Git config (file)
];

/**
 * Files that must be **copied** (not symlinked) because the CLI atomically
 * replaces them via write-tmp + rename.  A rename over a symlink destroys the
 * link and writes a regular file into the temp dir, leaving the CLI with
 * stale/broken state for subsequent reads.
 */
const AGENT_HOME_COPY_TARGETS = [
  // NOTE: .claude.json is NOT blindly copied — it is sanitized first
  // (see sanitizeClaudeJsonForIsolation) to strip MCP servers.
];

/**
 * Create a minimal `$HOME/.claude/` directory for the spawned CLI.
 *
 * We do NOT symlink the real `~/.claude` because it contains MCP server
 * plugins, OAuth credentials for external services (e.g., PostHog), and
 * user-specific session data.  Symlinking causes the CLI to attempt MCP
 * server initialization, which can hang (waiting for OAuth) or crash.
 *
 * Only the API credentials file is copied (for auth), and a minimal
 * settings.json is written (with no plugins/MCP servers).
 */
async function scaffoldMinimalClaudeDir(tmpDir, realHome) {
  const fs = await import('fs/promises');
  const pathM = await import('path');

  const claudeDir = pathM.default.join(tmpDir, '.claude');
  await fs.default.mkdir(claudeDir, { recursive: true });

  // Copy credentials file (API/OAuth auth tokens).
  // Claude CLI uses `credentials.json` (no dot prefix) since ~v1.0.
  // Try both names for backwards compatibility.
  const credentialFileNames = ['credentials.json', '.credentials.json'];
  for (const name of credentialFileNames) {
    const credsSrc = pathM.default.join(realHome, '.claude', name);
    const credsDest = pathM.default.join(claudeDir, name);
    try {
      await fs.default.copyFile(credsSrc, credsDest);
    } catch {
      // File doesn't exist — try next
    }
  }

  // Write a clean settings.json — no plugins, no MCP servers.
  // Explicitly set enabledPlugins to empty to prevent plugin-sourced
  // MCP servers (e.g. PostHog) from initializing during the review.
  const minimalSettings = {
    permissions: { allow: [] },
    enabledPlugins: {},
    skipDangerousModePermissionPrompt: true,
  };
  await fs.default.writeFile(
    pathM.default.join(claudeDir, 'settings.json'),
    JSON.stringify(minimalSettings, null, 2),
    'utf8'
  );
}

/**
 * Create a minimal `$HOME/.codex/` directory for the spawned Codex CLI.
 *
 * Same rationale as scaffoldMinimalClaudeDir: the real `~/.codex/config.toml`
 * may contain `[mcp_servers]` entries (e.g., PostHog) that trigger browser-based
 * OAuth during init.  We copy only auth credentials and write a clean config
 * that preserves the model/personality but strips MCP servers.
 */
async function scaffoldMinimalCodexDir(tmpDir, realHome) {
  const fs = await import('fs/promises');
  const pathM = await import('path');

  const codexDir = pathM.default.join(tmpDir, '.codex');
  await fs.default.mkdir(codexDir, { recursive: true });

  // Copy auth.json (API auth tokens)
  const authSrc = pathM.default.join(realHome, '.codex', 'auth.json');
  const authDest = pathM.default.join(codexDir, 'auth.json');
  try {
    await fs.default.copyFile(authSrc, authDest);
  } catch {
    // No auth file — CLI will use OPENAI_API_KEY env var
  }

  // Read the real config.toml, strip [mcp_servers.*] sections, write a clean copy.
  const configSrc = pathM.default.join(realHome, '.codex', 'config.toml');
  try {
    const raw = await fs.default.readFile(configSrc, 'utf8');
    const cleaned = stripTomlMcpServers(raw);
    await fs.default.writeFile(
      pathM.default.join(codexDir, 'config.toml'),
      cleaned,
      'utf8'
    );
  } catch {
    // No config — CLI uses defaults
  }
}

/**
 * Create a minimal `$HOME/.gemini/` directory for the spawned Gemini CLI.
 *
 * Same rationale as scaffoldMinimalClaudeDir: copy only auth credentials
 * and write a clean settings.json to avoid sandbox/TCC issues.
 */
async function scaffoldMinimalGeminiDir(tmpDir, realHome) {
  const fs = await import('fs/promises');
  const pathM = await import('path');

  const geminiDir = pathM.default.join(tmpDir, '.gemini');
  await fs.default.mkdir(geminiDir, { recursive: true });

  // Copy OAuth credentials
  for (const name of ['oauth_creds.json', 'google_accounts.json', 'installation_id']) {
    const src = pathM.default.join(realHome, '.gemini', name);
    const dest = pathM.default.join(geminiDir, name);
    try {
      await fs.default.copyFile(src, dest);
    } catch {
      // File doesn't exist — skip
    }
  }

  // Copy settings.json (contains model preferences)
  const settingsSrc = pathM.default.join(realHome, '.gemini', 'settings.json');
  const settingsDest = pathM.default.join(geminiDir, 'settings.json');
  try {
    await fs.default.copyFile(settingsSrc, settingsDest);
  } catch {
    // No settings — CLI uses defaults
  }
}

/**
 * Remove `[mcp_servers.*]` table blocks from a TOML string.
 * Scans line-by-line: when a `[mcp_servers.xxx]` header is found, all
 * subsequent lines are skipped until the next top-level `[section]` header.
 */
function stripTomlMcpServers(toml) {
  const lines = toml.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    // Detect any table header: [something] or [something.something]
    if (/^\[.+\]$/.test(trimmed)) {
      if (/^\[mcp_servers(?:\..*)?\]$/i.test(trimmed)) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * Read `~/.claude.json`, strip all MCP server definitions (global + per-project),
 * and write the sanitized version into the isolated HOME directory.
 *
 * `.claude.json` contains project-specific `mcpServers` (e.g. Playwright, PostHog)
 * that would cause the spawned CLI to attempt MCP server connections — hanging or
 * crashing the review process.  We preserve everything else (auth, settings, etc.).
 */
async function sanitizeClaudeJsonForIsolation(tmpDir, realHome) {
  const fs = await import('fs/promises');
  const pathM = await import('path');

  const src = pathM.default.join(realHome, '.claude.json');
  const dest = pathM.default.join(tmpDir, '.claude.json');
  let raw;
  try {
    raw = await fs.default.readFile(src, 'utf8');
  } catch {
    return; // File doesn't exist — nothing to copy
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Malformed JSON — copy as-is rather than lose auth data
    await fs.default.writeFile(dest, raw, 'utf8');
    return;
  }

  // Strip global mcpServers
  delete data.mcpServers;

  // Strip per-project mcpServers
  if (data.projects && typeof data.projects === 'object') {
    for (const projectKey of Object.keys(data.projects)) {
      const proj = data.projects[projectKey];
      if (proj && typeof proj === 'object') {
        delete proj.mcpServers;
      }
    }
  }

  await fs.default.writeFile(dest, JSON.stringify(data), 'utf8');
}

const AGENT_HOME_TCC_BLOCKED_RELATIVE_PATHS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Music',
  'Pictures',
  'Movies',
  'Library/Mobile Documents', // iCloud Drive
  'Library/CloudStorage',     // Cloud provider mounts
];

function isPathWithinDirectory(parentPath, targetPath) {
  const parent = pathResolve(parentPath);
  const target = pathResolve(targetPath);
  return target === parent || target.startsWith(parent + pathSep);
}

function isProtectedHomeTarget(realHome, resolvedTargetPath) {
  const home = pathResolve(realHome);
  const target = pathResolve(resolvedTargetPath);
  // Any target outside HOME is considered unsafe for isolated HOME symlinks.
  if (!isPathWithinDirectory(home, target)) return true;
  for (const relativePath of AGENT_HOME_TCC_BLOCKED_RELATIVE_PATHS) {
    const blockedRoot = pathResolve(home, relativePath);
    if (isPathWithinDirectory(blockedRoot, target)) {
      return true;
    }
  }
  return false;
}

/**
 * Create a temporary HOME directory containing only symlinks to essential
 * dotfiles. TCC-protected directories (Desktop, Documents, Downloads, Music,
 * Pictures, Movies) are never created, so the spawned CLI process never probes
 * them and macOS never fires a TCC consent dialog.
 *
 * @returns {Promise<{ home: string, env: Record<string, string>, cleanup: () => Promise<void> }>}
 */
async function createIsolatedAgentHome() {
  const fs = await import('fs/promises');
  const pathM = await import('path');
  const os = await import('os');

  const realHome = os.default.homedir();
  const cacheRoot = process.env.ATLAS_AGENT_HOME_ROOT
    ? pathM.default.resolve(process.env.ATLAS_AGENT_HOME_ROOT)
    : pathM.default.join(realHome, '.cache', 'atlas');
  let tmpDir;
  try {
    await fs.default.mkdir(cacheRoot, { recursive: true });
    tmpDir = await fs.default.mkdtemp(pathM.default.join(cacheRoot, 'atlas-agent-home-'));
  } catch {
    tmpDir = await fs.default.mkdtemp(
      pathM.default.join(os.default.tmpdir(), 'atlas-agent-home-')
    );
  }

  for (const name of AGENT_HOME_SYMLINK_TARGETS) {
    const src = pathM.default.join(realHome, name);
    const dest = pathM.default.join(tmpDir, name);
    try {
      const srcLstat = await fs.default.lstat(src);
      const resolvedTarget = await fs.default.realpath(src);
      if (isProtectedHomeTarget(realHome, resolvedTarget)) {
        continue;
      }
      // For nested paths (e.g. Library/Keychains), create parent dirs first
      const parentDir = pathM.default.dirname(dest);
      if (parentDir !== tmpDir) {
        await fs.default.mkdir(parentDir, { recursive: true });
      }
      const symlinkType = srcLstat.isDirectory() ? 'dir' : 'file';
      await fs.default.symlink(src, dest, symlinkType);
    } catch {
      // Source doesn't exist — skip silently
    }
  }

  // Copy files that the CLI atomically replaces (write-tmp + rename).
  // Symlinking these would break: the rename destroys the symlink and writes
  // a regular file, leaving subsequent reads pointing at stale temp-dir data.
  for (const name of AGENT_HOME_COPY_TARGETS) {
    const src = pathM.default.join(realHome, name);
    const dest = pathM.default.join(tmpDir, name);
    try {
      await fs.default.copyFile(src, dest);
    } catch {
      // Source doesn't exist — skip silently
    }
  }

  // Scaffold minimal CLI config directories with only API credentials.
  // We do NOT symlink the real ~/.claude or ~/.codex because they contain
  // MCP plugins, OAuth tokens for external services, and session data
  // that can cause the spawned CLI to hang or crash during initialization.
  await scaffoldMinimalClaudeDir(tmpDir, realHome);
  await scaffoldMinimalCodexDir(tmpDir, realHome);
  await scaffoldMinimalGeminiDir(tmpDir, realHome);

  // Sanitize .claude.json: strip MCP servers (global + per-project) to prevent
  // the spawned CLI from initializing Playwright, PostHog, etc.
  await sanitizeClaudeJsonForIsolation(tmpDir, realHome);

  // Ensure XDG defaults exist in the isolated HOME for tools that expect them.
  const seedDirectories = [
    pathM.default.join(tmpDir, '.config'),
    pathM.default.join(tmpDir, '.cache'),
    pathM.default.join(tmpDir, '.local'),
    pathM.default.join(tmpDir, '.local', 'share'),
    pathM.default.join(tmpDir, '.local', 'state'),
  ];
  for (const directory of seedDirectories) {
    try {
      await fs.default.lstat(directory);
      continue;
    } catch {
      // Missing path; create below.
    }
    try {
      await fs.default.mkdir(directory, { recursive: true });
    } catch {
      // Best-effort seeding
    }
  }

  return {
    home: tmpDir,
    env: buildIsolatedHomeEnv(tmpDir),
    cleanup: async () => {
      try {
        await fs.default.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

/**
 * Generate a macOS sandbox-exec profile that blocks file access to TCC-protected
 * directories (Documents, Desktop, Downloads, etc.) while allowing everything else.
 *
 * Design: allowlist-based sandboxing (import "system.sb" + explicit allows) is
 * impractical because the Claude CLI needs Mach IPC, IOKit, sysctl, and many
 * home-directory config files at runtime — impossible to enumerate.  Instead we
 * use `(allow default)` + deny rules on the specific directories that trigger
 * macOS TCC permission popups.  Layer 2 (stream-based path enforcement) provides
 * the fine-grained project-scope restriction.
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @param {string} _binaryPath - (unused, kept for API compat) CLI binary path
 * @returns {Promise<string>} Path to the temporary .sb profile file
 */
async function generateSandboxProfile(projectPath, _binaryPath) {
  const pathM = await import('path');
  const fs = await import('fs/promises');
  const os = await import('os');

  const homedir = os.default.homedir();

  // TCC-protected directories that trigger macOS permission popups.
  // The project directory is excluded from deny rules in case it lives
  // under one of these (e.g., ~/Documents/projects/my-app).
  const resolvedProject = pathM.default.resolve(projectPath);
  const tccDirs = ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music'];
  const denyLines = [];
  for (const dir of tccDirs) {
    const fullPath = pathM.default.join(homedir, dir);
    // Don't block access if the project itself lives under this directory
    if (resolvedProject.startsWith(fullPath + pathM.default.sep) || resolvedProject === fullPath) {
      continue;
    }
    denyLines.push(`(deny file-read* (subpath "${fullPath}"))`);
    denyLines.push(`(deny file-write* (subpath "${fullPath}"))`);
  }

  const profile = `(version 1)
(allow default)

;; Block access to TCC-protected user directories that trigger permission popups.
;; Everything else is allowed — Layer 2 (stream-based path enforcement) handles
;; fine-grained project-scope restriction at the tool_use event level.
${denyLines.join('\n')}
`;

  const tmpDir = await fs.default.mkdtemp(pathM.default.join(os.default.tmpdir(), 'atlas-sandbox-'));
  const profilePath = pathM.default.join(tmpDir, 'review.sb');
  await fs.default.writeFile(profilePath, profile, 'utf8');
  return profilePath;
}

/**
 * Map provider type to stable CLI labels and login commands.
 */
function getCliProviderLabel(providerType) {
  if (providerType === 'anthropic') return 'Claude';
  if (providerType === 'openai') return 'Codex';
  if (providerType === 'google') return 'Gemini';
  if (providerType === 'opencode') return 'OpenCode';
  return 'CLI';
}

function getCliLoginCommand(providerType) {
  if (providerType === 'anthropic') return 'claude login';
  if (providerType === 'openai') return 'codex login';
  if (providerType === 'google') return 'gemini auth login';
  if (providerType === 'opencode') return 'opencode auth';
  return 'login';
}

// Bun-compiled CLIs (recent Claude Code builds ship as a Bun binary) print a
// runtime warning to stderr on CPUs without AVX:
//   "warn: CPU lacks AVX support, strange crashes may occur. Reinstall Bun or
//    use *-baseline build: https://github.com/oven-sh/bun/releases/..."
// followed by the wrapped URL on its own line. That noise gets prepended to
// every surfaced CLI error (e.g. "Claude CLI-agent error: warn: CPU lacks
// AVX...") which buries the real cause — and when the CLI then fails, the
// unstable Bun runtime is usually the actual reason. Strip the noise lines
// before surfacing, and remember whether the AVX warning was present so we can
// attach an actionable hint.
const BUN_AVX_WARNING_RE = /^[ \t]*warn:[ \t]*CPU lacks AVX support[^\n]*$/im;
const CLI_RUNTIME_NOISE_LINE_RES = [
  BUN_AVX_WARNING_RE,
  /^[ \t]*https?:\/\/github\.com\/oven-sh\/bun\/releases\/[^\n]*$/im,
];

function detectCliRuntimeNoise(text) {
  return { bunLacksAvx: BUN_AVX_WARNING_RE.test(String(text || '')) };
}

function stripCliRuntimeNoise(text) {
  let raw = String(text || '');
  for (const re of CLI_RUNTIME_NOISE_LINE_RES) {
    raw = raw.replace(new RegExp(re.source, 'gim'), '');
  }
  return raw.replace(/\n{3,}/g, '\n\n').trim();
}

function describeCliRuntimeNoiseHint(providerType, noise) {
  if (!noise || !noise.bunLacksAvx) return null;
  const cli = providerType === 'anthropic' ? 'claude'
    : providerType === 'openai' ? 'codex'
      : providerType === 'google' ? 'gemini'
        : providerType === 'opencode' ? 'opencode'
          : 'the AI';
  return `The \`${cli}\` CLI is running on a Bun build that is unstable on this CPU (no AVX support) — reinstall the CLI (or use a "*-baseline" Bun build). This is the likely cause of the failure.`;
}

// Build the trailing detail for a "<CLI> error: <detail>" message: strip the
// Bun/no-AVX noise from stderr, fall back to stdout when stderr was only noise,
// and append the runtime hint when the AVX warning was present.
function formatCliErrorDetail(providerType, err, out = '', { maxLen = 300 } = {}) {
  const noise = detectCliRuntimeNoise(err);
  const cleanedErr = stripCliRuntimeNoise(err).slice(-maxLen).trim();
  const detail = cleanedErr || String(out || '').trim().slice(-maxLen);
  const hint = describeCliRuntimeNoiseHint(providerType, noise);
  if (!detail) return hint || '';
  if (!hint) return detail;
  // Avoid "…settings.. The claude CLI…" when detail already ends with a period.
  return `${detail.replace(/[.\s]+$/, '')}. ${hint}`;
}

function getCliQuotaGuidance(providerType) {
  if (providerType === 'anthropic') {
    return 'Check Claude credits or Anthropic Console billing, then retry.';
  }
  if (providerType === 'google') {
    return 'Check Google AI Studio quota/billing, then retry.';
  }
  if (providerType === 'openai') {
    return 'Check OpenAI API billing/credits, then retry.';
  }
  return 'Check provider credits/quota, then retry.';
}

function isCliRateLimitText(lower) {
  return (
    lower.includes('429')
    || lower.includes('rate limit')
    || lower.includes('too many requests')
    || lower.includes('requests per minute')
    || lower.includes('tokens per minute')
  );
}

// Recognise authentication failures from CLI error text. This covers both the
// "not logged in / run login" family and provider-API rejections like
// Anthropic's `authentication_error` ("Invalid authentication credentials",
// "invalid x-api-key") which the CLI prints back verbatim as JSON.
function isCliAuthErrorText(lower) {
  return (
    lower.includes('not authenticated')
    || lower.includes('not logged in')
    || lower.includes('authentication failed')
    || lower.includes('authentication_error')
    || lower.includes('invalid authentication credentials')
    || lower.includes('invalid x-api-key')
    || lower.includes('invalid bearer token')
    || lower.includes('invalid api key')
    || lower.includes('oauth token has expired')
    || lower.includes('please log in')
    || lower.includes('please login')
    || lower.includes('please run /login')
    || lower.includes('please run `claude login`')
    || lower.includes('please run `codex login`')
    // Keep HTTP-401 phrasings but not a bare `unauthorized` substring: this text
    // is sometimes the full CLI output / extracted review text, and an
    // "unauthorized" mention in a diff or code snippet would otherwise be
    // misclassified as an auth failure (see CLAUDE.md — "CLI error
    // classification must use stderr-tail, not full output").
    || lower.includes('401 unauthorized')
    || lower.includes('http 401')
    || lower.includes('error 401')
    || lower.includes('status 401')
  );
}

function isCliQuotaOrBillingText(lower) {
  return (
    lower.includes('credit balance')
    || lower.includes('insufficient credits')
    || lower.includes('credits exhausted')
    || lower.includes('out of credits')
    || lower.includes('no credits')
    || lower.includes('creditserror')
    || lower.includes('quota exceeded')
    || lower.includes('insufficient quota')
    || lower.includes('billing')
    || lower.includes('payment required')
    || lower.includes('no payment method')
    || lower.includes('purchase credits')
  );
}

function extractCliJsonErrorText(rawText) {
  const raw = String(rawText || '');
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(line);
      // Anthropic-style API error envelope surfaced verbatim by the CLI:
      //   { "type": "error", "error": { "type": "authentication_error",
      //     "message": "Invalid authentication credentials" }, "request_id": "..." }
      // Here `error` is an object, not a string, so the string-candidate scan
      // below misses it entirely — pull the inner type/message out explicitly.
      if (
        parsed?.error
        && typeof parsed.error === 'object'
        && !Array.isArray(parsed.error)
        && typeof parsed.error.message === 'string'
        && parsed.error.message.trim()
      ) {
        const innerType = typeof parsed.error.type === 'string' ? parsed.error.type.trim() : '';
        const innerMessage = parsed.error.message.trim();
        return innerType ? `${innerType}: ${innerMessage}` : innerMessage;
      }
      for (const candidate of [parsed?.error, parsed?.message]) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        const lowerCandidate = candidate.toLowerCase();
        if (
          isCliQuotaOrBillingText(lowerCandidate)
          || isCliRateLimitText(lowerCandidate)
          || isCliAuthErrorText(lowerCandidate)
          || lowerCandidate.includes('model not found')
          || lowerCandidate.includes('model is not enabled')
          || lowerCandidate.includes('request was rejected')
        ) {
          return candidate.trim();
        }
      }
      if (
        typeof parsed?.result === 'string'
        && parsed.result.trim()
        && (
          parsed.is_error === true
          || String(parsed.subtype || '').toLowerCase().includes('error')
          || isCliQuotaOrBillingText(parsed.result.toLowerCase())
          || isCliRateLimitText(parsed.result.toLowerCase())
        )
      ) {
        return parsed.result.trim();
      }
    } catch {
      // Continue scanning older JSONL lines.
    }
  }
  return '';
}

function hasCliSystemInitTelemetry(rawText) {
  const raw = String(rawText || '');
  if (!raw.trim()) return false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed?.type === 'system'
        && String(parsed?.subtype || '').toLowerCase() === 'init'
      ) {
        return true;
      }
    } catch {
      // Continue scanning later JSONL lines.
    }
  }
  return false;
}

function classifyCliRuntimeTextError(providerType, text) {
  const providerLabel = getCliProviderLabel(providerType);
  const loginCmd = getCliLoginCommand(providerType);
  const raw = String(text || '').trim();
  if (!raw) {
    return createReviewRuntimeError(
      `${providerLabel} CLI returned an empty response.`,
      'invalid_request'
    );
  }

  const extractedJsonErrorText = extractCliJsonErrorText(raw);
  const textForClassification = extractedJsonErrorText || raw;
  const lower = textForClassification.toLowerCase();
  // A valid review response must be a JSON object with at least a summary or recommendations field.
  // Minimal JSON like `{}` or `[]` should NOT be treated as a successful review.
  const hasReviewFields = lower.includes('"summary"') || lower.includes('"recommendations"')
    || lower.includes('"candidatefindings"')
    || lower.includes('"changegroups"') || lower.includes('"risklevel"');
  const likelyJsonPayload = (raw.startsWith('{') || raw.startsWith('[')) && hasReviewFields;
  if (likelyJsonPayload) {
    return null;
  }

  if (isCliRateLimitText(lower)) {
    return createReviewRuntimeError(
      `${providerLabel} CLI rate limit reached. Retry in a moment.`,
      'rate_limit'
    );
  }

  if (isCliQuotaOrBillingText(lower)) {
    return createReviewRuntimeError(
      `${providerLabel} CLI credits or quota are exhausted. ${getCliQuotaGuidance(providerType)}`,
      'quota'
    );
  }

  // Reject JSON-like output that lacks review fields and did not expose a
  // known provider error above.
  if ((raw.startsWith('{') || raw.startsWith('[')) && !hasReviewFields && !extractedJsonErrorText) {
    return createReviewRuntimeError(
      `${providerLabel} CLI returned a JSON response without review content (missing summary/recommendations). Raw: ${raw.slice(0, 200)}`,
      'invalid_request'
    );
  }

  if (isCliAuthErrorText(lower)) {
    return createReviewRuntimeError(
      `${providerLabel} CLI authentication failed. Re-run \`${loginCmd}\` (or update the API key in provider settings), then retry.`,
      'auth'
    );
  }

  if (
    lower.includes('no git repository')
    || lower.includes('not a git repository')
    || lower.includes('not inside a git repository')
    || lower.includes('no git repo')
    || lower.includes('cannot compute requested sha diff')
    || lower.includes('unknown revision or path not in the working tree')
    || lower.includes('bad revision')
  ) {
    return createReviewRuntimeError(
      `${providerLabel} CLI could not resolve git history for this review. Ensure the project path is a valid git repository and the base/head refs exist.`,
      'invalid_request'
    );
  }

  if (
    lower.includes('shell access denied by sandbox')
    || lower.includes('access denied by sandbox')
  ) {
    return createReviewRuntimeError(
      `${providerLabel} CLI was blocked by sandbox restrictions. Verify CLI sandbox settings for agentic review.`,
      'invalid_request'
    );
  }

  if (
    lower.includes('invalid model')
    || lower.includes('model not found')
    || lower.includes('unsupported model')
    || lower.includes('model is not supported')
    || lower.includes('selected model is not enabled')
    || lower.includes('model is not enabled')
    || lower.includes('not enabled for this account')
    || lower.includes('no last agent message')
    || lower.includes('wrote empty content')
  ) {
    return createReviewRuntimeError(
      `${providerLabel} CLI request was rejected: ${textForClassification.slice(0, 220)}`,
      'model_unavailable'
    );
  }

  if (
    lower.includes('provider request was rejected')
    || lower.includes('request was rejected')
  ) {
    return createReviewRuntimeError(
      `${providerLabel} CLI request was rejected: ${textForClassification.slice(0, 220)}`,
      'invalid_request'
    );
  }

  if (extractedJsonErrorText) {
    return createReviewRuntimeError(
      `${providerLabel} CLI request was rejected: ${textForClassification.slice(0, 220)}`,
      'invalid_request'
    );
  }

  return null;
}

/**
 * Scan raw JSONL stdout for a result event with subtype "error_max_turns".
 * Returns { numTurns } if found, or null otherwise.
 * Only scans the last ~2 KB of stdout for performance (the result event is
 * always the final line).
 */
function detectMaxTurnsExhausted(rawStdout) {
  const raw = String(rawStdout || '');
  if (!raw) return null;
  // Only scan the tail — the result event is always the last JSONL line.
  const tail = raw.slice(-2048);
  for (const line of tail.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (
      parsed?.type === 'result'
      && String(parsed?.subtype || '').toLowerCase() === 'error_max_turns'
    ) {
      return { numTurns: parsed.num_turns || parsed.numTurns || '?' };
    }
  }
  return null;
}

function normalizeCliTokenUsage(rawUsage) {
  if (rawUsage == null) return null;
  if (typeof rawUsage === 'number') {
    return { input: 0, output: Math.max(0, rawUsage) };
  }
  if (typeof rawUsage !== 'object' || Array.isArray(rawUsage)) {
    return null;
  }

  // Anthropic's prompt-caching API reports input across three fields:
  // - input_tokens                  (fresh, uncached input — often tiny)
  // - cache_creation_input_tokens   (input written to cache this turn)
  // - cache_read_input_tokens       (input read from cache this turn — bulk)
  // The "true" input the model billed for is the SUM. Reading only
  // input_tokens (as Anthropic's docs default) under-reports input
  // by 100-1000x for agentic Claude Code runs (e.g. "6 in" when the
  // real value was ~50,000 in). Sum all three.
  const baseInput = Number(
    rawUsage.input_tokens
    ?? rawUsage.inputTokens
    ?? rawUsage.prompt_tokens
    ?? rawUsage.promptTokens
    ?? rawUsage.input
  );
  const cacheCreate = Number(
    rawUsage.cache_creation_input_tokens
    ?? rawUsage.cacheCreationInputTokens
    ?? 0
  );
  const cacheRead = Number(
    rawUsage.cache_read_input_tokens
    ?? rawUsage.cacheReadInputTokens
    ?? 0
  );
  const input = (Number.isFinite(baseInput) ? baseInput : 0)
    + (Number.isFinite(cacheCreate) ? cacheCreate : 0)
    + (Number.isFinite(cacheRead) ? cacheRead : 0);
  const output = Number(
    rawUsage.output_tokens
    ?? rawUsage.outputTokens
    ?? rawUsage.completion_tokens
    ?? rawUsage.completionTokens
    ?? rawUsage.output
  );

  // Treat the usage as "absent" only when nothing parsable came in
  // for either side. (baseInput alone might be NaN while cache_read
  // contributes a real input value — that's the point of summing.)
  if (!Number.isFinite(baseInput) && !Number.isFinite(output) && cacheCreate === 0 && cacheRead === 0) {
    return null;
  }

  return {
    input: Math.max(0, input),
    output: Number.isFinite(output) ? Math.max(0, output) : 0,
  };
}

function normalizeCliCostUsd(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function extractClaudeCliPipeResultMeta(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tokensUsed: { input: 0, output: 0 }, costUsd: null };
  }
  const tokensUsed = normalizeCliTokenUsage(
    parsed.usage
    ?? parsed.stats
    ?? parsed.message?.usage
    ?? parsed.response?.usage
  ) || { input: 0, output: 0 };
  const costUsd = normalizeCliCostUsd(
    parsed.cost_usd
    ?? parsed.costUsd
    ?? parsed.total_cost_usd
    ?? parsed.totalCostUsd
    ?? parsed.total_cost
    ?? parsed.cost?.usd
    ?? parsed.totalCost?.usd
  );

  return { tokensUsed, costUsd };
}

/**
 * Extract metadata from CLI JSONL stdout.
 * Works for both success and error_max_turns subtypes.
 * When a provider omits the final result event but review text was still recovered
 * from streamed assistant output, callers can opt into treating that as success.
 * Returns { subtype, numTurns, costUsd, tokensUsed } or null if no useful signal is found.
 */
function extractAgenticResultMeta(rawStdout, options = {}) {
  const raw = String(rawStdout || '');
  if (!raw) return null;
  const recoveredText = String(options?.recoveredText || '').trim();
  let resultMeta = null;
  let summedTurnUsage = { input: 0, output: 0 };
  let sawTurnUsage = false;
  let turnCount = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (parsed?.type === 'turn.completed') {
      const turnUsage = normalizeCliTokenUsage(parsed.usage ?? parsed.stats);
      turnCount += 1;
      if (turnUsage) {
        summedTurnUsage.input += turnUsage.input;
        summedTurnUsage.output += turnUsage.output;
        sawTurnUsage = true;
      }
      continue;
    }
    // Claude/Anthropic stream-json does not emit `turn.completed`; usage
    // arrives on each `assistant` event under `message.usage`. Sum those
    // so we don't have to rely on the final `result` event (which on
    // Claude reports last-turn usage only, not cumulative — leading to
    // displays like "12 in · 13,268 out" where "12 in" was just the
    // final wrap-up turn).
    if (parsed?.type === 'assistant' && parsed?.message?.usage) {
      const turnUsage = normalizeCliTokenUsage(parsed.message.usage);
      turnCount += 1;
      if (turnUsage) {
        summedTurnUsage.input += turnUsage.input;
        summedTurnUsage.output += turnUsage.output;
        sawTurnUsage = true;
      }
      continue;
    }
    if (parsed?.type === 'result') {
      resultMeta = {
        subtype: String(parsed.subtype || 'unknown').toLowerCase(),
        numTurns: parsed.num_turns ?? parsed.numTurns ?? null,
        costUsd: typeof parsed.cost_usd === 'number' ? parsed.cost_usd : null,
        tokensUsed: normalizeCliTokenUsage(parsed.usage ?? parsed.stats),
      };
    }
  }

  if (!resultMeta && !sawTurnUsage) {
    return null;
  }

  if (!resultMeta) {
    resultMeta = {
      subtype: recoveredText ? 'success' : 'unknown',
      numTurns: turnCount || null,
      costUsd: null,
      tokensUsed: null,
    };
  }

  // Reconcile per-axis: take the larger of summed-per-turn vs the result
  // event's reported usage for input and output independently. Claude
  // splits its usage signal awkwardly — the result event reports only
  // last-turn input (often tiny because of caching) while the streamed
  // assistant events sometimes miss the final text turn's output. Taking
  // max(summed, result) per axis recovers the truthful number from
  // whichever side has it. Codex/Gemini give cumulative totals on the
  // result event so result wins both axes for them.
  if (sawTurnUsage) {
    if (!resultMeta.tokensUsed) {
      resultMeta.tokensUsed = summedTurnUsage;
    } else {
      resultMeta.tokensUsed = {
        input: Math.max(resultMeta.tokensUsed.input || 0, summedTurnUsage.input),
        output: Math.max(resultMeta.tokensUsed.output || 0, summedTurnUsage.output),
      };
    }
  }

  // Prefer the streaming-counted turn count (one per `assistant` /
  // `turn.completed` event) over the CLI's `result.num_turns`. Claude
  // historically reports num_turns as a message-pair count that disagrees
  // with our maxTurns budget, producing displays like "11 of 7". Counting
  // assistant events ourselves keeps actualTurns and maxTurns on the
  // same scale.
  if (turnCount > 0) {
    resultMeta.numTurns = turnCount;
  }

  return resultMeta;
}

function classifyCliAgenticExitError(providerType, code, err, out) {
  const stderrLower = String(err || '').toLowerCase();
  if (isCliRateLimitText(stderrLower)) {
    return createReviewRuntimeError(
      `${getCliProviderLabel(providerType)} CLI rate limit reached. Retry in a moment.`,
      'rate_limit'
    );
  }
  if (isCliQuotaOrBillingText(stderrLower)) {
    return createReviewRuntimeError(
      `${getCliProviderLabel(providerType)} CLI credits or quota are exhausted. ${getCliQuotaGuidance(providerType)}`,
      'quota'
    );
  }

  const adapter = getAdapterForProvider(providerType);
  if (adapter && typeof adapter.extractReviewText === 'function') {
    try {
      const extracted = adapter.extractReviewText(String(out || ''));
      if (String(extracted || '').trim()) {
        const runtimeTextError = classifyCliRuntimeTextError(providerType, extracted);
        if (runtimeTextError) {
          return runtimeTextError;
        }
      } else if (String(out || '').trim()) {
        console.debug(
          `[ReviewProviderExecution] ${providerType} CLI output extraction returned empty text; falling back to stderr/stdout-tail error heuristics`
        );
      }
    } catch {
      // Fall back to stderr/stdout tail heuristics below.
    }
  }

  const jsonErrorText = extractCliJsonErrorText(`${err || ''}\n${out || ''}`);
  if (jsonErrorText) {
    const runtimeTextError = classifyCliRuntimeTextError(providerType, jsonErrorText);
    if (runtimeTextError) return runtimeTextError;
  }

  const errTail = String(err || '').slice(-500).toLowerCase();
  // Some CLIs (e.g. OpenCode) emit errors as JSONL to stdout, not stderr.
  // Check both streams for error classification.
  const outTail = String(out || '').slice(-500).toLowerCase();
  const combined = `${String(err || '').slice(-10000)} ${String(out || '').slice(-10000)}`.toLowerCase();
  const providerLabel = getCliProviderLabel(providerType);
  const loginCmd = getCliLoginCommand(providerType);
  if (
    combined.includes('not authenticated')
    || combined.includes('not logged in')
    || combined.includes('authentication failed')
    || combined.includes('please log in')
    || combined.includes('please login')
    || combined.includes('please run /login')
    || combined.includes('unauthorized')
    || (combined.includes('error') && combined.includes('auth'))
  ) {
    return createReviewRuntimeError(
      `${providerLabel} CLI authentication failed. Please run \`${loginCmd}\` to re-authenticate.`,
      'auth'
    );
  }

  if (isCliRateLimitText(combined)) {
    return createReviewRuntimeError(
      `${providerLabel} CLI rate limit reached. Retry in a moment.`,
      'rate_limit'
    );
  }

  if (isCliQuotaOrBillingText(combined)) {
    return createReviewRuntimeError(
      `${providerLabel} CLI credits or quota are exhausted. ${getCliQuotaGuidance(providerType)}`,
      'quota'
    );
  }

  if (providerType === 'openai' && errTail.includes('reasoning.effort') && errTail.includes('unsupported_value')) {
    return createReviewRuntimeError(
      'Codex CLI rejected reasoning effort from local config. Use low/medium/high (or set ATLAS_CODEX_REASONING_EFFORT).',
      'invalid_request'
    );
  }

  if (
    combined.includes('selected model is not enabled')
    || combined.includes('model is not enabled')
    || combined.includes('not enabled for this account')
    || combined.includes('model not found')
    || combined.includes('invalid model')
    || combined.includes('unsupported model')
    || combined.includes('model is not supported')
    || combined.includes('no last agent message')
    || combined.includes('wrote empty content')
  ) {
    return createReviewRuntimeError(
      `${providerLabel} CLI request was rejected: ${formatCliErrorDetail(providerType, err, out)}`,
      'model_unavailable'
    );
  }

  if (
    combined.includes('too long')
    || combined.includes('too large')
    || combined.includes('context window')
    || combined.includes('context length')
    || combined.includes('ran out of room')
  ) {
    return createReviewRuntimeError(
      'Context limit reached during agentic review.',
      'context_limit'
    );
  }

  if (!String(err || '').trim() && hasCliSystemInitTelemetry(out)) {
    return createReviewRuntimeError(
      `${providerLabel} CLI started but exited before returning a review. Check ${providerType === 'anthropic' ? 'Claude credits/billing or run `claude doctor`' : 'provider CLI health/auth'} and retry.`,
      'invalid_request'
    );
  }

  return createReviewRuntimeError(
    `${providerLabel} CLI-agentic error (exit ${code}): ${formatCliErrorDetail(providerType, err, out)}`,
    'invalid_request'
  );
}

function shouldDetachCliSubprocess() {
  return process.platform !== 'win32';
}

/** Kill a child process tree.
 *  - Windows: taskkill /T avoids detached child consoles while still terminating descendants.
 *  - POSIX detached children: kill the process group via -pid.
 *  Falls back to child.kill() if tree termination fails. */
function killProcessGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch {
      try { child.kill(signal); } catch { /* already dead */ }
      return;
    }
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already dead */ }
  }
}

// timeoutMs is retained for positional-arg compatibility with existing callers
// (callClaudeCliAgentic, callCodexCliAgentic, callOpenCodeCliAgentic, etc.) but
// is no longer consulted: liveness/ceiling are read directly from
// CLI_AGENTIC_LIVENESS_THRESHOLD_MS and CLI_AGENTIC_ABSOLUTE_CEILING_MS in
// reviewConstants.js. Adjust those env vars to change termination behavior.
/**
 * Section R Phase B: assemble the per-review runtime MCP server config
 * from `requestContext`. Returns null when runtime MCP is not enabled for
 * this call (Balanced reviews, missing SHAs, non-Anthropic providers, or
 * no project path) so the spawn args remain byte-equivalent to pre-Phase-B.
 *
 * Adapter remains responsible for translating this config into the actual
 * --mcp-config flag. This helper just resolves the bin path and validates
 * that all required pieces are present.
 *
 * @param {Object|null} requestContext
 * @param {string|null} projectPath
 * @returns {{binPath: string, projectRoot: string, mergeBaseSha: string, headSha: string}|null}
 */
function buildRuntimeMcpInvocationConfig(requestContext, projectPath) {
  if (!requestContext || requestContext.runtimeMcpEnabled !== true) return null;
  if (!projectPath || typeof projectPath !== 'string') return null;
  const mergeBaseSha = typeof requestContext.mergeBaseSha === 'string' ? requestContext.mergeBaseSha.trim() : '';
  const headSha = typeof requestContext.headSha === 'string' ? requestContext.headSha.trim() : '';
  if (!mergeBaseSha || !headSha) return null;
  // Resolve the bin path off this module's location so it works whether the
  // backend is invoked from the dev server, the desktop bundle, or a CI
  // worktree without depending on a hardcoded absolute path.
  const here = fileURLToPath(import.meta.url);
  const binPath = path.resolve(path.dirname(here), 'runtimeMcp', 'bin.js');
  return { binPath, projectRoot: projectPath, mergeBaseSha, headSha };
}

/**
 * CodeGraph experiment: assemble the per-review CodeGraph MCP server
 * config from `requestContext`. Returns null unless `codegraphMcpEnabled`
 * is true on the request context — that flag is computed in
 * reviewService.js using the I1 gate (toggle ON + ready index +
 * worktree_sha === reviewHeadSha), so by the time we land here, every
 * precondition is already satisfied.
 *
 * The adapter is responsible for spawning `codegraph serve --mcp` with
 * `cwd: projectRoot`; this helper just provides projectRoot (and an
 * optional bin override).
 *
 * @param {Object|null} requestContext
 * @param {string|null} projectPath
 * @returns {{ projectRoot: string, binPath?: string }|null}
 */
function buildCodegraphMcpInvocationConfig(requestContext, projectPath) {
  if (!requestContext || requestContext.codegraphMcpEnabled !== true) return null;
  if (!projectPath || typeof projectPath !== 'string') return null;
  const binPath = process.env.ATLAS_CODEGRAPH_BIN || undefined;
  return { projectRoot: projectPath, binPath };
}

async function callCliAgentic(
  providerType,
  prompt,
  model,
  _timeoutMsUnused = PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null,
  { onToolUse = null } = {}
) {
  // Loud warning: if a caller still passes a non-default timeoutMs assuming
  // it gates the per-shard budget, surface that loudly so the contract drift
  // is visible instead of silently overshooting their intended limit.
  if (
    Number.isFinite(_timeoutMsUnused)
    && _timeoutMsUnused !== PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS
    && !callCliAgentic._timeoutMsWarned
  ) {
    callCliAgentic._timeoutMsWarned = true;
    console.warn(
      '[callCliAgentic] timeoutMs is no longer honored; CLI_AGENTIC_LIVENESS_THRESHOLD_MS and CLI_AGENTIC_ABSOLUTE_CEILING_MS in reviewConstants.js are the operative controls. Caller passed:',
      _timeoutMsUnused
    );
  }
  const { spawn } = await import('child_process');
  const fsP = await import('fs/promises');
  const adapter = getAdapterForProvider(providerData || providerType);
  if (!adapter) {
    throw createReviewRuntimeError(`No ${getCliProviderLabel(providerType)} CLI adapter registered for agentic mode`, 'invalid_request');
  }

  const binaryPath = await adapter.findBinary();
  const projectPath = requestContext?.projectPath || process.cwd();
  const maxTurns = normalizeAgenticMaxTurns(requestContext?.maxTurns, requestContext?.agenticTier);
  const useStructuredExtraction = requestContext?.agenticExtractionMode === true;
  const useFreeformDiscovery = requestContext?.agenticDiscoveryMode === true && !useStructuredExtraction;

  // Create an isolated HOME so the CLI never probes TCC-protected dirs.
  // Claude Code on macOS now commonly uses Keychain-backed auth without
  // ~/.claude/credentials.json. Isolating HOME breaks that auth flow, so
  // Claude review executions keep the real HOME. Newer Claude CLI builds can
  // constrain settings sources; ClaudeAdapter only enables that flag after
  // probing support because older builds reject it as an unknown option.
  let agentHome = null;
  if (process.platform === 'darwin' && providerType !== 'anthropic') {
    const allowRealHomeFallback = String(
      process.env.ATLAS_ALLOW_REAL_HOME_FALLBACK || ''
    ).trim() === '1';
    try {
      agentHome = await createIsolatedAgentHome();
    } catch (homeErr) {
      if (!allowRealHomeFallback) {
        throw createReviewRuntimeError(
          `Failed to initialize isolated CLI HOME: ${homeErr?.message || 'unknown error'}. `
            + 'Set ATLAS_ALLOW_REAL_HOME_FALLBACK=1 to bypass.',
          'invalid_request',
          { cause: homeErr }
        );
      }
      console.error('[callCliAgentic] isolated HOME creation failed; ATLAS_ALLOW_REAL_HOME_FALLBACK=1, using real HOME:', homeErr.message);
    }
  }

  const useDarwinSandboxProfile = (
    process.platform === 'darwin'
    && typeof adapter.shouldUseDarwinSandboxProfile === 'function'
    && adapter.shouldUseDarwinSandboxProfile()
  );
  const outputCapture = typeof adapter.createOutputCapture === 'function'
    ? await adapter.createOutputCapture()
    : null;
  const outputFile = outputCapture?.outputFile || null;
  const sessionId = randomUUID();
  // Permission strategy: configurable via requestContext or env var for A/B testing.
  // Values: 'skip' (default), 'allowedTools', 'addDir'
  const permissionStrategy = requestContext?.permissionStrategy
    || process.env.ATLAS_CLI_PERMISSION_STRATEGY
    || 'skip';
  const runtimeMcp = buildRuntimeMcpInvocationConfig(requestContext, projectPath);
  const codegraphMcp = buildCodegraphMcpInvocationConfig(requestContext, projectPath);
  const invocation = typeof adapter.buildAgenticArgs === 'function'
    ? adapter.buildAgenticArgs({
      message: prompt,
      sessionId,
      model,
      maxTurns,
      projectPath,
      outputFile,
      externalSandbox: useDarwinSandboxProfile,
      systemPrompt: useFreeformDiscovery ? null : CLI_REVIEW_JSON_SYSTEM_PROMPT,
      permissionStrategy,
      runtimeMcp,
      codegraphMcp,
    })
    : adapter.buildArgs({
      message: prompt,
      sessionId,
      model,
      systemPrompt: useFreeformDiscovery ? null : CLI_REVIEW_JSON_SYSTEM_PROMPT,
      outputFile,
    });
  const args = Array.isArray(invocation?.args) ? invocation.args.slice() : [];
  const stdinMessage = invocation?.stdinMessage !== false;

  let spawnBinary = binaryPath;
  let spawnArgs = args;
  let sandboxProfilePath = null;
  if (useDarwinSandboxProfile) {
    try {
      sandboxProfilePath = await generateSandboxProfile(projectPath, binaryPath);
      spawnBinary = '/usr/bin/sandbox-exec';
      spawnArgs = ['-f', sandboxProfilePath, binaryPath, ...args];
    } catch (sandboxErr) {
      console.error('[callCliAgentic] sandbox profile generation failed, proceeding unsandboxed:', sandboxErr.message);
    }
  }

  // Track whether temp resources have been cleaned up so both the inner
  // Promise path and the outer finally block can call cleanup idempotently.
  let tempResourcesCleaned = false;
  const cleanupTempResources = () => {
    if (tempResourcesCleaned) return;
    tempResourcesCleaned = true;
    if (sandboxProfilePath) {
      fsP.default.rm(pathDirname(sandboxProfilePath), { recursive: true, force: true }).catch(() => {});
    }
    if (agentHome) {
      agentHome.cleanup().catch(() => {});
    }
  };

  throwIfDeadlineExceeded(deadlineSignal);
  let stdout = '';
  let capturedStderr = '';
  try {
    const spawnEnv = await buildProviderCliSpawnEnv(providerType, agentHome?.env || {});
    const spawnInvocation = resolveCliSpawnInvocation(spawnBinary, spawnArgs);
    stdout = await new Promise((resolve, reject) => {
      const detachChild = shouldDetachCliSubprocess();
      const child = spawn(spawnInvocation.command, spawnInvocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        cwd: projectPath,
      detached: detachChild,
      windowsHide: true,
      shell: spawnInvocation.shell,
    });
      // Keep the subprocess referenced while the parent is still awaiting the
      // review result. Detaching still gives us a killable process group.
      let settled = false;
      let livenessInterval = null;
      let out = '';
      let err = '';
      let lineBuffer = '';
      let oosReadCount = 0;
      let onDeadlineAbort = null;

      let turnCount = 0;

      const livenessStartMs = Date.now();
      let lastDataAtMs = livenessStartMs;
      const touchLiveness = () => { lastDataAtMs = Date.now(); };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (livenessInterval) {
          clearInterval(livenessInterval);
          livenessInterval = null;
        }
        // Ensure the entire process group is terminated on any exit path.
        killProcessGroup(child);
        cleanupTempResources();
        if (deadlineSignal && onDeadlineAbort) {
          try {
            deadlineSignal.removeEventListener('abort', onDeadlineAbort);
          } catch {
            // noop
          }
        }
        fn(value);
      };

      child.stdout.on('data', (d) => {
        touchLiveness();
        const chunk = String(d);
        out += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) {
          const parsedEvent = typeof adapter.parseAgenticStreamLine === 'function'
            ? adapter.parseAgenticStreamLine(line)
            : (typeof adapter.parseStreamLine === 'function' ? adapter.parseStreamLine(line) : null);
          if (!parsedEvent) continue;

          // Track turns for diagnostics (no hard enforcement — prompt handles pacing)
          if (parsedEvent?.raw?.type === 'turn.completed') {
            turnCount += 1;
          }

          // Handle permission prompt tool control_request events
          // (only for Claude adapter with permissionPrompt strategy)
          if (parsedEvent?.type === 'control_request' && child.stdin && !child.stdin.destroyed) {
            const reqToolName = parsedEvent.toolName || '';
            const reqToolInput = parsedEvent.toolInput || {};
            const requestId = parsedEvent.requestId;
            const toolPath = resolveToolPathForAdapter(adapter, reqToolName, reqToolInput);
            let allow = true;

            if (toolPath && !isPathWithinScope(toolPath, projectPath)
                && !isClaudeInternalPath(toolPath, { homePath: agentHome?.home || null })) {
              if (isFileMutationTool(reqToolName)) {
                // Deny out-of-scope writes immediately
                allow = false;
                console.warn(`[callCliAgentic] permissionPrompt: DENY out-of-scope write: ${reqToolName} → ${toolPath}`);
                const denyResponse = JSON.stringify({ type: 'control_response', id: requestId, allow: false });
                child.stdin.write(denyResponse + '\n');
                killProcessGroup(child);
                finish(reject, createReviewRuntimeError(
                  `CLI-agentic attempted out-of-scope write (denied pre-execution): ${toolPath}`,
                  'out_of_scope_access'
                ));
                return;
              }
              // Out-of-scope read: allow up to limit
              oosReadCount += 1;
              console.warn(`[callCliAgentic] permissionPrompt: out-of-scope read #${oosReadCount}: ${reqToolName} → ${toolPath}`);
              if (oosReadCount >= OOS_READ_LIMIT) {
                const denyResponse = JSON.stringify({ type: 'control_response', id: requestId, allow: false });
                child.stdin.write(denyResponse + '\n');
                killProcessGroup(child);
                finish(reject, createReviewRuntimeError(
                  `CLI-agentic exceeded out-of-scope read limit (denied pre-execution): ${toolPath}`,
                  'out_of_scope_access'
                ));
                return;
              }
            }

            if (allow) {
              const allowResponse = JSON.stringify({ type: 'control_response', id: requestId, allow: true });
              child.stdin.write(allowResponse + '\n');
            }
            continue;
          }

          const events = Array.isArray(parsedEvent) ? parsedEvent : [parsedEvent];
          for (const event of events) {
            if (!event || event.type !== 'assistant' || !Array.isArray(event.contentBlocks)) continue;
            for (const block of event.contentBlocks) {
              if (block?.type !== 'tool_use') continue;
              const toolName = typeof block.toolName === 'string'
                ? block.toolName
                : (typeof block.name === 'string' ? block.name : '');
              const toolInput = block.toolInput && typeof block.toolInput === 'object'
                ? block.toolInput
                : (block.input && typeof block.input === 'object' ? block.input : {});
              if (typeof onToolUse === 'function') {
                onToolUse({
                  type: 'tool_use',
                  name: toolName,
                  input: toolInput,
                });
              }
              const toolPath = resolveToolPathForAdapter(adapter, toolName, toolInput);
              if (
                toolPath
                && !isPathWithinScope(toolPath, projectPath)
                && !isClaudeInternalPath(toolPath, { homePath: agentHome?.home || null })
              ) {
                if (isFileMutationTool(toolName)) {
                  // Write to out-of-scope path — terminate immediately.
                  killProcessGroup(child);
                  finish(reject, createReviewRuntimeError(
                    `CLI-agentic attempted out-of-scope write: ${toolPath}`,
                    'out_of_scope_access'
                  ));
                  return;
                }
                // Read-only out-of-scope access: log and continue.
                // The CLI has already executed the tool by the time we see the
                // event in the stream, so killing wastes the entire review for
                // a harmless read (e.g., Tauri app bundle path).
                oosReadCount += 1;
                console.warn(
                  `[callCliAgentic] out-of-scope read #${oosReadCount}: ${toolName} → ${toolPath}`
                );
                if (oosReadCount >= OOS_READ_LIMIT) {
                  killProcessGroup(child);
                  finish(reject, createReviewRuntimeError(
                    `CLI-agentic exceeded out-of-scope read limit (${OOS_READ_LIMIT}): last path ${toolPath}`,
                    'out_of_scope_access'
                  ));
                  return;
                }
              }
            }
          }
        }
      });
      child.stderr.on('data', (d) => { touchLiveness(); err += d; });

      if (deadlineSignal) {
        onDeadlineAbort = () => {
          killProcessGroup(child);
          finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
        };
        if (deadlineSignal.aborted) {
          onDeadlineAbort();
          return;
        }
        deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
      }

      child.stdin.on('error', () => {}); // Prevent unhandled stream error if child exits early
      if (stdinMessage) {
        // Use adapter-modified message when available (e.g. Gemini prepends
        // system prompt to stdin since it lacks --append-system-prompt).
        child.stdin.write(typeof invocation?.message === 'string' ? invocation.message : prompt);
      }
      child.stdin.end();

      livenessInterval = setInterval(() => {
        const now = Date.now();
        const sinceData = now - lastDataAtMs;
        const sinceStart = now - livenessStartMs;
        // Evaluate the absolute ceiling first and independently of the
        // liveness check: a CLI that trickles a byte every 2m59s would
        // never trip the silence threshold but must still be killed at
        // the absolute ceiling.
        if (sinceStart > CLI_AGENTIC_ABSOLUTE_CEILING_MS) {
          killProcessGroup(child);
          finish(
            reject,
            createReviewRuntimeError(
              `${getCliProviderLabel(providerType)} CLI-agentic exceeded absolute ceiling of ${Math.round(CLI_AGENTIC_ABSOLUTE_CEILING_MS / 1000)}s`,
              'timeout'
            )
          );
          return;
        }
        if (sinceData > CLI_AGENTIC_LIVENESS_THRESHOLD_MS) {
          killProcessGroup(child);
          finish(
            reject,
            createReviewRuntimeError(
              `${getCliProviderLabel(providerType)} CLI-agentic stuck: no output for ${Math.round(sinceData / 1000)}s`,
              'timeout'
            )
          );
        }
      }, CLI_AGENTIC_LIVENESS_CHECK_INTERVAL_MS);
      if (typeof livenessInterval?.unref === 'function') livenessInterval.unref();

      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(reject, classifyCliAgenticExitError(providerType, code, err, out));
          return;
        }
        capturedStderr = err;
        finish(resolve, out);
      });

      child.on('error', (error) => {
        finish(reject, createReviewRuntimeError(`${getCliProviderLabel(providerType)} CLI-agentic error: ${error.message}`, 'unknown', { cause: error }));
      });
    });

    let outputFileText = '';
    if (outputFile) {
      try {
        outputFileText = await fsP.default.readFile(outputFile, 'utf8');
      } catch {
        outputFileText = '';
      }
    }

    const extracted = useFreeformDiscovery
      ? (
        typeof adapter.extractDiscoveryText === 'function'
          ? adapter.extractDiscoveryText(outputFileText || stdout)
          : String(outputFileText || stdout || '').trim()
      )
      : (
        typeof adapter.extractReviewText === 'function'
          ? adapter.extractReviewText(stdout, outputFileText)
          : String(outputFileText || stdout || '').trim()
      );

    // Log diagnostics when CLI exited 0 but produced no review content.
    if (!extracted.trim() && (capturedStderr || stdout)) {
      console.error(
        '[callCliAgentic] CLI exited 0 but produced no review text.',
        `stdout_len=${stdout.length}`,
        capturedStderr ? `stderr_tail=${capturedStderr.slice(-500)}` : 'stderr=(empty)',
      );
      // Dump raw stdout for post-mortem analysis.
      try {
        const dumpPath = `/tmp/atlas-agentic-stdout-${Date.now()}.log`;
        (await import('fs/promises')).default.writeFile(dumpPath, stdout, { encoding: 'utf8', mode: 0o600 });
        console.error(`[callCliAgentic] Raw stdout dumped to ${dumpPath}`);
      } catch { /* best-effort */ }

      // Detect error_max_turns — log a warning but don't throw.
      // Without a hard --max-turns limit this should be rare; the timeout
      // is now the primary safety net, and the prompt instructs the model
      // to produce output before exploring excessively.
      const maxTurnsInfo = detectMaxTurnsExhausted(stdout);
      if (maxTurnsInfo) {
        console.warn(
          `[callCliAgentic] CLI reported error_max_turns (${maxTurnsInfo.numTurns} turns) — no review produced.`
        );
      }
    }

    const runtimeTextError = classifyCliRuntimeTextError(providerType, extracted);
    if (runtimeTextError) throw runtimeTextError;

    // Extract turn count and completion info from the JSONL result event
    const agenticMeta = extractAgenticResultMeta(stdout, { recoveredText: extracted }) || {};

    return {
      text: extracted,
      tokensUsed: agenticMeta.tokensUsed || { input: 0, output: 0 },
      agenticMeta: {
        actualTurns: agenticMeta.numTurns ?? null,
        maxTurns,
        completionReason: agenticMeta.subtype || 'success',
        costUsd: agenticMeta.costUsd ?? null,
      },
    };
  } finally {
    cleanupTempResources();
    if (outputCapture?.cleanup) {
      await outputCapture.cleanup();
    }
  }
}

async function callClaudeCliAgentic(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null,
  { onToolUse = null } = {}
) {
  return callCliAgentic(
    'anthropic',
    prompt,
    model,
    timeoutMs,
    deadlineSignal,
    requestContext,
    providerData,
    { onToolUse }
  );
}

async function callClaudeCliAgent(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_CLAUDE_CLI_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null
) {
  const { spawn } = await import('child_process');
  const providerType = providerData?.provider?.type || 'anthropic';
  const cliLabel = getCliProviderLabel(providerType);
  const adapter = getAdapterForProvider(providerData || 'anthropic');
  if (!adapter) {
    throw createReviewRuntimeError(`No ${cliLabel} CLI adapter registered`, 'invalid_request');
  }

  const binaryPath = await adapter.findBinary();
  const envelope = buildCliAgentReviewRequest({
    prompt,
    model,
    providerData,
    timeoutMs,
    requestContext,
  });
  const message = buildCliAgentEnvelopePrompt(envelope);
  const sessionId = randomUUID();
  const { args, stdinMessage } = adapter.buildArgs({
    message,
    sessionId,
    model,
    systemPrompt: CLI_REVIEW_JSON_SYSTEM_PROMPT,
  });

  throwIfDeadlineExceeded(deadlineSignal);
  let sandboxProfilePath = null;
  let stdout;
  try {
    const spawnEnv = await buildProviderCliSpawnEnv(providerType);
    stdout = await new Promise(async (resolve, reject) => {
      let spawnInvocation;
      try {
        spawnInvocation = await resolveTccSafeCliSpawnInvocation(binaryPath, args, requestContext);
        sandboxProfilePath = spawnInvocation.sandboxProfilePath;
      } catch (error) {
        reject(createReviewRuntimeError(`Failed to prepare ${cliLabel} CLI-agent sandbox: ${error.message}`, 'invalid_request', { cause: error }));
        return;
      }
      const child = spawn(spawnInvocation.command, spawnInvocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        cwd: resolveCliSpawnCwd(requestContext),
        windowsHide: true,
        shell: spawnInvocation.shell,
      });
      let settled = false;
      let timer = null;
      let out = '';
      let err = '';

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (deadlineSignal && onDeadlineAbort) {
        try {
          deadlineSignal.removeEventListener('abort', onDeadlineAbort);
        } catch {
          // noop
        }
      }
      fn(value);
    };

    let onDeadlineAbort = null;
    if (deadlineSignal) {
      onDeadlineAbort = () => {
        try { child.kill('SIGTERM'); } catch {}
        finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
      };
      if (deadlineSignal.aborted) {
        onDeadlineAbort();
        return;
      }
      deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
    }

    child.stdin.on('error', () => {}); // Prevent unhandled stream error if child exits early
    if (stdinMessage) {
      child.stdin.write(message);
    }
    child.stdin.end();

    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(
        reject,
        createReviewRuntimeError(
          `${cliLabel} CLI-agent timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          'timeout'
        )
      );
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        // Only check the LAST part of stderr for error classification (after the echoed prompt).
        // CLI-agent echoes the full prompt in output, so checking full combined output
        // causes false positives when the diff contains common words like "auth" or "context".
        const errTail = err.slice(-500).toLowerCase();
        if (
          errTail.includes('not authenticated')
          || errTail.includes('authentication failed')
          || errTail.includes('please log in')
          || errTail.includes('please login')
          || errTail.includes('unauthorized')
          || (errTail.includes('error') && errTail.includes('auth'))
        ) {
          finish(
            reject,
            createReviewRuntimeError(
              `${cliLabel} CLI authentication failed. Please run \`${getCliLoginCommand(providerType)}\` to re-authenticate.`,
              'auth'
            )
          );
          return;
        }
        if (errTail.includes('too long') || errTail.includes('too large') || errTail.includes('context window') || errTail.includes('context length')) {
          finish(
            reject,
            createReviewRuntimeError(
              `Diff is too large for a single ${cliLabel} CLI-agent review.`,
              'context_limit'
            )
          );
          return;
        }
        finish(reject, createReviewRuntimeError(`${cliLabel} CLI-agent error: ${formatCliErrorDetail(providerType, err, out)}`, 'invalid_request'));
      } else {
        finish(resolve, out);
      }
    });

    child.on('error', (error) => {
      finish(reject, createReviewRuntimeError(`${cliLabel} CLI-agent error: ${error.message}`, 'unknown', { cause: error }));
    });
    });
  } finally {
    await cleanupTccSandboxProfile(sandboxProfilePath);
  }

  const extracted = typeof adapter.extractReviewText === 'function'
    ? adapter.extractReviewText(stdout)
    : String(stdout || '').trim();
  const runtimeTextError = classifyCliRuntimeTextError(providerType, extracted);
  if (runtimeTextError) throw runtimeTextError;

  return {
    text: extracted,
    tokensUsed: { input: 0, output: 0 },
  };
}

async function callCodexCliAgentic(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null,
  { onToolUse = null } = {}
) {
  return callCliAgentic(
    'openai',
    prompt,
    model,
    timeoutMs,
    deadlineSignal,
    requestContext,
    providerData,
    { onToolUse }
  );
}

async function callCodexCliAgent(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_CODEX_CLI_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null
) {
  const { spawn } = await import('child_process');
  const fsP = await import('fs/promises');
  const providerType = providerData?.provider?.type || 'openai';
  const cliLabel = getCliProviderLabel(providerType);
  const adapter = getAdapterForProvider(providerData || 'openai');
  if (!adapter) {
    throw createReviewRuntimeError(`No ${cliLabel} CLI adapter registered`, 'invalid_request');
  }
  const binaryPath = await adapter.findBinary();
  const envelope = buildCliAgentReviewRequest({
    prompt,
    model,
    providerData,
    timeoutMs,
    requestContext,
  });
  const message = buildCliAgentEnvelopePrompt(envelope);
  const outputCapture = typeof adapter.createOutputCapture === 'function'
    ? await adapter.createOutputCapture()
    : null;
  const outputFile = outputCapture?.outputFile || null;
  const { args, stdinMessage } = adapter.buildArgs({
    message,
    sessionId: randomUUID(),
    model,
    outputFile,
  });

  throwIfDeadlineExceeded(deadlineSignal);
  let sandboxProfilePath = null;
  let stdout = '';
  try {
    stdout = await new Promise(async (resolve, reject) => {
      let spawnInvocation;
      try {
        spawnInvocation = await resolveTccSafeCliSpawnInvocation(binaryPath, args, requestContext);
        sandboxProfilePath = spawnInvocation.sandboxProfilePath;
      } catch (error) {
        reject(createReviewRuntimeError(`Failed to prepare ${cliLabel} CLI-agent sandbox: ${error.message}`, 'invalid_request', { cause: error }));
        return;
      }
      const child = spawn(spawnInvocation.command, spawnInvocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildCliSpawnEnv(),
        cwd: resolveCliSpawnCwd(requestContext),
        windowsHide: true,
        shell: spawnInvocation.shell,
      });
      let settled = false;
      let timer = null;
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (deadlineSignal && onDeadlineAbort) {
          try {
            deadlineSignal.removeEventListener('abort', onDeadlineAbort);
          } catch {
            // noop
          }
        }
        fn(value);
      };

      let onDeadlineAbort = null;
      if (deadlineSignal) {
        onDeadlineAbort = () => {
          try { child.kill('SIGTERM'); } catch {}
          finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
        };
        if (deadlineSignal.aborted) {
          onDeadlineAbort();
          return;
        }
        deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
      }

      child.stdin.on('error', () => {}); // Prevent unhandled stream error if child exits early
      if (stdinMessage) {
        child.stdin.write(message);
      }
      child.stdin.end();

      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        finish(
          reject,
          createReviewRuntimeError(
            `${cliLabel} CLI-agent timed out after ${Math.round(timeoutMs / 1000)} seconds`,
            'timeout'
          )
        );
      }, timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();

      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          const errTail = err.slice(-500).toLowerCase();
          if (
            errTail.includes('not authenticated')
            || errTail.includes('authentication failed')
            || errTail.includes('please log in')
            || errTail.includes('please login')
            || errTail.includes('unauthorized')
          ) {
            finish(
              reject,
              createReviewRuntimeError(
                `${cliLabel} CLI authentication failed. Please run \`${getCliLoginCommand(providerType)}\` to re-authenticate.`,
                'auth'
              )
            );
            return;
          }
          if (errTail.includes('too long') || errTail.includes('too large') || errTail.includes('context window') || errTail.includes('context length')) {
            finish(
              reject,
              createReviewRuntimeError(
                `Diff is too large for ${cliLabel} CLI-agent context window.`,
                'context_limit'
              )
            );
            return;
          }
          finish(reject, createReviewRuntimeError(`${cliLabel} CLI-agent error (exit ${code}): ${formatCliErrorDetail(providerType, err, out)}`, 'invalid_request'));
        } else {
          finish(resolve, out);
        }
      });

      child.on('error', (error) => {
        finish(reject, createReviewRuntimeError(`${cliLabel} CLI-agent error: ${error.message}`, 'unknown', { cause: error }));
      });
    });

    let outputFileText = '';
    if (outputFile) {
      try {
        outputFileText = await fsP.default.readFile(outputFile, 'utf8');
      } catch {
        outputFileText = '';
      }
    }
    const extracted = typeof adapter.extractReviewText === 'function'
      ? adapter.extractReviewText(stdout, outputFileText)
      : String(outputFileText || stdout || '').trim();
    const runtimeTextError = classifyCliRuntimeTextError(providerType, extracted);
    if (runtimeTextError) throw runtimeTextError;
    return {
      text: extracted,
      tokensUsed: { input: 0, output: 0 },
    };
  } finally {
    await cleanupTccSandboxProfile(sandboxProfilePath);
    if (outputCapture?.cleanup) {
      await outputCapture.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Google / Gemini providers
// ---------------------------------------------------------------------------

/**
 * Call Google Gemini API directly (BYOK mode).
 */
async function callGoogleAPI(
  prompt,
  apiKey,
  model = 'gemini-2.5-flash',
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_API_MS,
  deadlineSignal = null
) {
  throwIfDeadlineExceeded(deadlineSignal);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 16384 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer?.unref === 'function') timer.unref();

  let onDeadlineAbort = null;
  if (deadlineSignal) {
    onDeadlineAbort = () => controller.abort();
    if (deadlineSignal.aborted) {
      clearTimeout(timer);
      throw getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS));
    }
    deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const msg = errBody?.error?.message || `HTTP ${response.status}`;

      if (response.status === 401 || response.status === 403) {
        throw createReviewRuntimeError(`Gemini API auth error: ${msg}`, 'auth');
      }
      if (response.status === 429) {
        throw createReviewRuntimeError(`Gemini API rate limited: ${msg}`, 'rate_limit');
      }
      if (response.status >= 500) {
        throw createReviewRuntimeError(`Gemini API server error: ${msg}`, 'transient');
      }
      throw createReviewRuntimeError(`Gemini API error: ${msg}`, 'invalid_request');
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const usage = data?.usageMetadata || {};

    return {
      text: text.trim(),
      tokensUsed: {
        input: usage.promptTokenCount || 0,
        output: usage.candidatesTokenCount || 0,
      },
    };
  } catch (error) {
    if (error.runtimeCode) throw error; // already classified
    if (error.name === 'AbortError') {
      if (deadlineSignal?.aborted) {
        throw getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS));
      }
      throw createReviewRuntimeError(
        `Gemini API timed out after ${Math.round(timeoutMs / 1000)} seconds`,
        'timeout'
      );
    }
    throw createReviewRuntimeError(`Gemini API error: ${error.message}`, 'unknown', { cause: error });
  } finally {
    clearTimeout(timer);
    if (deadlineSignal && onDeadlineAbort) {
      try { deadlineSignal.removeEventListener('abort', onDeadlineAbort); } catch { /* noop */ }
    }
  }
}

/**
 * Call Gemini CLI in pipe mode (cli-pipe).
 */
async function callGeminiCLI(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_GEMINI_CLI_MS,
  deadlineSignal = null,
  requestContext = null
) {
  const { spawn } = await import('child_process');

  const adapter = getAdapterForProvider('google');
  if (!adapter) {
    throw createReviewRuntimeError('No Gemini CLI adapter registered', 'invalid_request');
  }
  const geminiPath = await findGeminiCliBinary();
  if (!geminiPath) {
    throw createReviewRuntimeError('Gemini CLI not found', 'invalid_request');
  }

  const sessionId = `atlas-review-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const invocation = typeof adapter.buildArgs === 'function'
    ? adapter.buildArgs({
      message: prompt,
      sessionId,
      model,
    })
    : null;
  const cliArgs = Array.isArray(invocation?.args)
    ? invocation.args
    : ['--prompt', '', '--output-format', 'stream-json', '--yolo', ...(model ? ['--model', model] : [])];
  const stdinMessage = invocation?.stdinMessage !== false;
  const stdinPayload = typeof invocation?.message === 'string' ? invocation.message : prompt;

  throwIfDeadlineExceeded(deadlineSignal);
  let sandboxProfilePath = null;
  let stdout;
  try {
    stdout = await new Promise(async (resolve, reject) => {
      const detachChild = shouldDetachCliSubprocess();
      let spawnInvocation;
      try {
        spawnInvocation = await resolveTccSafeCliSpawnInvocation(geminiPath, cliArgs, requestContext);
        sandboxProfilePath = spawnInvocation.sandboxProfilePath;
      } catch (error) {
        reject(createReviewRuntimeError(`Failed to prepare Gemini CLI sandbox: ${error.message}`, 'invalid_request', { cause: error }));
        return;
      }
    const child = spawn(spawnInvocation.command, spawnInvocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCliSpawnEnv({ GEMINI_CLI: '1' }),
      cwd: resolveCliSpawnCwd(requestContext),
      detached: detachChild,
      windowsHide: true,
      shell: spawnInvocation.shell,
    });
    if (detachChild) child.unref();
    let settled = false;
    let timer = null;
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child);
      if (deadlineSignal && onDeadlineAbort) {
        try { deadlineSignal.removeEventListener('abort', onDeadlineAbort); } catch { /* noop */ }
      }
      fn(value);
    };

    let onDeadlineAbort = null;
    if (deadlineSignal) {
      onDeadlineAbort = () => {
        killProcessGroup(child);
        finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
      };
      if (deadlineSignal.aborted) {
        onDeadlineAbort();
        return;
      }
      deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
    }

    child.stdin.on('error', () => {});
    if (stdinMessage) {
      child.stdin.write(stdinPayload);
    }
    child.stdin.end();

    timer = setTimeout(() => {
      killProcessGroup(child);
      finish(
        reject,
        createReviewRuntimeError(
          `Gemini CLI timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          'timeout'
        )
      );
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const errTail = err.slice(-500).toLowerCase();
        if (
          errTail.includes('not authenticated')
          || errTail.includes('authentication failed')
          || errTail.includes('unauthorized')
          || errTail.includes('invalid api key')
          || errTail.includes('api key not valid')
          || errTail.includes('refreshauth')
          || errTail.includes('refresh token')
        ) {
          finish(
            reject,
            createReviewRuntimeError(
              'Gemini CLI authentication failed. Check your GEMINI_API_KEY or run `gemini auth login`.',
              'auth'
            )
          );
        } else if (errTail.includes('too long') || errTail.includes('too large') || errTail.includes('context window') || errTail.includes('token limit')) {
          finish(
            reject,
            createReviewRuntimeError(
              'Diff is too large for Gemini CLI context window.',
              'context_limit'
            )
          );
        } else {
          finish(
            reject,
            createReviewRuntimeError(
              `Gemini CLI error (exit ${code}): ${err.slice(-300).trim() || out.trim()}`,
              'invalid_request'
            )
          );
        }
      } else {
        finish(resolve, out);
      }
    });

    child.on('error', (e) => {
      finish(reject, createReviewRuntimeError(`Gemini CLI error: ${e.message}`, 'unknown', { cause: e }));
    });
    });
  } finally {
    await cleanupTccSandboxProfile(sandboxProfilePath);
  }

  // Parse Gemini JSON response
  let text = stdout.trim();
  if (typeof adapter.extractReviewText === 'function') {
    text = adapter.extractReviewText(stdout);
  }
  try {
    const parsed = JSON.parse(text);
    text = (parsed.response || parsed.text || parsed.content || parsed.result || text).trim();
  } catch {
    // Not JSON — use raw stdout
  }

  return {
    text,
    tokensUsed: { input: 0, output: 0 },
  };
}

/**
 * Call Gemini CLI in agent mode (cli-agent) — full envelope review.
 */
async function callGeminiCliAgentic(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null,
  { onToolUse = null } = {}
) {
  return callCliAgentic(
    'google',
    prompt,
    model,
    timeoutMs,
    deadlineSignal,
    requestContext,
    providerData,
    { onToolUse }
  );
}

async function callGeminiCliAgent(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_GEMINI_CLI_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null
) {
  const { spawn } = await import('child_process');
  const adapter = getAdapterForProvider(providerData || 'google');
  if (!adapter) {
    throw createReviewRuntimeError('No Gemini CLI adapter registered', 'invalid_request');
  }

  const binaryPath = await adapter.findBinary();
  const envelope = buildCliAgentReviewRequest({
    prompt,
    model,
    providerData,
    timeoutMs,
    requestContext,
  });
  const message = buildCliAgentEnvelopePrompt(envelope);
  const sessionId = `atlas-review-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const { args, stdinMessage } = adapter.buildArgs({
    message,
    sessionId,
    model,
  });

  throwIfDeadlineExceeded(deadlineSignal);
  let sandboxProfilePath = null;
  let stdout;
  try {
    stdout = await new Promise(async (resolve, reject) => {
      const detachChild = shouldDetachCliSubprocess();
      let spawnInvocation;
      try {
        spawnInvocation = await resolveTccSafeCliSpawnInvocation(binaryPath, args, requestContext);
        sandboxProfilePath = spawnInvocation.sandboxProfilePath;
      } catch (error) {
        reject(createReviewRuntimeError(`Failed to prepare Gemini CLI-agent sandbox: ${error.message}`, 'invalid_request', { cause: error }));
        return;
      }
    const child = spawn(spawnInvocation.command, spawnInvocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCliSpawnEnv({ GEMINI_CLI: '1' }),
      cwd: resolveCliSpawnCwd(requestContext),
      detached: detachChild,
      windowsHide: true,
      shell: spawnInvocation.shell,
    });
    if (detachChild) child.unref();
    let settled = false;
    let timer = null;
    let out = '';
    let err = '';

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child);
      if (deadlineSignal && onDeadlineAbort) {
        try { deadlineSignal.removeEventListener('abort', onDeadlineAbort); } catch { /* noop */ }
      }
      fn(value);
    };

    let onDeadlineAbort = null;
    if (deadlineSignal) {
      onDeadlineAbort = () => {
        killProcessGroup(child);
        finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
      };
      if (deadlineSignal.aborted) {
        onDeadlineAbort();
        return;
      }
      deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
    }

    child.stdin.on('error', () => {});
    if (stdinMessage) {
      child.stdin.write(message);
    }
    child.stdin.end();

    timer = setTimeout(() => {
      killProcessGroup(child);
      finish(
        reject,
        createReviewRuntimeError(
          `Gemini CLI-agent timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          'timeout'
        )
      );
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const errTail = err.slice(-500).toLowerCase();
        if (
          errTail.includes('not authenticated')
          || errTail.includes('authentication failed')
          || errTail.includes('unauthorized')
          || errTail.includes('invalid api key')
          || errTail.includes('api key not valid')
          || errTail.includes('refreshauth')
          || errTail.includes('refresh token')
        ) {
          finish(
            reject,
            createReviewRuntimeError(
              'Gemini CLI authentication failed. Check your GEMINI_API_KEY or run `gemini auth login`.',
              'auth'
            )
          );
          return;
        }
        if (errTail.includes('too long') || errTail.includes('too large') || errTail.includes('context window') || errTail.includes('token limit')) {
          finish(
            reject,
            createReviewRuntimeError(
              'Diff is too large for a single Gemini CLI-agent review.',
              'context_limit'
            )
          );
          return;
        }
        finish(reject, createReviewRuntimeError(`Gemini CLI-agent error: ${formatCliErrorDetail('google', err, out)}`, 'invalid_request'));
      } else {
        finish(resolve, out);
      }
    });

    child.on('error', (error) => {
      finish(reject, createReviewRuntimeError(`Gemini CLI-agent error: ${error.message}`, 'unknown', { cause: error }));
    });
    });
  } finally {
    await cleanupTccSandboxProfile(sandboxProfilePath);
  }

  const extracted = typeof adapter.extractReviewText === 'function'
    ? adapter.extractReviewText(stdout)
    : String(stdout || '').trim();

  return {
    text: extracted,
    tokensUsed: { input: 0, output: 0 },
  };
}

// ---------------------------------------------------------------------------
// OpenCode CLI call functions
// ---------------------------------------------------------------------------

/**
 * Call OpenCode CLI in pipe mode (cli-pipe).
 * Follows the callGeminiCLI pattern: find binary via adapter, build args,
 * spawn process with stdin, collect stdout, extract review text.
 */
async function callOpenCodeCLI(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS,
  deadlineSignal = null,
  requestContext = null
) {
  const { spawn } = await import('child_process');
  const adapter = getAdapterForProvider('opencode');
  if (!adapter) {
    throw createReviewRuntimeError('No OpenCode CLI adapter registered', 'invalid_request');
  }

  const binaryPath = await adapter.findBinary();
  const { args, stdinMessage, message } = adapter.buildArgs({ message: prompt, model });

  // Inject NVIDIA_API_KEY if the model targets nvidia (OpenCode config uses {env:NVIDIA_API_KEY})
  const extraSpawnEnv = { OPENCODE_CLI: '1' };
  if (!process.env.NVIDIA_API_KEY && (model?.startsWith('nvidia/') || model?.startsWith('nvidia\\'))) {
    try {
      const resolved = await resolveOpenCodeDirectApiParams();
      if (resolved?.apiKey) extraSpawnEnv.NVIDIA_API_KEY = resolved.apiKey;
    } catch { /* best-effort */ }
  }

  throwIfDeadlineExceeded(deadlineSignal);
  let sandboxProfilePath = null;
  let stdout;
  try {
    stdout = await new Promise(async (resolve, reject) => {
      const detachChild = shouldDetachCliSubprocess();
      let spawnInvocation;
      try {
        spawnInvocation = await resolveTccSafeCliSpawnInvocation(binaryPath, args, requestContext);
        sandboxProfilePath = spawnInvocation.sandboxProfilePath;
      } catch (error) {
        reject(createReviewRuntimeError(`Failed to prepare OpenCode CLI sandbox: ${error.message}`, 'invalid_request', { cause: error }));
        return;
      }
    const child = spawn(spawnInvocation.command, spawnInvocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCliSpawnEnv(extraSpawnEnv),
      cwd: resolveCliSpawnCwd(requestContext),
      detached: detachChild,
      windowsHide: true,
      shell: spawnInvocation.shell,
    });
    if (detachChild) child.unref();
    let settled = false;
    let timer = null;
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child);
      if (deadlineSignal && onDeadlineAbort) {
        try { deadlineSignal.removeEventListener('abort', onDeadlineAbort); } catch { /* noop */ }
      }
      fn(value);
    };

    let onDeadlineAbort = null;
    if (deadlineSignal) {
      onDeadlineAbort = () => {
        killProcessGroup(child);
        finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
      };
      if (deadlineSignal.aborted) {
        onDeadlineAbort();
        return;
      }
      deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
    }

    child.stdin.on('error', () => {});
    if (stdinMessage) {
      child.stdin.write(message || prompt);
    }
    child.stdin.end();

    timer = setTimeout(() => {
      killProcessGroup(child);
      finish(
        reject,
        createReviewRuntimeError(
          `OpenCode CLI timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          'timeout'
        )
      );
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const errTail = err.slice(-500).toLowerCase();
        if (
          errTail.includes('not authenticated')
          || errTail.includes('authentication failed')
          || errTail.includes('unauthorized')
          || errTail.includes('invalid api key')
          || errTail.includes('api key not valid')
        ) {
          finish(
            reject,
            createReviewRuntimeError(
              'OpenCode CLI authentication failed. Please run `opencode auth` to re-authenticate.',
              'auth'
            )
          );
        } else if (errTail.includes('too long') || errTail.includes('too large') || errTail.includes('context window') || errTail.includes('token limit')) {
          finish(
            reject,
            createReviewRuntimeError(
              'Diff is too large for OpenCode CLI context window.',
              'context_limit'
            )
          );
        } else {
          finish(
            reject,
            createReviewRuntimeError(
              `OpenCode CLI error (exit ${code}): ${err.slice(-300).trim() || out.trim()}`,
              'invalid_request'
            )
          );
        }
      } else {
        finish(resolve, out);
      }
    });

    child.on('error', (e) => {
      finish(reject, createReviewRuntimeError(`OpenCode CLI error: ${e.message}`, 'unknown', { cause: e }));
    });
    });
  } finally {
    await cleanupTccSandboxProfile(sandboxProfilePath);
  }

  const extracted = typeof adapter.extractReviewText === 'function'
    ? adapter.extractReviewText(stdout)
    : String(stdout || '').trim();

  if (!extracted) {
    throw classifyCliRuntimeTextError('opencode', stdout);
  }

  return {
    text: extracted,
    tokensUsed: { input: 0, output: 0 },
  };
}

/**
 * Call OpenCode CLI in agentic mode (cli-agentic).
 * Delegates to shared callCliAgentic — same pattern as callCodexCliAgentic/callGeminiCliAgentic.
 */
async function callOpenCodeCliAgentic(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null,
  { onToolUse = null } = {}
) {
  return callCliAgentic(
    'opencode',
    prompt,
    model,
    timeoutMs,
    deadlineSignal,
    requestContext,
    providerData,
    { onToolUse }
  );
}

/**
 * Call OpenCode CLI in agent mode (cli-agent) — full envelope review.
 * Follows the callGeminiCliAgent pattern: adapter-based binary, args, spawn, extract.
 */
async function callOpenCodeCliAgent(
  prompt,
  model,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS,
  deadlineSignal = null,
  requestContext = {},
  providerData = null
) {
  const { spawn } = await import('child_process');
  const adapter = getAdapterForProvider(providerData || 'opencode');
  if (!adapter) {
    throw createReviewRuntimeError('No OpenCode CLI adapter registered', 'invalid_request');
  }

  const binaryPath = await adapter.findBinary();
  const envelope = buildCliAgentReviewRequest({
    prompt,
    model,
    providerData,
    timeoutMs,
    requestContext,
  });
  const message = buildCliAgentEnvelopePrompt(envelope);
  const sessionId = `atlas-review-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const { args, stdinMessage } = adapter.buildArgs({
    message,
    sessionId,
    model,
  });

  // Inject NVIDIA_API_KEY if the model targets nvidia (OpenCode config uses {env:NVIDIA_API_KEY})
  const extraSpawnEnv = { OPENCODE_CLI: '1' };
  if (!process.env.NVIDIA_API_KEY && (model?.startsWith('nvidia/') || model?.startsWith('nvidia\\'))) {
    try {
      const resolved = await resolveOpenCodeDirectApiParams();
      if (resolved?.apiKey) extraSpawnEnv.NVIDIA_API_KEY = resolved.apiKey;
    } catch { /* best-effort */ }
  }

  throwIfDeadlineExceeded(deadlineSignal);
  let sandboxProfilePath = null;
  let stdout;
  try {
    stdout = await new Promise(async (resolve, reject) => {
      const detachChild = shouldDetachCliSubprocess();
      let spawnInvocation;
      try {
        spawnInvocation = await resolveTccSafeCliSpawnInvocation(binaryPath, args, requestContext);
        sandboxProfilePath = spawnInvocation.sandboxProfilePath;
      } catch (error) {
        reject(createReviewRuntimeError(`Failed to prepare OpenCode CLI-agent sandbox: ${error.message}`, 'invalid_request', { cause: error }));
        return;
      }
      const child = spawn(spawnInvocation.command, spawnInvocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildCliSpawnEnv(extraSpawnEnv),
        cwd: resolveCliSpawnCwd(requestContext),
        detached: detachChild,
        windowsHide: true,
        shell: spawnInvocation.shell,
      });
    if (detachChild) child.unref();
    let settled = false;
    let timer = null;
    let out = '';
    let err = '';

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child);
      if (deadlineSignal && onDeadlineAbort) {
        try { deadlineSignal.removeEventListener('abort', onDeadlineAbort); } catch { /* noop */ }
      }
      fn(value);
    };

    let onDeadlineAbort = null;
    if (deadlineSignal) {
      onDeadlineAbort = () => {
        killProcessGroup(child);
        finish(reject, getAbortReasonError(deadlineSignal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
      };
      if (deadlineSignal.aborted) {
        onDeadlineAbort();
        return;
      }
      deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
    }

    child.stdin.on('error', () => {});
    if (stdinMessage) {
      child.stdin.write(message);
    }
    child.stdin.end();

    timer = setTimeout(() => {
      killProcessGroup(child);
      finish(
        reject,
        createReviewRuntimeError(
          `OpenCode CLI-agent timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          'timeout'
        )
      );
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const errTail = err.slice(-500).toLowerCase();
        if (
          errTail.includes('not authenticated')
          || errTail.includes('authentication failed')
          || errTail.includes('unauthorized')
          || errTail.includes('invalid api key')
          || errTail.includes('api key not valid')
        ) {
          finish(
            reject,
            createReviewRuntimeError(
              'OpenCode CLI authentication failed. Please run `opencode auth` to re-authenticate.',
              'auth'
            )
          );
          return;
        }
        if (errTail.includes('too long') || errTail.includes('too large') || errTail.includes('context window') || errTail.includes('token limit')) {
          finish(
            reject,
            createReviewRuntimeError(
              'Diff is too large for a single OpenCode CLI-agent review.',
              'context_limit'
            )
          );
          return;
        }
        finish(reject, createReviewRuntimeError(`OpenCode CLI-agent error: ${formatCliErrorDetail('opencode', err, out)}`, 'invalid_request'));
      } else {
        finish(resolve, out);
      }
    });

    child.on('error', (error) => {
      finish(reject, createReviewRuntimeError(`OpenCode CLI-agent error: ${error.message}`, 'unknown', { cause: error }));
    });
    });
  } finally {
    await cleanupTccSandboxProfile(sandboxProfilePath);
  }

  const extracted = typeof adapter.extractReviewText === 'function'
    ? adapter.extractReviewText(stdout)
    : String(stdout || '').trim();

  return {
    text: extracted,
    tokensUsed: { input: 0, output: 0 },
  };
}

// ---------------------------------------------------------------------------
// Provider dispatch and retry
// ---------------------------------------------------------------------------

async function callProviderForReview(providerData, prompt, {
  deadline = null,
  deadlineSignal = null,
  modelOverride = null,
  requestContext = null,
  onToolUse = null,
} = {}) {
  if (isReviewTestProviderEnabled()) {
    const signal = deadline?.signal || deadlineSignal || null;
    if (deadline) {
      deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, 'provider call');
    } else {
      throwIfDeadlineExceeded(signal);
    }
    const delayMs = getReviewTestStubDelayMs();
    if (delayMs > 0) {
      await sleep(delayMs, signal);
    }
    return buildReviewTestStubResponse(prompt, providerData, requestContext);
  }

  const { provider, apiKey, authType } = providerData;
  const resolvedModel = typeof modelOverride === 'string' && modelOverride.trim()
    ? modelOverride.trim()
    : provider.model;
  const signal = deadline?.signal || deadlineSignal || null;
  if (deadline) {
    deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, 'provider call');
  } else {
    throwIfDeadlineExceeded(signal);
  }
  const timeoutMs = resolveProviderTimeoutForExecutionAttempt(providerData, null, requestContext, deadline);
  if (timeoutMs <= 1 && deadline) {
    deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, 'provider call');
  }
  const userModeOrder = Array.isArray(requestContext?._executionModeOrder) ? requestContext._executionModeOrder : null;
  const executionModes = filterExecutionModesForRequest(
    resolveProviderExecutionModes(providerData, userModeOrder),
    requestContext || {}
  );
  if (executionModes.length === 0) {
    throw createReviewRuntimeError(
      `No runnable execution mode available for provider type: ${provider?.type || 'unknown'}`,
      'invalid_request'
    );
  }

  for (let index = 0; index < executionModes.length; index += 1) {
    const mode = executionModes[index];
    const isLast = index === executionModes.length - 1;
    try {
      let result;
      if (provider.type === 'anthropic') {
        if (mode === 'cli-agentic') {
          const agenticTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
            providerData,
            'cli-agentic',
            requestContext,
            deadline,
          );
          result = await callClaudeCliAgentic(
            prompt,
            resolvedModel,
            agenticTimeoutMs,
            signal,
            requestContext || {},
            providerData,
            { onToolUse }
          );
        } else if (mode === 'api') {
          result = await callAnthropic(prompt, apiKey, resolvedModel, authType, timeoutMs, signal);
        } else if (mode === 'cli-agent') {
          result = await callClaudeCliAgent(
            prompt,
            resolvedModel,
            timeoutMs,
            signal,
            requestContext || {},
            providerData
          );
        } else if (mode === 'cli-pipe') {
          result = await callClaudeCLI(prompt, resolvedModel, timeoutMs, signal, requestContext || {});
        } else {
          throw createReviewRuntimeError(`Unsupported anthropic mode: ${mode}`, 'invalid_request');
        }
      } else if (provider.type === 'openai') {
        const openAiCliFallbackModel = resolveOpenAICliFallbackModel(resolvedModel);
        if (mode === 'cli-agentic') {
          const agenticTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
            providerData,
            'cli-agentic',
            requestContext,
            deadline,
          );
          try {
            result = await callCodexCliAgentic(
              prompt,
              resolvedModel,
              agenticTimeoutMs,
              signal,
              requestContext || {},
              providerData,
              { onToolUse }
            );
          } catch (error) {
            if (!shouldRetryOpenAICliWithFallback(error, resolvedModel, openAiCliFallbackModel)) {
              throw error;
            }
            const retryAgenticTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
              providerData,
              'cli-agentic',
              requestContext,
              deadline,
            );
            result = await callCodexCliAgentic(
              prompt,
              openAiCliFallbackModel,
              retryAgenticTimeoutMs,
              signal,
              requestContext || {},
              providerData,
              { onToolUse }
            );
          }
        } else if (mode === 'api') {
          result = await callOpenAI(prompt, apiKey, resolvedModel, timeoutMs, signal);
        } else if (mode === 'cli-agent') {
          try {
            result = await callCodexCliAgent(
              prompt,
              resolvedModel,
              timeoutMs,
              signal,
              requestContext || {},
              providerData
            );
          } catch (error) {
            if (!shouldRetryOpenAICliWithFallback(error, resolvedModel, openAiCliFallbackModel)) {
              throw error;
            }
            const retryTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
              providerData,
              mode,
              requestContext,
              deadline,
            );
            result = await callCodexCliAgent(
              prompt,
              openAiCliFallbackModel,
              retryTimeoutMs,
              signal,
              requestContext || {},
              providerData
            );
          }
        } else if (mode === 'cli-pipe') {
          try {
            result = await callCodexCLI(prompt, resolvedModel, timeoutMs, signal, requestContext || {});
          } catch (error) {
            if (!shouldRetryOpenAICliWithFallback(error, resolvedModel, openAiCliFallbackModel)) {
              throw error;
            }
            const retryTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
              providerData,
              mode,
              requestContext,
              deadline,
            );
            result = await callCodexCLI(prompt, openAiCliFallbackModel, retryTimeoutMs, signal, requestContext || {});
          }
        } else {
          throw createReviewRuntimeError(`Unsupported openai mode: ${mode}`, 'invalid_request');
        }
      } else if (provider.type === 'google') {
        const googleCliFallbackModel = typeof providerService.getProviderCliDefaultModel === 'function'
          ? providerService.getProviderCliDefaultModel('google')
          : 'gemini-3-flash-preview';
        if (mode === 'cli-agentic') {
          const agenticTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
            providerData,
            'cli-agentic',
            requestContext,
            deadline,
          );
          try {
            result = await callGeminiCliAgentic(
              prompt,
              resolvedModel,
              agenticTimeoutMs,
              signal,
              requestContext || {},
              providerData,
              { onToolUse }
            );
          } catch (error) {
            if (!shouldRetryGoogleCliWithFallback(error, resolvedModel, googleCliFallbackModel)) {
              throw error;
            }
            const retryAgenticTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
              providerData,
              'cli-agentic',
              requestContext,
              deadline,
            );
            result = await callGeminiCliAgentic(
              prompt,
              googleCliFallbackModel,
              retryAgenticTimeoutMs,
              signal,
              requestContext || {},
              providerData,
              { onToolUse }
            );
          }
        } else if (mode === 'api') {
          result = await callGoogleAPI(prompt, apiKey, resolvedModel, timeoutMs, signal);
        } else if (mode === 'cli-agent') {
          try {
            result = await callGeminiCliAgent(
              prompt,
              resolvedModel,
              timeoutMs,
              signal,
              requestContext || {},
              providerData
            );
          } catch (error) {
            if (!shouldRetryGoogleCliWithFallback(error, resolvedModel, googleCliFallbackModel)) {
              throw error;
            }
            const retryTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
              providerData,
              mode,
              requestContext,
              deadline,
            );
            result = await callGeminiCliAgent(
              prompt,
              googleCliFallbackModel,
              retryTimeoutMs,
              signal,
              requestContext || {},
              providerData
            );
          }
        } else if (mode === 'cli-pipe') {
          try {
            result = await callGeminiCLI(prompt, resolvedModel, timeoutMs, signal, requestContext || {});
          } catch (error) {
            if (!shouldRetryGoogleCliWithFallback(error, resolvedModel, googleCliFallbackModel)) {
              throw error;
            }
            const retryTimeoutMs = resolveProviderTimeoutForExecutionAttempt(
              providerData,
              mode,
              requestContext,
              deadline,
            );
            result = await callGeminiCLI(prompt, googleCliFallbackModel, retryTimeoutMs, signal, requestContext || {});
          }
        } else {
          throw createReviewRuntimeError(`Unsupported google mode: ${mode}`, 'invalid_request');
        }
      } else if (provider.type === 'opencode') {
        // OpenCode CLI (`opencode run`) has upstream bugs with several
        // provider backends.  For non-agentic modes, resolve the underlying
        // provider from OpenCode config and call the API directly.
        if (mode === 'cli-agentic') {
          const agenticTimeoutMs = resolveTimeoutForRemainingBudget(
            resolveProviderRequestTimeoutMs(providerData, 'cli-agentic', requestContext),
            deadline
          );
          result = await callOpenCodeCliAgentic(
            prompt,
            resolvedModel,
            agenticTimeoutMs,
            signal,
            requestContext || {},
            providerData,
            { onToolUse }
          );
        } else if (mode === 'api' || mode === 'cli-pipe') {
          // Direct-API passthrough requires a supported underlying provider
          // (anthropic/google/openai/nvidia) declared via opencode.json. When
          // the user runs OpenCode's first-party `opencode/...` provider, or
          // omits a top-level `model` field, fall back to `opencode run`
          // verbatim — the same CLI path that powers cli-agentic review.
          const resolved = await resolveOpenCodeDirectApiParams();
          if (!resolved) {
            result = await callOpenCodeCLI(
              prompt,
              resolvedModel,
              timeoutMs,
              signal,
              requestContext || {}
            );
          } else {
            const { providerType: ocProvider, bareModel: ocModel, apiKey: ocKey } = resolved;
            if (ocProvider === 'google') {
              result = await callGoogleAPI(prompt, ocKey, ocModel, timeoutMs, signal);
            } else if (ocProvider === 'anthropic') {
              result = await callAnthropic(prompt, ocKey, ocModel, 'api_key', timeoutMs, signal);
            } else if (ocProvider === 'openai') {
              result = await callOpenAI(prompt, ocKey, ocModel, timeoutMs, signal);
            } else if (ocProvider === 'nvidia') {
              // NVIDIA NIM uses OpenAI-compatible API at a different endpoint
              result = await callNvidiaAPI(prompt, ocKey, ocModel, timeoutMs, signal);
            } else {
              throw createReviewRuntimeError(
                `Unsupported OpenCode underlying provider: ${ocProvider}`,
                'invalid_request'
              );
            }
          }
        } else if (mode === 'cli-agent') {
          result = await callOpenCodeCliAgent(
            prompt,
            resolvedModel,
            timeoutMs,
            signal,
            requestContext || {},
            providerData
          );
        } else {
          throw createReviewRuntimeError(`Unsupported opencode mode: ${mode}`, 'invalid_request');
        }
      } else {
        throw createReviewRuntimeError(`Unsupported provider type: ${provider.type}`, 'invalid_request');
      }

      return {
        ...result,
        modelUsed: resolvedModel,
        executionMode: mode,
        executionModes,
      };
    } catch (error) {
      // cli-agentic uses a directive prompt (no diff) incompatible with other modes;
      // falling back would produce garbage output, so always rethrow.
      // Exception: OpenCode cli-agentic auth errors CAN fall back to 'api' mode.
      // The CLI spawns `opencode run` which reads env vars for keys, but 'api' mode
      // resolves keys from auth.json via resolveOpenCodeDirectApiParams() — different
      // auth path, so the same auth error won't recur.
      const openCodeCliAgenticAuthFallback = mode === 'cli-agentic'
        && provider.type === 'opencode'
        && error?.errorType === 'auth'
        && executionModes.includes('api');
      if (openCodeCliAgenticAuthFallback && !isLast) {
        // Allow fallback — skip the normal rethrow logic.
      } else if (!shouldFallbackToNextExecutionMode(error) || isLast || mode === 'cli-agentic') {
        throw error;
      }
    }
  }

  throw createReviewRuntimeError(`Provider execution chain exhausted for ${provider.type}`, 'unknown');
}

/**
 * Decide whether a failed Claude review attempt should drop a stored
 * `CLAUDE_CODE_OAUTH_TOKEN` and retry.
 *
 * Atlas injects that token into the `claude` subprocess (see `buildClaudeCliEnv`),
 * where it *overrides* the CLI's own `claude login` credentials. A stale or
 * revoked stored token therefore makes every Claude review fail with
 * `authentication_error` ("Invalid authentication credentials") even though
 * `claude` works fine in the user's terminal. Clearing the stored token lets the
 * retry fall back to the CLI's own login.
 *
 * @param {Error} error - the error thrown by the provider attempt
 * @param {Object|null} providerData - provider config (`provider.type`)
 * @param {boolean} alreadyCleared - true if we've already cleared once this call
 * @returns {boolean}
 */
function shouldClearStaleClaudeTokenForRetry(error, providerData, alreadyCleared) {
  if (alreadyCleared) return false;
  if (providerData?.provider?.type !== 'anthropic') return false;
  return isLikelyAuthError(error);
}

async function callProviderForReviewWithRetry(providerData, prompt, {
  onRetry = null,
  maxRetries = PROVIDER_TRANSIENT_MAX_RETRIES,
  deadline = null,
  deadlineSignal = null,
  modelOverride = null,
  fallbackModelOverride = null,
  requestContext = null,
  onModelUnavailable = null,
  onToolUse = null,
  requestExecutor = callProviderForReview,
} = {}) {
  const signal = deadline?.signal || deadlineSignal || null;
  const normalizedMaxRetries = Math.max(0, Number(maxRetries) || 0);
  let attempt = 0;
  let activeModelOverride = modelOverride;
  let modelFallbackConsumed = false;
  let staleClaudeTokenCleared = false;

  while (true) {
    if (deadline) {
      deadline.check();
    } else {
      throwIfDeadlineExceeded(signal);
    }
    attempt += 1;
    try {
      return await requestExecutor(providerData, prompt, {
        deadline,
        deadlineSignal: signal,
        modelOverride: activeModelOverride,
        requestContext,
        onToolUse,
      });
    } catch (error) {
      if (error?.isDeadline || signal?.aborted) {
        throw getAbortReasonError(signal, error?.isDeadline ? error : new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS));
      }
      const canFallbackModel =
        !modelFallbackConsumed
        && typeof activeModelOverride === 'string'
        && activeModelOverride.trim()
        && typeof fallbackModelOverride === 'string'
        && fallbackModelOverride.trim()
        && fallbackModelOverride.trim() !== activeModelOverride.trim()
        && isLikelyModelUnavailableError(error);
      if (canFallbackModel) {
        modelFallbackConsumed = true;
        const unavailableModel = activeModelOverride.trim();
        const fallbackModel = fallbackModelOverride.trim();
        activeModelOverride = fallbackModel;
        if (typeof onModelUnavailable === 'function') {
          onModelUnavailable({
            unavailableModel,
            fallbackModel,
            errorClass: classifyProviderError(error),
            errorMessage: error?.message || 'Model unavailable',
          });
        }
        continue;
      }
      if (
        shouldClearStaleClaudeTokenForRetry(error, providerData, staleClaudeTokenCleared)
        // Side-effect-free existence check: hasStoredClaudeOAuthToken() would
        // re-mirror the (stale, about-to-be-deleted) token into process.env.
        && (await hasStoredClaudeOAuthTokenRecord().catch(() => false))
      ) {
        staleClaudeTokenCleared = true;
        await clearStoredClaudeOAuthToken().catch(() => {
          // Best-effort: even if the DB delete fails, clearStoredClaudeOAuthToken
          // has already dropped process.env.CLAUDE_CODE_OAUTH_TOKEN, so the retry
          // below won't re-inject the stale token into the `claude` subprocess.
        });
        if (typeof onRetry === 'function') {
          onRetry({
            attempt,
            maxAttempts: normalizedMaxRetries + 1,
            delayMs: 0,
            errorMessage: 'Stored Claude credential was rejected; retrying with the Claude CLI login.',
            errorClass: classifyProviderError(error),
          });
        }
        continue;
      }
      const retryable = isLikelyTransientProviderError(error);
      const shouldRetry = retryable && attempt <= normalizedMaxRetries;
      if (!shouldRetry) {
        if (attempt > 1) {
          error.message = `${error.message} (after ${attempt} attempts)`;
        }
        throw error;
      }

      const delayMs = computeRetryDelayMs(attempt);
      if (typeof onRetry === 'function') {
        onRetry({
          attempt,
          maxAttempts: normalizedMaxRetries + 1,
          delayMs,
          errorMessage: error?.message || 'Transient provider error',
          errorClass: classifyProviderError(error),
        });
      }
      await sleep(delayMs, signal);
    }
  }
}

// ---------------------------------------------------------------------------
// Failover state
// ---------------------------------------------------------------------------

function createProviderFailoverState(providerCandidates = []) {
  const candidates = Array.isArray(providerCandidates)
    ? providerCandidates.filter((entry) => entry && entry.provider)
    : [];
  return {
    candidates,
    preferredIndex: 0,
  };
}

function getUnavailableModelCacheKey(providerData, modelId) {
  const provider = providerData?.provider || {};
  const providerId = typeof provider.id === 'string' && provider.id.trim()
    ? provider.id.trim()
    : `${provider.type || 'unknown'}`;
  const model = typeof modelId === 'string' ? modelId.trim() : '';
  if (!model) return providerId;
  return `${providerId}:${model}`;
}

// ---------------------------------------------------------------------------
// Persistence helpers (used by the failover chain)
// ---------------------------------------------------------------------------

async function updateChangeSetReview(projectPath, changesetId, reviewFields) {
  const changesetPath = getChangeSetFilePath(projectPath, changesetId);
  const legacyChangesetPath = pathResolve(projectPath, '.atlas', 'changesets', `${changesetId}.json`);

  try {
    let changeset;
    try {
      changeset = await readJsonFileWithRetry(changesetPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      changeset = await readJsonFileWithRetry(legacyChangesetPath);
    }

    // Update review fields on full changeset
    Object.assign(changeset, reviewFields);
    await writeJsonFileAtomic(changesetPath, changeset);

    try {
      await updateChangeSetReviewIndex(projectPath, changesetId, reviewFields);
    } catch {
      // Index update is best-effort
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Changeset not found');
    }
    throw error;
  }
}

async function persistChangesetTerminalState(projectPath, changesetId, {
  reviewStatus,
  reviewData = undefined,
  reviewRiskLevel = undefined,
  reviewSummary = undefined,
  reviewedBy = undefined,
  reviewedAt = undefined,
  reviewError = undefined,
} = {}) {
  const payload = {
    reviewStatus,
    reviewData,
    reviewRiskLevel,
    reviewSummary,
    reviewedBy,
    reviewedAt,
    reviewError,
  };
  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });
  await updateChangeSetReview(projectPath, changesetId, payload);
}

async function persistBranchReviewTerminalState(branchReviewId, {
  reviewStatus,
  reviewRiskLevel = undefined,
  reviewSummary = undefined,
  reviewJson = undefined,
  reviewError = undefined,
  reviewBaseBranch = undefined,
  reviewMergeBaseSha = undefined,
  reviewForkPointSha = undefined,
  reviewHeadSha = undefined,
  reviewedAt = undefined,
} = {}) {
  const payload = {
    review_status: reviewStatus,
    review_risk_level: reviewRiskLevel,
    review_summary: reviewSummary,
    review_json: reviewJson,
    review_error: reviewError,
    review_base_branch: reviewBaseBranch,
    review_merge_base_sha: reviewMergeBaseSha,
    review_fork_point_sha: reviewForkPointSha,
    review_head_sha: reviewHeadSha,
    reviewed_at: reviewedAt,
  };
  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });
  await branchReviewService.updateReview(branchReviewId, payload);
}

// ---------------------------------------------------------------------------
// Provider failover chain
// ---------------------------------------------------------------------------

async function callProviderForReviewWithFailover(providerFailoverState, prompt, {
  onRetry = null,
  maxRetries = PROVIDER_TRANSIENT_MAX_RETRIES,
  deadline = null,
  deadlineSignal = null,
  reviewTiming = null,
  modelPhase = 'review',
  reviewModelConfig = DEFAULT_REVIEW_MODEL_CONFIG,
  unavailableModels = null,
  modelDecisionContext = {},
  onToolUse = null,
} = {}) {
  const candidates = Array.isArray(providerFailoverState?.candidates)
    ? providerFailoverState.candidates
    : [];
  if (candidates.length === 0) {
    throw createReviewRuntimeError(
      'No active AI provider configured. Add an API key in Settings → AI Provider.',
      'invalid_request'
    );
  }

  const signal = deadline?.signal || deadlineSignal || null;
  const normalizedMaxRetries = Math.max(0, Number(maxRetries) || 0);
  const startIndex = Math.max(0, Math.min(candidates.length - 1, Number(providerFailoverState?.preferredIndex) || 0));
  const attemptOrder = [];
  for (let i = startIndex; i < candidates.length; i += 1) attemptOrder.push(i);
  for (let i = 0; i < startIndex; i += 1) attemptOrder.push(i);

  for (let orderIndex = 0; orderIndex < attemptOrder.length; orderIndex += 1) {
    const candidateIndex = attemptOrder[orderIndex];
    const candidate = candidates[candidateIndex];
    const resolvedModel = resolveEffectiveReviewModel(
      candidate,
      modelPhase,
      reviewModelConfig,
      modelDecisionContext
    );
    const preferredModel = resolvedModel.model;
    const fallbackModel = candidate?.provider?.model || preferredModel || null;
    const unavailableKey = getUnavailableModelCacheKey(candidate, preferredModel);
    const shouldBypassUnavailable =
      unavailableModels instanceof Set
      && typeof preferredModel === 'string'
      && preferredModel.trim()
      && unavailableModels.has(unavailableKey);
    const effectiveModel = shouldBypassUnavailable
      ? (fallbackModel || preferredModel)
      : preferredModel;
    const descriptor = describeProviderCandidate(
      candidate,
      effectiveModel,
      (providerData) => resolveProviderExecutionMode(providerData, modelDecisionContext)
    );
    let localRetryCount = 0;

    try {
      const result = await callProviderForReviewWithRetry(candidate, prompt, {
        deadline,
        deadlineSignal: signal,
        maxRetries,
        modelOverride: effectiveModel,
        fallbackModelOverride: fallbackModel,
        requestContext: modelDecisionContext,
        onToolUse,
        onRetry: (retryMeta) => {
          localRetryCount += 1;
          if (typeof onRetry === 'function') {
            onRetry({
              ...retryMeta,
              providerId: descriptor.providerId,
              providerType: descriptor.providerType,
              providerModel: descriptor.model,
              providerMode: descriptor.mode,
            });
          }
        },
        onModelUnavailable: ({ unavailableModel, fallbackModel: runtimeFallbackModel } = {}) => {
          if (unavailableModels instanceof Set && typeof unavailableModel === 'string' && unavailableModel.trim()) {
            unavailableModels.add(getUnavailableModelCacheKey(candidate, unavailableModel));
          }
          if (typeof onRetry === 'function') {
            onRetry({
              attempt: localRetryCount + 1,
              maxAttempts: normalizedMaxRetries + 1,
              delayMs: 0,
              errorMessage: `Model unavailable (${unavailableModel || 'unknown'}) — falling back to ${runtimeFallbackModel || 'default model'}`,
              errorClass: 'model_unavailable',
              providerId: descriptor.providerId,
              providerType: descriptor.providerType,
              providerModel: descriptor.model,
              providerMode: descriptor.mode,
            });
          }
        },
      });

      if (providerFailoverState && typeof providerFailoverState === 'object') {
        providerFailoverState.preferredIndex = candidateIndex;
      }
      if (reviewTiming && typeof reviewTiming === 'object') {
        reviewTiming.providerMode = descriptor.mode;
      }
      recordProviderAttempt(reviewTiming, {
        ...descriptor,
        model: result?.modelUsed || descriptor.model,
        outcome: 'success',
        retries: localRetryCount,
      });
      return {
        ...result,
        providerData: candidate,
      };
    } catch (error) {
      if (error?.isDeadline || signal?.aborted) {
        recordProviderAttempt(reviewTiming, {
          ...descriptor,
          outcome: 'failed',
          errorClass: 'deadline',
          retries: localRetryCount,
        });
        throw getAbortReasonError(signal, error?.isDeadline ? error : new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS));
      }

      const errorClass = classifyProviderError(error);
      const isTransient = isLikelyTransientProviderError(error);
      const hasFallbackCandidate = orderIndex < (attemptOrder.length - 1);
      const willFailover = isTransient && hasFallbackCandidate;

      recordProviderAttempt(reviewTiming, {
        ...descriptor,
        outcome: willFailover ? 'failed_failover' : 'failed',
        errorClass,
        retries: localRetryCount,
      });

      if (!willFailover) {
        throw error;
      }
    }
  }

  throw createReviewRuntimeError('Provider failover chain exhausted', 'transient');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  DANGEROUS_ENV_VARS,
  buildCliSpawnEnv,
  resolveCliSpawnInvocation,
  resolveCliSpawnCwd,
  killProcessGroup,
  detectMaxTurnsExhausted,
  extractAgenticResultMeta,
  extractClaudeCliPipeResultMeta,
  buildIsolatedHomeEnv,
  getExecutionModeOrder,
  invalidateExecutionModeOrderCache,
  resolveProviderRequestTimeoutMs,
  resolveProviderTimeoutForExecutionAttempt,
  classifyCliRuntimeTextError,
  classifyCliAgenticExitError,
  detectCliRuntimeNoise,
  stripCliRuntimeNoise,
  formatCliErrorDetail,
  getCliProviderLabel,
  getCliLoginCommand,
  isCliAgentExecutionEnabled,
  isCliAgenticExecutionEnabled,
  resolveProviderExecutionModes,
  filterExecutionModesForRequest,
  shouldFallbackToNextExecutionMode,
  resolveProviderExecutionMode,
  callAnthropic,
  callOpenAI,
  callGoogleAPI,
  buildClaudeCliPipeArgs,
  resolveClaudeCliModelArg,
  callClaudeCLI,
  callCodexCLI,
  findCodexCliBinary,
  callGeminiCLI,
  findGeminiCliBinary,
  normalizeScopePatternListForEnvelope,
  buildCliAgentReviewRequest,
  buildCliAgentEnvelopePrompt,
  buildCliAgenticReviewPrompt,
  buildCliAgenticDiscoveryPrompt,
  buildCliAgenticDiscoveryExtractionPrompt,
  buildRuntimeMcpInvocationConfig,
  parseCliAgenticDiscoveryResponse,
  convertCliAgenticDiscoveryToReviewPayload,
  summarizeToolInput,
  extractToolPath,
  isFileMutationTool as isWriteTool,
  isPathWithinScope,
  isClaudeInternalPath,
  isProtectedHomeTarget,
  stripTomlMcpServers,
  generateSandboxProfile,
  createIsolatedAgentHome,
  callClaudeCliAgentic,
  callCodexCliAgentic,
  callClaudeCliAgent,
  callCodexCliAgent,
  callGeminiCliAgent,
  callOpenCodeCLI,
  callOpenCodeCliAgentic,
  callOpenCodeCliAgent,
  callProviderForReview,
  callProviderForReviewWithRetry,
  shouldClearStaleClaudeTokenForRetry,
  createProviderFailoverState,
  getUnavailableModelCacheKey,
  updateChangeSetReview,
  persistChangesetTerminalState,
  persistBranchReviewTerminalState,
  callProviderForReviewWithFailover,
  shouldRetryGoogleCliWithFallback,
  shouldRetryOpenAICliWithFallback,
  resolveOpenAICliFallbackModel,
  resolveAgenticTier,
  computeAgenticMaxTurns,
  normalizeAgenticMaxTurns,
  computeAgenticTimeoutMs,
  buildBehavioralHotspotDistillation,
  tierFileHintsForAgenticPrompt,
  partitionFilesForParallelAgenticReview,
};
