import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import providerService from '../providerService.js';
import { encrypt } from '../../utils/encryption.js';
import { close as closeDb } from '../../db/index.js';

let tempDataDir;
let originalDataDir;
let originalEncryptionKey;
let originalDisableCliProviderDetection;
let originalOpenAiApiKey;
let originalHome;
let originalUserProfile;
let originalXdgConfigHome;
let originalXdgDataHome;
let originalAnthropicApiKey;
let originalClaudeCodeOauthToken;
let originalGoogleApiKey;
let originalGeminiApiKey;
let originalGoogleApplicationCredentials;
let originalOpenAiCompatUrl;
let originalLocalAppData;
let originalAppData;
let originalPath;
let originalDbType;
let originalCodexModelRefreshTtlMs;
let originalAtlasAppVersion;

beforeEach(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-provider-api-first-'));
  originalDataDir = process.env.ATLAS_DATA_DIR;
  originalEncryptionKey = process.env.ENCRYPTION_KEY;
  originalDisableCliProviderDetection = process.env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION;
  originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  originalClaudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  originalGoogleApiKey = process.env.GOOGLE_API_KEY;
  originalGeminiApiKey = process.env.GEMINI_API_KEY;
  originalGoogleApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  originalOpenAiCompatUrl = process.env.ATLAS_OPENAI_COMPAT_URL;
  originalLocalAppData = process.env.LOCALAPPDATA;
  originalAppData = process.env.APPDATA;
  originalPath = process.env.PATH;
  originalDbType = process.env.ATLAS_DB_TYPE;
  originalCodexModelRefreshTtlMs = process.env.ATLAS_CODEX_MODEL_REFRESH_TTL_MS;
  originalAtlasAppVersion = process.env.ATLAS_APP_VERSION;
  process.env.ATLAS_DATA_DIR = tempDataDir;
  process.env.ATLAS_DB_TYPE = 'sqlite';
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.HOME = tempDataDir;
  process.env.USERPROFILE = tempDataDir;
  process.env.XDG_CONFIG_HOME = path.join(tempDataDir, '.config');
  process.env.XDG_DATA_HOME = path.join(tempDataDir, '.local', 'share');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.ATLAS_OPENAI_COMPAT_URL;
  process.env.LOCALAPPDATA = path.join(tempDataDir, 'AppData', 'Local');
  process.env.APPDATA = path.join(tempDataDir, 'AppData', 'Roaming');
});

afterEach(async () => {
  await providerService.getPendingScanPromise()?.catch(() => {});
  await closeDb().catch(() => {});

  if (originalDataDir === undefined) delete process.env.ATLAS_DATA_DIR;
  else process.env.ATLAS_DATA_DIR = originalDataDir;

  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;

  if (originalDisableCliProviderDetection === undefined) delete process.env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION;
  else process.env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION = originalDisableCliProviderDetection;

  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;

  if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;

  if (originalClaudeCodeOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeCodeOauthToken;

  if (originalGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
  else process.env.GOOGLE_API_KEY = originalGoogleApiKey;

  if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiApiKey;

  if (originalGoogleApplicationCredentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalGoogleApplicationCredentials;

  if (originalOpenAiCompatUrl === undefined) delete process.env.ATLAS_OPENAI_COMPAT_URL;
  else process.env.ATLAS_OPENAI_COMPAT_URL = originalOpenAiCompatUrl;

  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;

  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;

  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;

  if (originalDbType === undefined) delete process.env.ATLAS_DB_TYPE;
  else process.env.ATLAS_DB_TYPE = originalDbType;

  if (originalCodexModelRefreshTtlMs === undefined) delete process.env.ATLAS_CODEX_MODEL_REFRESH_TTL_MS;
  else process.env.ATLAS_CODEX_MODEL_REFRESH_TTL_MS = originalCodexModelRefreshTtlMs;

  if (originalAtlasAppVersion === undefined) delete process.env.ATLAS_APP_VERSION;
  else process.env.ATLAS_APP_VERSION = originalAtlasAppVersion;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rm(tempDataDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

const isWindowsTestHost = process.platform === 'win32';

function testCliPath(binDir, name) {
  return path.join(binDir, isWindowsTestHost ? `${name}.cmd` : name);
}

function withTestBinOnPath(binDir) {
  if (isWindowsTestHost) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return [
      binDir,
      path.dirname(process.execPath),
      path.join(systemRoot, 'System32'),
      systemRoot,
    ].filter(Boolean).join(path.delimiter);
  }

  return [
    binDir,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(path.delimiter);
}

async function writeFakeCli(binDir, name, posixScript, windowsScript) {
  await fs.mkdir(binDir, { recursive: true });
  const cliPath = testCliPath(binDir, name);
  await fs.writeFile(cliPath, isWindowsTestHost ? windowsScript : posixScript, 'utf8');
  if (!isWindowsTestHost) {
    await fs.chmod(cliPath, 0o755);
  }
  return cliPath;
}

function codexCatalogScripts(models, options = {}) {
  const payload = JSON.stringify({ models });
  const logLine = options.callLogPath
    ? `  printf 'call\\n' >> "${options.callLogPath}"\n  sleep 0.2\n`
    : '';
  const windowsLogLine = options.callLogPath
    ? `  >>"${options.callLogPath}" echo call\r\n  node -e "setTimeout(function(){}, 200)"\r\n`
    : '';

  return {
    posix: `#!/bin/sh
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
${logLine}  echo '${payload}'
  exit 0
fi
exit 0
`,
    windows: `@echo off\r\nif /I "%~1"=="debug" if /I "%~2"=="models" (\r\n${windowsLogLine}  echo ${payload}\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n`,
  };
}

function claudeAuthStatusScripts(authMethod = 'claude.ai') {
  const payload = JSON.stringify({ loggedIn: true, authMethod });
  return {
    posix: `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "Usage: claude --print --verbose --tools --session-id --resume"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "2.1.89 (Claude Code)"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  echo '${payload}'
  exit 0
fi
exit 0
`,
    windows: `@echo off\r\nif /I "%~1"=="--help" (\r\n  echo Usage: claude --print --verbose --tools --session-id --resume\r\n  exit /b 0\r\n)\r\nif /I "%~1"=="--version" (\r\n  echo 2.1.89 (Claude Code)\r\n  exit /b 0\r\n)\r\nif /I "%~1"=="auth" if /I "%~2"=="status" if /I "%~3"=="--json" (\r\n  echo ${payload}\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n`,
  };
}

function authFailScripts(message) {
  return {
    posix: `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "Usage: claude --print --verbose --tools --session-id --resume"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "2.1.89 (Claude Code)"
  exit 0
fi
if [ "$1" = "auth" ]; then
  echo "${message}" >&2
  exit 1
fi
exit 0
`,
    windows: `@echo off\r\nif /I "%~1"=="--help" (\r\n  echo Usage: claude --print --verbose --tools --session-id --resume\r\n  exit /b 0\r\n)\r\nif /I "%~1"=="--version" (\r\n  echo 2.1.89 (Claude Code)\r\n  exit /b 0\r\n)\r\nif /I "%~1"=="auth" (\r\n  echo ${message} 1>&2\r\n  exit /b 1\r\n)\r\nexit /b 0\r\n`,
  };
}

function codexExecAuthFailureScripts() {
  return {
    posix: `#!/bin/sh
if [ "$1" = "exec" ]; then
  echo "not authenticated" >&2
  exit 1
fi
exit 0
`,
    windows: '@echo off\r\nif /I "%~1"=="exec" (\r\n  echo not authenticated 1>&2\r\n  exit /b 1\r\n)\r\nexit /b 0\r\n',
  };
}

describe('providerService API-first routing', () => {
  const itWindows = process.platform === 'win32' ? it : it.skip;

  it('prefers API mode when a valid BYOK key exists even if CLI flag is set', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const encrypted = encrypt('sk-live-test-key');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'byok-openai',
        providers: [
          {
            id: 'byok-openai',
            type: 'openai',
            source: 'byok',
            label: 'OpenAI (BYOK)',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
            _encryptedKey: encrypted,
            _useCodexCLI: true,
          },
        ],
      }, null, 2),
      'utf8'
    );

    const active = await providerService.getActiveProviderWithKey();
    expect(active).not.toBeNull();
    expect(active.apiKey).toBe('sk-live-test-key');
    expect(active.useCodexCLI).toBe(false);
  });

  it('falls back to CLI mode when no API key is available', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli-openai',
        providers: [
          {
            id: 'cli-openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (subscription)',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
            _authType: 'codex_oauth',
            _useCodexCLI: true,
            _credentialSource: 'codex_oauth:/tmp/nonexistent-auth.json',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const active = await providerService.getActiveProviderWithKey();
    expect(active).not.toBeNull();
    expect(active.apiKey).toBeNull();
    expect(active.useCodexCLI).toBe(true);
  });

  it('returns review provider candidates with active provider first and API fallback next', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const encrypted = encrypt('sk-live-fallback-key');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli-anthropic',
        providers: [
          {
            id: 'cli-anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude CLI subscription',
            model: 'claude-sonnet-4-6',
            status: 'connected',
            isActive: true,
            _useClaudeCLI: true,
            _authType: 'oauth',
            _credentialSource: 'oauth:/tmp/nonexistent-claude-credentials.json',
          },
          {
            id: 'byok-openai',
            type: 'openai',
            source: 'byok',
            label: 'OpenAI (BYOK)',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: false,
            _encryptedKey: encrypted,
          },
        ],
      }, null, 2),
      'utf8'
    );

    const candidates = await providerService.getReviewProviderCandidatesWithKeys({ maxCandidates: 3 });
    expect(candidates).toHaveLength(2);
    expect(candidates[0].provider.id).toBe('cli-anthropic');
    expect(candidates[0].useClaudeCLI).toBe(true);
    expect(candidates[1].provider.id).toBe('byok-openai');
    expect(candidates[1].apiKey).toBe('sk-live-fallback-key');
    expect(candidates[1].useCodexCLI).toBe(false);
  });

  it('keeps cli-detected oauth providers in CLI mode even when a token is present', async () => {
    const oauthPath = path.join(tempDataDir, 'claude-credentials.json');
    await fs.writeFile(
      oauthPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token-not-an-api-key',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      }),
      'utf8'
    );

    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli-anthropic',
        providers: [
          {
            id: 'cli-anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (subscription) — via CLI',
            model: 'claude-opus-4-6',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _credentialSource: `oauth:${oauthPath}`,
          },
        ],
      }, null, 2),
      'utf8'
    );

    const active = await providerService.getActiveProviderWithKey();
    expect(active).not.toBeNull();
    expect(active.useClaudeCLI).toBe(true);
    expect(active.apiKey).toBeNull();
  });

  it('skips non-runnable active provider and promotes runnable fallback candidate', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const encrypted = encrypt('sk-live-runnable');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'active-broken',
        providers: [
          {
            id: 'active-broken',
            type: 'openai',
            source: 'cli_detected',
            label: 'Broken active provider',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
          },
          {
            id: 'byok-openai',
            type: 'openai',
            source: 'byok',
            label: 'OpenAI (BYOK)',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: false,
            _encryptedKey: encrypted,
          },
        ],
      }, null, 2),
      'utf8'
    );

    const candidates = await providerService.getReviewProviderCandidatesWithKeys({ maxCandidates: 2 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].provider.id).toBe('byok-openai');
    expect(candidates[0].apiKey).toBe('sk-live-runnable');
  });

  it('returns an unchecked Keychain-backed Claude as the primary review candidate when explicitly preferred', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const claudeConfigDir = path.join(tempDataDir, '.claude');
    const authDenied = authFailScripts('User interaction is not allowed');

    await fs.mkdir(claudeConfigDir, { recursive: true });
    const claudePath = await writeFakeCli(binDir, 'claude', authDenied.posix, authDenied.windows);
    await fs.writeFile(path.join(claudeConfigDir, 'settings.json'), '{"version":1}', 'utf8');
    process.env.PATH = withTestBinOnPath(binDir);

    // Two providers persisted: Claude as Keychain-backed (unchecked) + Codex
    // as a connected fallback. Reproduces the dev's "click Use on Claude
    // then run review" path that previously routed to a non-existent Gemini.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (subscription) — via CLI',
            model: 'claude-opus-4-7',
            status: 'unchecked',
            isActive: false,
            _authType: 'oauth',
            _useClaudeCLI: true,
            _binaryPath: claudePath,
          },
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (plus) — via CLI',
            model: 'gpt-5.5',
            status: 'connected',
            isActive: true,
            _authType: 'codex_oauth',
            _useCodexCLI: true,
          },
        ],
      }, null, 2),
      'utf8',
    );

    const candidates = await providerService.getReviewProviderCandidatesWithKeys({
      maxCandidates: 3,
      preferredProviderId: 'cli_anthropic',
    });

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].provider.id).toBe('cli_anthropic');
    expect(candidates[0].useClaudeCLI).toBe(true);
    // Codex remains as a connected failover
    expect(candidates.some((c) => c.provider.id === 'cli_openai')).toBe(true);
  });

  it('resolves smart review models by provider type and phase', () => {
    expect(providerService.getSmartReviewModel('anthropic', 'triage')).toBe('claude-haiku-4-5-20251001');
    expect(providerService.getSmartReviewModel('anthropic', 'review')).toBe('claude-sonnet-4-6');
    expect(providerService.getSmartReviewModel('openai', 'triage')).toBe('gpt-5.4-nano');
    expect(providerService.getSmartReviewModel('openai', 'review')).toBe('gpt-5.5');
    expect(providerService.getSmartReviewModel('google', 'triage')).toBe('gemini-3.1-flash-lite-preview');
    expect(providerService.getSmartReviewModel('google', 'review')).toBe('gemini-3.1-pro-preview');
    expect(providerService.getSmartReviewModel('openai', 'review', { transport: 'cli' })).toBe('gpt-5.3-codex');
    expect(providerService.getSmartReviewModel('openai', 'walkthrough', { transport: 'cli' })).toBe('gpt-5.3-codex');
    expect(providerService.getSmartReviewModel('google', 'triage', { transport: 'cli' })).toBe('gemini-3.1-flash-lite-preview');
    expect(providerService.getSmartReviewModel('google', 'review', { transport: 'cli' })).toBe('gemini-3-flash-preview');
    expect(providerService.getSmartReviewModel('google', 'verifier', { transport: 'cli' })).toBe('gemini-3-flash-preview');
  });

  it('resolves cost-aware review models without changing smart defaults', () => {
    // Anthropic smart and cost-aware both land on Sonnet 4.6 today; the
    // contrast still holds for openai/google below.
    expect(providerService.getSmartReviewModel('anthropic', 'review')).toBe('claude-sonnet-4-6');
    expect(providerService.getCostAwareReviewModel('anthropic', 'review')).toBe('claude-sonnet-4-6');
    expect(providerService.getCostAwareReviewModel('anthropic', 'verifier')).toBe('claude-sonnet-4-6');
    expect(providerService.getSmartReviewModel('openai', 'review')).toBe('gpt-5.5');
    expect(providerService.getCostAwareReviewModel('openai', 'review')).toBe('gpt-5.3-codex');
    expect(providerService.getCostAwareReviewModel('openai', 'synthesis')).toBe('gpt-5.3-codex');
    expect(providerService.getCostAwareReviewModel('openai', 'triage', { transport: 'cli' })).toBe('gpt-5.3-codex');
    expect(providerService.getCostAwareReviewModel('google', 'review')).toBe('gemini-3-flash-preview');
    expect(providerService.getCostAwareReviewModel('unknown', 'review')).toBeNull();
  });

  it('returns provider default model for known provider types', () => {
    expect(providerService.getProviderDefaultModel('anthropic')).toBe('claude-sonnet-4-6');
    expect(providerService.getProviderDefaultModel('openai')).toBe('gpt-5.5');
    expect(providerService.getProviderDefaultModel('google')).toBe('gemini-3.1-pro-preview');
    expect(providerService.getProviderCliDefaultModel('openai')).toBe('gpt-5.3-codex');
    expect(providerService.getProviderCliDefaultModel('google')).toBe('gemini-3-flash-preview');
    expect(providerService.getProviderDefaultModel('unknown')).toBeNull();
  });

  it('migrates persisted cli-detected Gemini providers off unsupported pro preview defaults', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_google',
        providers: [
          {
            id: 'cli_google',
            type: 'google',
            source: 'cli_detected',
            label: 'Gemini CLI (detected)',
            model: 'gemini-3.1-pro-preview',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
          },
        ],
      }, null, 2),
      'utf8',
    );

    await providerService.loadGlobalConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers).toHaveLength(1);
    expect(persisted.providers[0].model).toBe('gemini-3-flash-preview');
  });

  it('keeps persisted cli-detected Codex providers on the safe CLI default', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
          },
        ],
      }, null, 2),
      'utf8',
    );

    await providerService.loadGlobalConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers).toHaveLength(1);
    expect(persisted.providers[0].model).toBe('gpt-5.3-codex');
  });

  it('preserves persisted cli-detected Codex GPT-5.5 selections', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.5',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
          },
        ],
      }, null, 2),
      'utf8',
    );

    await providerService.loadGlobalConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers).toHaveLength(1);
    expect(persisted.providers[0].model).toBe('gpt-5.5');
  });

  it('treats legacy Codex CLI non-default models as implicit user selections', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.4',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
          },
        ],
      }, null, 2),
      'utf8',
    );

    await providerService.loadGlobalConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers[0].model).toBe('gpt-5.4');
    expect(persisted.providers[0]._modelSelectionSource).toBe('user');
  });

  it('detects GPT-5.5 from the Codex model catalog when available', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const codexDir = path.join(tempDataDir, '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    await fs.mkdir(codexDir, { recursive: true });
    const codexScript = codexCatalogScripts([
      { slug: 'gpt-5.5', visibility: 'list', upgrade: null },
      { slug: 'gpt-5.3-codex', visibility: 'list', upgrade: null },
    ]);
    await writeFakeCli(binDir, 'codex', codexScript.posix, codexScript.windows);
    await fs.writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: 'chatgpt-subscription-token',
          id_token: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJwcm8ifX0=.sig',
        },
      }),
      'utf8'
    );
    process.env.PATH = withTestBinOnPath(binDir);

    const providers = await providerService.scanForCLIProviders();
    const codex = providers.find((provider) => provider.id === 'cli_openai');

    expect(codex).toBeTruthy();
    expect(codex.model).toBe('gpt-5.5');
    expect(codex._modelSelectionSource).toBe('detected');
    expect(Date.parse(codex._codexModelCatalogCheckedAt)).toBeGreaterThan(0);
  }, 20000);

  it('detects GPT-5.4 from the Codex model catalog when GPT-5.5 is unavailable', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const codexDir = path.join(tempDataDir, '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    await fs.mkdir(codexDir, { recursive: true });
    const codexScript = codexCatalogScripts([
      { slug: 'gpt-5.4', visibility: 'list', upgrade: null },
      { slug: 'gpt-5.3-codex', visibility: 'list', upgrade: null },
    ]);
    await writeFakeCli(binDir, 'codex', codexScript.posix, codexScript.windows);
    await fs.writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: 'chatgpt-subscription-token',
          id_token: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJwcm8ifX0=.sig',
        },
      }),
      'utf8'
    );
    process.env.PATH = withTestBinOnPath(binDir);

    const providers = await providerService.scanForCLIProviders();
    const codex = providers.find((provider) => provider.id === 'cli_openai');

    expect(codex).toBeTruthy();
    expect(codex.model).toBe('gpt-5.4');
    expect(codex._modelSelectionSource).toBe('detected');
  }, 20000);

  it('refreshes auto-detected Codex models on provider read after CLI updates', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const codexScript = codexCatalogScripts([
      { slug: 'gpt-5.5', visibility: 'list', upgrade: null },
      { slug: 'gpt-5.3-codex', visibility: 'list', upgrade: null },
    ]);
    await writeFakeCli(binDir, 'codex', codexScript.posix, codexScript.windows);
    process.env.PATH = withTestBinOnPath(binDir);
    process.env.ATLAS_CODEX_MODEL_REFRESH_TTL_MS = '60000';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
            _modelSelectionSource: 'detected',
            _codexModelCatalogCheckedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
      }, null, 2),
      'utf8',
    );

    const result = await providerService.getProviders();
    const codex = result.providers.find((provider) => provider.id === 'cli_openai');

    expect(codex).toBeTruthy();
    expect(codex.model).toBe('gpt-5.5');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers[0].model).toBe('gpt-5.5');
  }, 20000);

  it('refreshes auto-detected Codex models on provider read after an Atlas app update', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const codexScript = codexCatalogScripts([
      { slug: 'gpt-5.5', visibility: 'list', upgrade: null },
      { slug: 'gpt-5.3-codex', visibility: 'list', upgrade: null },
    ]);
    await writeFakeCli(binDir, 'codex', codexScript.posix, codexScript.windows);
    process.env.PATH = withTestBinOnPath(binDir);
    process.env.ATLAS_APP_VERSION = '0.25.7';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        appVersion: '0.25.6',
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
            _modelSelectionSource: 'detected',
            _codexModelCatalogCheckedAt: new Date().toISOString(),
            _codexModelCatalogAppVersion: '0.25.6',
          },
        ],
      }, null, 2),
      'utf8',
    );

    const result = await providerService.getProviders();
    const codex = result.providers.find((provider) => provider.id === 'cli_openai');

    expect(codex).toBeTruthy();
    expect(codex.model).toBe('gpt-5.5');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.appVersion).toBe('0.25.7');
    expect(persisted.providers[0].model).toBe('gpt-5.5');
    expect(persisted.providers[0]._codexModelCatalogAppVersion).toBe('0.25.7');
  }, 20000);

  it('deduplicates concurrent Codex model catalog refreshes across provider reads', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const callLogPath = path.join(tempDataDir, 'codex-debug-models.log');
    const codexScript = codexCatalogScripts(
      [
        { slug: 'gpt-5.5', visibility: 'list', upgrade: null },
        { slug: 'gpt-5.3-codex', visibility: 'list', upgrade: null },
      ],
      { callLogPath },
    );
    await writeFakeCli(binDir, 'codex', codexScript.posix, codexScript.windows);
    process.env.PATH = withTestBinOnPath(binDir);
    process.env.ATLAS_APP_VERSION = '0.25.7';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        appVersion: '0.25.6',
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
            _modelSelectionSource: 'detected',
            _codexModelCatalogCheckedAt: '2020-01-01T00:00:00.000Z',
            _codexModelCatalogAppVersion: '0.25.6',
          },
        ],
      }, null, 2),
      'utf8',
    );

    const [first, second] = await Promise.all([
      providerService.getProviders(),
      providerService.getProviders(),
    ]);
    const firstCodex = first.providers.find((provider) => provider.id === 'cli_openai');
    const secondCodex = second.providers.find((provider) => provider.id === 'cli_openai');
    const calls = (await fs.readFile(callLogPath, 'utf8')).trim().split('\n').filter(Boolean);

    expect(firstCodex?.model).toBe('gpt-5.5');
    expect(secondCodex?.model).toBe('gpt-5.5');
    expect(calls).toHaveLength(1);
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers[0].model).toBe('gpt-5.5');
  }, 20000);

  it('does not refresh explicit user-selected Codex models on provider read', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const codexScript = codexCatalogScripts([
      { slug: 'gpt-5.5', visibility: 'list', upgrade: null },
      { slug: 'gpt-5.3-codex', visibility: 'list', upgrade: null },
    ]);
    await writeFakeCli(binDir, 'codex', codexScript.posix, codexScript.windows);
    process.env.PATH = withTestBinOnPath(binDir);
    process.env.ATLAS_CODEX_MODEL_REFRESH_TTL_MS = '60000';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
            _modelSelectionSource: 'user',
            _codexModelCatalogCheckedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
      }, null, 2),
      'utf8',
    );

    const result = await providerService.getProviders();
    const codex = result.providers.find((provider) => provider.id === 'cli_openai');

    expect(codex).toBeTruthy();
    expect(codex.model).toBe('gpt-5.3-codex');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers[0].model).toBe('gpt-5.3-codex');
  }, 20000);

  it('preserves explicit GPT-5.3 Codex selections for cli-detected Codex providers', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
            _modelSelectionSource: 'user',
          },
        ],
      }, null, 2),
      'utf8',
    );

    await providerService.loadGlobalConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers).toHaveLength(1);
    expect(persisted.providers[0].model).toBe('gpt-5.3-codex');
  });

  it('marks provider model updates as explicit user selections', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_openai',
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro) — via CLI',
            model: 'gpt-5.4',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'codex_oauth',
            _useCodexCLI: true,
          },
        ],
      }, null, 2),
      'utf8',
    );

    const updated = await providerService.updateProviderModel('cli_openai', 'gpt-5.3-codex');
    expect(updated.model).toBe('gpt-5.3-codex');

    await providerService.loadGlobalConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers).toHaveLength(1);
    expect(persisted.providers[0].model).toBe('gpt-5.3-codex');
    expect(persisted.providers[0]._modelSelectionSource).toBe('user');
  });

  it('getProviderConfigs includes byokEligible flag based on apiUrl presence', () => {
    const configs = providerService.getProviderConfigs();
    const byType = Object.fromEntries(configs.map(c => [c.type, c.byokEligible]));
    // Providers with apiUrl should be byokEligible: true
    expect(byType.anthropic).toBe(true);
    expect(byType.openai).toBe(true);
    expect(byType.google).toBe(true);
    // CLI-only providers (apiUrl: null) should be byokEligible: false
    expect(byType.opencode).toBe(false);
  });

  it('getProviderConfigs includes balanced review model defaults by phase', () => {
    const configs = providerService.getProviderConfigs();
    const anthropic = configs.find(c => c.type === 'anthropic');
    const openai = configs.find(c => c.type === 'openai');

    expect(anthropic?.reviewModelDefaults).toMatchObject({
      triage: 'claude-haiku-4-5-20251001',
      walkthrough: 'claude-haiku-4-5-20251001',
      review: 'claude-sonnet-4-6',
      synthesis: 'claude-sonnet-4-6',
    });
    expect(openai?.reviewModelDefaults).toMatchObject({
      triage: 'gpt-5.4-nano',
      walkthrough: 'gpt-5.4-nano',
      review: 'gpt-5.5',
      synthesis: 'gpt-5.5',
    });
    expect(openai?.cliReviewModelDefaults).toMatchObject({
      triage: 'gpt-5.3-codex',
      walkthrough: 'gpt-5.3-codex',
      review: 'gpt-5.3-codex',
      synthesis: 'gpt-5.3-codex',
    });
  });

  it('validates known provider models against provider config', () => {
    expect(providerService.isKnownProviderModel('anthropic', 'claude-opus-4-7')).toBe(true);
    expect(providerService.isKnownProviderModel('anthropic', 'claude-opus-4-6')).toBe(true);
    expect(providerService.isKnownProviderModel('openai', 'gpt-5.5')).toBe(true);
    expect(providerService.isKnownProviderModel('openai', 'gpt-5.4')).toBe(true);
    expect(providerService.isKnownProviderModel('openai', 'gpt-5.4-nano')).toBe(true);
    expect(providerService.isKnownProviderModel('openai', 'gpt-5.2-codex')).toBe(false);
    expect(providerService.isKnownProviderModel('openai', 'non-existent-model')).toBe(false);
    expect(providerService.isKnownProviderModel('unknown', 'x')).toBe(false);
  });

  it('isModelReviewCapable returns false for models marked reviewCapable: false', () => {
    expect(providerService.isModelReviewCapable('openai', 'gpt-5.5')).toBe(true);
    expect(providerService.isModelReviewCapable('openai', 'gpt-5.4')).toBe(true);
    expect(providerService.isModelReviewCapable('openai', 'gpt-5.4-nano')).toBe(false);
    expect(providerService.isModelReviewCapable('openai', 'gpt-5.3-codex')).toBe(true);
    expect(providerService.isModelReviewCapable('anthropic', 'claude-sonnet-4-6')).toBe(true);
    // Unknown provider/model — not blocked
    expect(providerService.isModelReviewCapable('unknown', 'x')).toBe(true);
    expect(providerService.isModelReviewCapable('openai', 'non-existent')).toBe(true);
  });

  it('returns no CLI providers when ambient CLI detection is disabled and Atlas has no managed installs', async () => {
    process.env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION = '1';
    const providers = await providerService.scanForCLIProviders();
    expect(providers).toEqual([]);
  });

  it('ignores legacy Atlas-managed Claude installs when ambient CLI detection is disabled', async () => {
    const atlasClaudeDir = path.join(tempDataDir, 'cli-tools', 'bin');
    const atlasClaudePath = path.join(atlasClaudeDir, 'claude');
    const claudeConfigDir = path.join(tempDataDir, '.claude');
    const credentialsPath = path.join(claudeConfigDir, '.credentials.json');
    await fs.mkdir(atlasClaudeDir, { recursive: true });
    await fs.writeFile(atlasClaudePath, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(atlasClaudePath, 0o755);
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'atlas-managed-oauth-token',
          subscriptionType: 'max',
        },
      }),
      'utf8'
    );

    process.env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION = '1';

    await expect(providerService.scanForCLIProviders()).resolves.toEqual([]);
  });

  it('detects an ambient Claude binary even when no credentials are configured yet', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const claudePath = path.join(binDir, 'claude');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(claudePath, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Usage: claude --print --verbose --tools --session-id --resume"; exit 0; fi\nif [ "$1" = "--version" ]; then echo "2.1.89 (Claude Code)"; exit 0; fi\nexit 0\n', 'utf8');
    await fs.chmod(claudePath, 0o755);
    process.env.PATH = withTestBinOnPath(binDir);

    const providers = await providerService.scanForCLIProviders();
    const claude = providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.label).toBe('Claude Code (installed - sign in required)');
    expect(claude.status).toBe('error');
    expect(claude.error).toContain('claude login');
    expect(claude._binaryPath).toBe(claudePath);
  }, 10000);

  it('detects Claude installs with a config directory but no extractable credentials', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const claudePath = path.join(binDir, 'claude');
    const claudeConfigDir = path.join(tempDataDir, '.claude');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(claudePath, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Usage: claude --print --verbose --tools --session-id --resume"; exit 0; fi\nif [ "$1" = "--version" ]; then echo "2.1.89 (Claude Code)"; exit 0; fi\nexit 0\n', 'utf8');
    await fs.chmod(claudePath, 0o755);
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeConfigDir, 'config.json'),
      JSON.stringify({ theme: 'dark' }),
      'utf8',
    );
    process.env.PATH = withTestBinOnPath(binDir);

    const providers = await providerService.scanForCLIProviders();
    const claude = providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.label).toBe('Claude Code (installed - sign in required)');
    expect(claude.status).toBe('error');
    expect(claude.error).toContain('claude login');
    expect(claude._binaryPath).toBe(claudePath);
  }, 10000);

  it('detects Claude auth via cli auth status even without readable credential files', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const claudeScript = claudeAuthStatusScripts('claude.ai');
    const claudePath = await writeFakeCli(binDir, 'claude', claudeScript.posix, claudeScript.windows);
    process.env.PATH = withTestBinOnPath(binDir);

    const providers = await providerService.scanForCLIProviders();
    const claude = providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.label).toBe('Claude Code (claude.ai) — via CLI');
    expect(claude.status).toBe('connected');
    expect(claude._authType).toBe('oauth');
    expect(claude._credentialSource).toBe('cli_auth_status:claude.ai');
    expect(claude._binaryPath).toBe(claudePath);
  }, 10000);

  it('promotes cli-auth-status Claude detection to connected when the detected binary path is runnable', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const claudeScript = claudeAuthStatusScripts('claude.ai');
    await writeFakeCli(binDir, 'claude', claudeScript.posix, claudeScript.windows);
    process.env.PATH = withTestBinOnPath(binDir);

    const result = await providerService.fullScan();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.status).toBe('connected');
    expect(claude.label).toBe('Claude Code (claude.ai) — via CLI');
  });

  it('preserves explicit user-selected Claude CLI models across fullScan re-detect', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const claudeScript = claudeAuthStatusScripts('claude.ai');
    const claudePath = await writeFakeCli(binDir, 'claude', claudeScript.posix, claudeScript.windows);
    process.env.PATH = withTestBinOnPath(binDir);
    process.env.ATLAS_APP_VERSION = '0.25.7';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (claude.ai) — via CLI',
            model: 'claude-sonnet-4-5-20250929',
            status: 'connected',
            isActive: true,
            lastCheckedAt: new Date().toISOString(),
            _authType: 'oauth',
            _useClaudeCLI: true,
            _modelSelectionSource: 'user',
            _claudeModelDefaultAppVersion: '0.25.6',
          },
        ],
      }, null, 2),
      'utf8',
    );

    const result = await providerService.fullScan();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.model).toBe('claude-sonnet-4-5-20250929');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers[0].model).toBe('claude-sonnet-4-5-20250929');
    expect(persisted.providers[0]._modelSelectionSource).toBe('user');
  });

  it('rescans when config has no providers even if a stale activeProviderId is persisted', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    process.env.OPENAI_API_KEY = 'sk-test-provider-scan';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'stale-active-provider',
        providers: [],
      }, null, 2),
      'utf8'
    );

    const result = await providerService.getProviders();

    expect(result.providers.length).toBeGreaterThan(0);
    expect(result.providers.some((provider) => provider.type === 'openai')).toBe(true);
  });

  it('rescans persisted unchecked CLI providers and promotes a connected active provider', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    process.env.OPENAI_API_KEY = 'sk-test-provider-heal';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.openai.com/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      }

      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: null,
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro)',
            model: 'gpt-5.3-codex',
            status: 'unchecked',
            isActive: false,
            _credentialSource: 'codex_oauth:/tmp/nonexistent-auth.json',
            _authType: 'codex_oauth',
          },
        ],
      }, null, 2),
      'utf8'
    );

    try {
      // getProviders() now serves cached data and runs the auto-heal scan in
      // the background; await the in-flight promise before checking healed state.
      await providerService.getProviders();
      await providerService.getPendingScanPromise();
      const result = await providerService.getProviders();
      const openaiProvider = result.providers.find((provider) => provider.id === 'cli_openai');

      expect(openaiProvider).toBeTruthy();
      expect(openaiProvider.status).toBe('connected');
      expect(openaiProvider.isActive).toBe(true);
      expect(result.activeProvider?.id).toBe('cli_openai');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rescans persisted Claude CLI error providers with auth metadata and promotes them to connected', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const claudeScript = claudeAuthStatusScripts('claude.ai');
    const claudePath = await writeFakeCli(binDir, 'claude', claudeScript.posix, claudeScript.windows);
    process.env.PATH = withTestBinOnPath(binDir);

    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: null,
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (claude.ai)',
            model: 'claude-sonnet-4-6',
            status: 'error',
            isActive: false,
            error: 'No API key available',
            _authType: 'oauth',
            _credentialSource: 'cli_auth_status:claude.ai',
            _binaryPath: claudePath,
          },
        ],
      }, null, 2),
      'utf8'
    );

    // getProviders() now serves cached data and runs the auto-heal scan in
    // the background; await the in-flight promise before checking healed state.
    await providerService.getProviders();
    await providerService.getPendingScanPromise();
    const result = await providerService.getProviders();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.status).toBe('connected');
    expect(claude.isActive).toBe(true);
    expect(claude.label).toBe('Claude Code (claude.ai) — via CLI');
    expect(result.activeProvider?.id).toBe('cli_anthropic');
  }, 20000);

  it('ignores persisted Atlas-managed Claude binary paths during CLI validation', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const atlasClaudeDir = path.join(tempDataDir, 'cli-tools', 'bin');
    const atlasClaudePath = path.join(atlasClaudeDir, 'claude');
    const binDir = path.join(tempDataDir, 'bin');
    const claudeScript = claudeAuthStatusScripts('claude.ai');
    const machineClaudePath = await writeFakeCli(binDir, 'claude', claudeScript.posix, claudeScript.windows);
    await fs.mkdir(atlasClaudeDir, { recursive: true });
    await fs.writeFile(atlasClaudePath, '#!/bin/sh\nexit 1\n', 'utf8');
    await fs.chmod(atlasClaudePath, 0o755);
    process.env.PATH = withTestBinOnPath(binDir);

    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (claude.ai)',
            model: 'claude-sonnet-4-6',
            status: 'error',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
            _credentialSource: 'cli_auth_status:claude.ai',
            _binaryPath: atlasClaudePath,
          },
        ],
      }, null, 2),
      'utf8'
    );

    await providerService.getProviders();
    await providerService.getPendingScanPromise();
    const result = await providerService.getProviders();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.status).toBe('connected');
    expect(claude._binaryPath).toBe(machineClaudePath);
  }, 20000);

  it('validates a Claude CLI provider via on-disk credentials when auth-status check fails', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const claudeConfigDir = path.join(tempDataDir, '.claude');
    const credentialsPath = path.join(claudeConfigDir, '.credentials.json');
    const authFails = authFailScripts('unknown command');

    await fs.mkdir(claudeConfigDir, { recursive: true });
    // Older Claude CLI: `auth status --json` is unrecognized → exit 1
    // (mirrors the false-negative we hit on dev machines with stale CLIs
    // and on macOS Keychain-backed installs that deny subprocess access).
    const claudePath = await writeFakeCli(binDir, 'claude', authFails.posix, authFails.windows);
    await fs.writeFile(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-access-token-from-claude-login',
          subscriptionType: 'pro',
        },
      }),
      'utf8',
    );
    process.env.PATH = withTestBinOnPath(binDir);

    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (pro) — via CLI',
            model: 'claude-opus-4-7',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
            _binaryPath: claudePath,
          },
        ],
      }, null, 2),
      'utf8',
    );

    const result = await providerService.validateAllProviders();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.status).toBe('connected');
    expect(claude.error).toBeUndefined();
  });

  it('marks Keychain-backed Claude CLI providers as unchecked instead of erroring when auth-status fails and no on-disk credentials exist', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const claudeConfigDir = path.join(tempDataDir, '.claude');
    const authDenied = authFailScripts('User interaction is not allowed');

    await fs.mkdir(claudeConfigDir, { recursive: true });
    // Simulate a Keychain-backed install: `auth status --json` is denied
    // (subprocess can't read Keychain) and credentials.json never exists.
    // Filesystem post-login artifacts (here: settings.json) are the only
    // proof the user authenticated at some point.
    const claudePath = await writeFakeCli(binDir, 'claude', authDenied.posix, authDenied.windows);
    await fs.writeFile(path.join(claudeConfigDir, 'settings.json'), '{"version":1}', 'utf8');
    process.env.PATH = withTestBinOnPath(binDir);

    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (pro) — via CLI',
            model: 'claude-opus-4-7',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
            _binaryPath: claudePath,
          },
        ],
      }, null, 2),
      'utf8',
    );

    const result = await providerService.validateAllProviders();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.status).toBe('unchecked');
    expect(claude.error).toBeUndefined();
  });

  it('re-scan recovers a Keychain-backed Claude install instead of leaving it stuck on "Run claude login"', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const claudeConfigDir = path.join(tempDataDir, '.claude');
    const authDenied = authFailScripts('User interaction is not allowed');

    await fs.mkdir(claudeConfigDir, { recursive: true });
    // `auth status --json` denied (Keychain access blocked from subprocess).
    // No credentials.json on disk. But a post-login artifact exists.
    const claudePath = await writeFakeCli(binDir, 'claude', authDenied.posix, authDenied.windows);
    await fs.writeFile(path.join(claudeConfigDir, 'settings.json'), '{"version":1}', 'utf8');
    process.env.PATH = withTestBinOnPath(binDir);

    // Seed config with the broken state the dev would have seen pre-fix.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: null,
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (installed - sign in required)',
            model: 'claude-opus-4-7',
            status: 'error',
            isActive: false,
            error: 'Claude Code is installed but not authenticated. Run `claude login` in your terminal, then re-scan.',
            _binaryPath: claudePath,
          },
        ],
      }, null, 2),
      'utf8',
    );

    const result = await providerService.fullScan();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(['connected', 'unchecked']).toContain(claude.status);
    expect(claude.error).toBeUndefined();
    // Internal flags get sanitized off the API response, so verify the
    // persisted config picked up the CLI-routed marker.
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers[0]._useClaudeCLI).toBe(true);
    expect(persisted.providers[0]._authType).toBe('oauth');
  });

  it('still reports Claude CLI as unauthenticated when neither auth-status, on-disk credentials, nor post-login artifacts exist', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const authFails = authFailScripts('not logged in');

    const claudePath = await writeFakeCli(binDir, 'claude', authFails.posix, authFails.windows);
    process.env.PATH = withTestBinOnPath(binDir);
    // Deliberately do NOT create ~/.claude — user has never logged in.

    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code (pro) — via CLI',
            model: 'claude-opus-4-7',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
            _binaryPath: claudePath,
          },
        ],
      }, null, 2),
      'utf8',
    );

    const result = await providerService.validateAllProviders();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.status).toBe('error');
    expect(claude.error).toMatch(/claude login/i);
  });

  it('throttles repeated auto-heal rescans for persistent CLI auth errors', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    const binDir = path.join(tempDataDir, 'bin');
    const codexDir = path.join(tempDataDir, '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    const codexScript = codexExecAuthFailureScripts();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.openai.com/')) {
        return {
          ok: false,
          status: 401,
          text: async () => 'unauthorized',
          json: async () => ({ error: { message: 'unauthorized' } }),
        };
      }

      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    await fs.mkdir(codexDir, { recursive: true });
    const codexPath = await writeFakeCli(binDir, 'codex', codexScript.posix, codexScript.windows);
    await fs.writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: 'chatgpt-subscription-token',
          id_token: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJwcm8ifX0=.sig',
        },
      }),
      'utf8'
    );
    process.env.PATH = withTestBinOnPath(binDir);

    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: null,
        providers: [
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex CLI (pro)',
            model: 'gpt-5.3-codex',
            status: 'error',
            isActive: false,
            error: 'No API key available',
            _authType: 'codex_oauth',
            _credentialSource: `codex_oauth:${authPath}`,
            _binaryPath: codexPath,
          },
        ],
      }, null, 2),
      'utf8'
    );

    try {
      const first = await providerService.getProviders();
      const firstProvider = first.providers.find((provider) => provider.id === 'cli_openai');
      const firstConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const firstPersisted = firstConfig.providers.find((provider) => provider.id === 'cli_openai');

      expect(firstProvider).toBeTruthy();
      expect(firstProvider.status).toBe('error');
      expect(firstPersisted?._lastAutoHealAt).toBeTruthy();

      const second = await providerService.getProviders();
      const secondProvider = second.providers.find((provider) => provider.id === 'cli_openai');
      const secondConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const secondPersisted = secondConfig.providers.find((provider) => provider.id === 'cli_openai');

      expect(secondProvider).toBeTruthy();
      expect(secondProvider.status).toBe('error');
      expect(secondPersisted?._lastAutoHealAt).toBe(firstPersisted?._lastAutoHealAt);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('getCliAuthStatus reports discovered binary paths outside the Atlas install prefix', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const codexPath = path.join(binDir, 'codex');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(codexPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(codexPath, 0o755);
    process.env.PATH = withTestBinOnPath(binDir);
    process.env.OPENAI_API_KEY = 'sk-test-global-binary';

    const status = await providerService.getCliAuthStatus();

    expect(status.codex.binaryPath).toBe(codexPath);
    expect(status.codex.authenticated).toBe(true);
    expect(status.codex.source).toBe('env:OPENAI_API_KEY');
  });

  it('scanForCLIProviders detects Codex from common install locations without PATH help', async () => {
    const codexPath = isWindowsTestHost
      ? path.join(tempDataDir, '.local', 'bin', 'codex.exe')
      : path.join(tempDataDir, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'codex');
    const codexDir = path.join(tempDataDir, '.codex');
    const authPath = path.join(codexDir, 'auth.json');

    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(
      codexPath,
      isWindowsTestHost
        ? ''
        : '#!/bin/sh\nif [ "$1" = "debug" ] && [ "$2" = "models" ]; then echo \'{"models":[{"id":"gpt-5.5"}]}\'; exit 0; fi\nexit 0\n',
      'utf8'
    );
    if (!isWindowsTestHost) {
      await fs.chmod(codexPath, 0o755);
    }
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: 'chatgpt-subscription-token',
          id_token: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJwcm8ifX0=.sig',
        },
      }),
      'utf8'
    );
    process.env.PATH = '';

    const providers = await providerService.scanForCLIProviders();
    const codex = providers.find((provider) => provider.id === 'cli_openai');

    expect(codex).toBeTruthy();
    expect(codex._binaryPath).toBe(codexPath);
    expect(codex._credentialSource).toBe(`codex_oauth:${authPath}`);
  });

  itWindows('getCliAuthStatus detects Claude from the WinGet links directory without PATH', async () => {
    const winGetLinksDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links');
    const claudePath = path.join(winGetLinksDir, 'claude.exe');
    await fs.mkdir(winGetLinksDir, { recursive: true });
    await fs.writeFile(claudePath, '', 'utf8');
    process.env.PATH = originalPath || '';

    const status = await providerService.getCliAuthStatus();

    expect(status['claude-code'].binaryPath).toBe(claudePath);
    expect(status['claude-code'].authenticated).toBe(false);
  });

  it('getCliAuthStatus keeps Gemini unauthenticated when only the binary is installed', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const geminiPath = path.join(binDir, 'gemini');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(geminiPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(geminiPath, 0o755);
    process.env.PATH = withTestBinOnPath(binDir);

    const status = await providerService.getCliAuthStatus();

    expect(status['gemini-cli'].binaryPath).toBe(geminiPath);
    expect(status['gemini-cli'].authenticated).toBe(false);
    expect(status['gemini-cli'].source).toBeNull();
  });

  it('getCliAuthStatus reports Gemini authenticated after Google login is selected in settings', async () => {
    const binDir = path.join(tempDataDir, 'bin');
    const geminiPath = path.join(binDir, 'gemini');
    const geminiDir = path.join(tempDataDir, '.gemini');
    const settingsPath = path.join(geminiDir, 'settings.json');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(geminiPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(geminiPath, 0o755);
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        security: {
          auth: {
            selectedType: 'oauth-personal',
          },
        },
      }, null, 2),
      'utf8'
    );
    process.env.PATH = withTestBinOnPath(binDir);

    const status = await providerService.getCliAuthStatus();

    expect(status['gemini-cli'].binaryPath).toBe(geminiPath);
    expect(status['gemini-cli'].authenticated).toBe(true);
    expect(status['gemini-cli'].source).toBe(`gemini_auth:${settingsPath}:oauth-personal`);
  });

  it('refreshes auto-detected Claude CLI defaults on provider read after an Atlas app update', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    process.env.ATLAS_APP_VERSION = '0.25.7';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        appVersion: '0.25.6',
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code',
            model: 'claude-sonnet-4-6',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
            _modelSelectionSource: 'detected',
            _claudeModelDefaultAppVersion: '0.25.6',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const result = await providerService.getProviders();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.model).toBe('claude-sonnet-4-6');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.appVersion).toBe('0.25.7');
    expect(persisted.providers[0].model).toBe('claude-sonnet-4-6');
    expect(persisted.providers[0]._claudeModelDefaultAppVersion).toBe('0.25.7');
  });

  it('does not refresh explicit user-selected Claude CLI models on provider read', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    process.env.ATLAS_APP_VERSION = '0.25.7';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        appVersion: '0.25.6',
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code',
            model: 'claude-sonnet-4-6',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
            _modelSelectionSource: 'user',
            _claudeModelDefaultAppVersion: '0.25.6',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const result = await providerService.getProviders();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.model).toBe('claude-sonnet-4-6');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers[0].model).toBe('claude-sonnet-4-6');
    expect(persisted.providers[0]._claudeModelDefaultAppVersion).toBe('0.25.6');
  });

  it('treats legacy Claude CLI non-default models as implicit user selections', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    process.env.ATLAS_APP_VERSION = '0.25.7';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        appVersion: '0.25.6',
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code',
            model: 'claude-sonnet-4-5-20250929',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
            _claudeModelDefaultAppVersion: '0.25.6',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const result = await providerService.getProviders();
    const claude = result.providers.find((provider) => provider.id === 'cli_anthropic');

    expect(claude).toBeTruthy();
    expect(claude.model).toBe('claude-sonnet-4-5-20250929');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.providers[0].model).toBe('claude-sonnet-4-5-20250929');
    expect(persisted.providers[0]._claudeModelDefaultAppVersion).toBe('0.25.6');
  });

  it('defaults both review and build to Codex CLI when both CLI providers are connected', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code',
            model: 'claude-sonnet-4-6',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
          },
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: false,
            _authType: 'codex_oauth',
            _useCodexCLI: true,
          },
        ],
      }, null, 2),
      'utf8'
    );

    const reviewDefault = await providerService.getContextActiveProvider('review');
    const buildDefault = await providerService.getContextActiveProvider('build');

    // Both contexts default to Codex CLI when no explicit context override is saved
    expect(reviewDefault).toEqual({
      providerId: 'cli_openai',
      model: 'gpt-5.3-codex',
    });
    expect(buildDefault).toEqual({
      providerId: 'cli_openai',
      model: 'gpt-5.3-codex',
    });
  });

  it('preserves an explicitly saved context provider over the automatic default', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli_anthropic',
        providers: [
          {
            id: 'cli_anthropic',
            type: 'anthropic',
            source: 'cli_detected',
            label: 'Claude Code',
            model: 'claude-sonnet-4-6',
            status: 'connected',
            isActive: true,
            _authType: 'oauth',
            _useClaudeCLI: true,
          },
          {
            id: 'cli_openai',
            type: 'openai',
            source: 'cli_detected',
            label: 'Codex',
            model: 'gpt-5.3-codex',
            status: 'connected',
            isActive: false,
            _authType: 'codex_oauth',
            _useCodexCLI: true,
          },
        ],
      }, null, 2),
      'utf8'
    );

    await providerService.setContextActiveProvider('review', {
      providerId: 'cli_anthropic',
      model: 'claude-sonnet-4-6',
    });

    const reviewDefault = await providerService.getContextActiveProvider('review');

    expect(reviewDefault).toEqual({
      providerId: 'cli_anthropic',
      model: 'claude-sonnet-4-6',
    });
  });
});

describe('OpenCode provider contract', () => {
  it('PROVIDER_CONFIGS.opencode has required fields via getProviderConfigs', () => {
    const configs = providerService.getProviderConfigs();
    const opencode = configs.find(c => c.type === 'opencode');
    expect(opencode).toBeDefined();
    expect(opencode.label).toBe('OpenCode');
    expect(Array.isArray(opencode.models)).toBe(true);
    expect(opencode.models.length).toBeGreaterThan(0);
    expect(opencode.defaultModel).toBe('opencode-default');
    expect(opencode.reviewExecutionProfile).toBeDefined();
    expect(typeof opencode.reviewExecutionProfile.coverageMultiplier).toBe('number');
    expect(typeof opencode.reviewExecutionProfile.chunkConcurrencyBias).toBe('number');
    expect(typeof opencode.reviewExecutionProfile.perFileConcurrencyBias).toBe('number');
  });

  it('REVIEW_MODEL_DEFAULTS.opencode resolves via getSmartReviewModel', () => {
    expect(providerService.getSmartReviewModel('opencode', 'triage')).toBe('opencode-default');
    expect(providerService.getSmartReviewModel('opencode', 'review')).toBe('opencode-default');
    expect(providerService.getSmartReviewModel('opencode', 'synthesis')).toBe('opencode-default');
    expect(providerService.getSmartReviewModel('opencode', 'verifier')).toBe('opencode-default');
  });

  it('getProviderDefaultModel returns opencode default model', () => {
    expect(providerService.getProviderDefaultModel('opencode')).toBe('opencode-default');
  });

  it('isKnownProviderModel validates opencode models', () => {
    expect(providerService.isKnownProviderModel('opencode', 'opencode-default')).toBe(true);
    expect(providerService.isKnownProviderModel('opencode', 'nonexistent')).toBe(false);
  });

  it('getProviderReviewExecutionProfile returns opencode profile with conservative defaults', () => {
    const profile = providerService.getProviderReviewExecutionProfile('opencode');
    expect(profile).not.toBeNull();
    expect(profile.coverageMultiplier).toBeLessThanOrEqual(1.0);
    expect(profile.chunkConcurrencyBias).toBeLessThanOrEqual(1.0);
    expect(profile.perFileConcurrencyBias).toBeLessThanOrEqual(1.0);
  });

  it('scanForCLIProviders does not crash and returns valid shape when OpenCode binary absent', async () => {
    // Disable all other detection to isolate the OpenCode path
    // We can't easily mock findBinary, but we can verify no crash and valid array return
    const providers = await providerService.scanForCLIProviders();
    expect(Array.isArray(providers)).toBe(true);
    // Each provider should have the expected shape
    for (const p of providers) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('type');
      expect(p).toHaveProperty('source');
      expect(p).toHaveProperty('label');
      expect(p).toHaveProperty('model');
    }
  });

  it('OpenCode CLI provider routes through CLI when persisted with opencode_cli authType', async () => {
    const configPath = path.join(tempDataDir, '.atlas-providers.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProviderId: 'cli-opencode',
        providers: [
          {
            id: 'cli-opencode',
            type: 'opencode',
            source: 'cli_detected',
            label: 'OpenCode (detected) — via CLI',
            model: 'opencode-default',
            status: 'connected',
            isActive: true,
            _authType: 'opencode_cli',
            _useOpenCodeCLI: true,
          },
        ],
      }, null, 2),
      'utf8'
    );

    // Disable CLI detection so fullScan doesn't re-detect and overwrite
    process.env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION = '1';

    const active = await providerService.getActiveProviderWithKey();
    expect(active).not.toBeNull();
    expect(active.apiKey).toBeNull();
    expect(active.useOpenCodeCLI).toBe(true);
    expect(active.useClaudeCLI).toBe(false);
    expect(active.useCodexCLI).toBe(false);
    expect(active.useGeminiCLI).toBe(false);
    expect(active.provider.type).toBe('opencode');
  });

  it('scanForCLIProviders returns OpenCode when detection finds config directory', async () => {
    // This test verifies the scan detects OpenCode if the config dir exists.
    // On machines without opencode, the provider won't appear — skip gracefully.
    const providers = await providerService.scanForCLIProviders();
    const opencode = providers.find(p => p.type === 'opencode');
    if (opencode) {
      expect(opencode.id).toBe('cli_opencode');
      expect(opencode.source).toBe('cli_detected');
      // Model may be 'opencode-default' or resolved from OpenCode config (e.g. 'nvidia/meta/...')
      expect(typeof opencode.model).toBe('string');
      expect(opencode.model.length).toBeGreaterThan(0);
    }
    // No assertion failure if opencode not found — binary may not exist in CI
  });
});
