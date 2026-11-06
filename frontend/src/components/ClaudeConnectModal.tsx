/**
 * ClaudeConnectModal Component
 * Modal for Claude Code CLI connection and authentication
 * Following the pattern from LILA Eval's ClaudeStep.tsx
 */

import { useState, useEffect } from 'react';
import { claudeApi, type ClaudeStatus } from '@/services/api';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface ClaudeConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected: () => void;
}

export function ClaudeConnectModal({
  isOpen,
  onClose,
  onConnected,
}: ClaudeConnectModalProps) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [testResult, setTestResult] = useState<{
    authenticated: boolean;
    error?: string;
  } | null>(null);
  const [isChangingToken, setIsChangingToken] = useState(false);

  // State for error display
  const [statusError, setStatusError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const backdropStyle = {
    background: 'rgba(var(--bg-base-rgb), 0.58)',
    backdropFilter: 'blur(12px)',
  } as const;

  const shellStyle = {
    background: 'var(--review-panel-bg)',
    border: '1px solid var(--review-shell-border)',
    borderRadius: 24,
    boxShadow: 'var(--review-panel-shadow)',
  } as const;

  const inputStyle = {
    background: 'var(--review-code-bg)',
    border: '1px solid var(--review-shell-border-strong)',
    color: 'var(--text-primary)',
    borderRadius: 12,
  } as const;

  // Reset all state when modal opens
  useEffect(() => {
    if (isOpen) {
      // Reset state to prevent stale data
      setToken('');
      setTestResult(null);
      setIsChangingToken(false);
      setStatusError(null);
      setSaveError(null);
      // Then check status
      checkStatus();
    }
  }, [isOpen]);

  const checkStatus = async () => {
    setLoading(true);
    setStatusError(null);
    console.log('[ClaudeConnectModal] checkStatus called');
    try {
      console.log('[ClaudeConnectModal] Calling claudeApi.getStatus()');
      const response = await claudeApi.getStatus();
      console.log('[ClaudeConnectModal] Response:', response);
      if (response.success && response.data) {
        setClaudeStatus(response.data);
        // If already authenticated, show success
        if (response.data.authenticated) {
          setTestResult({ authenticated: true });
        }
      } else {
        setStatusError('Failed to check status');
      }
    } catch (error) {
      console.error('[ClaudeConnectModal] Failed to check Claude status:', error);
      setStatusError('Unable to connect to server. Please try again.');
      setClaudeStatus(null);
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const response = await claudeApi.testConnection(token || undefined);
      if (response.success && response.data) {
        setTestResult(response.data);
      } else {
        setTestResult({
          authenticated: false,
          error: 'Connection test failed',
        });
      }
    } catch (error) {
      setTestResult({
        authenticated: false,
        error: 'Failed to test connection',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveAndConnect = async () => {
    if (!testResult?.authenticated) return;

    // If using native auth and not entering a new token, just close
    if (claudeStatus?.hasNativeAuth && !token) {
      onConnected();
      onClose();
      return;
    }

    if (!token) {
      onConnected();
      onClose();
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const response = await claudeApi.saveToken(token);
      if (response.success) {
        onConnected();
        onClose();
      } else {
        setSaveError('Failed to save token');
      }
    } catch (error) {
      console.error('Failed to save token:', error);
      setSaveError('Unable to save token. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleChangeToken = () => {
    setIsChangingToken(true);
    setToken('');
    setTestResult(null);
  };

  const handleCancelChange = () => {
    setIsChangingToken(false);
    setToken('');
    setTestResult(claudeStatus?.authenticated ? { authenticated: true } : null);
  };

  const handleDisconnect = async () => {
    try {
      await claudeApi.clearToken();
      setClaudeStatus(null);
      setTestResult(null);
      setToken('');
      await checkStatus();
    } catch (error) {
      console.error('Failed to disconnect:', error);
    }
  };

  if (!isOpen) return null;

  // Loading state
  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-50" style={backdropStyle}>
        <div className="p-6 max-w-md w-full mx-4" style={shellStyle}>
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent-blue)', borderTopColor: 'transparent' }}></div>
          </div>
        </div>
      </div>
    );
  }

  // Error state - couldn't fetch status
  if (statusError && !claudeStatus) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-50" style={backdropStyle}>
        <div className="p-6 max-w-md w-full mx-4" style={shellStyle}>
          <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Connection Error
          </h2>
          <div className="rounded-lg p-4 mb-6" style={{ background: 'var(--chip-error-bg)', border: '1px solid var(--chip-error-border)' }}>
            <div className="flex items-center gap-2">
              <span className="text-lg" style={{ color: 'var(--accent-red)' }}>✗</span>
              <p style={{ color: 'var(--accent-red)' }}>{statusError}</p>
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              style={getReviewActionButtonStyle({ tone: 'neutral' })}
            >
              Close
            </button>
            <button
              onClick={checkStatus}
              style={getReviewActionButtonStyle({ tone: 'blue', active: true })}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // CLI not installed
  if (claudeStatus && !claudeStatus.installed) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-50" style={backdropStyle}>
        <div className="p-6 max-w-md w-full mx-4" style={shellStyle}>
          <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Claude Code Setup
          </h2>
          <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
            Claude Code CLI is required for AI-powered development.
          </p>

          <div className="rounded-lg p-4 mb-6" style={{ background: 'var(--chip-error-bg)', border: '1px solid var(--chip-error-border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg" style={{ color: 'var(--accent-red)' }}>✗</span>
              <p className="font-medium" style={{ color: 'var(--accent-red)' }}>Claude Code CLI not found</p>
            </div>
            <p className="text-sm mb-4" style={{ color: 'var(--accent-red)' }}>
              Please install Claude Code CLI first.
            </p>
            <div className="rounded p-3" style={{ background: 'var(--review-code-bg)' }}>
              <p className="text-sm font-medium mb-2" style={{ color: 'var(--accent-red)' }}>Installation:</p>
              <code className="text-sm block font-mono" style={{ color: 'var(--accent-red)' }}>
                npm install -g @anthropic-ai/claude-code
              </code>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              style={getReviewActionButtonStyle({ tone: 'neutral' })}
            >
              Close
            </button>
            <button
              onClick={checkStatus}
              style={getReviewActionButtonStyle({ tone: 'blue', active: true })}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Native auth present and not changing
  if (claudeStatus?.hasNativeAuth && !isChangingToken) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-50" style={backdropStyle}>
        <div className="p-6 max-w-md w-full mx-4" style={shellStyle}>
          <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Claude Code Connected
          </h2>
          <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
            Claude Code is already configured on this machine.
          </p>

          <div className="space-y-4">
            <div className="rounded-lg p-4" style={{ background: 'var(--chip-success-bg)', border: '1px solid var(--chip-success-border)' }}>
              <div className="flex items-center gap-2">
                <span className="text-lg" style={{ color: 'var(--accent-green)' }}>✓</span>
                <p className="font-medium" style={{ color: 'var(--accent-green)' }}>Connected via CLI</p>
              </div>
              <p className="text-sm mt-2" style={{ color: 'var(--accent-green)' }}>
                You're logged in via the Claude CLI. No additional setup needed.
              </p>
            </div>

            {claudeStatus?.version && (
              <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                Claude CLI version: {claudeStatus.version}
              </div>
            )}

            <button
              onClick={handleChangeToken}
              className="text-sm"
              style={{ color: 'var(--accent-blue)' }}
            >
              Use a different OAuth token instead
            </button>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={onClose}
              style={getReviewActionButtonStyle({ tone: 'neutral' })}
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onConnected();
                onClose();
              }}
              style={getReviewActionButtonStyle({ tone: 'blue', active: true })}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Token input mode
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={backdropStyle}>
      <div className="p-6 max-w-md w-full mx-4" style={shellStyle}>
        <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          Connect Claude Code
        </h2>
        <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
          {claudeStatus?.hasStoredToken
            ? 'Claude Code is configured with an OAuth token.'
            : 'Enter your Claude OAuth token to enable AI-powered development.'}
        </p>

        <div className="space-y-4">
          {/* Token input */}
          <div>
            <label
              htmlFor="claude-token"
              className="block text-sm font-medium mb-2"
              style={{ color: 'var(--text-primary)' }}
            >
              OAuth Token
            </label>
            <div className="flex gap-2">
              <input
                id="claude-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter your Claude OAuth token"
                className="flex-1 px-4 py-2 placeholder-content-tertiary focus:outline-none"
                style={inputStyle}
              />
              <button
                onClick={handleTestConnection}
                disabled={!token.trim() || testing}
                className="whitespace-nowrap"
                style={getReviewActionButtonStyle({ tone: 'neutral', disabled: !token.trim() || testing })}
              >
                {testing ? 'Testing...' : 'Test'}
              </button>
            </div>
            {isChangingToken && claudeStatus?.hasNativeAuth && (
              <button
                onClick={handleCancelChange}
                className="mt-2 text-sm"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Cancel and use CLI authentication
              </button>
            )}
          </div>

          {/* Instructions */}
          {!claudeStatus?.authenticated && (
            <div className="rounded-lg p-4" style={{ background: 'var(--chip-info-bg)', border: '1px solid var(--chip-info-border)' }}>
              <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--accent-blue)' }}>
                OAuth token setup
              </h3>
              <p className="text-sm" style={{ color: 'var(--accent-blue)' }}>
                Run{' '}
                <code className="mx-1 inline-flex items-center rounded-md border border-accent-blue/40 bg-accent-blue/15 px-1.5 py-0.5 font-mono text-[12px] text-accent-blue shadow-[0_0_0_1px_rgba(59,130,246,0.08)]">
                  claude setup-token
                </code>{' '}
                in your terminal, then paste the generated Claude OAuth token here. Atlas will test it against the installed Claude CLI before saving it for future sessions.
              </p>
            </div>
          )}

          {/* Version info */}
          {claudeStatus?.version && (
            <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              Claude CLI version: {claudeStatus.version}
            </div>
          )}

          {/* Test Result */}
          {testResult && (
            <div
              className={`rounded-lg p-4 ${
                testResult.authenticated
                  ? ''
                  : ''
              }`}
              style={testResult.authenticated
                ? { background: 'var(--chip-success-bg)', border: '1px solid var(--chip-success-border)' }
                : { background: 'var(--chip-error-bg)', border: '1px solid var(--chip-error-border)' }}
            >
              {testResult.authenticated ? (
                <div className="flex items-center gap-2">
                  <span className="text-lg" style={{ color: 'var(--accent-green)' }}>✓</span>
                  <p className="font-medium" style={{ color: 'var(--accent-green)' }}>
                    Connected successfully!
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-lg" style={{ color: 'var(--accent-red)' }}>✗</span>
                  <div>
                    <p className="font-medium" style={{ color: 'var(--accent-red)' }}>Connection failed</p>
                    <p className="text-sm" style={{ color: 'var(--accent-red)' }}>{testResult.error}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Save Error */}
          {saveError && (
            <div className="rounded-lg p-3" style={{ background: 'var(--chip-error-bg)', border: '1px solid var(--chip-error-border)' }}>
              <div className="flex items-center gap-2">
                <span style={{ color: 'var(--accent-red)' }}>✗</span>
                <p className="text-sm" style={{ color: 'var(--accent-red)' }}>{saveError}</p>
              </div>
            </div>
          )}

        {/* Actions */}
        <div className="flex justify-between mt-6">
          <div>
            {claudeStatus?.hasStoredToken && (
              <button
                onClick={handleDisconnect}
                className="text-sm"
                style={{ color: 'var(--accent-red)' }}
              >
                Disconnect
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              style={getReviewActionButtonStyle({ tone: 'neutral' })}
            >
              Cancel
            </button>
            <button
              onClick={handleSaveAndConnect}
              disabled={!testResult?.authenticated || saving}
              style={getReviewActionButtonStyle({ tone: 'blue', active: true, disabled: !testResult?.authenticated || saving })}
            >
              {saving ? 'Saving...' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ClaudeConnectModal;
