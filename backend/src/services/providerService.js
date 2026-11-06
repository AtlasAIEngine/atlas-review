/**
 * Provider Service
 * Manages AI providers for the Trust Pipeline review engine.
 * Supports CLI-detected providers (Claude Code, Codex) and BYOK API keys.
 */

import fs from 'fs/promises';
import { randomUUID } from 'node:crypto';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encrypt, decrypt } from '../utils/encryption.js';
import { getClaudeCliAuthStatus } from '../utils/claudeAuthStatus.js';
import { findClaudeBinary, isAtlasManagedClaudeBinaryPath } from '../utils/claudeBinary.js';
import { findCodexBinary } from '../utils/codexBinary.js';
import { getWindowsCliShimCandidates, resolveWindowsCliExecutablePath } from '../utils/windowsCliPaths.js';
import { getAppDataDir } from '../config/paths.js';
import { isReviewTestProviderEnabled } from '../utils/reviewTestProvider.js';
import db from '../db/connection.js';
import { getStoredClaudeOAuthToken } from './claudeTokenService.js';
import cliInstallService from './cliInstallService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Supported provider types and their API configurations
 */
const PROVIDER_CONFIGS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    testUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', cliAlias: 'opus', toolSupport: true },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', cliAlias: 'sonnet', toolSupport: true },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', cliAlias: 'haiku', toolSupport: true, reviewCapable: false },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', cliAlias: 'claude-fable-5-1', toolSupport: true },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', toolSupport: true },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', toolSupport: true },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', toolSupport: true },
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', toolSupport: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', toolSupport: true, reviewCapable: false },
    ],
    headerKey: 'x-api-key',
    versionHeader: { 'anthropic-version': '2023-06-01' },
    reviewExecutionProfile: {
      coverageMultiplier: 1.05,
      chunkConcurrencyBias: 1.05,
      perFileConcurrencyBias: 1.0,
      focusedTriggerFileCountBias: 1.0,
      focusedTriggerDiffBias: 1.0,
    },
  },
  openai: {
    label: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    testUrl: 'https://api.openai.com/v1/models',
    defaultModel: 'gpt-5.5',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', toolSupport: false },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', toolSupport: false },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', toolSupport: false },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', toolSupport: false },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol', toolSupport: false },
      { id: 'gpt-5.5', label: 'GPT-5.5', toolSupport: true },
      { id: 'gpt-5.4', label: 'GPT-5.4', toolSupport: true },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano', toolSupport: true, reviewCapable: false },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', toolSupport: true, reviewCapable: false },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', toolSupport: true },
    ],
    headerKey: 'Authorization',
    headerPrefix: 'Bearer ',
    versionHeader: {},
    reviewExecutionProfile: {
      coverageMultiplier: 1.12,
      chunkConcurrencyBias: 1.2,
      perFileConcurrencyBias: 1.15,
      focusedTriggerFileCountBias: 0.9,
      focusedTriggerDiffBias: 0.92,
    },
  },
  google: {
    label: 'Google (Gemini)',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    testUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    defaultModel: 'gemini-3.1-pro-preview',
    models: [
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', toolSupport: true },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', toolSupport: true },
      { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite', toolSupport: true },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', toolSupport: true },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', toolSupport: true },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', toolSupport: true },
    ],
    headerKey: 'x-goog-api-key',
    versionHeader: {},
    reviewExecutionProfile: {
      coverageMultiplier: 1.0,
      chunkConcurrencyBias: 1.0,
      perFileConcurrencyBias: 1.0,
      focusedTriggerFileCountBias: 1.0,
      focusedTriggerDiffBias: 1.0,
    },
  },
  opencode: {
    label: 'OpenCode',
    apiUrl: null,       // CLI-only provider — routes through its own provider backends
    testUrl: null,
    defaultModel: 'opencode-default',
    models: [
      { id: 'opencode-default', label: 'OpenCode Default', toolSupport: true },
    ],
    headerKey: null,
    headerPrefix: null,
    versionHeader: {},
    reviewExecutionProfile: {
      coverageMultiplier: 0.9,
      chunkConcurrencyBias: 0.85,
      perFileConcurrencyBias: 0.85,
      focusedTriggerFileCountBias: 1.0,
      focusedTriggerDiffBias: 1.0,
    },
  },
};

/**
 * Default models for each OpenCode provider type (used when building the dynamic model list).
 */
const OPENCODE_PROVIDER_DEFAULT_MODELS = {
  google: 'google/gemini-3.1-pro-preview',
  nvidia: 'nvidia/deepseek-ai/deepseek-v3.2',
  ollama: 'ollama/llama3.2',
  anthropic: 'anthropic/claude-sonnet-4-6',
  openai: 'openai/gpt-5.5',
};

const OPENCODE_PROVIDER_LABELS = {
  google: 'Gemini',
  nvidia: 'NVIDIA NIM',
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

const PROVIDER_CLI_DEFAULT_MODELS = {
  openai: 'gpt-5.3-codex',
  google: 'gemini-3-flash-preview',
};

const OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL = 'gpt-5.3-codex';
const OPENAI_CODEX_CLI_PREFERRED_MODEL = 'gpt-5.5';
const OPENAI_CODEX_CLI_AUTO_MODEL_ORDER = [
  OPENAI_CODEX_CLI_PREFERRED_MODEL,
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-5.4',
  OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL,
];
const CODEX_MODEL_CATALOG_TIMEOUT_MS = parseTimeoutMs(
  process.env.ATLAS_CODEX_MODEL_CATALOG_TIMEOUT_MS,
  1500,
  { min: 250, max: 10000 }
);
const CODEX_MODEL_REFRESH_TTL_MS = parseTimeoutMs(
  process.env.ATLAS_CODEX_MODEL_REFRESH_TTL_MS,
  6 * 60 * 60 * 1000,
  { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 }
);

const CLI_ERROR_AUTO_HEAL_COOLDOWN_MS = 60_000;
let codexCatalogRefreshInFlight = null;
// Singleton in-flight background scan promise. getProviders() kicks off
// fullScan() in the background and returns cached data immediately; this
// dedupes concurrent triggers so we don't pile up CLI probes.
let _bgScanPromise = null;

function getCurrentAtlasAppVersion() {
  const envVersion = String(process.env.ATLAS_APP_VERSION || '').trim();
  if (envVersion) return envVersion;

  try {
    const desktopPackagePath = path.join(__dirname, '..', '..', '..', 'apps', 'desktop', 'package.json');
    const desktopPackage = JSON.parse(fsSync.readFileSync(desktopPackagePath, 'utf8'));
    const desktopVersion = String(desktopPackage?.version || '').trim();
    if (desktopVersion) return desktopVersion;
  } catch {
    // Bundled desktop builds pass ATLAS_APP_VERSION instead.
  }

  return null;
}

function hasRecoverableCliAuthMetadata(provider) {
  return !!(
    provider?._authType
    || provider?._useClaudeCLI
    || provider?._useCodexCLI
    || provider?._useGeminiCLI
    || provider?._useOpenCodeCLI
    || typeof provider?._credentialSource === 'string'
  );
}

function shouldAutoHealRecoverableCliError(provider, now = Date.now()) {
  if (
    provider?.source !== 'cli_detected'
    || provider?.status !== 'error'
    || !hasRecoverableCliAuthMetadata(provider)
  ) {
    return false;
  }

  if (!provider._lastAutoHealAt) {
    return true;
  }

  const lastAttemptAt = Date.parse(provider._lastAutoHealAt);
  if (!Number.isFinite(lastAttemptAt)) {
    return true;
  }

  return now - lastAttemptAt > CLI_ERROR_AUTO_HEAL_COOLDOWN_MS;
}

const GOOGLE_CLI_UNSUPPORTED_MODELS = new Set([
  // Gemini CLI rejects 3.1 Pro preview; migrate cli-detected providers to Flash instead.
  'gemini-3.1-pro-preview',
]);

const OPENAI_CLI_LEGACY_DEFAULT_MODELS = new Set([
  // API/frontier defaults are not safe defaults for subscription-backed Codex
  // CLI accounts. Let CLI-detected providers start on the Codex model instead.
  'gpt-5.4',
  'gpt-5.4-nano',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
]);

/**
 * Which OpenCode provider backends support tool/function calling in the builder chat.
 * Providers marked false are filtered from the builder model dropdown.
 */
const OPENCODE_PROVIDER_TOOL_SUPPORT = {
  anthropic: true,
  openai: true,
  nvidia: true,    // has SOME tool-capable models (filtered individually)
  google: false,   // upstream OpenCode tool schema bug
  ollama: false,   // local models — no verified tool support
};

const REVIEW_MODEL_DEFAULTS = {
  anthropic: {
    triage: 'claude-haiku-4-5-20251001',
    // Walkthrough is structural narration only — alias to the triage tier by
    // default. Kept explicit (not inferred from `triage`) so a future
    // per-provider tuning is one-line. Phase 11.
    walkthrough: 'claude-haiku-4-5-20251001',
    // Default to Sonnet 4.6 for review: balanced cost/quality. Users who want
    // Opus can pick it explicitly in the provider dropdown — Balanced strategy
    // honors the user's selection.
    review: 'claude-sonnet-4-6',
    synthesis: 'claude-sonnet-4-6',
    verifier: 'claude-sonnet-4-6',
  },
  openai: {
    triage: 'gpt-5.4-nano',
    walkthrough: 'gpt-5.4-nano',
    review: 'gpt-5.5',
    synthesis: 'gpt-5.5',
    verifier: 'gpt-5.5',
  },
  google: {
    triage: 'gemini-3.1-flash-lite-preview',
    walkthrough: 'gemini-3.1-flash-lite-preview',
    review: 'gemini-3.1-pro-preview',
    synthesis: 'gemini-3.1-pro-preview',
    verifier: 'gemini-3.1-pro-preview',
  },
  opencode: {
    triage: 'opencode-default',
    walkthrough: 'opencode-default',
    review: 'opencode-default',
    synthesis: 'opencode-default',
    verifier: 'opencode-default',
  },
};

const REVIEW_MODEL_CLI_DEFAULTS = {
  openai: {
    triage: OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL,
    walkthrough: OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL,
    review: OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL,
    synthesis: OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL,
    verifier: OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL,
  },
  google: {
    triage: 'gemini-3.1-flash-lite-preview',
    walkthrough: 'gemini-3.1-flash-lite-preview',
    review: 'gemini-3-flash-preview',
    synthesis: 'gemini-3-flash-preview',
    verifier: 'gemini-3-flash-preview',
  },
};

const REVIEW_MODEL_COST_AWARE_DEFAULTS = {
  anthropic: {
    review: 'claude-sonnet-4-6',
    synthesis: 'claude-sonnet-4-6',
    verifier: 'claude-sonnet-4-6',
  },
  openai: {
    review: 'gpt-5.3-codex',
    synthesis: 'gpt-5.3-codex',
    verifier: 'gpt-5.3-codex',
  },
  google: {
    review: 'gemini-3-flash-preview',
    synthesis: 'gemini-3-flash-preview',
    verifier: 'gemini-3-flash-preview',
  },
  opencode: {
    review: 'opencode-default',
    synthesis: 'opencode-default',
    verifier: 'opencode-default',
  },
};

function parseTimeoutMs(rawValue, fallback, { min = 1, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(rawValue);
  const normalized = Number.isFinite(parsed) ? Math.trunc(parsed) : Math.trunc(fallback);
  return Math.min(max, Math.max(min, normalized));
}

const CLI_AUTH_TEST_TIMEOUT_MS = parseTimeoutMs(
  process.env.ATLAS_PROVIDER_CLI_AUTH_TIMEOUT_MS,
  15000,
  { min: 3000, max: 120000 }
);

const PROVIDER_TEST_TIMEOUT_MS = parseTimeoutMs(
  process.env.ATLAS_PROVIDER_TEST_TIMEOUT_MS,
  15000,
  { min: 3000, max: 120000 }
);

const GEMINI_AUTH_TYPES = {
  LOGIN_WITH_GOOGLE: 'oauth-personal',
  USE_GEMINI: 'gemini-api-key',
  USE_VERTEX_AI: 'vertex-ai',
  COMPUTE_ADC: 'compute-default-credentials',
};

function getGeminiSettingsPaths() {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    return [];
  }

  return [
    path.join(homeDir, '.gemini', 'settings.json'),
    path.join(homeDir, 'Library', 'Application Support', 'GeminiCli', 'settings.json'),
  ];
}

function getGeminiSelectedAuthType(config) {
  const selectedType = config?.security?.auth?.selectedType;
  return typeof selectedType === 'string' && selectedType.trim() ? selectedType.trim() : null;
}

function hasGeminiVertexCredentialsConfigured() {
  const googleCloudProject =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID;

  return Boolean(
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    (googleCloudProject && process.env.GOOGLE_CLOUD_LOCATION)
  );
}

function getClaudeWindowsPrerequisiteStatus(binaryPath) {
  if (process.platform !== 'win32' || !binaryPath) {
    return null;
  }

  const envVar = 'CLAUDE_CODE_GIT_BASH_PATH';
  const configuredPath = process.env[envVar]?.trim();
  const hasConfiguredPath = Boolean(configuredPath);
  if (configuredPath) {
    if (fsSync.existsSync(configuredPath)) {
      return {
        type: 'git-bash',
        status: 'ok',
        envVar,
        detectedPath: configuredPath,
        message: 'Git Bash is configured for Claude Code.',
      };
    }

  }

  const candidates = [
    path.join(getAppDataDir(), 'portable-git', 'bin', 'bash.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
  ].filter(Boolean);

  const detectedPath = candidates.find((candidate) => fsSync.existsSync(candidate)) || null;
  if (detectedPath) {
    return {
      type: 'git-bash',
      status: hasConfiguredPath ? 'detected_not_configured' : 'detected_not_configured',
      envVar,
      detectedPath,
      message: hasConfiguredPath
        ? 'Claude Code on Windows found a different Git Bash than the one currently configured.'
        : 'Claude Code on Windows requires Git Bash. Git Bash was detected, but Claude Code is not configured to use it.',
      remediation: `Set ${envVar} to ${detectedPath}.`,
    };
  }

  return {
    type: 'git-bash',
    status: 'missing',
    envVar,
    detectedPath: configuredPath || null,
    message: hasConfiguredPath
      ? 'Claude Code on Windows could not find the configured Git Bash path.'
      : 'Claude Code on Windows requires Git Bash before login will work.',
    remediation: hasConfiguredPath
      ? 'Install Git for Windows or update CLAUDE_CODE_GIT_BASH_PATH to a valid bash.exe path.'
      : 'Install Git for Windows, then set CLAUDE_CODE_GIT_BASH_PATH to bash.exe if Git Bash is not already on PATH.',
  };
}

/**
 * In-memory provider state. Persisted to .atlas/providers.json per-project
 * and global settings for BYOK keys.
 */
let globalProviders = [];
let activeProviderId = null;

/**
 * Path to global provider config (shared across projects)
 */
function getGlobalConfigPath() {
  const dataDir = process.env.ATLAS_DATA_DIR || path.join(__dirname, '..', '..');
  return path.join(dataDir, '.atlas-providers.json');
}

/**
 * Load global provider config from disk
 */
async function loadGlobalConfig() {
  try {
    const content = await fs.readFile(getGlobalConfigPath(), 'utf8');
    const data = JSON.parse(content);
    globalProviders = data.providers || [];
    activeProviderId = data.activeProviderId || null;

    // Migrate providers whose persisted model is no longer in the valid list.
    // This happens when PROVIDER_CONFIGS models are updated (e.g. gpt-4o → gpt-5.x-codex).
    // Without this, <select value="gpt-4o"> visually shows the first option but the
    // underlying value stays stale, so reviews use the wrong model.
    let migrated = false;
    for (const provider of globalProviders) {
      const config = PROVIDER_CONFIGS[provider.type];
      if (!config) continue;
      // Skip OpenCode — its models are dynamic (resolved from OpenCode's own config)
      if (provider.type === 'opencode') continue;
      const previousModel = provider.model;
      const previousModelSelectionSource = provider._modelSelectionSource;
      normalizeCliDetectedProviderModel(provider);
      if (
        provider.model !== previousModel
        || provider._modelSelectionSource !== previousModelSelectionSource
      ) {
        migrated = true;
      }
      const validIds = config.models.map(m => m.id);
      if (provider.model && !validIds.includes(provider.model)) {
        provider.model = config.defaultModel;
        migrated = true;
      }
    }
    if (migrated) {
      await saveGlobalConfig();
    }

    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      globalProviders = [];
      activeProviderId = null;
      return { providers: [], activeProviderId: null };
    }
    throw error;
  }
}

/**
 * Save global provider config to disk
 */
async function saveGlobalConfig() {
  const configPath = getGlobalConfigPath();
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });
  const data = {
    version: 1,
    appVersion: getCurrentAtlasAppVersion(),
    providers: globalProviders,
    activeProviderId,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, configPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

/**
 * Scan for CLI-detected providers on the local machine
 * @returns {Promise<Array>} Detected providers
 */
async function scanForCLIProviders() {
  const disableAmbientCliDetection = process.env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION === '1';

  // Run all CLI detectors in parallel
  const [claudeProvider, codexProvider, geminiProvider, opencodeProvider, ollamaProvider, lmStudioProvider, openaiCompatProvider] =
    await Promise.all([
      detectClaudeCode(),
      detectCodexCLI(),
      detectGeminiCLI(),
      detectOpenCodeCLI(),
      detectOllama(),
      detectLMStudio(),
      detectOpenAICompat(),
    ]);

  const detected = [claudeProvider, codexProvider, geminiProvider, opencodeProvider, ollamaProvider, lmStudioProvider, openaiCompatProvider]
    .filter(Boolean);

  if (disableAmbientCliDetection) {
    return [];
  }

  // Detect standalone API keys not already covered by a CLI provider
  const standaloneKeys = await detectStandaloneApiKeys(detected);
  detected.push(...standaloneKeys);

  return detected;
}

/**
 * Read on-disk Claude credentials from ~/.claude/.
 * Used as a fallback when `claude auth status --json` fails or is
 * unavailable (older CLI versions, macOS Keychain access denied to
 * subprocess, etc.). Returns null if no usable credentials are found.
 */
async function readClaudeFilesystemCredentials() {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) return null;
  const claudeConfigDir = path.join(homeDir, '.claude');
  try {
    await fs.access(claudeConfigDir);
  } catch {
    return null;
  }

  const credCandidates = [
    path.join(claudeConfigDir, '.credentials.json'),
    path.join(claudeConfigDir, 'credentials.json'),
  ];
  for (const credentialsPath of credCandidates) {
    try {
      const content = await fs.readFile(credentialsPath, 'utf8');
      const config = JSON.parse(content);
      const oauth = config?.claudeAiOauth;
      if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken.trim()) {
        return {
          authType: 'oauth',
          source: oauth.subscriptionType || 'subscription',
          credentialSource: `oauth:${credentialsPath}`,
        };
      }
    } catch {
      // try next candidate
    }
  }

  const apiKeyLocations = [
    path.join(claudeConfigDir, 'config.json'),
    path.join(claudeConfigDir, 'credentials.json'),
    path.join(claudeConfigDir, '.credentials'),
  ];
  for (const loc of apiKeyLocations) {
    try {
      const content = await fs.readFile(loc, 'utf8');
      const config = JSON.parse(content);
      const apiKey = config?.apiKey || config?.api_key || config?.anthropic_api_key
        || config?.ANTHROPIC_API_KEY || config?.token;
      if (apiKey && typeof apiKey === 'string' && apiKey.length > 10) {
        return {
          authType: 'api_key',
          source: 'config',
          credentialSource: `file:${loc}`,
        };
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

/**
 * Detect filesystem evidence that `claude login` was completed at some
 * point. Used as a last-resort signal for macOS Keychain-backed auth
 * where there are no on-disk credentials and `auth status --json` may
 * be silently denied. We deliberately stay on filesystem APIs only —
 * no Security framework / `security` CLI calls — so we cannot trigger
 * a Keychain access prompt.
 */
async function hasClaudePostLoginArtifacts() {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) return false;
  const claudeConfigDir = path.join(homeDir, '.claude');
  const artifactCandidates = [
    path.join(claudeConfigDir, 'projects'),
    path.join(claudeConfigDir, 'statsig'),
    path.join(claudeConfigDir, 'settings.json'),
    path.join(claudeConfigDir, '.claude.json'),
    path.join(claudeConfigDir, 'CLAUDE.md'),
  ];
  for (const artifact of artifactCandidates) {
    try {
      await fs.access(artifact);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

/**
 * Detect Claude Code CLI and extract credentials
 * @returns {Promise<Object|null>} Provider object or null
 */
async function detectClaudeCode() {
  try {
    const buildUnconfiguredClaudeProvider = (claudePath) => ({
      id: 'cli_anthropic',
      type: 'anthropic',
      source: 'cli_detected',
      label: 'Claude Code (installed - sign in required)',
      model: PROVIDER_CONFIGS.anthropic.defaultModel,
      isActive: false,
      status: 'error',
      lastCheckedAt: new Date().toISOString(),
      error: 'Claude Code is installed but not authenticated. Run `claude login` in your terminal, then re-scan.',
      _binaryPath: claudePath,
    });

    // Check for claude binary — use findClaudeBinary (absolute paths) first,
    // then fall back to findBinary (PATH-based `which`).
    // Desktop apps launched from Finder/Dock have minimal PATH, so absolute
    // path checks are essential.
    let claudePath = null;
    try {
      const result = await findClaudeBinary();
      if (result.binary !== 'npx') {
        claudePath = result.binary;
      }
    } catch { /* fall through */ }
    if (!claudePath) {
      claudePath = await findBinary('claude');
    }
    if (!claudePath) return null;

    // Look for API key in environment (includes dotenv-loaded vars)
    let envKey = process.env.ANTHROPIC_API_KEY;

    // Also check backend/.env directly if not in process.env
    // (handles cases where server.js CWD differs from backend/)
    if (!envKey) {
      const envPaths = [
        path.join(__dirname, '..', '..', '.env'),       // backend/.env
        path.join(process.cwd(), '.env'),                // CWD/.env
        path.join(process.cwd(), 'backend', '.env'),     // CWD/backend/.env
      ];
      for (const envPath of envPaths) {
        try {
          const content = await fs.readFile(envPath, 'utf8');
          const match = content.match(/^ANTHROPIC_API_KEY[ \t]*=[ \t]*["']?([^"'\r\n]+)["']?/m);
          if (match && match[1].trim()) {
            envKey = match[1].trim();
            break;
          }
        } catch {
          // File not found, continue
        }
      }
    }

    // Ignore placeholder/dummy API keys — they'll fail validation and hide
    // valid OAuth credentials that the ~/.claude check below would find.
    const isPlaceholder = !envKey
      || envKey === 'sk-ant-placeholder'
      || envKey.startsWith('sk-ant-placeholder')
      || envKey.length < 20;

    if (envKey && !isPlaceholder) {
      return {
        id: 'cli_anthropic',
        type: 'anthropic',
        source: 'cli_detected',
        label: 'Claude Code (detected)',
        model: PROVIDER_CONFIGS.anthropic.defaultModel,
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _credentialSource: 'env:ANTHROPIC_API_KEY',
        _binaryPath: claudePath,
        // Store the key directly if resolved from .env file (not in process.env)
        _resolvedKey: !process.env.ANTHROPIC_API_KEY ? envKey : undefined,
      };
    }

    const storedOAuthToken = await getStoredClaudeOAuthToken().catch(() => null);
    if (storedOAuthToken) {
      return {
        id: 'cli_anthropic',
        type: 'anthropic',
        source: 'cli_detected',
        label: 'Claude Code (stored OAuth token)',
        model: PROVIDER_CONFIGS.anthropic.defaultModel,
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _credentialSource: 'stored_oauth:claude',
        _authType: 'oauth',
        _binaryPath: claudePath,
      };
    }

    const cliAuthStatus = await getClaudeCliAuthStatus().catch(() => ({
      available: false,
      authenticated: false,
      source: null,
    }));
    if (cliAuthStatus.available && cliAuthStatus.authenticated) {
      return {
        id: 'cli_anthropic',
        type: 'anthropic',
        source: 'cli_detected',
        label: `Claude Code (${cliAuthStatus.source || 'subscription'}) — via CLI`,
        model: PROVIDER_CONFIGS.anthropic.defaultModel,
        isActive: false,
        status: 'connected',
        lastCheckedAt: new Date().toISOString(),
        _credentialSource: `cli_auth_status:${cliAuthStatus.source || 'unknown'}`,
        _authType: 'oauth',
        _useClaudeCLI: true,
        _binaryPath: claudePath,
      };
    }

    // Check ~/.claude/ config directory for credentials
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const claudeConfigDir = path.join(homeDir, '.claude');
    try {
      await fs.access(claudeConfigDir);
      // Config directory exists — Claude Code is installed

      // 1. Check for OAuth credentials (Claude subscription — Max/Pro)
      // Newer CLI versions use .credentials.json (dot-prefixed); older use credentials.json
      const credCandidates = [
        path.join(claudeConfigDir, '.credentials.json'),
        path.join(claudeConfigDir, 'credentials.json'),
      ];
      for (const credentialsPath of credCandidates) {
        try {
          const credContent = await fs.readFile(credentialsPath, 'utf8');
          const config = JSON.parse(credContent);
          const oauth = config.claudeAiOauth;
          if (oauth && oauth.accessToken && typeof oauth.accessToken === 'string') {
            // Don't pre-reject based on expiresAt — Claude Code may refresh the token
            // in-place. Let the connection test determine if it actually works.
            return {
              id: 'cli_anthropic',
              type: 'anthropic',
              source: 'cli_detected',
              label: `Claude Code (${oauth.subscriptionType || 'subscription'})`,
              model: PROVIDER_CONFIGS.anthropic.defaultModel,
              isActive: false,
              status: 'unchecked',
              lastCheckedAt: null,
              _credentialSource: `oauth:${credentialsPath}`,
              _authType: 'oauth',
              _binaryPath: claudePath,
            };
          }
        } catch {
          // file doesn't exist or isn't valid JSON — try next candidate
        }
      }

      // 2. Check for API keys in config files
      const credLocations = [
        path.join(claudeConfigDir, 'config.json'),
        path.join(claudeConfigDir, 'credentials.json'),
        path.join(claudeConfigDir, '.credentials'),
      ];

      for (const loc of credLocations) {
        try {
          const content = await fs.readFile(loc, 'utf8');
          const config = JSON.parse(content);
          // Look for API key in common field names
          const apiKey = config.apiKey || config.api_key || config.anthropic_api_key ||
                         config.ANTHROPIC_API_KEY || config.token;
          if (apiKey && typeof apiKey === 'string' && apiKey.length > 10) {
            return {
              id: 'cli_anthropic',
              type: 'anthropic',
              source: 'cli_detected',
              label: 'Claude Code (detected)',
              model: PROVIDER_CONFIGS.anthropic.defaultModel,
              isActive: false,
              status: 'unchecked',
              lastCheckedAt: null,
              _credentialSource: `file:${loc}`,
              _credentialField: Object.keys(config).find(k =>
                config[k] === apiKey
              ),
              _binaryPath: claudePath,
            };
          }
        } catch {
          // File doesn't exist or isn't valid JSON, continue
        }
      }

      // Binary exists but no extractable credentials. Before declaring
      // unconfigured, check for filesystem evidence of past `claude login`
      // (covers macOS Keychain / Windows Credential Manager installs that
      // store the token outside ~/.claude/). Unchecked + _useClaudeCLI
      // lets the rest of the pipeline route through the CLI rather than
      // showing a misleading "Run claude login" error.
      if (await hasClaudePostLoginArtifacts()) {
        return {
          id: 'cli_anthropic',
          type: 'anthropic',
          source: 'cli_detected',
          label: 'Claude Code (subscription) — via CLI',
          model: PROVIDER_CONFIGS.anthropic.defaultModel,
          isActive: false,
          status: 'unchecked',
          lastCheckedAt: null,
          _credentialSource: 'cli_keychain_artifacts',
          _authType: 'oauth',
          _useClaudeCLI: true,
          _binaryPath: claudePath,
        };
      }
      return buildUnconfiguredClaudeProvider(claudePath);
    } catch {
      // No .claude directory — binary found but no config
      return buildUnconfiguredClaudeProvider(claudePath);
    }
  } catch {
    return null;
  }
}

function normalizeCodexCatalogModelId(model) {
  if (typeof model === 'string') return model.trim();
  if (!model || typeof model !== 'object') return '';
  return String(model.slug || model.id || model.model || model.name || '').trim();
}

function isCodexCatalogModelUsable(model) {
  if (!model || typeof model !== 'object') return false;
  if (model.upgrade) return false;
  const visibility = typeof model.visibility === 'string' ? model.visibility.trim().toLowerCase() : '';
  return visibility !== 'hidden' && visibility !== 'disabled';
}

function buildCliProbeExecOptions(commandPath, options = {}) {
  const ext = path.extname(String(commandPath || '')).toLowerCase();
  const isWindowsShim = process.platform === 'win32' && (ext === '.cmd' || ext === '.bat');
  return {
    ...options,
    windowsHide: true,
    ...(isWindowsShim ? { shell: true } : {}),
  };
}

async function resolveCodexCliDetectedModel(codexPath) {
  if (!codexPath) return OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL;
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      codexPath,
      ['debug', 'models'],
      buildCliProbeExecOptions(codexPath, {
        timeout: CODEX_MODEL_CATALOG_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      })
    );
    const parsed = JSON.parse(stdout);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const available = new Set(
      models
        .filter(isCodexCatalogModelUsable)
        .map(normalizeCodexCatalogModelId)
        .filter(Boolean)
    );
    for (const model of OPENAI_CODEX_CLI_AUTO_MODEL_ORDER) {
      if (available.has(model)) {
        return model;
      }
    }
  } catch {
    // Older Codex CLIs may not expose `debug models`; keep setup fast and fall back.
  }
  return OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL;
}

function shouldRefreshCodexDetectedModel(provider, now = Date.now()) {
  if (!provider || provider.type !== 'openai') return false;
  if (provider.source !== 'cli_detected' || provider._authType !== 'codex_oauth') return false;
  if (provider._modelSelectionSource === 'user') return false;
  if (isLegacyImplicitCodexUserSelection(provider)) return false;
  const currentAppVersion = getCurrentAtlasAppVersion();
  if (currentAppVersion && provider._codexModelCatalogAppVersion !== currentAppVersion) {
    return true;
  }
  const lastRefreshAt = Date.parse(provider._codexModelCatalogCheckedAt || provider.lastCheckedAt || '');
  if (!Number.isFinite(lastRefreshAt)) return true;
  return now - lastRefreshAt > CODEX_MODEL_REFRESH_TTL_MS;
}

async function refreshDetectedCodexCliModel(provider, nowIso = new Date().toISOString()) {
  if (!provider || !shouldRefreshCodexDetectedModel(provider, Date.parse(nowIso))) {
    return false;
  }
  if (!codexCatalogRefreshInFlight) {
    codexCatalogRefreshInFlight = resolveCodexCatalogRefresh(nowIso)
      .finally(() => {
        codexCatalogRefreshInFlight = null;
      });
  }
  const result = await codexCatalogRefreshInFlight;
  applyCodexCatalogRefreshResult(provider, result);
  const currentProvider = globalProviders.find((candidate) => candidate.id === provider.id);
  if (currentProvider && currentProvider !== provider && shouldRefreshCodexDetectedModel(currentProvider, Date.now())) {
    applyCodexCatalogRefreshResult(currentProvider, result);
  }
  return true;
}

async function resolveCodexCatalogRefresh(nowIso) {
  const currentAppVersion = getCurrentAtlasAppVersion();
  const codexPath = await findBinary('codex');
  // If the binary disappeared, persist the attempted check timestamp so provider
  // reads do not hammer PATH lookup; validation will surface the missing runtime.
  if (!codexPath) {
    return {
      checkedAt: nowIso,
      appVersion: currentAppVersion,
      detectedModel: null,
      hasBinary: false,
    };
  }
  const detectedModel = await resolveCodexCliDetectedModel(codexPath);
  return {
    checkedAt: nowIso,
    appVersion: currentAppVersion,
    detectedModel,
    hasBinary: true,
  };
}

function applyCodexCatalogRefreshResult(provider, result) {
  provider._codexModelCatalogCheckedAt = result.checkedAt;
  if (result.appVersion) {
    provider._codexModelCatalogAppVersion = result.appVersion;
  }
  if (!result.hasBinary) return;
  if (result.detectedModel && provider.model !== result.detectedModel) {
    provider.model = result.detectedModel;
    provider._modelSelectionSource = 'detected';
  } else if (!provider._modelSelectionSource) {
    provider._modelSelectionSource = 'detected';
  }
}

function isClaudeCliBackedProvider(provider) {
  if (!provider || provider.type !== 'anthropic' || provider.source !== 'cli_detected') return false;
  if (provider._useClaudeCLI === true || provider._authType === 'oauth') return true;
  const credentialSource = typeof provider._credentialSource === 'string' ? provider._credentialSource : '';
  return credentialSource.startsWith('oauth:')
    || credentialSource.startsWith('stored_oauth:')
    || credentialSource.startsWith('cli_auth_status:');
}

function refreshDetectedClaudeCliModel(provider) {
  if (!isClaudeCliBackedProvider(provider)) return false;
  if (provider._modelSelectionSource === 'user') return false;
  if (isLegacyImplicitClaudeUserSelection(provider)) return false;
  const currentAppVersion = getCurrentAtlasAppVersion();
  if (!currentAppVersion || provider._claudeModelDefaultAppVersion === currentAppVersion) {
    return false;
  }
  provider.model = PROVIDER_CONFIGS.anthropic.defaultModel;
  provider._modelSelectionSource = 'detected';
  provider._claudeModelDefaultAppVersion = currentAppVersion;
  return true;
}

function isLegacyImplicitCodexUserSelection(provider) {
  if (!provider || provider._modelSelectionSource !== undefined) return false;
  const model = typeof provider.model === 'string' ? provider.model.trim() : '';
  if (!model) return false;
  return model !== OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL
    && model !== OPENAI_CODEX_CLI_PREFERRED_MODEL;
}

function isLegacyImplicitClaudeUserSelection(provider) {
  if (!provider || provider._modelSelectionSource !== undefined) return false;
  const model = typeof provider.model === 'string' ? provider.model.trim() : '';
  if (!model) return false;
  return model !== PROVIDER_CONFIGS.anthropic.defaultModel;
}

/**
 * Detect Codex CLI and extract credentials
 * @returns {Promise<Object|null>} Provider object or null
 */
async function detectCodexCLI() {
  try {
    // Check for codex binary
    const codexPath = await findBinary('codex');
    if (!codexPath) {
      // Also check for environment variable as signal
      if (!process.env.OPENAI_API_KEY) return null;
    }
    const codexCliModel = codexPath
      ? await resolveCodexCliDetectedModel(codexPath)
      : OPENAI_CODEX_CLI_SAFE_DEFAULT_MODEL;
    const codexModelCatalogCheckedAt = codexPath ? new Date().toISOString() : null;
    const codexModelCatalogAppVersion = getCurrentAtlasAppVersion();

    // OpenAI key from environment (most reliable path)
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) {
      return {
        id: 'cli_openai',
        type: 'openai',
        source: 'cli_detected',
        label: 'Codex CLI (detected)',
        model: PROVIDER_CONFIGS.openai.defaultModel,
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _credentialSource: 'env:OPENAI_API_KEY',
        _binaryPath: codexPath,
      };
    }

    // Check ~/.codex/ config
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const codexConfigDir = path.join(homeDir, '.codex');
    try {
      const configPath = path.join(codexConfigDir, 'config.json');
      const content = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(content);
      const apiKey = config.apiKey || config.api_key || config.openai_api_key || config.OPENAI_API_KEY;
      if (apiKey && typeof apiKey === 'string' && apiKey.length > 10) {
        return {
          id: 'cli_openai',
          type: 'openai',
          source: 'cli_detected',
          label: 'Codex CLI (detected)',
          model: PROVIDER_CONFIGS.openai.defaultModel,
          isActive: false,
          status: 'unchecked',
          lastCheckedAt: null,
          _credentialSource: `file:${configPath}`,
          _binaryPath: codexPath,
        };
      }
    } catch {
      // No config found
    }

    // Check ~/.codex/auth.json for ChatGPT OAuth tokens (subscription)
    const authPath = path.join(codexConfigDir, 'auth.json');
    try {
      const authContent = await fs.readFile(authPath, 'utf8');
      const auth = JSON.parse(authContent);
      if (auth.tokens && auth.tokens.access_token) {
        // Extract plan type from the JWT id_token claims
        let planType = 'subscription';
        try {
          const payload = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64').toString());
          planType = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type || 'subscription';
        } catch { /* use default */ }
        return {
          id: 'cli_openai',
          type: 'openai',
          source: 'cli_detected',
          label: `Codex CLI (${planType})`,
          model: codexCliModel,
          isActive: false,
          status: 'unchecked',
          lastCheckedAt: null,
          _credentialSource: `codex_oauth:${authPath}`,
          _authType: 'codex_oauth',
          _binaryPath: codexPath,
          _modelSelectionSource: 'detected',
          _codexModelCatalogCheckedAt: codexModelCatalogCheckedAt,
          _codexModelCatalogAppVersion: codexModelCatalogAppVersion,
        };
      }
    } catch { /* auth.json not found or invalid */ }

    if (codexPath) {
      return {
        id: 'cli_openai',
        type: 'openai',
        source: 'cli_detected',
        label: 'Codex CLI (detected — use BYOK)',
        model: codexCliModel,
        isActive: false,
        status: 'error',
        lastCheckedAt: new Date().toISOString(),
        error: 'Codex CLI found but credentials could not be extracted. Add an API key manually.',
        _binaryPath: codexPath,
        _modelSelectionSource: 'detected',
        _codexModelCatalogCheckedAt: codexModelCatalogCheckedAt,
        _codexModelCatalogAppVersion: codexModelCatalogAppVersion,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect Gemini CLI and extract credentials
 * @returns {Promise<Object|null>} Provider object or null
 */
async function detectGeminiCLI() {
  try {
    const geminiPath = await findBinary('gemini');
    if (!geminiPath) {
      // Also check for environment variable as signal
      if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) return null;
    }

    // 1. Check GEMINI_API_KEY env var
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && geminiKey.length > 10) {
      return {
        id: 'cli_google',
        type: 'google',
        source: 'cli_detected',
        label: 'Gemini CLI (detected)',
        model: getProviderCliDefaultModel('google'),
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _credentialSource: 'env:GEMINI_API_KEY',
        _binaryPath: geminiPath,
      };
    }

    // 2. Check GOOGLE_API_KEY env var
    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey && googleKey.length > 10) {
      return {
        id: 'cli_google',
        type: 'google',
        source: 'cli_detected',
        label: 'Gemini CLI (detected)',
        model: getProviderCliDefaultModel('google'),
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _credentialSource: 'env:GOOGLE_API_KEY',
        _binaryPath: geminiPath,
      };
    }

    // 3. Check ~/.gemini/.env for GEMINI_API_KEY
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const geminiEnvPath = path.join(homeDir, '.gemini', '.env');
    try {
      const content = await fs.readFile(geminiEnvPath, 'utf8');
      const match = content.match(/^GEMINI_API_KEY[ \t]*=[ \t]*["']?([^"'\r\n]+)["']?/m);
      if (match && match[1].trim() && match[1].trim().length > 10) {
        return {
          id: 'cli_google',
          type: 'google',
          source: 'cli_detected',
          label: 'Gemini CLI (detected)',
          model: getProviderCliDefaultModel('google'),
          isActive: false,
          status: 'unchecked',
          lastCheckedAt: null,
          _credentialSource: `gemini_env:${geminiEnvPath}`,
          _resolvedKey: match[1].trim(),
          _binaryPath: geminiPath,
        };
      }
    } catch { /* file not found */ }

    // 4. Check ~/.gemini/settings.json for stored API key
    const geminiSettingsPath = path.join(homeDir, '.gemini', 'settings.json');
    try {
      const content = await fs.readFile(geminiSettingsPath, 'utf8');
      const config = JSON.parse(content);
      const apiKey = config.apiKey || config.api_key || config.GEMINI_API_KEY;
      if (apiKey && typeof apiKey === 'string' && apiKey.length > 10) {
        return {
          id: 'cli_google',
          type: 'google',
          source: 'cli_detected',
          label: 'Gemini CLI (detected)',
          model: getProviderCliDefaultModel('google'),
          isActive: false,
          status: 'unchecked',
          lastCheckedAt: null,
          _credentialSource: `file:${geminiSettingsPath}`,
          _binaryPath: geminiPath,
        };
      }
    } catch { /* file not found or invalid */ }

    // 5. Check Gemini settings for an interactive auth method that the CLI can use directly.
    for (const settingsPath of getGeminiSettingsPaths()) {
      try {
        const content = await fs.readFile(settingsPath, 'utf8');
        const config = JSON.parse(content);
        const selectedType = getGeminiSelectedAuthType(config);
        if (!selectedType) {
          continue;
        }

        if (
          selectedType === GEMINI_AUTH_TYPES.LOGIN_WITH_GOOGLE ||
          selectedType === GEMINI_AUTH_TYPES.COMPUTE_ADC
        ) {
          return {
            id: 'cli_google',
            type: 'google',
            source: 'cli_detected',
            label: 'Gemini CLI (detected)',
            model: getProviderCliDefaultModel('google'),
            isActive: false,
            status: 'unchecked',
            lastCheckedAt: null,
            _credentialSource: `gemini_auth:${settingsPath}:${selectedType}`,
            _authType: 'gemini_cli',
            _binaryPath: geminiPath,
          };
        }

        if (
          selectedType === GEMINI_AUTH_TYPES.USE_VERTEX_AI &&
          hasGeminiVertexCredentialsConfigured()
        ) {
          return {
            id: 'cli_google',
            type: 'google',
            source: 'cli_detected',
            label: 'Gemini CLI (detected)',
            model: getProviderCliDefaultModel('google'),
            isActive: false,
            status: 'unchecked',
            lastCheckedAt: null,
            _credentialSource: `gemini_auth:${settingsPath}:${selectedType}`,
            _authType: 'gemini_cli',
            _binaryPath: geminiPath,
          };
        }
      } catch { /* file not found or invalid */ }
    }

    // 6. Check for Google ADC
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      return {
        id: 'cli_google',
        type: 'google',
        source: 'cli_detected',
        label: 'Gemini CLI (ADC)',
        model: getProviderCliDefaultModel('google'),
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _credentialSource: 'env:GOOGLE_APPLICATION_CREDENTIALS',
        _authType: 'gemini_cli',
        _binaryPath: geminiPath,
      };
    }

    // 7. Binary found but no extractable credentials — report as detected
    // with gemini_cli auth type to trigger CLI fallback
    if (geminiPath) {
      return {
        id: 'cli_google',
        type: 'google',
        source: 'cli_detected',
        label: 'Gemini CLI (detected)',
        model: getProviderCliDefaultModel('google'),
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _authType: 'gemini_cli',
        _binaryPath: geminiPath,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect OpenCode CLI and extract credentials
 * @returns {Promise<Object|null>} Provider object or null
 */
async function detectOpenCodeCLI() {
  try {
    // Check for opencode binary on PATH
    let opencodePath = await findBinary('opencode');

    // Also check for well-known install paths (desktop apps may have minimal PATH)
    if (!opencodePath) {
      const knownPaths = [
        path.join(process.env.HOME || '', '.opencode', 'bin', 'opencode'),
        '/usr/local/bin/opencode',
        '/opt/homebrew/bin/opencode',
        path.join(process.env.HOME || '', '.local', 'bin', 'opencode'),
        path.join(process.env.HOME || '', 'go', 'bin', 'opencode'),
      ];
      // Allow test override
      if (process.env.ATLAS_OPENCODE_PATH) {
        knownPaths.unshift(process.env.ATLAS_OPENCODE_PATH);
      }
      for (const p of knownPaths) {
        try {
          await fs.access(p);
          opencodePath = p;
          break;
        } catch { /* not found */ }
      }
    }
    if (!opencodePath) return null;

    let provider = null;

    // Check for OpenCode API key in environment
    const envKey = process.env.OPENCODE_API_KEY;
    if (envKey && envKey.length >= 10) {
      provider = {
        id: 'cli_opencode',
        type: 'opencode',
        source: 'cli_detected',
        label: 'OpenCode (detected)',
        model: PROVIDER_CONFIGS.opencode.defaultModel,
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _credentialSource: 'env:OPENCODE_API_KEY',
        _binaryPath: opencodePath,
      };
    }

    if (!provider) {
      // Check for OpenCode config directory (~/.opencode/ or $XDG_CONFIG_HOME/opencode/)
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
      const configCandidates = [
        path.join(homeDir, '.opencode'),
        path.join(xdgConfig, 'opencode'),
      ];

      for (const configDir of configCandidates) {
        if (provider) break;
        try {
          await fs.access(configDir);

          // Look for config.json with credentials
          const configFiles = [
            path.join(configDir, 'config.json'),
            path.join(configDir, 'credentials.json'),
          ];

          for (const configFile of configFiles) {
            try {
              const content = await fs.readFile(configFile, 'utf8');
              const config = JSON.parse(content);
              const apiKey = config.apiKey || config.api_key || config.token ||
                             config.OPENCODE_API_KEY;
              if (apiKey && typeof apiKey === 'string' && apiKey.length > 10) {
                provider = {
                  id: 'cli_opencode',
                  type: 'opencode',
                  source: 'cli_detected',
                  label: 'OpenCode (detected)',
                  model: PROVIDER_CONFIGS.opencode.defaultModel,
                  isActive: false,
                  status: 'unchecked',
                  lastCheckedAt: null,
                  _credentialSource: `file:${configFile}`,
                  _binaryPath: opencodePath,
                };
                break;
              }
            } catch { /* file not found or invalid JSON */ }
          }

          if (!provider) {
            // Config directory exists but no extractable credentials — binary found,
            // mark as opencode_cli auth type to enable CLI fallback
            provider = {
              id: 'cli_opencode',
              type: 'opencode',
              source: 'cli_detected',
              label: 'OpenCode (detected)',
              model: PROVIDER_CONFIGS.opencode.defaultModel,
              isActive: false,
              status: 'unchecked',
              lastCheckedAt: null,
              _authType: 'opencode_cli',
              _binaryPath: opencodePath,
            };
          }
        } catch { /* config dir not found */ }
      }
    }

    if (!provider) {
      // Binary found but no config directory — report as detected with CLI auth
      provider = {
        id: 'cli_opencode',
        type: 'opencode',
        source: 'cli_detected',
        label: 'OpenCode (detected)',
        model: PROVIDER_CONFIGS.opencode.defaultModel,
        isActive: false,
        status: 'unchecked',
        lastCheckedAt: null,
        _authType: 'opencode_cli',
        _binaryPath: opencodePath,
      };
    }

    // Resolve the effective OpenCode model from OpenCode itself so Atlas
    // matches the user's actual selection instead of only raw global config.
    if (process.env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION !== '1') {
      const activeModel = await resolveOpenCodeActiveModel(opencodePath);
      if (activeModel) {
        provider.model = activeModel;
      }
    }

    return provider;
  } catch {
    return null;
  }
}

/**
 * Detect Ollama running locally
 * Probes localhost:11434/api/tags with 2s timeout
 * @returns {Promise<Object|null>} Provider object or null
 */
async function detectOllama() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    const models = (data.models || []).map(m => m.name);
    return {
      id: 'local_ollama',
      type: 'ollama',
      source: 'local_detected',
      label: `Ollama (${models.length} model${models.length !== 1 ? 's' : ''})`,
      model: models[0] || 'llama3',
      isActive: false,
      status: 'unchecked',
      lastCheckedAt: null,
      _capabilities: ['review-api-only'],
      _availableModels: models,
    };
  } catch {
    return null;
  }
}

/**
 * Detect LM Studio running locally
 * Probes localhost:1234/v1/models with 2s timeout
 * @returns {Promise<Object|null>} Provider object or null
 */
async function detectLMStudio() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch('http://localhost:1234/v1/models', { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    const models = (data.data || []).map(m => m.id);
    return {
      id: 'local_lmstudio',
      type: 'lmstudio',
      source: 'local_detected',
      label: `LM Studio (${models.length} model${models.length !== 1 ? 's' : ''})`,
      model: models[0] || 'default',
      isActive: false,
      status: 'unchecked',
      lastCheckedAt: null,
      _capabilities: ['review-api-only'],
      _availableModels: models,
    };
  } catch {
    return null;
  }
}

/**
 * Detect OpenAI-compatible endpoint via env var
 * Checks ATLAS_OPENAI_COMPAT_URL and probes /v1/models
 * @returns {Promise<Object|null>} Provider object or null
 */
async function detectOpenAICompat() {
  const baseUrl = process.env.ATLAS_OPENAI_COMPAT_URL;
  if (!baseUrl) return null;
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/v1/models';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    const models = (data.data || []).map(m => m.id);
    return {
      id: 'openai_compat',
      type: 'openai_compat',
      source: 'env_detected',
      label: `OpenAI-Compatible (${baseUrl})`,
      model: models[0] || 'default',
      isActive: false,
      status: 'unchecked',
      lastCheckedAt: null,
      _capabilities: ['review-api-only'],
      _availableModels: models,
    };
  } catch {
    return null;
  }
}

/**
 * Detect standalone API keys that don't have a corresponding CLI installed
 * @param {Array} cliDetected - Already-detected CLI providers
 * @returns {Promise<Array>} Array of standalone key providers
 */
async function detectStandaloneApiKeys(cliDetected) {
  const detected = [];
  const cliTypes = new Set(cliDetected.map(p => p.type));

  // OpenAI API key without Codex CLI
  if (!cliTypes.has('openai') && process.env.OPENAI_API_KEY) {
    detected.push({
      id: 'key_openai',
      type: 'openai',
      source: 'env_key',
      label: 'OpenAI API Key',
      model: PROVIDER_CONFIGS.openai.defaultModel,
      isActive: false,
      status: 'unchecked',
      lastCheckedAt: null,
      _capabilities: ['review-api-only'],
      _credentialSource: 'env:OPENAI_API_KEY',
    });
  }

  // Google API key without Gemini CLI
  if (!cliTypes.has('google') && process.env.GOOGLE_API_KEY) {
    detected.push({
      id: 'key_google',
      type: 'google',
      source: 'env_key',
      label: 'Google API Key',
      model: 'gemini-2.0-flash',
      isActive: false,
      status: 'unchecked',
      lastCheckedAt: null,
      _capabilities: ['review-api-only'],
      _credentialSource: 'env:GOOGLE_API_KEY',
    });
  }

  return detected;
}

/**
 * Find a binary on the system PATH
 * @param {string} name - Binary name
 * @returns {Promise<string|null>} Path to binary or null
 */
// Cache for findBinary() so repeated `which` lookups during one settings open
// don't spawn 5+ child processes. TTL is short so PATH changes (user installs
// a CLI in another terminal) are picked up within ~30s, and we always clear
// it when the user explicitly re-scans.
const FIND_BINARY_CACHE_TTL_MS = 30_000;
const _findBinaryCache = new Map();

function clearFindBinaryCache() {
  _findBinaryCache.clear();
}

async function findBinary(name) {
  if (name === 'claude') {
    try {
      const result = await findClaudeBinary({ allowNpx: false });
      return result?.binary || null;
    } catch {
      return null;
    }
  }

  // findCodexBinary owns its own caching/probing (model catalog, version, etc.)
  if (name === 'codex') {
    return findCodexBinary();
  }

  // Include the env vars findBinary actually reads in the cache key so any
  // change to PATH or HOME (e.g. tests swapping into a fake bin dir, or a
  // user installing a CLI in another shell) invalidates the entry naturally.
  const cacheKey = `${name}|${process.env.PATH || ''}|${process.env.HOME || process.env.USERPROFILE || ''}|${process.env.LOCALAPPDATA || ''}|${process.env.APPDATA || ''}`;
  const cached = _findBinaryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await _findBinaryUncached(name);
  _findBinaryCache.set(cacheKey, { value, expiresAt: Date.now() + FIND_BINARY_CACHE_TTL_MS });
  return value;
}

async function _findBinaryUncached(name) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const isWindows = process.platform === 'win32';
  if (isWindows) {
    for (const candidate of getWindowsCliShimCandidates(name)) {
      try {
        fsSync.accessSync(candidate, fsSync.constants.F_OK);
        return resolveWindowsCliExecutablePath(candidate);
      } catch {
        // Not found, try next user-installed shim.
      }
    }
  }

  // Fall back to PATH lookup
  try {
    const cmd = isWindows ? 'where' : 'which';
    const { stdout } = await execFileAsync(cmd, [name], { timeout: 5000 });
    const binPath = stdout.trim().split(/\r?\n/)[0].trim();
    if (!binPath) return null;
    return resolveWindowsCliExecutablePath(binPath);
  } catch {
    return null;
  }
}

function isExecutableFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }

  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveRunnableClaudeBinary(provider = null) {
  const detectedBinaryPath = provider?._binaryPath;
  if (isExecutableFile(detectedBinaryPath) && !isAtlasManagedClaudeBinaryPath(detectedBinaryPath)) {
    return detectedBinaryPath;
  }

  try {
    const claudeBin = await findClaudeBinary();
    if (claudeBin.binary !== 'npx') {
      return claudeBin.binary;
    }
  } catch {
    // Fall through to PATH lookup.
  }

  return findBinary('claude');
}

async function validateClaudeCliConnection(provider = null) {
  try {
    const claudeBin = await resolveRunnableClaudeBinary(provider);
    if (!claudeBin) {
      return {
        connected: false,
        binaryPath: null,
        error: 'Claude CLI no longer found. Re-scan or add an API key.',
      };
    }

    const authStatus = await getClaudeCliAuthStatus();
    if (authStatus.available && authStatus.authenticated) {
      return {
        connected: true,
        binaryPath: claudeBin,
        source: authStatus.source || null,
      };
    }

    // `claude auth status --json` can fail or return false-negative on
    // older CLI versions (subcommand/flag not supported, output format
    // changed) and on macOS where Keychain access from a subprocess can
    // be silently denied. Mirror detectClaudeCode's filesystem fallback
    // so a re-scan does not flip a working install to "Run claude login".
    const fsCredentials = await readClaudeFilesystemCredentials();
    if (fsCredentials) {
      return {
        connected: true,
        binaryPath: claudeBin,
        source: fsCredentials.source,
        credentialSource: fsCredentials.credentialSource,
      };
    }

    // Last resort for Keychain-backed installs (no on-disk credentials).
    // If filesystem artifacts prove the CLI has been used post-login,
    // mark as unchecked rather than flipping to "Run claude login" —
    // the first real review will surface the actual CLI error if auth
    // is genuinely broken, which is more accurate than our guess.
    // Filesystem-only signal: never accesses Keychain APIs, so no OS
    // permission prompt can fire from this code path.
    if (await hasClaudePostLoginArtifacts()) {
      if (authStatus.error) {
        console.warn(
          `[providerService] Claude CLI auth check failed at ${claudeBin}: ${authStatus.error}. ` +
          'Filesystem artifacts indicate prior login (likely Keychain-backed); deferring auth verification to first review.'
        );
      }
      return {
        unchecked: true,
        binaryPath: claudeBin,
        source: null,
      };
    }

    if (authStatus.error) {
      console.warn(
        `[providerService] Claude CLI auth check failed at ${claudeBin}: ${authStatus.error}. ` +
        'No on-disk credentials or post-login artifacts; reporting unauthenticated.'
      );
    }

    return {
      connected: false,
      binaryPath: claudeBin,
      error: 'Claude CLI is installed but not authenticated. Run `claude login` in your terminal, then re-scan.',
    };
  } catch {
    return {
      connected: false,
      binaryPath: null,
      error: 'Claude CLI no longer found. Re-scan or add an API key.',
    };
  }
}

/**
 * Test Codex CLI authentication by running a trivial prompt.
 * Returns true if codex exec succeeds, false if auth fails.
 */
async function testCodexAuth(codexPath) {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const args = ['exec', '--skip-git-repo-check', '-'];
    if (cliInstallService.isWindowsSandboxEnvironment()) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    const isWindowsCommandShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(codexPath || ''));
    const child = spawn(
      isWindowsCommandShim ? (process.env.ComSpec || 'cmd.exe') : codexPath,
      isWindowsCommandShim ? ['/d', '/c', codexPath, ...args] : args,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
        windowsHide: true,
      },
    );

    let err = '';
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    // Send a trivial prompt and close stdin
    child.stdin.write('Reply with exactly: ok');
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // Timeout likely means the CLI is working (slow model response) — treat as connected
      resolve(true);
    }, CLI_AUTH_TEST_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(true);
      } else {
        // Check tail of stderr for auth errors (avoid false positives from echoed prompt)
        const errTail = err.slice(-300).toLowerCase();
        const isAuthError = errTail.includes('not authenticated') ||
          errTail.includes('authentication failed') ||
          errTail.includes('please log in') ||
          errTail.includes('please login') ||
          errTail.includes('unauthorized') ||
          errTail.includes('invalid token') ||
          errTail.includes('token expired') ||
          (errTail.includes('error') && errTail.includes('auth'));
        if (isAuthError) {
          resolve(false);
        } else {
          // Non-auth error (e.g. rate limit, network) — binary works, auth likely ok
          resolve(true);
        }
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Get the API key for a provider (resolves from source)
 * @param {Object} provider - Provider object
 * @returns {Promise<string|null>} API key or null
 */
async function getProviderApiKey(provider) {
  // BYOK: key stored encrypted in provider config
  if (provider._encryptedKey) {
    try {
      return decrypt(provider._encryptedKey);
    } catch {
      return null;
    }
  }

  // CLI detected: resolve from source
  if (provider._credentialSource) {
    const source = provider._credentialSource;

    if (source.startsWith('env:')) {
      const envVar = source.substring(4);
      // Try process.env first, fall back to resolved key from .env file scan
      return process.env[envVar] || provider._resolvedKey || null;
    }

    if (source === 'stored_oauth:claude') {
      return getStoredClaudeOAuthToken();
    }

    // OAuth: read access token from Claude Code credentials
    if (source.startsWith('oauth:')) {
      const filePath = source.substring(6);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const config = JSON.parse(content);
        const oauth = config.claudeAiOauth;
        if (oauth && oauth.accessToken) {
          // Try the token even if expiresAt suggests it's stale —
          // Claude Code may have refreshed it internally.
          // The connection test will determine actual validity.
          return oauth.accessToken;
        }
      } catch {
        return null;
      }
    }

    // Codex OAuth: read access token from ~/.codex/auth.json
    // The token won't work with the OpenAI API directly, but returning it
    // lets fullScan() reach the codex_oauth fallback branch after testConnection fails.
    if (source.startsWith('codex_oauth:')) {
      const filePath = source.substring(12);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const auth = JSON.parse(content);
        if (auth.tokens && auth.tokens.access_token) {
          return auth.tokens.access_token;
        }
      } catch {
        return null;
      }
    }

    // Gemini .env file: parse GEMINI_API_KEY from ~/.gemini/.env
    if (source.startsWith('gemini_env:')) {
      const filePath = source.substring(11);
      // Try resolved key first, then re-read the file
      if (provider._resolvedKey) return provider._resolvedKey;
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const match = content.match(/^GEMINI_API_KEY[ \t]*=[ \t]*["']?([^"'\r\n]+)["']?/m);
        if (match && match[1].trim()) {
          return match[1].trim();
        }
      } catch {
        return null;
      }
    }

    if (source.startsWith('file:')) {
      const filePath = source.substring(5);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const config = JSON.parse(content);
        // Try common key field names
        return config.apiKey || config.api_key || config.anthropic_api_key ||
               config.openai_api_key || config.GEMINI_API_KEY ||
               config.ANTHROPIC_API_KEY || config.OPENAI_API_KEY ||
               config.token || null;
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Build auth headers for a provider
 * @param {string} providerType - 'anthropic' or 'openai'
 * @param {string} apiKey - API key or OAuth token
 * @param {string} [authType] - 'oauth' for Bearer token, otherwise uses provider default
 * @returns {Object} Headers object
 */
function buildAuthHeaders(providerType, apiKey, authType) {
  const config = PROVIDER_CONFIGS[providerType];
  if (!config) return {};

  // OAuth tokens use Authorization: Bearer
  if (authType === 'oauth') {
    return {
      'Authorization': `Bearer ${apiKey}`,
      ...config.versionHeader,
    };
  }

  // Standard API key auth
  if (config.headerPrefix) {
    return {
      [config.headerKey]: `${config.headerPrefix}${apiKey}`,
      ...config.versionHeader,
    };
  }

  return {
    [config.headerKey]: apiKey,
    ...config.versionHeader,
  };
}

/**
 * Test connection to a provider
 * @param {string} providerType - 'anthropic' or 'openai'
 * @param {string} apiKey - API key to test
 * @param {{ authType?: string }} [options] - Options (authType: 'oauth' for Bearer token)
 * @returns {Promise<{success: boolean, latencyMs: number, error?: string}>}
 */
async function testConnection(providerType, apiKey, options = {}) {
  const config = PROVIDER_CONFIGS[providerType];
  if (!config) {
    return { success: false, latencyMs: 0, error: `Unknown provider type: ${providerType}` };
  }

  const startTime = Date.now();
  const authHeaders = buildAuthHeaders(providerType, apiKey, options.authType);

  try {
    if (providerType === 'anthropic') {
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startTime;

      if (response.ok || response.status === 200) {
        return { success: true, latencyMs };
      }

      // 401 = bad key, 429 = rate limited (key is valid though)
      if (response.status === 429) {
        return { success: true, latencyMs };
      }

      const body = await response.json().catch(() => ({}));
      return {
        success: false,
        latencyMs,
        error: body.error?.message || `HTTP ${response.status}`,
      };
    }

    if (providerType === 'openai') {
      const response = await fetch(config.testUrl, {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return { success: true, latencyMs };
      }

      if (response.status === 429) {
        return { success: true, latencyMs };
      }

      const body = await response.json().catch(() => ({}));
      return {
        success: false,
        latencyMs,
        error: body.error?.message || `HTTP ${response.status}`,
      };
    }

    if (providerType === 'google') {
      // Gemini API: list models endpoint — lightweight, no body needed
      const url = `${config.testUrl}?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return { success: true, latencyMs };
      }

      // 429 = rate limited (key is valid)
      if (response.status === 429) {
        return { success: true, latencyMs };
      }

      const body = await response.json().catch(() => ({}));
      return {
        success: false,
        latencyMs,
        error: body.error?.message || `HTTP ${response.status}`,
      };
    }

    if (providerType === 'nvidia') {
      // NVIDIA NIM uses OpenAI-compatible API
      const response = await fetch('https://integrate.api.nvidia.com/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return { success: true, latencyMs };
      }

      if (response.status === 429) {
        return { success: true, latencyMs };
      }

      const body = await response.json().catch(() => ({}));
      return {
        success: false,
        latencyMs,
        error: body.error?.message || `HTTP ${response.status}`,
      };
    }

    return { success: false, latencyMs: 0, error: 'Unsupported provider type' };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return {
      success: false,
      latencyMs,
      error: error.name === 'TimeoutError' ? 'Connection timed out' : error.message,
    };
  }
}

/**
 * Add or update a BYOK provider
 * @param {string} providerType - 'anthropic' or 'openai'
 * @param {string} apiKey - API key
 * @param {string} [model] - Model override
 * @returns {Promise<Object>} Created/updated provider
 */
async function addBYOKProvider(providerType, apiKey, model) {
  const config = PROVIDER_CONFIGS[providerType];
  if (!config) throw new Error(`Unknown provider type: ${providerType}`);

  await loadGlobalConfig();

  const id = `byok_${providerType}`;
  const encryptedKey = encrypt(apiKey);

  // Test connection first
  const testResult = await testConnection(providerType, apiKey);

  const provider = {
    id,
    type: providerType,
    source: 'byok',
    label: `${config.label} (API Key)`,
    model: model || config.defaultModel,
    isActive: false,
    status: testResult.success ? 'connected' : 'error',
    lastCheckedAt: new Date().toISOString(),
    error: testResult.success ? undefined : testResult.error,
    _encryptedKey: encryptedKey,
  };

  // Replace existing or add new
  const existingIdx = globalProviders.findIndex(p => p.id === id);
  if (existingIdx >= 0) {
    globalProviders[existingIdx] = provider;
  } else {
    globalProviders.push(provider);
  }

  // Auto-activate if this is the only connected provider
  const connectedProviders = globalProviders.filter(p => p.status === 'connected');
  if (connectedProviders.length === 1 && testResult.success) {
    activeProviderId = id;
    provider.isActive = true;
  }

  await saveGlobalConfig();
  return sanitizeProvider(provider);
}

/**
 * Remove a BYOK provider
 * @param {string} providerId - Provider ID to remove
 */
async function removeBYOKProvider(providerId) {
  await loadGlobalConfig();
  globalProviders = globalProviders.filter(p => p.id !== providerId);
  if (activeProviderId === providerId) {
    activeProviderId = null;
    // Auto-activate first connected provider
    const connected = globalProviders.find(p => p.status === 'connected');
    if (connected) {
      activeProviderId = connected.id;
      connected.isActive = true;
    }
  }
  await saveGlobalConfig();
}

/**
 * Set the active provider
 * @param {string} providerId - Provider ID to activate
 */
async function setActiveProvider(providerId) {
  await loadGlobalConfig();

  const provider = globalProviders.find(p => p.id === providerId);
  if (!provider) throw new Error('Provider not found');

  // Deactivate all
  for (const p of globalProviders) {
    p.isActive = false;
  }

  provider.isActive = true;
  activeProviderId = providerId;
  await saveGlobalConfig();
  return sanitizeProvider(provider);
}

/**
 * Update model for a provider
 * @param {string} providerId - Provider ID
 * @param {string} model - New model ID
 */
async function updateProviderModel(providerId, model) {
  await loadGlobalConfig();
  const provider = globalProviders.find(p => p.id === providerId);
  if (!provider) throw new Error('Provider not found');
  provider.model = model;
  provider._modelSelectionSource = 'user';
  await saveGlobalConfig();
  return sanitizeProvider(provider);
}

/**
 * Get all providers (sanitized — no credentials in response)
 * @returns {Promise<{providers: Array, activeProvider: Object|null}>}
 */
async function getProviders() {
  await loadGlobalConfig();
  const autoHealScanStartedAt = new Date().toISOString();
  const autoHealScanStartedAtMs = Date.parse(autoHealScanStartedAt);

  // Auto-scan on first access when no providers are currently loaded.
  // A stale persisted activeProviderId can survive after providers were removed
  // or detection changed, and in that case we still need a fresh scan.
  if (globalProviders.length === 0) {
    return fullScan();
  }

  // Auto-scan when any CLI-detected provider is stale (missing _authType from
  // older detection code). This catches providers persisted before auth.json
  // detection was added — they'll have source='cli_detected' and status='error'
  // but no _authType, so validateAll can't trigger CLI fallback. A fresh scan
  // re-detects properly.
  const hasStaleCliProvider = globalProviders.some(
    p => p.source === 'cli_detected' && p.status === 'error' && !p._authType
  );
  // Auto-heal persisted CLI detections that already have recoverable auth
  // metadata. Earlier builds could persist a CLI provider in `error` even
  // though the CLI auth probe or validation path would now promote it to
  // connected. Re-scan on read so users do not need to click "Test" first.
  const hasRecoverableCliErrorProvider = globalProviders.some(
    p => shouldAutoHealRecoverableCliError(p, autoHealScanStartedAtMs)
  );
  // Auto-heal persisted CLI detections that were saved before validation ran.
  // This can happen in desktop flows where a provider is detected during setup,
  // but the persisted cache still contains `status: unchecked` and no active
  // provider. A normal read should promote that into the validated/activated
  // state rather than forcing the user to hit "Re-scan".
  const hasUncheckedCliProvider = globalProviders.some(
    p => p.source === 'cli_detected' && p.status === 'unchecked'
  );
  const hasConnectedProviderWithoutActive = !activeProviderId
    && globalProviders.some(p => p.status === 'connected');

  if (
    hasStaleCliProvider
    || hasRecoverableCliErrorProvider
    || hasUncheckedCliProvider
    || hasConnectedProviderWithoutActive
  ) {
    if (hasRecoverableCliErrorProvider) {
      for (const provider of globalProviders) {
        if (shouldAutoHealRecoverableCliError(provider, autoHealScanStartedAtMs)) {
          provider._lastAutoHealAt = autoHealScanStartedAt;
        }
      }
      await saveGlobalConfig();
    }

    // Don't block the request on a CLI rescan. We have cached provider data;
    // return it immediately and refresh in the background. Subsequent reads
    // will pick up the fresh state from globalProviders / the persisted file.
    // A singleton promise dedupes overlapping triggers.
    if (!_bgScanPromise) {
      const autoHealAttemptedAt = hasRecoverableCliErrorProvider ? autoHealScanStartedAt : null;
      _bgScanPromise = fullScan({ autoHealAttemptedAt })
        .catch((err) => {
          console.error('[providerService] background fullScan failed:', err.message);
        })
        .finally(() => {
          _bgScanPromise = null;
        });
    }

    const providers = globalProviders.map(sanitizeProvider);
    const activeProvider = providers.find(p => p.id === activeProviderId) || null;
    return { providers, activeProvider, scanInFlight: true };
  }

  // Resolve actual active model for OpenCode providers still showing 'opencode-default'.
  // This happens when the provider was persisted before dynamic model resolution was added.
  let providerMetadataChanged = false;
  const providerReadAt = new Date().toISOString();
  for (const p of globalProviders) {
    if (p.type === 'opencode' && p.model === 'opencode-default') {
      const activeModel = await resolveOpenCodeActiveModel();
      if (activeModel) {
        p.model = activeModel;
        providerMetadataChanged = true;
      }
      break; // only one opencode provider possible
    }
  }
  for (const p of globalProviders) {
    if (await refreshDetectedCodexCliModel(p, providerReadAt)) {
      providerMetadataChanged = true;
    }
    if (refreshDetectedClaudeCliModel(p)) {
      providerMetadataChanged = true;
    }
  }
  if (providerMetadataChanged) {
    await saveGlobalConfig();
  }

  const providers = globalProviders.map(sanitizeProvider);
  const activeProvider = providers.find(p => p.id === activeProviderId) || null;
  return { providers, activeProvider };
}

/**
 * "Can the user select this provider and have it route to a real CLI/API?"
 *
 * True for verified `connected` providers AND for `unchecked` CLI-detected
 * providers (e.g. macOS Keychain / Windows Credential Manager Claude where
 * we couldn't verify offline but post-login artifacts prove past auth).
 *
 * Use this for: review/build candidate eligibility, default context
 * resolution, frontend selection lists, "Use" button visibility.
 *
 * Do NOT use this for: auto-activation, silent failover. Those are
 * "best-guess pick something that works" and should stay strict.
 */
function isProviderUsable(provider) {
  if (!provider) return false;
  if (provider.status === 'connected') return true;
  if (provider.status === 'unchecked' && provider.source === 'cli_detected') return true;
  return false;
}

/**
 * "Is this provider verified working right now?" — strict.
 *
 * Use this for: auto-activation after BYOK add, auto-pick after removing
 * the active provider, fullScan auto-activate priority list, silent
 * failover candidate list.
 */
function isProviderConfirmedConnected(provider) {
  return provider?.status === 'connected';
}

function buildProviderRuntime(provider, apiKey) {
  if (!provider) return null;

  const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
  const isCliDetected = provider.source === 'cli_detected';

  // API-first routing by default, but CLI-detected OAuth providers must remain
  // CLI-routed even when a token string exists (those tokens are often not
  // valid direct API keys).
  const forceClaudeCLI = provider.type === 'anthropic'
    && isCliDetected
    && (provider._useClaudeCLI === true || provider._authType === 'oauth');
  const forceCodexCLI = provider.type === 'openai'
    && isCliDetected
    && (provider._useCodexCLI === true || provider._authType === 'codex_oauth');
  const forceGeminiCLI = provider.type === 'google'
    && isCliDetected
    && (provider._useGeminiCLI === true || provider._authType === 'gemini_cli');
  const forceOpenCodeCLI = provider.type === 'opencode'
    && isCliDetected
    && (provider._useOpenCodeCLI === true || provider._authType === 'opencode_cli');

  const useClaudeCLI = forceClaudeCLI || (
    !hasApiKey
    && provider.type === 'anthropic'
    && (provider._useClaudeCLI === true || provider._authType === 'oauth')
  );
  const useCodexCLI = forceCodexCLI || (
    !hasApiKey
    && provider.type === 'openai'
    && (provider._useCodexCLI === true || provider._authType === 'codex_oauth')
  );
  const useGeminiCLI = forceGeminiCLI || (
    !hasApiKey
    && provider.type === 'google'
    && (provider._useGeminiCLI === true || provider._authType === 'gemini_cli')
  );
  const useOpenCodeCLI = forceOpenCodeCLI || (
    !hasApiKey
    && provider.type === 'opencode'
    && (provider._useOpenCodeCLI === true || provider._authType === 'opencode_cli')
  );

  const canUseDirectApi = hasApiKey && !useClaudeCLI && !useCodexCLI && !useGeminiCLI && !useOpenCodeCLI;
  if (!canUseDirectApi && !useClaudeCLI && !useCodexCLI && !useGeminiCLI && !useOpenCodeCLI) return null;

  return {
    provider: sanitizeProvider(provider),
    apiKey: canUseDirectApi ? apiKey : null,
    authType: provider._authType || null,
    useClaudeCLI,
    useCodexCLI,
    useGeminiCLI,
    useOpenCodeCLI,
    config: PROVIDER_CONFIGS[provider.type],
  };
}

/**
 * Get ordered review provider candidates with credentials.
 * Order:
 * 1) active provider (if runnable),
 * 2) other connected runnable providers (API-routable first).
 *
 * @param {{ maxCandidates?: number, preferredProviderId?: string }} [options]
 * @returns {Promise<Array<{provider: Object, apiKey: string|null, authType: string|null, useClaudeCLI: boolean, useCodexCLI: boolean, config: Object}>>}
 */
async function getReviewProviderCandidatesWithKeys(options = {}) {
  // Harness-only stub provider. Ignore the env flag in production so a leaked
  // variable cannot silently short-circuit real provider execution.
  if (isReviewTestProviderEnabled()) {
    return [{
      provider: {
        id: 'atlas-review-test-provider',
        type: 'openai',
        model: 'gpt-5.3-codex',
        source: 'test_stub',
        status: 'connected',
        label: 'Atlas Review Test Stub',
      },
      apiKey: 'atlas-review-test-key',
      authType: 'api_key',
      useClaudeCLI: false,
      useCodexCLI: false,
      useGeminiCLI: false,
      useOpenCodeCLI: false,
      config: PROVIDER_CONFIGS.openai,
    }];
  }

  await loadGlobalConfig();

  // Use preferred provider (context-specific) if supplied, else fall back to global active
  const effectiveActiveId = options.preferredProviderId || activeProviderId;

  const activeProvider = effectiveActiveId
    ? globalProviders.find(p => p.id === effectiveActiveId)
    : null;
  // An `unchecked` CLI-backed provider (e.g. Keychain-detected Claude) is a
  // legitimate user selection — don't force a re-scan or filter it out.
  // Validation is intentionally deferred to the actual review call, where
  // the CLI itself produces an actionable error if auth is broken.
  const needsScan = globalProviders.length === 0
    || !effectiveActiveId
    || (activeProvider && !isProviderUsable(activeProvider));

  if (needsScan) {
    await fullScan();
  }

  const eligibleProviders = globalProviders.filter(isProviderUsable);
  if (eligibleProviders.length === 0) return [];

  const active = effectiveActiveId
    ? eligibleProviders.find(p => p.id === effectiveActiveId) || null
    : null;
  // Failover list (`others`) is more conservative — only `connected` providers
  // automatically run as fallbacks. A user-selected `unchecked` provider is
  // honored as primary but not silently retried as someone else's fallback.
  const others = eligibleProviders.filter(
    (p) => isProviderConfirmedConnected(p) && (!active || p.id !== active.id)
  );

  const activeRuntime = active
    ? buildProviderRuntime(active, await getProviderApiKey(active))
    : null;

  const otherRuntimes = [];
  for (const provider of others) {
    const runtime = buildProviderRuntime(provider, await getProviderApiKey(provider));
    if (runtime) {
      otherRuntimes.push(runtime);
    }
  }

  otherRuntimes.sort((a, b) => {
    const aApi = a.apiKey ? 1 : 0;
    const bApi = b.apiKey ? 1 : 0;
    if (aApi !== bApi) return bApi - aApi;
    return String(a.provider?.id || '').localeCompare(String(b.provider?.id || ''));
  });

  const candidates = activeRuntime
    ? [activeRuntime, ...otherRuntimes]
    : otherRuntimes;

  const maxCandidates = Math.max(1, Number(options.maxCandidates) || candidates.length || 1);
  return candidates.slice(0, maxCandidates);
}

/**
 * Get the active provider with credentials (for internal use only)
 * @param {Object} [options]
 * @param {string|null} [options.preferredProviderId]
 * @returns {Promise<{provider: Object, apiKey: string}|null>}
 */
async function getActiveProviderWithKey(options = {}) {
  const candidates = await getReviewProviderCandidatesWithKeys({
    maxCandidates: 1,
    preferredProviderId: options.preferredProviderId || null,
  });
  return candidates[0] || null;
}

/**
 * Run a full scan: detect CLIs + merge with existing BYOK providers
 * @returns {Promise<{providers: Array, activeProvider: Object|null}>}
 */
async function fullScan(options = {}) {
  await loadGlobalConfig();
  const autoHealAttemptedAt = typeof options.autoHealAttemptedAt === 'string'
    ? options.autoHealAttemptedAt
    : null;
  const autoHealAttemptedAtMs = autoHealAttemptedAt
    ? Date.parse(autoHealAttemptedAt)
    : Number.NaN;

  // User-initiated rescans must bypass the findBinary cache so a fresh
  // PATH lookup is performed for each detector. Background auto-heal scans
  // can keep the cached lookups (TTL is short anyway).
  if (options.force === true) {
    clearFindBinaryCache();
  }

  // Scan for CLI providers
  const detected = await scanForCLIProviders();

  // Merge: keep existing BYOK, update CLI-detected
  const byokProviders = globalProviders.filter(p => p.source === 'byok');

  // For detected CLI providers, check if we already have a validated version
  for (const det of detected) {
    normalizeCliDetectedProviderModel(det);
    const existing = globalProviders.find(p => p.id === det.id);
    if (existing && existing.status === 'connected') {
      // Keep existing validated provider state
      det.status = existing.status;
      det.error = undefined;
      det.lastCheckedAt = existing.lastCheckedAt;
      det.isActive = existing.isActive;
      det.label = existing.label; // Preserve "— via CLI" label
      // Preserve user's model selection, but only if it's still in the current model list.
      // Stale models (e.g. gpt-4o from before codex model update) get replaced with the new default.
      const config = PROVIDER_CONFIGS[det.type];
      const validModelIds = config ? config.models.map(m => m.id) : [];
      const preserveExistingModel = existing._modelSelectionSource === 'user'
        || det.type !== 'openai'
        || det._authType !== 'codex_oauth';
      if (
        preserveExistingModel
        && existing.model
        && validModelIds.includes(existing.model)
        && !(det.type === 'google' && det.source === 'cli_detected' && GOOGLE_CLI_UNSUPPORTED_MODELS.has(existing.model))
      ) {
        det.model = existing.model;
      }
      if (existing._encryptedKey) det._encryptedKey = existing._encryptedKey;
      if (existing._credentialSource) det._credentialSource = existing._credentialSource;
      if (existing._useClaudeCLI) det._useClaudeCLI = existing._useClaudeCLI;
      if (existing._useCodexCLI) det._useCodexCLI = existing._useCodexCLI;
      if (existing._useGeminiCLI) det._useGeminiCLI = existing._useGeminiCLI;
      if (existing._useOpenCodeCLI) det._useOpenCodeCLI = existing._useOpenCodeCLI;
      if (existing._authType) det._authType = existing._authType;
      if (existing._modelSelectionSource === 'user') det._modelSelectionSource = existing._modelSelectionSource;
      if (existing._codexModelCatalogCheckedAt) det._codexModelCatalogCheckedAt = existing._codexModelCatalogCheckedAt;
      if (existing._codexModelCatalogAppVersion) det._codexModelCatalogAppVersion = existing._codexModelCatalogAppVersion;
      if (existing._claudeModelDefaultAppVersion) det._claudeModelDefaultAppVersion = existing._claudeModelDefaultAppVersion;
    }

    if (existing?._lastAutoHealAt) {
      det._lastAutoHealAt = existing._lastAutoHealAt;
    }
  }

  globalProviders = [...detected, ...byokProviders];

  // Validate unchecked providers so they can be auto-activated
  for (const provider of globalProviders) {
    if (provider.status === 'unchecked') {
      // CLI-backed Claude install with no extractable key (e.g. macOS
      // Keychain or Windows Credential Manager). Run the validation flow
      // so machines where keychain access from a subprocess works get
      // promoted to connected; the rest stay unchecked rather than error.
      if (provider._useClaudeCLI && provider.type === 'anthropic') {
        const claudeStatus = await validateClaudeCliConnection(provider);
        if (claudeStatus.connected) {
          provider.status = 'connected';
          provider._binaryPath = claudeStatus.binaryPath;
          provider.error = undefined;
        } else if (claudeStatus.unchecked) {
          provider._binaryPath = claudeStatus.binaryPath;
          provider.error = undefined;
        } else {
          provider.status = 'error';
          provider._binaryPath = claudeStatus.binaryPath || provider._binaryPath;
          provider.error = claudeStatus.error;
        }
        provider.lastCheckedAt = new Date().toISOString();
        continue;
      }

      const apiKey = await getProviderApiKey(provider);
      if (apiKey) {
        const result = await testConnection(provider.type, apiKey, {
          authType: provider._authType,
        });
        if (result.success) {
          provider.status = 'connected';
          provider.error = undefined;
        } else if (provider._authType === 'oauth') {
          // OAuth tokens from subscriptions don't work with the standard API.
          // Check if claude CLI is available for subscription-based reviews via `claude -p`.
          try {
            const claudeBin = await resolveRunnableClaudeBinary(provider);
            if (claudeBin) {
              provider.status = 'connected';
              provider._useClaudeCLI = true;
              provider._binaryPath = claudeBin;
              provider.error = undefined;
              const subType = provider.label.match(/\((.+)\)/)?.[1] || 'subscription';
              provider.label = `Claude Code (${subType}) — via CLI`;
            } else {
              provider.status = 'needs_key';
              provider.error = 'Subscription detected but claude CLI not found. Add an API key from console.anthropic.com.';
            }
          } catch {
            provider.status = 'needs_key';
            provider.error = 'Subscription detected but claude CLI not found. Add an API key from console.anthropic.com.';
          }
        } else if (provider._authType === 'codex_oauth') {
          // ChatGPT subscription tokens can't call the OpenAI API directly.
          // Check if codex CLI is available AND authenticated for subscription-based reviews.
          const codexPath = await findBinary('codex');
          if (codexPath) {
            // Actually test authentication by running a trivial prompt
            const authOk = await testCodexAuth(codexPath);
            if (authOk) {
              provider.status = 'connected';
              provider._useCodexCLI = true;
              provider.error = undefined;
              const subType = provider.label.match(/\((.+)\)/)?.[1] || 'subscription';
              provider.label = `Codex CLI (${subType}) — via CLI`;
            } else {
              provider.status = 'error';
              provider._useCodexCLI = false;
              provider.error = 'Codex CLI found but not authenticated. Run `codex login` in your terminal.';
            }
          } else {
            provider.status = 'needs_key';
            provider.error = 'ChatGPT subscription detected but codex CLI not found. Add an API key manually.';
          }
        } else if (provider._authType === 'gemini_cli') {
          // Gemini CLI auth (Google OAuth/ADC/no extractable key) — check if CLI is available
          const geminiPath = await findBinary('gemini');
          if (geminiPath) {
            provider.status = 'connected';
            provider._useGeminiCLI = true;
            provider.error = undefined;
            provider.label = 'Gemini CLI (detected) — via CLI';
          } else {
            provider.status = 'error';
            provider.error = 'Gemini CLI not found.';
          }
        } else if (provider._authType === 'opencode_cli') {
          // OpenCode CLI — routes through its own provider backends
          const opencodePath = await findBinary('opencode');
          if (opencodePath) {
            provider.status = 'connected';
            provider._useOpenCodeCLI = true;
            provider.error = undefined;
            provider.label = 'OpenCode (detected) — via CLI';
          } else {
            provider.status = 'error';
            provider.error = 'OpenCode CLI not found.';
          }
        } else {
          provider.status = 'error';
          provider.error = result.error;
        }
        provider.lastCheckedAt = new Date().toISOString();
      } else if (provider._authType === 'gemini_cli') {
        // Gemini CLI with OAuth/ADC — no extractable API key, but CLI handles auth.
        const geminiPath = await findBinary('gemini');
        if (geminiPath) {
          provider.status = 'connected';
          provider._useGeminiCLI = true;
          provider.error = undefined;
          provider.label = 'Gemini CLI (detected) — via CLI';
        } else {
          provider.status = 'error';
          provider.error = 'Gemini CLI not found.';
        }
        provider.lastCheckedAt = new Date().toISOString();
      } else if (provider._authType === 'opencode_cli') {
        // OpenCode CLI — no extractable API key, CLI handles routing.
        const opencodePath = await findBinary('opencode');
        if (opencodePath) {
          provider.status = 'connected';
          provider._useOpenCodeCLI = true;
          provider.error = undefined;
          provider.label = 'OpenCode (detected) — via CLI';
        } else {
          provider.status = 'error';
          provider.error = 'OpenCode CLI not found.';
        }
        provider.lastCheckedAt = new Date().toISOString();
      } else {
        provider.status = 'error';
        provider.error = 'No API key available';
        provider.lastCheckedAt = new Date().toISOString();
      }
    }
  }

  if (autoHealAttemptedAt && Number.isFinite(autoHealAttemptedAtMs)) {
    for (const provider of globalProviders) {
      if (shouldAutoHealRecoverableCliError(provider, autoHealAttemptedAtMs)) {
        provider._lastAutoHealAt = autoHealAttemptedAt;
      }
    }
  }

  // Preserve active provider if still present
  if (activeProviderId && !globalProviders.find(p => p.id === activeProviderId)) {
    activeProviderId = null;
  }

  // Auto-activate first connected if none active, preferring Codex > Claude > Gemini > OpenCode
  if (!activeProviderId) {
    const AUTO_ACTIVATE_PRIORITY = ['openai', 'anthropic', 'google', 'opencode'];
    const connected = globalProviders.filter(p => p.status === 'connected');
    const firstConnected = connected.length > 0
      ? connected.sort((a, b) => {
          const ai = AUTO_ACTIVATE_PRIORITY.indexOf(a.type);
          const bi = AUTO_ACTIVATE_PRIORITY.indexOf(b.type);
          return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
        })[0]
      : null;
    if (firstConnected) {
      activeProviderId = firstConnected.id;
      firstConnected.isActive = true;
    }
  } else {
    // Mark active
    for (const p of globalProviders) {
      p.isActive = p.id === activeProviderId;
    }
  }

  await saveGlobalConfig();

  // Return providers directly (avoid recursive fullScan from getProviders)
  const providers = globalProviders.map(sanitizeProvider);
  const activeProvider = providers.find(p => p.id === activeProviderId) || null;
  return { providers, activeProvider };
}

/**
 * Validate and refresh status of all providers
 * @returns {Promise<{providers: Array, activeProvider: Object|null}>}
 */
async function validateAllProviders() {
  await loadGlobalConfig();

  for (const provider of globalProviders) {
    // CLI-routed providers: verify the CLI binary still exists instead of
    // hitting the API (subscription tokens don't work with direct API calls).
    if (provider._useClaudeCLI) {
      const claudeStatus = await validateClaudeCliConnection(provider);
      if (claudeStatus.connected) {
        provider.status = 'connected';
        provider._binaryPath = claudeStatus.binaryPath;
        provider.error = undefined;
      } else if (claudeStatus.unchecked) {
        // Keychain-backed install: defer auth verification to first use
        // rather than asserting "Run claude login" on a working setup.
        provider.status = 'unchecked';
        provider._binaryPath = claudeStatus.binaryPath;
        provider.error = undefined;
      } else {
        provider.status = 'error';
        provider._binaryPath = claudeStatus.binaryPath || provider._binaryPath;
        provider.error = claudeStatus.error;
      }
      provider.lastCheckedAt = new Date().toISOString();
      continue;
    }

    if (provider._useCodexCLI) {
      const codexPath = await findBinary('codex');
      if (codexPath) {
        provider.status = 'connected';
        provider.error = undefined;
      } else {
        provider.status = 'error';
        provider.error = 'Codex CLI no longer found. Re-scan or add an API key.';
      }
      provider.lastCheckedAt = new Date().toISOString();
      continue;
    }

    if (provider._useGeminiCLI) {
      const geminiPath = await findBinary('gemini');
      if (geminiPath) {
        provider.status = 'connected';
        provider.error = undefined;
      } else {
        provider.status = 'error';
        provider.error = 'Gemini CLI no longer found. Re-scan or add an API key.';
      }
      provider.lastCheckedAt = new Date().toISOString();
      continue;
    }

    if (provider._useOpenCodeCLI) {
      const opencodePath = await findBinary('opencode');
      if (opencodePath) {
        provider.status = 'connected';
        provider.error = undefined;
      } else {
        provider.status = 'error';
        provider.error = 'OpenCode CLI no longer found. Re-scan or add an API key.';
      }
      provider.lastCheckedAt = new Date().toISOString();
      continue;
    }

    const apiKey = await getProviderApiKey(provider);
    if (!apiKey) {
      // For OAuth/subscription providers without CLI flag yet, attempt CLI fallback
      if (provider._authType === 'oauth') {
        const claudeStatus = await validateClaudeCliConnection(provider);
        if (claudeStatus.connected || claudeStatus.unchecked) {
          provider.status = claudeStatus.unchecked ? 'unchecked' : 'connected';
          provider._useClaudeCLI = true;
          provider._binaryPath = claudeStatus.binaryPath;
          provider.error = undefined;
          const subType = provider.label.match(/\((.+)\)/)?.[1] || 'subscription';
          provider.label = `Claude Code (${subType}) — via CLI`;
        } else {
          provider.status = 'error';
          provider._binaryPath = claudeStatus.binaryPath || provider._binaryPath;
          provider.error = claudeStatus.error || 'No API key available';
        }
      } else if (provider._authType === 'codex_oauth') {
        const codexPath = await findBinary('codex');
        if (codexPath) {
          provider.status = 'connected';
          provider._useCodexCLI = true;
          provider.error = undefined;
          const subType = provider.label.match(/\((.+)\)/)?.[1] || 'subscription';
          provider.label = `Codex CLI (${subType}) — via CLI`;
        } else {
          provider.status = 'error';
          provider.error = 'No API key available';
        }
      } else if (provider._authType === 'gemini_cli') {
        const geminiPath = await findBinary('gemini');
        if (geminiPath) {
          provider.status = 'connected';
          provider._useGeminiCLI = true;
          provider.error = undefined;
          provider.label = 'Gemini CLI (detected) — via CLI';
        } else {
          provider.status = 'error';
          provider.error = 'Gemini CLI no longer found.';
        }
      } else if (provider._authType === 'opencode_cli') {
        const opencodePath = await findBinary('opencode');
        if (opencodePath) {
          provider.status = 'connected';
          provider._useOpenCodeCLI = true;
          provider.error = undefined;
          provider.label = 'OpenCode (detected) — via CLI';
        } else {
          provider.status = 'error';
          provider.error = 'OpenCode CLI no longer found.';
        }
      } else if (provider.source === 'cli_detected') {
        // Stale cli_detected provider without _authType — attempt CLI detection
        if (provider.type === 'anthropic') {
          const claudeStatus = await validateClaudeCliConnection(provider);
          if (claudeStatus.connected || claudeStatus.unchecked) {
            provider.status = claudeStatus.unchecked ? 'unchecked' : 'connected';
            provider._useClaudeCLI = true;
            provider._authType = 'oauth';
            provider._binaryPath = claudeStatus.binaryPath;
            provider.error = undefined;
            provider.label = `Claude Code (subscription) — via CLI`;
          } else {
            provider.status = 'error';
            provider._binaryPath = claudeStatus.binaryPath || provider._binaryPath;
            provider.error = claudeStatus.error || 'No API key available';
          }
        } else if (provider.type === 'openai') {
          const codexPath = await findBinary('codex');
          if (codexPath) {
            provider.status = 'connected';
            provider._useCodexCLI = true;
            provider._authType = 'codex_oauth';
            provider.error = undefined;
            provider.label = `Codex CLI (subscription) — via CLI`;
          } else {
            provider.status = 'error';
            provider.error = 'No API key available';
          }
        } else if (provider.type === 'google') {
          const geminiPath = await findBinary('gemini');
          if (geminiPath) {
            provider.status = 'connected';
            provider._useGeminiCLI = true;
            provider._authType = 'gemini_cli';
            provider.error = undefined;
            provider.label = 'Gemini CLI (detected) — via CLI';
          } else {
            provider.status = 'error';
            provider.error = 'No API key available';
          }
        } else if (provider.type === 'opencode') {
          const opencodePath = await findBinary('opencode');
          if (opencodePath) {
            provider.status = 'connected';
            provider._useOpenCodeCLI = true;
            provider._authType = 'opencode_cli';
            provider.error = undefined;
            provider.label = 'OpenCode (detected) — via CLI';
          } else {
            provider.status = 'error';
            provider.error = 'No API key available';
          }
        } else {
          provider.status = 'error';
          provider.error = 'No API key available';
        }
      } else {
        provider.status = 'error';
        provider.error = 'No API key available';
      }
      provider.lastCheckedAt = new Date().toISOString();
      continue;
    }

    const result = await testConnection(provider.type, apiKey, {
      authType: provider._authType,
    });

    if (result.success) {
      provider.status = 'connected';
      provider.error = undefined;
    } else if (provider._authType === 'oauth') {
      // OAuth tokens fail direct API test — fall back to CLI
      try {
        const claudeBin = await findClaudeBinary();
        if (claudeBin.binary !== 'npx') {
          provider.status = 'connected';
          provider._useClaudeCLI = true;
          provider.error = undefined;
          const subType = provider.label.match(/\((.+)\)/)?.[1] || 'subscription';
          provider.label = `Claude Code (${subType}) — via CLI`;
        } else {
          provider.status = 'error';
          provider.error = result.error;
        }
      } catch {
        provider.status = 'error';
        provider.error = result.error;
      }
    } else if (provider._authType === 'codex_oauth') {
      // ChatGPT subscription tokens fail direct API test — fall back to CLI
      const codexPath = await findBinary('codex');
      if (codexPath) {
        provider.status = 'connected';
        provider._useCodexCLI = true;
        provider.error = undefined;
        const subType = provider.label.match(/\((.+)\)/)?.[1] || 'subscription';
        provider.label = `Codex CLI (${subType}) — via CLI`;
      } else {
        provider.status = 'error';
        provider.error = result.error;
      }
    } else if (provider._authType === 'gemini_cli') {
      // Gemini CLI auth failed direct API test — fall back to CLI
      const geminiPath = await findBinary('gemini');
      if (geminiPath) {
        provider.status = 'connected';
        provider._useGeminiCLI = true;
        provider.error = undefined;
        provider.label = 'Gemini CLI (detected) — via CLI';
      } else {
        provider.status = 'error';
        provider.error = result.error;
      }
    } else if (provider._authType === 'opencode_cli') {
      // OpenCode CLI auth failed direct API test — fall back to CLI
      const opencodePath = await findBinary('opencode');
      if (opencodePath) {
        provider.status = 'connected';
        provider._useOpenCodeCLI = true;
        provider.error = undefined;
        provider.label = 'OpenCode (detected) — via CLI';
      } else {
        provider.status = 'error';
        provider.error = result.error;
      }
    } else {
      provider.status = 'error';
      provider.error = result.error;
    }
    provider.lastCheckedAt = new Date().toISOString();
  }

  await saveGlobalConfig();

  // Return directly to avoid recursive fullScan from getProviders
  const providers = globalProviders.map(sanitizeProvider);
  const activeProvider = providers.find(p => p.id === activeProviderId) || null;
  return { providers, activeProvider };
}

/**
 * Remove sensitive fields from provider before returning to frontend
 */
function sanitizeProvider(provider) {
  const {
    _encryptedKey,
    _credentialSource,
    _credentialField,
    _authType,
    _resolvedKey,
    _useClaudeCLI,
    _useCodexCLI,
    _useGeminiCLI,
    _useOpenCodeCLI,
    _modelSelectionSource,
    _lastAutoHealAt,
    ...safe
  } = provider;
  return safe;
}

/**
 * Get Anthropic models formatted for the Claude CLI builder chat dropdown.
 * Single source of truth — claude.js imports this instead of hardcoding MODEL_ALIASES.
 * @returns {Array<{alias: string, name: string, description: string}>}
 */
function getAnthropicCLIModels() {
  return PROVIDER_CONFIGS.anthropic.models
    .map(m => ({
      alias: m.cliAlias || m.id,
      name: m.label,
      description: m.cliAlias === 'opus' ? 'Most capable, best for complex tasks'
        : m.cliAlias === 'sonnet' ? 'Balanced performance and speed'
        : m.id.includes('haiku') ? 'Fast model for focused tasks' : 'Explicit Claude model version',
    }));
}

function resolveAnthropicCliModelArg(model = null) {
  const raw = typeof model === 'string' ? model.trim() : '';
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  const match = PROVIDER_CONFIGS.anthropic.models.find((candidate) => {
    const id = typeof candidate.id === 'string' ? candidate.id.trim().toLowerCase() : '';
    const alias = typeof candidate.cliAlias === 'string' ? candidate.cliAlias.trim().toLowerCase() : '';
    return normalized === id || (alias && normalized === alias);
  });
  return match?.cliAlias || raw;
}

/**
 * Get provider configuration (models, labels, etc.)
 */
function getProviderConfigs() {
  return Object.entries(PROVIDER_CONFIGS).map(([type, config]) => ({
    type,
    label: config.label,
    models: config.models.map(m => ({
      id: m.id,
      label: m.label,
      toolSupport: m.toolSupport !== false,
      ...(m.reviewCapable === false ? { reviewCapable: false } : {}),
      ...(m.cliAlias ? { cliAlias: m.cliAlias } : {}),
    })),
    defaultModel: config.defaultModel,
    reviewModelDefaults: {
      triage: getSmartReviewModel(type, 'triage'),
      walkthrough: getSmartReviewModel(type, 'walkthrough'),
      review: getSmartReviewModel(type, 'review'),
      synthesis: getSmartReviewModel(type, 'synthesis'),
    },
    cliReviewModelDefaults: {
      triage: getSmartReviewModel(type, 'triage', { transport: 'cli' }),
      walkthrough: getSmartReviewModel(type, 'walkthrough', { transport: 'cli' }),
      review: getSmartReviewModel(type, 'review', { transport: 'cli' }),
      synthesis: getSmartReviewModel(type, 'synthesis', { transport: 'cli' }),
    },
    reviewExecutionProfile: config.reviewExecutionProfile || null,
    byokEligible: Boolean(config.apiUrl),
    toolSupport: Boolean(config.apiUrl), // all BYOK-eligible providers support tool use
  }));
}

/**
 * Resolve provider default model by provider type.
 *
 * @param {string} providerType
 * @returns {string|null}
 */
function getProviderDefaultModel(providerType) {
  const type = typeof providerType === 'string' ? providerType.trim() : '';
  const model = PROVIDER_CONFIGS[type]?.defaultModel;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

function getProviderCliDefaultModel(providerType) {
  const type = typeof providerType === 'string' ? providerType.trim() : '';
  const model = PROVIDER_CLI_DEFAULT_MODELS[type] || PROVIDER_CONFIGS[type]?.defaultModel;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

function normalizeCliDetectedProviderModel(provider) {
  if (!provider || provider.source !== 'cli_detected') {
    return provider;
  }

  if (provider.type === 'openai') {
    const isCodexCliBacked = provider._useCodexCLI === true || provider._authType === 'codex_oauth';
    if (!isCodexCliBacked) {
      return provider;
    }
    const normalizedModel = typeof provider.model === 'string' ? provider.model.trim() : '';
    const selectionSource = typeof provider._modelSelectionSource === 'string'
      ? provider._modelSelectionSource.trim().toLowerCase()
      : '';
    const preserveExplicitSelection = selectionSource === 'user' || selectionSource === 'detected';
    if (isLegacyImplicitCodexUserSelection(provider)) {
      provider._modelSelectionSource = 'user';
      return provider;
    }
    if (!normalizedModel || (!preserveExplicitSelection && OPENAI_CLI_LEGACY_DEFAULT_MODELS.has(normalizedModel))) {
      provider.model = getProviderCliDefaultModel('openai');
    }
    return provider;
  }

  if (provider.type !== 'google') {
    return provider;
  }

  const normalizedModel = typeof provider.model === 'string' ? provider.model.trim() : '';
  if (!normalizedModel) {
    provider.model = getProviderCliDefaultModel('google');
    return provider;
  }
  if (GOOGLE_CLI_UNSUPPORTED_MODELS.has(normalizedModel)) {
    provider.model = getProviderCliDefaultModel('google');
  }
  return provider;
}

/**
 * Resolve smart-mode review model for a provider phase.
 * Falls back to provider default model if no phase default is configured.
 *
 * @param {string} providerType
 * @param {'triage'|'walkthrough'|'review'|'synthesis'|'verifier'} phase
 * @returns {string|null}
 */
function getSmartReviewModel(providerType, phase, options = {}) {
  const type = typeof providerType === 'string' ? providerType.trim() : '';
  const normalizedPhase = typeof phase === 'string' ? phase.trim() : '';
  const transport = typeof options?.transport === 'string' ? options.transport.trim().toLowerCase() : '';
  const phaseMap = transport === 'cli' && REVIEW_MODEL_CLI_DEFAULTS[type]
    ? REVIEW_MODEL_CLI_DEFAULTS[type]
    : REVIEW_MODEL_DEFAULTS[type];
  const configured = phaseMap?.[normalizedPhase];
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }
  return getProviderDefaultModel(type);
}

/**
 * Resolve cost-aware review model for a provider phase.
 * These are cheaper models that are still intended for review-like work;
 * triage/walkthrough continue to use smart defaults.
 *
 * @param {string} providerType
 * @param {'triage'|'walkthrough'|'review'|'synthesis'|'verifier'} phase
 * @param {{transport?: string}} [options]
 * @returns {string|null}
 */
function getCostAwareReviewModel(providerType, phase, options = {}) {
  const type = typeof providerType === 'string' ? providerType.trim() : '';
  const normalizedPhase = typeof phase === 'string' ? phase.trim() : '';
  const configured = REVIEW_MODEL_COST_AWARE_DEFAULTS[type]?.[normalizedPhase];
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }
  return getSmartReviewModel(type, normalizedPhase, options);
}

/**
 * Check whether a model id is in the known static model list for a provider type.
 *
 * @param {string} providerType
 * @param {string} modelId
 * @returns {boolean}
 */
function isKnownProviderModel(providerType, modelId) {
  const type = typeof providerType === 'string' ? providerType.trim() : '';
  const model = typeof modelId === 'string' ? modelId.trim() : '';
  if (!type || !model) return false;
  const config = PROVIDER_CONFIGS[type];
  if (!config) return false;
  return config.models.some((entry) => entry.id === model);
}

/**
 * Check whether a model is capable of producing reliable review output.
 * Models with `reviewCapable: false` in their provider config are blocked
 * from structured review phases, including triage.
 *
 * @param {string} providerType
 * @param {string} modelId
 * @returns {boolean} true if the model is review-capable (or unknown), false if explicitly blocked
 */
function isModelReviewCapable(providerType, modelId) {
  const type = typeof providerType === 'string' ? providerType.trim() : '';
  const model = typeof modelId === 'string' ? modelId.trim() : '';
  if (!type || !model) return true; // unknown models are not blocked
  const config = PROVIDER_CONFIGS[type];
  if (!config) return true;
  const entry = config.models.find((m) => m.id === model);
  if (!entry) return true; // unknown model within known provider — not blocked
  return entry.reviewCapable !== false;
}

/**
 * Resolve provider-specific review execution tuning profile.
 *
 * @param {string} providerType
 * @returns {{
 *   coverageMultiplier: number,
 *   chunkConcurrencyBias: number,
 *   perFileConcurrencyBias: number,
 *   focusedTriggerFileCountBias: number,
 *   focusedTriggerDiffBias: number
 * }|null}
 */
function getProviderReviewExecutionProfile(providerType) {
  const type = typeof providerType === 'string' ? providerType.trim() : '';
  const profile = PROVIDER_CONFIGS[type]?.reviewExecutionProfile;
  if (!profile || typeof profile !== 'object') return null;
  return {
    coverageMultiplier: Number(profile.coverageMultiplier) || 1,
    chunkConcurrencyBias: Number(profile.chunkConcurrencyBias) || 1,
    perFileConcurrencyBias: Number(profile.perFileConcurrencyBias) || 1,
    focusedTriggerFileCountBias: Number(profile.focusedTriggerFileCountBias) || 1,
    focusedTriggerDiffBias: Number(profile.focusedTriggerDiffBias) || 1,
  };
}

// ---------------------------------------------------------------------------
// OpenCode Setup Wizard helpers
// ---------------------------------------------------------------------------

/**
 * Curated list of popular NVIDIA NIM models available on the free tier.
 */
const NVIDIA_NIM_MODELS = [
  // Top coding performers
  { id: 'z-ai/glm5', label: 'GLM-5 (744B MoE)', toolSupport: true, reviewCapable: true },
  { id: 'deepseek-ai/deepseek-v3.2', label: 'DeepSeek V3 (685B)', toolSupport: true, reviewCapable: true },
  { id: 'qwen/qwen2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B', toolSupport: false, reviewCapable: true },
  { id: 'qwen/qwen2.5-coder-7b-instruct', label: 'Qwen 2.5 Coder 7B', toolSupport: false, reviewCapable: false },
  { id: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B Instruct', toolSupport: true, reviewCapable: true },
  { id: 'meta/llama-3.1-70b-instruct', label: 'Llama 3.1 70B Instruct', toolSupport: true, reviewCapable: true },
  { id: 'meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B Instruct', toolSupport: true, reviewCapable: false },
  { id: 'mistralai/mistral-large-3-675b-instruct-2512', label: 'Mistral Large 3 (675B)', toolSupport: true, reviewCapable: true },
  // Speed / efficiency
  { id: 'mistralai/mistral-small-24b-instruct', label: 'Mistral Small (24B)', toolSupport: false, reviewCapable: false },
  { id: 'mistralai/mistral-7b-instruct-v0.3', label: 'Mistral 7B', toolSupport: false, reviewCapable: false },
];

/** Compute the ordered list of OpenCode config file candidates. */
function getOpenCodeConfigCandidates() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  return [
    path.join(xdgConfig, 'opencode', 'opencode.json'),
    path.join(xdgConfig, 'opencode', 'opencode.jsonc'),
    path.join(homeDir, '.opencode', 'config.json'),
    path.join(xdgConfig, 'opencode', 'config.json'),
  ];
}

async function resolveOpenCodeActiveModel(opencodePath = null) {
  const candidateBinary = opencodePath || await findBinary('opencode');
  if (candidateBinary) {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(candidateBinary, ['debug', 'config'], { timeout: 8000 });
      const parsed = JSON.parse(stdout);
      if (parsed?.model && typeof parsed.model === 'string') {
        return parsed.model;
      }
    } catch {
      // Fall through to raw config candidates when OpenCode cannot emit merged config.
    }
  }

  for (const cfgPath of getOpenCodeConfigCandidates()) {
    try {
      const content = await fs.readFile(cfgPath, 'utf8');
      const config = JSON.parse(content);
      if (config.model && typeof config.model === 'string') {
        return config.model;
      }
    } catch {
      // Try next candidate
    }
  }

  return null;
}

/**
 * Get OpenCode installation and configuration status.
 * Returns ALL configured providers (not just the first one) and the active model.
 * @returns {Promise<{installed: boolean, binaryPath: string|null, configuredProviders: Array<{type: string, hasKey: boolean}>, activeModel: string|null, configuredProvider: string|null}>}
 */
async function getOpenCodeStatus() {
  let binaryPath = null;
  try {
    binaryPath = await findBinary('opencode');
  } catch { /* not found */ }

  // Also check well-known install paths
  if (!binaryPath) {
    const knownPaths = [
      path.join(process.env.HOME || '', '.opencode', 'bin', 'opencode'),
      '/usr/local/bin/opencode',
      '/opt/homebrew/bin/opencode',
      path.join(process.env.HOME || '', '.local', 'bin', 'opencode'),
      path.join(process.env.HOME || '', 'go', 'bin', 'opencode'),
    ];
    if (process.env.ATLAS_OPENCODE_PATH) {
      knownPaths.unshift(process.env.ATLAS_OPENCODE_PATH);
    }
    for (const p of knownPaths) {
      try {
        await fs.access(p);
        binaryPath = p;
        break;
      } catch { /* not found */ }
    }
  }

  // Detect ALL configured providers from auth file
  const configuredProviders = [];
  let activeModel = null;

  if (binaryPath) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const xdgData = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
    const authPath = path.join(xdgData, 'opencode', 'auth.json');

    try {
      const content = await fs.readFile(authPath, 'utf8');
      const auth = JSON.parse(content);
      const knownProviders = ['google', 'anthropic', 'openai', 'nvidia', 'ollama'];
      for (const p of knownProviders) {
        const entry = auth[p];
        const hasApiAuth = entry && entry.type === 'api' && entry.key;
        const hasOauthAuth = entry && entry.type === 'oauth' && (entry.access || entry.refresh);
        if (hasApiAuth || hasOauthAuth) {
          configuredProviders.push({ type: p, hasKey: true });
        }
      }
    } catch { /* no auth file */ }

    // Check for Ollama running (it doesn't need a key in auth.json)
    if (!configuredProviders.find(p => p.type === 'ollama')) {
      try {
        const resp = await fetch('http://localhost:11434/api/tags', {
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok) {
          configuredProviders.push({ type: 'ollama', hasKey: true });
        }
      } catch { /* ollama not running */ }
    }

    activeModel = await resolveOpenCodeActiveModel(binaryPath);
  }

  // Backwards compat: derive single configuredProvider from active model or first in list
  let configuredProvider = null;
  if (activeModel && activeModel.includes('/')) {
    configuredProvider = activeModel.split('/')[0];
  } else if (configuredProviders.length > 0) {
    configuredProvider = configuredProviders[0].type;
  }

  return {
    installed: Boolean(binaryPath),
    binaryPath,
    configuredProviders,
    activeModel,
    configuredProvider,
  };
}

/**
 * Set the active OpenCode model without reconfiguring auth.
 * Only writes to the model field in opencode.json.
 * @param {string} model - e.g. 'google/gemini-2.5-flash'
 * @returns {Promise<{success: boolean, model: string}>}
 */
async function setOpenCodeActiveModel(model) {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  const configDir = path.join(xdgConfig, 'opencode');
  const configPath = path.join(configDir, 'opencode.json');

  let config = {};
  try {
    const content = await fs.readFile(configPath, 'utf8');
    config = JSON.parse(content);
  } catch { /* file doesn't exist yet */ }

  config.model = model;

  // If switching to an nvidia model, ensure the model is registered in the provider config
  // and sync the full curated model list so users can switch without reconfiguring
  if (model.startsWith('nvidia/')) {
    const nvidiaModelId = model.slice('nvidia/'.length); // e.g. "deepseek-ai/deepseek-v3.2"
    if (config.provider?.nvidia) {
      if (!config.provider.nvidia.models) config.provider.nvidia.models = {};
      // Sync all curated NVIDIA models into the config
      for (const m of NVIDIA_NIM_MODELS) {
        if (!config.provider.nvidia.models[m.id]) {
          config.provider.nvidia.models[m.id] = { name: m.label };
        }
      }
      // Also ensure the specific model is present even if not in curated list
      if (!config.provider.nvidia.models[nvidiaModelId]) {
        config.provider.nvidia.models[nvidiaModelId] = { name: nvidiaModelId };
      }
    }
  }

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  return { success: true, model };
}

/**
 * Get the list of models available through OpenCode's configured providers.
 * Reads auth.json and opencode.json to build a dynamic model list.
 * @returns {Promise<{models: Array<{id: string, label: string}>, activeModel: string}>}
 */
async function getOpenCodeModels() {
  const status = await getOpenCodeStatus();
  const models = [];

  for (const cp of status.configuredProviders) {
    // Skip providers that don't support tool calling in the builder chat
    if (OPENCODE_PROVIDER_TOOL_SUPPORT[cp.type] === false) continue;

    const providerLabel = OPENCODE_PROVIDER_LABELS[cp.type];
    if (!providerLabel) continue;

    // For nvidia, enumerate individual models (some support tools, some don't)
    if (cp.type === 'nvidia') {
      for (const nimModel of NVIDIA_NIM_MODELS) {
        if (!nimModel.toolSupport) continue; // ← only tool-capable models in Build
        const modelId = `nvidia/${nimModel.id}`;
        models.push({ id: modelId, label: `${providerLabel} \u2014 ${nimModel.label}`, toolSupport: true });
      }
      continue;
    }

    // For other tool-capable providers, show active or default model
    const defaultModel = OPENCODE_PROVIDER_DEFAULT_MODELS[cp.type];
    if (!defaultModel) continue;

    const prefix = cp.type + '/';
    const model = (status.activeModel && status.activeModel.startsWith(prefix))
      ? status.activeModel
      : defaultModel;

    const modelShortName = model.split('/').slice(1).join('/');
    models.push({ id: model, label: `${providerLabel} \u2014 ${modelShortName}`, toolSupport: true });
  }

  // Always include a fallback
  if (models.length === 0) {
    models.push({ id: 'opencode-default', label: 'OpenCode Default', toolSupport: true });
  }

  return { models, activeModel: status.activeModel || 'opencode-default' };
}

/**
 * Get ALL models available through OpenCode's configured providers (no tool-support filter).
 * Used by the Review system which calls providers via API, not the CLI tool-use path.
 * @returns {Promise<{models: Array<{id: string, label: string}>, activeModel: string}>}
 */
async function getOpenCodeModelsForReview() {
  const status = await getOpenCodeStatus();
  const models = [];

  for (const cp of status.configuredProviders) {
    const providerLabel = OPENCODE_PROVIDER_LABELS[cp.type];
    if (!providerLabel) continue;

    // For nvidia, enumerate only review-capable models
    if (cp.type === 'nvidia') {
      for (const nimModel of NVIDIA_NIM_MODELS) {
        if (nimModel.reviewCapable === false) continue;
        const modelId = `nvidia/${nimModel.id}`;
        models.push({ id: modelId, label: `${providerLabel} \u2014 ${nimModel.label}`, toolSupport: Boolean(nimModel.toolSupport) });
      }
      continue;
    }

    const defaultModel = OPENCODE_PROVIDER_DEFAULT_MODELS[cp.type];
    if (!defaultModel) continue;

    const prefix = cp.type + '/';
    const model = (status.activeModel && status.activeModel.startsWith(prefix))
      ? status.activeModel
      : defaultModel;

    const hasToolSupport = OPENCODE_PROVIDER_TOOL_SUPPORT[cp.type] !== false;
    const modelShortName = model.split('/').slice(1).join('/');
    models.push({ id: model, label: `${providerLabel} \u2014 ${modelShortName}`, toolSupport: hasToolSupport });
  }

  if (models.length === 0) {
    models.push({ id: 'opencode-default', label: 'OpenCode Default', toolSupport: true });
  }

  return { models, activeModel: status.activeModel || 'opencode-default' };
}

/**
 * Configure OpenCode with a provider.
 * Writes API key to ~/.local/share/opencode/auth.json (OpenCode's credential store)
 * and sets the model in ~/.config/opencode/opencode.json.
 * For custom providers (nvidia, ollama), also registers provider config in the config file.
 *
 * @param {string} providerType - 'google', 'nvidia', 'ollama', 'anthropic', 'openai'
 * @param {string} [apiKey] - API key (not needed for ollama)
 * @param {{ model?: string }} [options]
 * @returns {Promise<{success: boolean, configPath: string}>}
 */
async function configureOpenCodeProvider(providerType, apiKey, options = {}) {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const xdgData = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  const authDir = path.join(xdgData, 'opencode');
  const authPath = path.join(authDir, 'auth.json');
  const configDir = path.join(xdgConfig, 'opencode');
  const configPath = path.join(configDir, 'opencode.json');

  // --- 1. Write API key to auth.json ---
  let auth = {};
  try {
    const content = await fs.readFile(authPath, 'utf8');
    auth = JSON.parse(content);
  } catch { /* file doesn't exist yet */ }

  // Map our providerType to OpenCode's auth key
  const authKeyMap = { google: 'google', nvidia: 'nvidia', anthropic: 'anthropic', openai: 'openai' };
  const authKey = authKeyMap[providerType];
  if (authKey && apiKey) {
    auth[authKey] = { type: 'api', key: apiKey };
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(authPath, JSON.stringify(auth, null, 2), 'utf8');
  }

  // --- 2. Set model in config file ---
  let config = {};
  try {
    const content = await fs.readFile(configPath, 'utf8');
    config = JSON.parse(content);
  } catch { /* file doesn't exist yet */ }

  if (!config.$schema) {
    config.$schema = 'https://opencode.ai/config.json';
  }
  if (!config.provider || typeof config.provider !== 'object') {
    config.provider = {};
  }

  // Set model name — built-in providers use "provider/model" format.
  // If options.model is explicitly provided, always update (user chose a model).
  // Otherwise only set when no model is configured yet (don't overwrite when adding
  // a second provider's key).
  const modelMap = {
    google: options.model || 'google/gemini-3.1-pro-preview',
    anthropic: options.model || 'anthropic/claude-sonnet-4-6',
    openai: options.model || 'openai/gpt-5.5',
    nvidia: options.model ? `nvidia/${options.model.replace(/^nvidia\//, '')}` : 'nvidia/meta/llama-3.1-405b-instruct',
    ollama: options.model || 'ollama/llama3.2',
  };
  if (options.model || !config.model) {
    config.model = modelMap[providerType];
  }

  // Custom providers (nvidia, ollama) need provider config in the config file
  if (providerType === 'nvidia') {
    // Keep the full namespace/model ID (e.g. "meta/llama-3.1-405b-instruct") — NIM API requires it
    const modelId = options.model || 'meta/llama-3.1-405b-instruct';
    // Build models map with all curated models so user can switch without reconfiguring
    const modelsMap = {};
    for (const m of NVIDIA_NIM_MODELS) {
      modelsMap[m.id] = { name: m.label };
    }
    // Ensure the chosen model is in the map even if not curated
    if (!modelsMap[modelId]) {
      modelsMap[modelId] = { name: modelId };
    }
    config.provider.nvidia = {
      npm: '@ai-sdk/openai-compatible',
      name: 'NVIDIA NIM',
      options: {
        baseURL: 'https://integrate.api.nvidia.com/v1',
        apiKey: `{env:NVIDIA_API_KEY}`,
      },
      models: modelsMap,
    };
    // NVIDIA NIM also needs the key in env (openai-compatible SDK reads it from options)
    if (apiKey) {
      auth.nvidia = { type: 'api', key: apiKey };
      await fs.writeFile(authPath, JSON.stringify(auth, null, 2), 'utf8');
    }
  } else if (providerType === 'ollama') {
    config.provider.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: { baseURL: 'http://localhost:11434/v1' },
      models: {
        [options.model?.replace('ollama/', '') || 'llama3.2']: {
          name: options.model?.replace('ollama/', '') || 'llama3.2',
        },
      },
    };
  }

  // Write config
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  return { success: true, configPath };
}

/**
 * Verify OpenCode's configured provider works by making a direct API call.
 * This is faster and more reliable than running `opencode run` (which does heavy init).
 * @returns {Promise<{success: boolean, error?: string, latencyMs: number}>}
 */
async function verifyOpenCodeConnection() {
  const status = await getOpenCodeStatus();
  if (!status.installed || !status.binaryPath) {
    return { success: false, error: 'OpenCode CLI is not installed', latencyMs: 0 };
  }

  // Derive provider from active model (e.g. "google/gemini-2.5-flash" → "google")
  const activeProvider = status.activeModel?.split('/')[0] || status.configuredProvider;
  if (!activeProvider) {
    return { success: false, error: 'No provider configured', latencyMs: 0 };
  }

  // Read API key from auth file
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const xdgData = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  const authPath = path.join(xdgData, 'opencode', 'auth.json');
  let auth = {};
  try {
    auth = JSON.parse(await fs.readFile(authPath, 'utf8'));
  } catch {
    return { success: false, error: 'Could not read credentials', latencyMs: 0 };
  }

  const providerAuth = auth[activeProvider];
  const apiKey = providerAuth?.key;

  const startTime = Date.now();
  try {
    switch (activeProvider) {
      case 'google': {
        // Google Gemini API: POST to generativelanguage.googleapis.com
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }] }),
            signal: AbortSignal.timeout(15000),
          },
        );
        const latencyMs = Date.now() - startTime;
        if (resp.ok) return { success: true, latencyMs };
        const err = await resp.json().catch(() => ({}));
        const msg = err?.error?.message || `HTTP ${resp.status}`;
        if (resp.status === 401 || resp.status === 403) {
          return { success: false, error: 'Authentication failed — check your API key', latencyMs };
        }
        return { success: false, error: msg, latencyMs };
      }

      case 'anthropic': {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Say OK' }],
          }),
          signal: AbortSignal.timeout(15000),
        });
        const latencyMs = Date.now() - startTime;
        if (resp.ok) return { success: true, latencyMs };
        const err = await resp.json().catch(() => ({}));
        if (resp.status === 401) {
          return { success: false, error: 'Authentication failed — check your API key', latencyMs };
        }
        return { success: false, error: err?.error?.message || `HTTP ${resp.status}`, latencyMs };
      }

      case 'openai': {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Say OK' }],
          }),
          signal: AbortSignal.timeout(15000),
        });
        const latencyMs = Date.now() - startTime;
        if (resp.ok) return { success: true, latencyMs };
        const err = await resp.json().catch(() => ({}));
        if (resp.status === 401) {
          return { success: false, error: 'Authentication failed — check your API key', latencyMs };
        }
        return { success: false, error: err?.error?.message || `HTTP ${resp.status}`, latencyMs };
      }

      case 'nvidia': {
        const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'meta/llama-3.1-70b-instruct',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Say OK' }],
          }),
          signal: AbortSignal.timeout(15000),
        });
        const latencyMs = Date.now() - startTime;
        if (resp.ok) return { success: true, latencyMs };
        const err = await resp.json().catch(() => ({}));
        if (resp.status === 401) {
          return { success: false, error: 'Authentication failed — check your API key', latencyMs };
        }
        return { success: false, error: err?.error?.message || `HTTP ${resp.status}`, latencyMs };
      }

      case 'ollama': {
        // Just check if Ollama is responding
        const resp = await fetch('http://localhost:11434/api/tags', {
          signal: AbortSignal.timeout(5000),
        });
        const latencyMs = Date.now() - startTime;
        if (resp.ok) return { success: true, latencyMs };
        return { success: false, error: 'Ollama is not responding', latencyMs };
      }

      default:
        return { success: false, error: `Unknown provider: ${activeProvider}`, latencyMs: 0 };
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { success: false, error: 'Connection timed out', latencyMs };
    }
    if (error?.cause?.code === 'ECONNREFUSED') {
      return { success: false, error: 'Connection refused — is the provider reachable?', latencyMs };
    }
    return { success: false, error: error?.message || 'Connection test failed', latencyMs };
  }
}

/**
 * Check if Ollama is running locally and list available models.
 * @returns {Promise<{running: boolean, models: Array<{id: string, label: string}>}>}
 */
async function checkOllamaRunning() {
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { running: false, models: [] };
    }
    const data = await response.json();
    const models = (data.models || []).map(m => ({
      id: `ollama/${m.name}`,
      label: m.name,
    }));
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

/**
 * Get curated list of NVIDIA NIM models.
 * @param {{ toolSupportOnly?: boolean, reviewCapableOnly?: boolean }} [options]
 * @returns {Array<{id: string, label: string, toolSupport: boolean, reviewCapable: boolean}>}
 */
function listNvidiaNimModels({ toolSupportOnly, reviewCapableOnly } = {}) {
  let models = NVIDIA_NIM_MODELS;
  if (toolSupportOnly) {
    models = models.filter(m => m.toolSupport);
  }
  if (reviewCapableOnly) {
    models = models.filter(m => m.reviewCapable !== false);
  }
  return models;
}

/**
 * Reset provider state for sign-out flow.
 * Deletes the providers config file and clears in-memory state
 * so the next launch triggers fresh CLI detection.
 */
async function resetForSignout() {
  // Clear in-memory state
  globalProviders = [];
  activeProviderId = null;

  // Delete persisted config file
  try {
    await fs.unlink(getGlobalConfigPath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ---------------------------------------------------------------------------
// Context-aware active provider (review vs build)
// ---------------------------------------------------------------------------

const VALID_PROVIDER_CONTEXTS = new Set(['review', 'build']);

function resolveDefaultContextProvider(context, providers, fallbackProviderId = null) {
  if (!VALID_PROVIDER_CONTEXTS.has(context)) return null;

  // `unchecked` CLI-detected providers (Keychain-backed installs we couldn't
  // verify offline) are eligible alongside connected ones — the actual
  // review will surface a real auth error if the CLI is broken.
  const eligibleProviders = Array.isArray(providers)
    ? providers.filter(isProviderUsable)
    : [];
  if (eligibleProviders.length === 0) return null;

  // Default to Codex CLI for both build and review contexts
  const preferredProvider = eligibleProviders.find(
    (provider) => provider.type === 'openai' && provider.source === 'cli_detected'
  );

  if (preferredProvider) {
    return preferredProvider;
  }

  if (fallbackProviderId) {
    const fallbackProvider = eligibleProviders.find((provider) => provider.id === fallbackProviderId);
    if (fallbackProvider) {
      return fallbackProvider;
    }
  }

  return eligibleProviders[0] || null;
}

/**
 * Get the active provider for a specific context (review or build).
 * Falls back to the global activeProviderId from .atlas-providers.json.
 *
 * @param {'review'|'build'} context
 * @returns {Promise<{providerId: string, model: string}|null>}
 */
async function getContextActiveProvider(context) {
  if (!VALID_PROVIDER_CONTEXTS.has(context)) return null;

  const settingKey = `${context}_active_provider`;
  try {
    const result = await db.query(
      'SELECT value FROM settings WHERE id = $1',
      [settingKey]
    );
    if (result.rows.length > 0 && result.rows[0].value) {
      const parsed = typeof result.rows[0].value === 'string'
        ? JSON.parse(result.rows[0].value)
        : result.rows[0].value;
      if (parsed && parsed.providerId) return parsed;
    }
  } catch { /* fall through to global */ }

  // Fallback: derive from global activeProviderId
  await loadGlobalConfig();
  const provider = resolveDefaultContextProvider(context, globalProviders, activeProviderId);
  return provider
    ? { providerId: provider.id, model: provider.model || null }
    : null;
}

/**
 * Set the active provider for a specific context (review or build).
 *
 * @param {'review'|'build'} context
 * @param {{ providerId: string, model?: string }} data
 * @returns {Promise<{ providerId: string, model: string|null }>}
 */
async function setContextActiveProvider(context, data) {
  if (!VALID_PROVIDER_CONTEXTS.has(context)) {
    throw new Error(`Invalid context: ${context}`);
  }
  if (!data?.providerId) {
    throw new Error('providerId is required');
  }

  const settingKey = `${context}_active_provider`;
  const payload = { providerId: data.providerId, model: data.model || null };
  const valueStr = JSON.stringify(payload);

  const dbType = db.getDbType ? db.getDbType() : 'postgres';
  if (dbType === 'sqlite') {
    await db.query(
      `INSERT INTO settings (id, value, updated_at)
       VALUES ($1, $2, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`,
      [settingKey, valueStr]
    );
  } else {
    await db.query(
      `INSERT INTO settings (id, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT(id) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [settingKey, valueStr]
    );
  }

  return payload;
}

/**
 * Get CLI auth status for all three CLI tools.
 * Returns which tools are authenticated (have credentials detected).
 */
async function getCliAuthStatus() {
  const [claude, codex, gemini] = await Promise.all([
    detectClaudeCode().catch(() => null),
    detectCodexCLI().catch(() => null),
    detectGeminiCLI().catch(() => null),
  ]);

  // A tool is "authenticated" only if detection found a concrete credential source
  // or an explicit Gemini auth selection that the CLI can execute directly.
  const hasAuth = (result) =>
    result !== null && Boolean(result._credentialSource);

  // Resolve the user-installed CLI binaries the detectors would actually use.
  const [claudePath, codexPath, geminiPath] = await Promise.all([
    findBinary('claude').catch(() => null),
    findBinary('codex').catch(() => null),
    findBinary('gemini').catch(() => null),
  ]);

  const binaryPaths = {
    'claude-code': claudePath,
    codex: codexPath,
    'gemini-cli': geminiPath,
  };

  const claudePrerequisite = getClaudeWindowsPrerequisiteStatus(binaryPaths['claude-code']);

  return {
    'claude-code': {
      authenticated: !!hasAuth(claude),
      source: claude?._credentialSource || null,
      binaryPath: binaryPaths['claude-code'],
      prerequisite: claudePrerequisite,
    },
    codex: {
      authenticated: !!hasAuth(codex),
      source: codex?._credentialSource || null,
      binaryPath: binaryPaths['codex'],
      prerequisite: null,
    },
    'gemini-cli': {
      authenticated: !!hasAuth(gemini),
      source: gemini?._credentialSource || null,
      binaryPath: binaryPaths['gemini-cli'],
      prerequisite: null,
    },
  };
}

export default {
  // Scanning & detection
  scanForCLIProviders,
  fullScan,
  validateAllProviders,
  // Returns the in-flight background scan promise (or null) so callers can
  // await until any auto-heal scan kicked off by getProviders() completes.
  getPendingScanPromise: () => _bgScanPromise,

  // CRUD
  addBYOKProvider,
  removeBYOKProvider,
  setActiveProvider,
  updateProviderModel,

  // Reading
  getProviders,
  getActiveProviderWithKey,
  getReviewProviderCandidatesWithKeys,
  isProviderUsable,
  isProviderConfirmedConnected,
  getProviderConfigs,
  getProviderDefaultModel,
  getProviderCliDefaultModel,
  getProviderReviewExecutionProfile,
  getAnthropicCLIModels,
  resolveAnthropicCliModelArg,
  getSmartReviewModel,
  getCostAwareReviewModel,
  isKnownProviderModel,
  isModelReviewCapable,
  REVIEW_MODEL_DEFAULTS,

  // Testing
  testConnection,

  // Auth
  buildAuthHeaders,

  // Internal
  loadGlobalConfig,

  // Reset
  resetForSignout,

  // OpenCode setup wizard
  getOpenCodeStatus,
  getOpenCodeModels,
  getOpenCodeModelsForReview,
  configureOpenCodeProvider,
  setOpenCodeActiveModel,
  verifyOpenCodeConnection,
  checkOllamaRunning,
  listNvidiaNimModels,

  // Context-aware active provider
  getContextActiveProvider,
  setContextActiveProvider,

  // CLI auth status
  getCliAuthStatus,
};
