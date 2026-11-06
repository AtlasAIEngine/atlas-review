/**
 * ProviderStep Component
 * Step 2: AI Provider auto-detect + BYOK fallback + CLI auto-install
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { providerApi, claudeApi, type CliInstallAttempt } from '@/services/api';
import {
  getSetupButtonStyle,
  getSetupIconBadgeStyle,
  getSetupNoticeStyle,
  getSetupTextButtonStyle,
  setupInputStyle,
  setupInsetPanelStyle,
} from './setupChrome';
import { SetupButtonIcon } from './setupButtonIcons';
import { isTauriEnvironment } from '@/utils/tauri';
import { isSetupAdvanceKey, shouldIgnoreSetupShortcut } from './setupKeyboard';

interface ScanResult {
  providers: any[];
  activeProvider: any | null;
  done: boolean;
}

interface ProviderStepProps {
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  scanResult: ScanResult;
  onRescan: () => void;
}

interface DetectedProvider {
  id?: string;
  type: string;
  label: string;
  source: string;
  isActive: boolean;
}

type InstallState = 'idle' | 'installing' | 'success' | 'error';

type AuthState = 'unknown' | 'checking' | 'authenticated' | 'unauthenticated' | 'prerequisite_required';

interface CliPrerequisite {
  type: string;
  status: 'ok' | 'missing' | 'detected_not_configured';
  envVar?: string | null;
  detectedPath?: string | null;
  message: string;
  remediation?: string | null;
}

interface CliToolState {
  installState: InstallState;
  isInstalled: boolean;
  logs: string[];
  error?: string;
  authState: AuthState;
  authSource?: string | null;
  binaryPath?: string | null;
  prerequisite?: CliPrerequisite | null;
}

const CLI_TOOLS = [
  { key: 'codex', label: 'Codex', provider: 'OpenAI', pkg: '@openai/codex' },
  { key: 'claude-code', label: 'Claude Code', provider: 'Anthropic', pkg: '@anthropic-ai/claude-code' },
  { key: 'gemini-cli', label: 'Gemini CLI', provider: 'Google', pkg: '@google/gemini-cli' },
] as const;

const PROVIDER_DISPLAY_ORDER: Record<string, number> = {
  openai: 0,
  anthropic: 1,
  google: 2,
  opencode: 3,
};

const CLI_PROVIDER_TYPES: Record<string, typeof CLI_TOOLS[number]['key']> = {
  openai: 'codex',
  anthropic: 'claude-code',
  google: 'gemini-cli',
};

const SETUP_OPEN_CLI_QUERY_KEY = 'setupOpenCli';
const SETUP_PROVIDERS_QUERY_KEY = 'setupProviders';
const SETUP_PROVIDERS_BROWSER_OVERRIDE_KEY = 'atlas_setup_providers_override';
const TERMINAL_INSTALL_STATUSES = new Set(['success', 'error']);

function shouldForceCliSectionOpen() {
  if (typeof window === 'undefined') {
    return false;
  }

  const value = new URLSearchParams(window.location.search).get(SETUP_OPEN_CLI_QUERY_KEY);
  return value === '1' || value === 'true';
}

function getBrowserProviderOverride() {
  if (typeof window === 'undefined' || isTauriEnvironment()) {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get(SETUP_PROVIDERS_QUERY_KEY);
  if (queryValue && queryValue.trim()) {
    return queryValue.trim().toLowerCase();
  }
  const storedValue = window.localStorage.getItem(SETUP_PROVIDERS_BROWSER_OVERRIDE_KEY);
  return storedValue && storedValue.trim() ? storedValue.trim().toLowerCase() : null;
}

function isWindowsClient() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.navigator.platform.toLowerCase().includes('win');
}

function isCliDetectedSource(source?: string | null) {
  return source === 'cli' || source === 'cli_detected';
}

function getProviderSourceLabel(source?: string | null) {
  if (isCliDetectedSource(source)) {
    return 'CLI detected';
  }
  if (source === 'env') {
    return 'Environment variable';
  }
  return 'Configured';
}

function getCliToolKeyForProvider(provider?: Pick<DetectedProvider, 'type' | 'source'> | null) {
  if (!provider || !isCliDetectedSource(provider.source)) {
    return null;
  }

  return CLI_PROVIDER_TYPES[provider.type] || null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copyable command block with a copy button */
function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="flex items-center gap-1 bg-surface rounded overflow-hidden">
      <code className="flex-1 px-2 py-1.5 text-[11px] text-content-secondary break-all font-mono">
        {command}
      </code>
      <button
        onClick={handleCopy}
        className="flex-shrink-0 px-2 py-1.5 text-content-tertiary hover:text-content-secondary transition-colors"
        title="Copy to clipboard"
      >
        {copied ? (
          <svg className="w-3.5 h-3.5 text-accent-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
    </div>
  );
}

/** Shared API key input form for manual BYOK auth */
function ApiKeyAuthForm({
  providerType,
  placeholder,
  onSuccess,
}: {
  providerType: 'openai' | 'google';
  placeholder: string;
  onSuccess: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);

  const handleTestAndSave = async () => {
    setTesting(true);
    setResult(null);
    try {
      const testResult = await providerApi.testConnection(providerType, apiKey);
      if (testResult.success) {
        await providerApi.addBYOK(providerType, apiKey);
        setResult({ success: true });
        onSuccess();
      } else {
        setResult({ success: false, error: testResult.error || 'Connection failed' });
      }
    } catch (err: any) {
      setResult({ success: false, error: err.message || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <input
        type="password"
        value={apiKey}
        onChange={(e) => { setApiKey(e.target.value); setResult(null); }}
        placeholder={placeholder}
        className="w-full bg-surface border border-border-strong text-content rounded px-2 py-1.5 font-mono text-xs focus:outline-none focus:border-accent-blue"
      />
      {result && (
        <div className={`text-xs rounded p-1.5 ${result.success ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'}`}>
          {result.success ? 'Authenticated & saved' : result.error}
        </div>
      )}
      <button
        onClick={handleTestAndSave}
        disabled={!apiKey || testing}
        style={getSetupButtonStyle({ tone: 'blue', active: true, disabled: !apiKey || testing, compact: true })}
      >
        <SetupButtonIcon name="key" size={13} />
        {testing ? 'Testing...' : 'Test & Save'}
      </button>
    </div>
  );
}

/** Shared CLI login/check flow for tools that authenticate natively */
function CliLoginAuthForm({
  command,
  helpText,
  notAuthenticatedMessage,
  checkAuth,
  onSuccess,
}: {
  command: string;
  helpText: string;
  notAuthenticatedMessage: string;
  checkAuth: () => Promise<boolean>;
  onSuccess: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);

  const handleCheck = async () => {
    setChecking(true);
    setResult(null);
    try {
      const authenticated = await checkAuth();
      if (authenticated) {
        setResult({ success: true });
        onSuccess();
      } else {
        setResult({ success: false, error: notAuthenticatedMessage });
      }
    } catch (err: any) {
      setResult({ success: false, error: err.message || 'Failed to check status' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <p className="text-content-tertiary text-[11px]">{helpText}</p>
      <CopyableCommand command={command} />
      <button
        onClick={handleCheck}
        disabled={checking}
        style={getSetupButtonStyle({ tone: 'blue', active: true, disabled: checking, compact: true })}
      >
        <SetupButtonIcon name="check" size={13} />
        {checking ? 'Checking...' : 'Check Auth'}
      </button>
      {result && (
        <div className={`text-xs rounded p-1.5 ${result.success ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'}`}>
          {result.success ? 'Authenticated' : result.error}
        </div>
      )}
    </div>
  );
}

/** Claude Code auth form — check native OAuth or paste token */
function ClaudeAuthForm({
  onSuccess,
  binaryPath,
  prerequisite,
}: {
  onSuccess: () => void;
  binaryPath?: string | null;
  prerequisite?: CliPrerequisite | null;
}) {
  const [mode, setMode] = useState<'check' | 'token'>('check');
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ success: boolean; error?: string; message?: string } | null>(null);
  const oauthBlocked = Boolean(prerequisite && prerequisite.status !== 'ok');
  const powershellLoginCommand = binaryPath ? `& "${binaryPath}" login` : 'claude login';
  const cmdLoginCommand = binaryPath ? `"${binaryPath}" login` : 'claude login';

  const handleCheck = async () => {
    if (oauthBlocked) return;
    setChecking(true);
    setResult(null);
    try {
      const status = await claudeApi.getStatus({ refresh: true });
      if (status.data?.authenticated) {
        setResult({ success: true });
        onSuccess();
      } else {
        setResult({ success: false, error: 'Not authenticated. Run "claude login" in your terminal, then click Check again.' });
      }
    } catch (err: any) {
      setResult({ success: false, error: err.message || 'Failed to check status' });
    } finally {
      setChecking(false);
    }
  };

  const handleSaveToken = async () => {
    setChecking(true);
    setResult(null);
    try {
      const testResult = await claudeApi.testConnection(token);
      if (testResult.data?.authenticated) {
        await claudeApi.saveToken(token);
        setResult({
          success: true,
          message: testResult.data?.deferredValidation
            ? 'Token saved. Windows validation will happen on first Claude request.'
            : 'Authenticated & saved',
        });
        onSuccess();
      } else {
        setResult({ success: false, error: testResult.data?.error || 'Invalid token' });
      }
    } catch (err: any) {
      setResult({ success: false, error: err.message || 'Token test failed' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-2 text-xs">
        <button
          onClick={() => { setMode('check'); setResult(null); }}
          data-testid="claude-auth-mode-oauth"
          style={getSetupButtonStyle({ tone: mode === 'check' ? 'blue' : 'neutral', active: mode === 'check', compact: true })}
        >
          OAuth
        </button>
        <button
          onClick={() => { setMode('token'); setResult(null); }}
          data-testid="claude-auth-mode-token"
          style={getSetupButtonStyle({ tone: mode === 'token' ? 'blue' : 'neutral', active: mode === 'token', compact: true })}
        >
          Token
        </button>
      </div>
      {prerequisite && prerequisite.status !== 'ok' && (
        <div className="rounded border border-amber-700/50 bg-amber-900/20 p-2 text-[11px] text-amber-200">
          <div>{prerequisite.message}</div>
          {prerequisite.remediation && <div className="mt-1">{prerequisite.remediation}</div>}
          {prerequisite.detectedPath && (
            <div className="mt-1 font-mono break-all">{prerequisite.detectedPath}</div>
          )}
        </div>
      )}
      {mode === 'check' ? (
        <>
          <p className="text-content-tertiary text-[11px]">
            {isWindowsClient()
              ? 'Copy and run this in PowerShell, then click Check Auth. In Command Prompt, remove the leading "&".'
              : 'Copy and run this in a terminal, then click Check Auth:'}
          </p>
          <CopyableCommand command={isWindowsClient() ? powershellLoginCommand : cmdLoginCommand} />
          <button
            onClick={handleCheck}
            disabled={checking || oauthBlocked}
            style={getSetupButtonStyle({ tone: 'blue', active: true, disabled: checking || oauthBlocked, compact: true })}
          >
            <SetupButtonIcon name="check" size={13} />
            {oauthBlocked ? 'Needs Git Bash' : checking ? 'Checking...' : 'Check Auth'}
          </button>
        </>
      ) : (
        <>
          <p className="text-content-tertiary text-[11px]">
            Run{' '}
            <code className="mx-1 inline-flex items-center rounded-md border border-accent-blue/40 bg-accent-blue/15 px-1.5 py-0.5 font-mono text-[11px] text-accent-blue shadow-[0_0_0_1px_rgba(59,130,246,0.08)]">
              claude setup-token
            </code>{' '}
            in your terminal, then paste the generated Claude OAuth token below. Atlas will validate it with the installed Claude CLI before saving it.
          </p>
          <input
            type="password"
            value={token}
            onChange={(e) => { setToken(e.target.value); setResult(null); }}
            placeholder="Paste Claude OAuth token..."
            data-testid="claude-token-input"
            className="w-full bg-surface border border-border-strong text-content rounded px-2 py-1.5 font-mono text-xs focus:outline-none focus:border-accent-blue"
          />
          <button
            onClick={handleSaveToken}
            disabled={!token || checking}
            data-testid="claude-token-test-save"
            style={getSetupButtonStyle({ tone: 'blue', active: true, disabled: !token || checking, compact: true })}
          >
            <SetupButtonIcon name="key" size={13} />
            {checking ? 'Testing...' : 'Test & Save'}
          </button>
        </>
      )}
      {result && (
        <div className={`text-xs rounded p-1.5 ${result.success ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'}`}>
          {result.success ? (result.message || 'Authenticated') : result.error}
        </div>
      )}
    </div>
  );
}

function CodexAuthForm({
  onSuccess,
  binaryPath,
}: {
  onSuccess: () => void;
  binaryPath?: string | null;
}) {
  const powershellLoginCommand = binaryPath ? `& "${binaryPath}" login` : 'codex login';
  const cmdLoginCommand = binaryPath ? `"${binaryPath}" login` : 'codex login';

  return (
    <CliLoginAuthForm
      command={isWindowsClient() ? powershellLoginCommand : cmdLoginCommand}
      helpText={
        isWindowsClient()
          ? 'Copy and run this in PowerShell, then click Check Auth. In Command Prompt, remove the leading "&".'
          : 'Copy and run this in a terminal, then click Check Auth:'
      }
      notAuthenticatedMessage='Not authenticated. Run "codex login" in your terminal, then click Check again.'
      checkAuth={async () => {
        const status = await providerApi.getCliAuthStatus();
        return Boolean(status.auth?.codex?.authenticated);
      }}
      onSuccess={onSuccess}
    />
  );
}

function GeminiAuthForm({
  onSuccess,
  binaryPath,
}: {
  onSuccess: () => void;
  binaryPath?: string | null;
}) {
  const powershellLaunchCommand = binaryPath ? `& "${binaryPath}"` : 'gemini';
  const cmdLaunchCommand = binaryPath ? `"${binaryPath}"` : 'gemini';

  return (
    <CliLoginAuthForm
      command={isWindowsClient() ? powershellLaunchCommand : cmdLaunchCommand}
      helpText={
        isWindowsClient()
          ? 'Copy and run this in PowerShell. Gemini will open its auth picker. Choose "Login with Google", finish the browser flow, then click Check Auth. In Command Prompt, remove the leading "&".'
          : 'Copy and run this in a terminal. Gemini will open its auth picker. Choose "Login with Google", finish the browser flow, then click Check Auth.'
      }
      notAuthenticatedMessage='Not authenticated. Run "gemini", choose "Login with Google", complete the browser flow, then click Check Auth again.'
      checkAuth={async () => {
        const status = await providerApi.getCliAuthStatus();
        return Boolean(status.auth?.['gemini-cli']?.authenticated);
      }}
      onSuccess={onSuccess}
    />
  );
}

function CompactInstallRow({ tool }: { tool: typeof CLI_TOOLS[number] }) {
  const [copied, setCopied] = useState(false);
  const cmd = `npm install -g ${tool.pkg}`;
  const handleCopy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-sm font-medium whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{tool.label}</span>
      <div className="flex-1" />
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1"
        style={{
          background: 'color-mix(in srgb, var(--review-shell-bg) 60%, transparent)',
          border: '1px solid var(--review-shell-divider)',
        }}
      >
        <code className="flex-1 truncate text-xs" style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
          {cmd}
        </code>
        <button
          onClick={handleCopy}
          title="Copy command"
          style={{ color: copied ? 'var(--accent-green, #4ade80)' : 'var(--text-tertiary)', flexShrink: 0 }}
        >
          {copied ? (
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}


function CliInstallCard({
  tool,
  state,
  detected = false,
  onAuthSuccess,
}: {
  tool: typeof CLI_TOOLS[number];
  state: CliToolState;
  detected?: boolean;
  onAuthSuccess: () => void;
}) {
  const logEndRef = useRef<HTMLDivElement>(null);
  const [showAuthForm, setShowAuthForm] = useState(false);
  const effectiveAuthState =
    detected && state.authState === 'unknown'
      ? 'authenticated'
      : state.authState;

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.logs.length]);

  // Auto-expand auth form after install if not authenticated
  useEffect(() => {
    if (
      (detected || state.isInstalled || state.installState === 'success')
      && (effectiveAuthState === 'unauthenticated' || effectiveAuthState === 'prerequisite_required')
    ) {
      setShowAuthForm(true);
    }
  }, [detected, effectiveAuthState, state.isInstalled, state.installState]);

  const isInstalled = detected || state.isInstalled || state.installState === 'success';

  return (
    <div
      className="bg-surface-base rounded-lg text-left"
      data-testid={`cli-card-${tool.key}`}
    >
      {/* Not-installed: single compact row with label · provider · command · copy */}
      {!isInstalled && state.installState !== 'installing' && (
        <CompactInstallRow tool={tool} />
      )}

      {/* Installing spinner */}
      {!isInstalled && state.installState === 'installing' && (
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="text-sm font-medium text-content-secondary">{tool.label}</span>
          <span className="text-content-tertiary text-xs">{tool.provider}</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-content-secondary">
            <div className="animate-spin rounded-full h-3 w-3 border-b border-content-secondary" />
            Installing...
          </span>
        </div>
      )}

      {/* Installed: normal two-line layout with badges */}
      {isInstalled && (
        <div className="flex items-center justify-between px-3 py-2">
          <div>
            <p className="text-content-secondary text-sm font-medium">{tool.label}</p>
            <p className="text-content-tertiary text-xs">{tool.provider}</p>
          </div>
          <div className="flex items-center gap-2">
            {effectiveAuthState === 'authenticated' && (
              <span className="inline-flex items-center gap-1 text-xs text-accent-green">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
                Authed
              </span>
            )}
            {effectiveAuthState === 'prerequisite_required' && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-300">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.487 0l5.58 9.92c.75 1.334-.213 2.981-1.742 2.981H4.42c-1.53 0-2.492-1.647-1.742-2.98l5.58-9.92zM11 13a1 1 0 10-2 0 1 1 0 002 0zm-1-6a1 1 0 00-.993.883L9 8v3a1 1 0 001.993.117L11 11V8a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                Needs Git Bash
              </span>
            )}
            {effectiveAuthState === 'checking' && (
              <div className="animate-spin rounded-full h-3 w-3 border-b border-content-tertiary" />
            )}
            <span
              className="inline-flex items-center gap-1 text-xs text-accent-green"
              data-testid={`cli-installed-${tool.key}`}
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Installed
            </span>
          </div>
        </div>
      )}

      {isInstalled && (effectiveAuthState === 'unauthenticated' || effectiveAuthState === 'prerequisite_required') && (
        <div className="mt-2">
          {!showAuthForm ? (
            <button
              onClick={() => setShowAuthForm(true)}
              className="px-3 py-1 text-xs bg-amber-900/30 text-amber-300 hover:bg-amber-900/50 rounded transition-colors"
            >
              {effectiveAuthState === 'prerequisite_required' ? 'View Steps' : 'Authenticate'}
            </button>
          ) : tool.key === 'claude-code' ? (
            <ClaudeAuthForm
              onSuccess={onAuthSuccess}
              binaryPath={state.binaryPath}
              prerequisite={state.prerequisite}
            />
          ) : tool.key === 'codex' ? (
            <CodexAuthForm
              onSuccess={onAuthSuccess}
              binaryPath={state.binaryPath}
            />
          ) : tool.key === 'gemini-cli' ? (
            <GeminiAuthForm
              onSuccess={onAuthSuccess}
              binaryPath={state.binaryPath}
            />
          ) : (
            <ApiKeyAuthForm providerType="google" placeholder="AIza..." onSuccess={onAuthSuccess} />
          )}
        </div>
      )}

      {/* Progress log area */}
      {state.logs.length > 0 && (
        <div className="mt-2 max-h-24 overflow-y-auto bg-surface rounded p-2 font-mono text-[10px] text-content-tertiary leading-relaxed">
          {state.logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      {/* Error message */}
      {state.error && (
        <div className="mt-2 text-xs text-red-400 bg-red-900/20 rounded p-2" data-testid={`cli-error-${tool.key}`}>
          {state.error}
        </div>
      )}
    </div>
  );
}

export function ProviderStep({ onNext, onBack, onSkip, scanResult, onRescan }: ProviderStepProps) {
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [showBYOK, setShowBYOK] = useState(false);
  const [showCLI, setShowCLI] = useState(() => shouldForceCliSectionOpen());
  const [byokType, setByokType] = useState('anthropic');
  const [byokKey, setByokKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const providerOverride = getBrowserProviderOverride();
  const emulateNoCliProviders = providerOverride === 'none';

  // CLI install state
  const [cliStates, setCliStates] = useState<Record<string, CliToolState>>(() => {
    const initial: Record<string, CliToolState> = {};
    for (const tool of CLI_TOOLS) {
      initial[tool.key] = { installState: 'idle', isInstalled: false, logs: [], authState: 'unknown', prerequisite: null };
    }
    return initial;
  });
  const isMountedRef = useRef(true);
  const activeInstallAttemptIdsRef = useRef<Record<string, string | null>>({});
  const trackedInstallPollersRef = useRef<Set<string>>(new Set());
  const providers = useMemo<DetectedProvider[]>(() =>
    (emulateNoCliProviders ? [] : (scanResult.providers || []))
      .map((p: any) => ({
        id: p.id,
        type: p.type,
        label: p.label || p.type,
        source: p.source || 'cli',
        isActive: !emulateNoCliProviders && scanResult.activeProvider?.id === p.id,
      }))
      .sort((a, b) => {
        const aOrder = PROVIDER_DISPLAY_ORDER[a.type] ?? Number.MAX_SAFE_INTEGER;
        const bOrder = PROVIDER_DISPLAY_ORDER[b.type] ?? Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }
        return a.label.localeCompare(b.label);
      }),
    [emulateNoCliProviders, scanResult],
  );

  // Default selection to first provider once scan completes
  useEffect(() => {
    if (providers.length > 0 && selectedProviderId === null) {
      setSelectedProviderId(providers[0].id ?? null);
    }
  }, [providers, selectedProviderId]);
  const detectedCliToolKeys = useMemo(() => new Set(
    providers
      .map((provider) => getCliToolKeyForProvider(provider))
      .filter((value): value is typeof CLI_TOOLS[number]['key'] => Boolean(value)),
  ), [providers]);
  const missingCliTools = useMemo(
    () => CLI_TOOLS.filter((tool) => !detectedCliToolKeys.has(tool.key)),
    [detectedCliToolKeys],
  );
  const hasDetectedCliProvider = providers.some((provider) => isCliDetectedSource(provider.source));
  const shouldLoadCliToolState = showCLI || providers.length > 0;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      activeInstallAttemptIdsRef.current = {};
      trackedInstallPollersRef.current.clear();
    };
  }, []);

  const refreshCliAuthState = useCallback(async (key: string) => {
    try {
      const result = await providerApi.getCliAuthStatus();
      if (!isMountedRef.current) return;
      const auth = result.auth?.[key];
      const prerequisite = auth?.prerequisite || null;
      const authState = auth?.authenticated
        ? 'authenticated'
        : prerequisite && prerequisite.status !== 'ok'
          ? 'prerequisite_required'
          : 'unauthenticated';

      setCliStates((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          authState,
          authSource: auth?.source,
          binaryPath: auth?.binaryPath || prev[key]?.binaryPath,
          prerequisite,
        },
      }));

      if (auth?.authenticated) {
        onRescan();
      }
    } catch {
      if (!isMountedRef.current) return;
      setCliStates((prev) => ({
        ...prev,
        [key]: { ...prev[key], authState: 'unauthenticated' },
      }));
    }
  }, [onRescan]);

  const applyCliInstallAttempt = useCallback((key: string, attempt: CliInstallAttempt) => {
    setCliStates((prev) => {
      const current = prev[key];
      if (!current) {
        return prev;
      }

      const installState: InstallState =
        attempt.status === 'success'
          ? 'success'
          : attempt.status === 'error'
            ? 'error'
            : 'installing';

      return {
        ...prev,
        [key]: {
          ...current,
          installState,
          isInstalled: attempt.status === 'success' ? true : current.isInstalled,
          logs: Array.isArray(attempt.logs) ? attempt.logs : current.logs,
          error: attempt.error || undefined,
          binaryPath: attempt.binaryPath || current.binaryPath,
          authState: attempt.status === 'success' ? 'checking' : current.authState,
          prerequisite: attempt.status === 'success' ? null : current.prerequisite,
        },
      };
    });
  }, []);

  const trackCliInstallAttempt = useCallback(async (key: string, attemptId: string) => {
    const trackerKey = `${key}:${attemptId}`;
    if (trackedInstallPollersRef.current.has(trackerKey)) {
      return;
    }

    trackedInstallPollersRef.current.add(trackerKey);
    activeInstallAttemptIdsRef.current[key] = attemptId;
    let consecutiveFailures = 0;

    try {
      while (isMountedRef.current && activeInstallAttemptIdsRef.current[key] === attemptId) {
        try {
          const result = await providerApi.getCliInstallAttempt(attemptId);
          if (!isMountedRef.current || activeInstallAttemptIdsRef.current[key] !== attemptId) {
            return;
          }

          consecutiveFailures = 0;
          applyCliInstallAttempt(key, result.attempt);

          if (TERMINAL_INSTALL_STATUSES.has(result.attempt.status)) {
            activeInstallAttemptIdsRef.current[key] = null;
            if (result.attempt.status === 'success') {
              await refreshCliAuthState(key);
            }
            return;
          }
        } catch (err: any) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            if (!isMountedRef.current || activeInstallAttemptIdsRef.current[key] !== attemptId) {
              return;
            }

            activeInstallAttemptIdsRef.current[key] = null;
            setCliStates((prev) => ({
              ...prev,
              [key]: {
                ...prev[key],
                installState: 'error',
                error: err?.message || 'Failed to load install status',
                logs: [...prev[key].logs, `Error: ${err?.message || 'Failed to load install status'}`],
              },
            }));
            return;
          }
        }

        await sleep(1000);
      }
    } finally {
      trackedInstallPollersRef.current.delete(trackerKey);
    }
  }, [applyCliInstallAttempt, refreshCliAuthState]);

  // Fetch CLI install status + auth status when CLI section is opened
  useEffect(() => {
    if (!shouldLoadCliToolState) return;
    let cancelled = false;

    providerApi.getCliInstallStatus().then((status) => {
      if (cancelled) return;
      setCliStates((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(status.installed || {})) {
          if (next[key]) {
            next[key] = {
              ...next[key],
              isInstalled: status.installed[key].installed,
              binaryPath: status.installed[key].binaryPath || prev[key]?.binaryPath,
            };
          }
        }
        return next;
      });

      for (const [key, attempt] of Object.entries(status.activeAttempts || {})) {
        if (!attempt) continue;
        applyCliInstallAttempt(key, attempt);
        void trackCliInstallAttempt(key, attempt.attemptId);
      }
    }).catch(() => {
      // Ignore — status check is best-effort
    });

    // Fetch auth status in parallel
    setCliStates((prev) => {
      const next = { ...prev };
      for (const tool of CLI_TOOLS) {
        next[tool.key] = { ...next[tool.key], authState: 'checking' };
      }
      return next;
    });
    providerApi.getCliAuthStatus().then((result) => {
      if (cancelled) return;
      setCliStates((prev) => {
        const next = { ...prev };
        for (const [key, auth] of Object.entries(result.auth || {})) {
          if (next[key]) {
            const prerequisite = auth.prerequisite || null;
            const authState = auth.authenticated
              ? 'authenticated'
              : prerequisite && prerequisite.status !== 'ok'
                ? 'prerequisite_required'
                : 'unauthenticated';
            next[key] = {
              ...next[key],
              authState,
              authSource: auth.source,
              binaryPath: auth.binaryPath || prev[key]?.binaryPath,
              prerequisite,
            };
          }
        }
        return next;
      });
    }).catch(() => {
      // On error, reset to unknown
      if (cancelled) return;
      setCliStates((prev) => {
        const next = { ...prev };
        for (const tool of CLI_TOOLS) {
          next[tool.key] = { ...next[tool.key], authState: 'unknown' };
        }
        return next;
      });
    });

    return () => { cancelled = true; };
  }, [applyCliInstallAttempt, shouldLoadCliToolState, trackCliInstallAttempt]);

  const handleAuthSuccess = useCallback((key: string) => {
    setCliStates((prev) => ({
        ...prev,
        [key]: { ...prev[key], authState: 'authenticated', prerequisite: null },
      }));
    onRescan();
  }, [onRescan]);

  // Check if any CLI tool was successfully installed in this session
  const hasSuccessfulInstall = useMemo(
    () => Object.values(cliStates).some((s) => s.authState === 'authenticated'),
    [cliStates],
  );

  const scanning = !scanResult.done;
  const canContinue = hasSuccessfulInstall || providers.length > 0;

  useEffect(() => {
    if (!scanResult.done || providers.length > 0) return;
    if (!showCLI && !showBYOK && !hasDetectedCliProvider) {
      setShowCLI(true);
    }
  }, [scanResult.done, providers.length, showCLI, showBYOK, hasDetectedCliProvider]);

  const handleTestKey = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await providerApi.testConnection(byokType, byokKey);
      setTestResult({ success: result.success, error: result.error });
    } catch (err: any) {
      setTestResult({ success: false, error: err.message || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveKey = useCallback(async () => {
    setSaving(true);
    try {
      await providerApi.addBYOK(byokType, byokKey);
      onNext();
    } catch {
      setTestResult({ success: false, error: 'Failed to save provider' });
    } finally {
      setSaving(false);
    }
  }, [byokKey, byokType, onNext]);

  const handleDetectedProviderContinue = useCallback(async () => {
    if (selectedProviderId) {
      try {
        await providerApi.setActive(selectedProviderId);
        await providerApi.setContextActive('review', selectedProviderId);
      } catch { /* best-effort */ }
    }
    onNext();
  }, [onNext, selectedProviderId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreSetupShortcut(event)) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        if (showBYOK) {
          setShowBYOK(false);
        } else {
          onBack();
        }
        return;
      }

      if (!isSetupAdvanceKey(event) || scanning) {
        return;
      }

      if (showBYOK) {
        if (!testResult?.success || saving) {
          return;
        }
        event.preventDefault();
        void handleSaveKey();
        return;
      }

      if (providers.length > 0) {
        event.preventDefault();
        void handleDetectedProviderContinue();
        return;
      }

      if (canContinue) {
        event.preventDefault();
        onNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    canContinue,
    handleDetectedProviderContinue,
    handleSaveKey,
    onBack,
    onNext,
    providers.length,
    saving,
    scanning,
    showBYOK,
    testResult?.success,
  ]);

  // Loading state
  if (scanning) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent-blue)', borderTopColor: 'transparent' }} />
        <p style={{ color: 'var(--text-secondary)' }}>Scanning for AI providers...</p>
        <p className="text-sm mt-2" style={{ color: 'var(--text-tertiary)' }}>Checking for existing CLIs and environment variables</p>
      </div>
    );
  }

  // BYOK form
  if (showBYOK) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-6" style={getSetupIconBadgeStyle('blue')}>
          <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Add API Key</h2>
        <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>Enter your own API key for AI-powered reviews.</p>

        <div className="mb-6 text-left max-w-xl mx-auto" style={setupInsetPanelStyle}>
          {/* Provider type */}
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Provider</label>
          <select
            value={byokType}
            onChange={(e) => { setByokType(e.target.value); setTestResult(null); }}
            className="mb-4"
            style={setupInputStyle}
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT)</option>
            <option value="google">Google (Gemini)</option>
          </select>

          {/* API key */}
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>API Key</label>
          <input
            type="password"
            value={byokKey}
            onChange={(e) => { setByokKey(e.target.value); setTestResult(null); }}
            placeholder={byokType === 'anthropic' ? 'sk-ant-...' : byokType === 'google' ? 'AIza...' : 'sk-...'}
            className="mb-4 font-mono"
            style={setupInputStyle}
          />

          {/* Test result */}
          {testResult && (
            <div className="mb-4" style={getSetupNoticeStyle(testResult.success ? 'green' : 'red')}>
              {testResult.success ? 'Connection successful' : testResult.error || 'Connection failed'}
            </div>
          )}

          {/* Test / Save buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleTestKey}
              disabled={!byokKey || testing}
              style={getSetupButtonStyle({ tone: 'neutral', disabled: !byokKey || testing, fullWidth: true })}
            >
              <SetupButtonIcon name="refresh" size={14} />
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              onClick={handleSaveKey}
              disabled={!testResult?.success || saving}
              style={getSetupButtonStyle({ tone: 'blue', active: true, disabled: !testResult?.success || saving, fullWidth: true })}
            >
              <SetupButtonIcon name="key" size={14} />
              {saving ? 'Saving...' : 'Save & Continue'}
            </button>
          </div>
        </div>

        <div className="flex justify-center gap-4">
          <button
            onClick={() => setShowBYOK(false)}
            style={getSetupButtonStyle({ tone: 'neutral' })}
          >
            Back
          </button>
          <button
            onClick={onSkip}
            style={getSetupTextButtonStyle()}
          >
            Skip for now
          </button>
        </div>
      </div>
    );
  }

  // Providers found
  if (providers.length > 0) {
    return (
      <div className="text-center">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div
            className="flex items-center justify-center rounded-full"
            style={{
              width: 36,
              height: 36,
              border: '2px solid rgba(98, 222, 128, 0.35)',
              background: 'rgba(98, 222, 128, 0.06)',
              color: '#6ee787',
              flexShrink: 0,
            }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>AI Providers Detected</h2>
        </div>
        <p className="mb-5 text-sm" style={{ color: 'var(--text-secondary)' }}>We found the following AI providers on your system.</p>

        <div className="space-y-2 mb-5 max-w-[570px] mx-auto">
          {providers.map((p, i) => {
            const isSelected = selectedProviderId === p.id;
            return (
            <div
              key={i}
              className="flex items-center gap-4 text-left"
              onClick={() => setSelectedProviderId(p.id ?? null)}
              style={{
                background: 'var(--review-card-bg)',
                border: `1px solid ${isSelected ? 'rgba(98, 222, 128, 0.2)' : 'var(--review-shell-border)'}`,
                borderRadius: 14,
                boxShadow: 'var(--review-panel-shadow)',
                padding: '10px 14px',
                cursor: 'pointer',
              }}
            >
              <div
                className="flex items-center justify-center rounded-full"
                style={{
                  width: 32,
                  height: 32,
                  border: `2px solid ${isSelected ? 'rgba(98, 222, 128, 0.45)' : 'var(--review-shell-border)'}`,
                  background: isSelected ? 'rgba(98, 222, 128, 0.04)' : 'transparent',
                  transition: 'border-color 150ms ease, background 150ms ease',
                }}
              >
                {isSelected && (
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 999,
                      background: '#6ee787',
                      boxShadow: '0 0 14px rgba(110, 231, 135, 0.25)',
                    }}
                  />
                )}
              </div>
              <div className="text-left flex-1">
                <p className="font-semibold text-[1.05rem]" style={{ color: 'var(--text-primary)' }}>{p.label}</p>
                <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {getProviderSourceLabel(p.source)}
                  {isSelected && ' (active)'}
                </p>
              </div>
              {isCliDetectedSource(p.source) && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[0.95rem] font-semibold"
                  style={{
                    color: '#6ee787',
                    background: 'rgba(98, 222, 128, 0.08)',
                    border: '1px solid rgba(98, 222, 128, 0.12)',
                  }}
                >
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Installed
                </span>
              )}
            </div>
          );
          })}
        </div>

        {missingCliTools.length > 0 && (
          <div className="mb-4 max-w-xl mx-auto text-left" style={setupInsetPanelStyle}>
            <div className="mb-3">
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Install missing CLI tools</p>
            </div>
            <div className="space-y-2">
              {missingCliTools.map((tool) => (
                <CliInstallCard
                  key={tool.key}
                  tool={tool}
                  state={cliStates[tool.key]}

                  onAuthSuccess={() => handleAuthSuccess(tool.key)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col items-center gap-4">
          <button
            onClick={() => void handleDetectedProviderContinue()}
            style={{
              ...getSetupButtonStyle({ tone: 'blue', active: true }),
            }}
          >
            <SetupButtonIcon name="plug" size={16} />
            Continue to MCP Setup
          </button>
          <button
            onClick={() => setShowBYOK(true)}
            style={{
              ...getSetupTextButtonStyle({ tone: 'link' }),
              fontSize: '0.95rem',
            }}
          >
            Add a different API key instead
          </button>
          <div className="flex items-center gap-5">
            <button
              onClick={onBack}
              style={{
                ...getSetupButtonStyle({ tone: 'neutral' }),
                minHeight: 42,
                padding: '0 20px',
                borderRadius: 12,
              }}
            >
              Back
            </button>
            <button
              onClick={onSkip}
              style={getSetupTextButtonStyle()}
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    );
  }

  // No providers found — prefer CLI setup, keep API key as secondary fallback
  return (
    <div className="text-center">
      <div className="mx-auto mb-6" style={getSetupIconBadgeStyle('yellow')}>
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
        </svg>
      </div>
      <h2 className="text-2xl font-bold text-content mb-2">Set Up AI Provider</h2>
      <p className="text-content-secondary mb-6">
        Install or detect a CLI tool to get started. API key setup is available as a fallback.
      </p>

      {emulateNoCliProviders && (
        <div className="mb-6 max-w-md mx-auto" style={getSetupNoticeStyle('blue')}>
          Browser dev override active: detected CLI providers are hidden for setup UI iteration.
        </div>
      )}

      <div className="space-y-3 mb-6 max-w-md mx-auto">
        <div className="bg-surface/50 border border-border rounded-lg text-left">
          <button
            onClick={() => setShowCLI(!showCLI)}
            data-testid="setup-cli-toggle"
            className="w-full p-4 flex items-center justify-between text-left hover:bg-surface-hover/50 transition-colors rounded-lg"
          >
            <div className="text-left">
              <p
                className="text-base font-semibold"
                style={{ color: 'var(--text-primary)' }}
              >
                Install or detect a CLI tool
              </p>
              <p className="text-content-tertiary text-xs mt-1">Recommended path for provider setup</p>
            </div>
            <svg
              className={`w-4 h-4 transition-transform ${showCLI ? 'rotate-180' : ''}`}
              style={{ color: showCLI ? 'var(--accent-blue)' : 'var(--text-tertiary)' }}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showCLI && (
            <div className="px-4 pb-4 space-y-2">
              <p className="text-content-tertiary text-xs mb-2">
                Click Install to set up a CLI tool, or Rescan if you already have one:
              </p>
              {CLI_TOOLS.map((tool) => (
                <CliInstallCard
                  key={tool.key}
                  tool={tool}
                  state={cliStates[tool.key]}

                  onAuthSuccess={() => handleAuthSuccess(tool.key)}
                />
              ))}
              <button
                onClick={onRescan}
                className="mt-2 px-4 py-1.5 bg-surface-elevated hover:bg-surface-hover text-content text-sm rounded-lg transition-colors"
              >
                Rescan for CLI tools
              </button>
            </div>
          )}
        </div>

        <div className="bg-surface/50 border border-border rounded-lg text-left">
          <button
            onClick={() => setShowBYOK(!showBYOK)}
            className="w-full p-4 flex items-center justify-between text-left hover:bg-surface-hover/50 transition-colors rounded-lg"
          >
            <div className="text-left">
              <p
                className="text-base font-semibold"
                style={{ color: showBYOK ? 'var(--accent-blue)' : 'var(--text-secondary)' }}
              >
                Add your API key
              </p>
              <p className="text-content-tertiary text-xs mt-1">Fallback path if you do not want to install a CLI</p>
            </div>
            <svg
              className={`w-4 h-4 transition-transform ${showBYOK ? 'rotate-180' : ''}`}
              style={{ color: showBYOK ? 'var(--accent-blue)' : 'var(--text-tertiary)' }}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showBYOK && (
            <div className="px-4 pb-4 text-left">
              <div className="space-y-4 rounded-lg border border-border bg-surface-base p-4">
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Provider</label>
                  <select
                    value={byokType}
                    onChange={(e) => { setByokType(e.target.value); setTestResult(null); }}
                    style={setupInputStyle}
                  >
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="openai">OpenAI (GPT)</option>
                    <option value="google">Google (Gemini)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>API Key</label>
                  <input
                    type="password"
                    value={byokKey}
                    onChange={(e) => { setByokKey(e.target.value); setTestResult(null); }}
                    placeholder={byokType === 'anthropic' ? 'sk-ant-...' : byokType === 'google' ? 'AIza...' : 'sk-...'}
                    className="font-mono"
                    style={setupInputStyle}
                  />
                </div>

                {testResult && (
                  <div style={getSetupNoticeStyle(testResult.success ? 'green' : 'red')}>
                    {testResult.success ? 'Connection successful' : testResult.error || 'Connection failed'}
                  </div>
                )}

                <p className="text-content-tertiary text-xs">
                  Keys are stored locally and encrypted before use.
                </p>

                <div className="flex gap-3">
                  <button
                    onClick={handleTestKey}
                    disabled={!byokKey || testing}
                    style={getSetupButtonStyle({ tone: 'neutral', disabled: !byokKey || testing, fullWidth: true })}
                  >
                    <SetupButtonIcon name="refresh" size={14} />
                    {testing ? 'Testing...' : 'Test Connection'}
                  </button>
                  <button
                    onClick={handleSaveKey}
                    disabled={!testResult?.success || saving}
                    style={getSetupButtonStyle({ tone: 'blue', active: true, disabled: !testResult?.success || saving, fullWidth: true })}
                  >
                    <SetupButtonIcon name="key" size={14} />
                    {saving ? 'Saving...' : 'Save & Continue'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {canContinue ? (
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={onNext}
            style={getSetupButtonStyle({ tone: 'blue', active: true })}
          >
            <SetupButtonIcon name="arrow-right" size={16} />
            Continue
          </button>
          <button
            onClick={onBack}
            className="px-6 py-2 text-content-secondary hover:text-content transition-colors"
          >
            Back
          </button>
        </div>
      ) : (
        <div className="flex justify-center gap-4">
          <button
            onClick={onBack}
            style={getSetupButtonStyle({ tone: 'neutral' })}
          >
            Back
          </button>
          <button
            onClick={onSkip}
            style={getSetupTextButtonStyle()}
          >
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}

export default ProviderStep;
