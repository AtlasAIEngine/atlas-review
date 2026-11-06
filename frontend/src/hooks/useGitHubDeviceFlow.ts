/**
 * Shared hook for GitHub device flow authentication.
 * Handles: connect → open browser → show device code → poll for completion.
 * Used by GitHubImportModal, GitHubPopover, and GitHubConnect.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import toast from '@/lib/toast';
import githubApi, { type GitHubInstallation } from '@/services/githubApi';
import { openExternal } from '@/utils/openExternal';
import { isTauriEnvironment } from '@/utils/tauri';
import { dispatchGitHubConnectionChanged } from '@/constants/githubEvents';

const isTauri = isTauriEnvironment();

// The frontend polls the local backend, which owns the real GitHub-facing
// device-flow cadence (5 s floor + slow_down backoff). So this value is
// purely UI-responsiveness pacing, not a GitHub rate-limit concern.
const POLL_INTERVAL_MS = 1000;
const FLOW_TIMEOUT_MS = 120000; // 2 minutes
const INSTALLATION_RETRY_DELAY_MS = 750;
const INSTALLATION_RETRY_ATTEMPTS = 5;

interface UseGitHubDeviceFlowOptions {
  onConnected?: (installation: GitHubInstallation) => void;
  onError?: (message: string) => void;
}

interface UseGitHubDeviceFlowReturn {
  connecting: boolean;
  deviceCode: string | null;
  connect: () => Promise<void>;
  cancel: () => void;
  loadInstallation: () => Promise<GitHubInstallation | null>;
}

export default function useGitHubDeviceFlow(
  options: UseGitHubDeviceFlowOptions = {}
): UseGitHubDeviceFlowReturn {
  const { onConnected, onError } = options;

  const [connecting, setConnecting] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);

  // Track intervals/timeouts for cleanup
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const flowStepRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cleanup();
    setDeviceCode(null);
    setConnecting(false);
    flowStepRef.current = null;
  }, [cleanup]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const loadInstallation = useCallback(async (): Promise<GitHubInstallation | null> => {
    try {
      const installations = await githubApi.getInstallations();
      if (installations.length > 0) {
        const active = installations.find(i => i.isActive) || installations[0];
        return active;
      }
    } catch (err) {
      console.error('Failed to load GitHub installation:', err);
    }
    return null;
  }, []);

  const sleep = useCallback((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)), []);

  const loadInstallationWithRetry = useCallback(async (): Promise<GitHubInstallation | null> => {
    for (let attempt = 0; attempt < INSTALLATION_RETRY_ATTEMPTS; attempt += 1) {
      if (cancelledRef.current) return null;
      const installation = await loadInstallation();
      if (cancelledRef.current) return null;
      if (installation) {
        return installation;
      }
      if (attempt < INSTALLATION_RETRY_ATTEMPTS - 1) {
        await sleep(INSTALLATION_RETRY_DELAY_MS);
      }
    }
    return null;
  }, [loadInstallation, sleep]);

  const finalizeConnection = useCallback(async () => {
    cleanup();
    const installation = await loadInstallationWithRetry();
    if (cancelledRef.current) return;
    setDeviceCode(null);
    setConnecting(false);
    flowStepRef.current = null;

    if (installation) {
      dispatchGitHubConnectionChanged({
        reason: 'device_flow',
        accountLogin: installation.accountLogin,
        installationId: installation.installationId,
      });
      onConnected?.(installation);
      return;
    }

    if (!installation && onError) {
      onError('GitHub connected, but the account list is still syncing. Reopen the dialog in a moment.');
    }
  }, [cleanup, loadInstallationWithRetry, onConnected, onError]);

  const connect = useCallback(async () => {
    // Reset state
    cancelledRef.current = false;
    cleanup();
    setConnecting(true);
    setDeviceCode(null);
    flowStepRef.current = null;

    // In browser mode, pre-open popup (must happen synchronously in click handler)
    const popup = isTauri ? null : window.open('', 'github-connect', 'width=800,height=600');

    try {
      const { url, step, message, userCode } = await githubApi.getConnectUrl();
      flowStepRef.current = step;

      if (!url) {
        const errorMsg = message || 'Failed to initiate GitHub connection';
        if (onError) {
          onError(errorMsg);
        } else {
          toast.error(errorMsg);
        }
        if (popup && !popup.closed) popup.close();
        setConnecting(false);
        return;
      }

      // Show device code if this is a device flow
      if (step === 'device' && userCode) {
        setDeviceCode(userCode);
      }

      // Open the URL
      if (isTauri) {
        await openExternal(url);
      } else if (popup && !popup.closed) {
        popup.location.href = url;
      } else {
        window.open(url, 'github-connect', 'width=800,height=600');
      }

      // Start polling for completion
      pollIntervalRef.current = setInterval(async () => {
        if (cancelledRef.current) return;

        try {
          // In browser mode, check if popup was closed
          if (!isTauri && popup?.closed && flowStepRef.current !== 'device') {
            cleanup();
            // Popup closed — check if we need a second auth step
            try {
              const status = await githubApi.getConnectUrl();
              if (status.step === 'connected') {
                await finalizeConnection();
                return;
              }
              if (status.url && status.step === 'authorize') {
                flowStepRef.current = status.step;
                // Need second authorization step — open another popup
                const authPopup = window.open(status.url, 'github-authorize', 'width=800,height=600');
                // Poll for this popup to close
                pollIntervalRef.current = setInterval(async () => {
                  if (cancelledRef.current) return;
                  if (authPopup?.closed) {
                    await finalizeConnection();
                  }
                }, POLL_INTERVAL_MS);
                timeoutRef.current = setTimeout(() => {
                  cleanup();
                  setDeviceCode(null);
                  setConnecting(false);
                  flowStepRef.current = null;
                }, FLOW_TIMEOUT_MS);
                return;
              }
            } catch {
              // Ignore errors checking status after popup close
            }

            setDeviceCode(null);
            setConnecting(false);
            flowStepRef.current = null;
            return;
          }

          // Poll /connect endpoint — most reliable completion detection
          const status = await githubApi.getConnectUrl();
          if (status.step === 'connected') {
            await finalizeConnection();
          }
        } catch {
          // Continue polling on error
        }
      }, POLL_INTERVAL_MS);

      // Safety timeout — stop polling after FLOW_TIMEOUT_MS
      timeoutRef.current = setTimeout(() => {
        cleanup();
        setDeviceCode(null);
        setConnecting(false);
        flowStepRef.current = null;
      }, FLOW_TIMEOUT_MS);
    } catch (err: any) {
      console.error('Failed to connect GitHub:', err);
      const msg = err.response?.data?.error || 'Failed to initiate GitHub connection';
      if (onError) {
        onError(msg);
      } else {
        toast.error(msg);
      }
      if (popup && !popup.closed) popup.close();
      setDeviceCode(null);
      setConnecting(false);
      flowStepRef.current = null;
    }
  }, [cleanup, finalizeConnection, onError]);

  return { connecting, deviceCode, connect, cancel, loadInstallation };
}
