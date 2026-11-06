/**
 * BackendLoader Component
 * Wraps the app and waits for backend to be ready before rendering children.
 * Shows loading spinner while connecting, error message if failed.
 * In browser mode, renders children immediately.
 * In Tauri mode, shows setup wizard on first run.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useBackend } from '../hooks/useBackend';
import { useSetupStatus } from '../hooks/useSetupStatus';
import { mcpApi, settingsApi, setApiBaseUrl } from '../services/api';
import { MCP_AUTO_SELECTED_AGENTS_KEY, parseMcpSelectedAgents } from '../constants/mcpSettings';
import { SetupWizard } from './SetupWizard';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface BackendLoaderProps {
  children: React.ReactNode;
}

const SETUP_WIZARD_QUERY_KEY = 'setupWizard';
const SETUP_WIZARD_BROWSER_OVERRIDE_KEY = 'atlas_force_setup_wizard';

function shouldForceSetupWizardInBrowser() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get(SETUP_WIZARD_QUERY_KEY);
  if (queryValue === '1' || queryValue === 'true') return true;
  return window.localStorage.getItem(SETUP_WIZARD_BROWSER_OVERRIDE_KEY) === '1';
}

function clearForcedSetupWizardInBrowser() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SETUP_WIZARD_BROWSER_OVERRIDE_KEY);
  const params = new URLSearchParams(window.location.search);
  if (!params.has(SETUP_WIZARD_QUERY_KEY)) return;
  params.delete(SETUP_WIZARD_QUERY_KEY);
  const search = params.toString();
  const nextUrl = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState({}, '', nextUrl);
}

export function BackendLoader({ children }: BackendLoaderProps) {
  const { isTauri, status, error, apiBaseUrl, retry } = useBackend();
  const forceBrowserWizard = !isTauri && shouldForceSetupWizardInBrowser();
  const [showWizard, setShowWizard] = useState(forceBrowserWizard);
  const [apiUrlSet, setApiUrlSet] = useState(!isTauri); // In browser mode, URL is ready immediately
  const managedMcpSetupReconciledRef = useRef(false);
  const backendBootstrapReady = status === 'bootstrapReady' || status === 'ready';

  // Set the API base URL when it becomes available
  useEffect(() => {
    if (apiBaseUrl) {
      setApiBaseUrl(apiBaseUrl);
      setApiUrlSet(true);
    }
  }, [apiBaseUrl]);

  // Only check setup status after API URL is configured (prevents race condition)
  const { isComplete: setupComplete, isLoading: setupLoading, markComplete } = useSetupStatus(apiUrlSet);

  // Show the first-run wizard as soon as the bootstrap routes are available,
  // even if the full backend runtime is still warming up.
  useEffect(() => {
    if (isTauri && backendBootstrapReady && !setupLoading && !setupComplete) {
      setShowWizard(true);
    }
  }, [backendBootstrapReady, isTauri, setupLoading, setupComplete]);

  useEffect(() => {
    if (forceBrowserWizard) {
      setShowWizard(true);
    }
  }, [forceBrowserWizard]);

  useEffect(() => {
    if (!isTauri || status !== 'ready' || !apiUrlSet || setupLoading || !setupComplete) {
      return;
    }
    if (managedMcpSetupReconciledRef.current) {
      return;
    }
    managedMcpSetupReconciledRef.current = true;

    let cancelled = false;

    const reconcileManagedMcpSetup = async () => {
      try {
        const selectionSetting = await settingsApi.get(MCP_AUTO_SELECTED_AGENTS_KEY).catch(() => ({
          exists: false,
          value: null,
        }));
        if (cancelled) return;

        const selectedAgentIds = parseMcpSelectedAgents(selectionSetting?.value);
        if (selectedAgentIds.length === 0) {
          return;
        }

        const agentsResponse = await mcpApi.getAgents(apiBaseUrl || undefined);
        if (cancelled) return;

        const detectionById = new Map(
          (agentsResponse.detectedAgents || []).map((agent) => [agent.id, agent])
        );
        const selectedAgents = (agentsResponse.supportedAgents || []).filter((agent) =>
          selectedAgentIds.includes(agent.id)
        );
        const needsReconcile = selectedAgents.some((agent) => {
          if (!agent.autoWriteSupported) {
            return false;
          }
          const detectedAgent = detectionById.get(agent.id);
          if (!detectedAgent || detectedAgent.mcpConnectionState?.status !== 'configured') {
            return true;
          }
          if (agent.workflowGuidance && detectedAgent.workflowGuidanceState?.status !== 'installed') {
            return true;
          }
          return false;
        });

        if (!needsReconcile) {
          return;
        }

        const response = await mcpApi.syncSetup({
          backendUrl: apiBaseUrl || undefined,
          selectedAgentIds,
          removeUnselected: true,
          buildIfNeeded: true,
        });
        if (cancelled) return;

        if (Array.isArray(response.failures) && response.failures.length > 0) {
          console.warn(
            `Managed MCP setup reconciliation completed with ${response.failures.length} failure${response.failures.length === 1 ? '' : 's'}:`,
            response.failures
          );
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to reconcile managed MCP setup:', error);
        }
      }
    };

    void reconcileManagedMcpSetup();

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, apiUrlSet, isTauri, setupComplete, setupLoading, status]);

  const handleWizardComplete = async () => {
    try {
      await markComplete();
      if (!isTauri) {
        clearForcedSetupWizardInBrowser();
        localStorage.setItem('atlas_visited', 'true');
      }
      setShowWizard(false);
    } catch (err) {
      console.error('Failed to complete setup:', err);
      // Still close wizard even if save fails
      if (!isTauri) {
        clearForcedSetupWizardInBrowser();
        localStorage.setItem('atlas_visited', 'true');
      }
      setShowWizard(false);
    }
  };

  // Setup wizard (first run)
  if (showWizard) {
    return <SetupWizard onComplete={handleWizardComplete} />;
  }

  // Loading state (backend not ready yet, or API URL not set)
  const shouldShowLoading = isTauri && (
    status === 'idle'
    || status === 'connecting'
    || (backendBootstrapReady && !apiUrlSet)
    || (backendBootstrapReady && setupLoading)
    || (status === 'bootstrapReady' && setupComplete)
  );

  if (shouldShowLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center" style={{ background: 'var(--review-shell-bg)' }}>
        <div className="text-center">
          {/* Logo/Spinner */}
          <div className="mb-6">
            <div className="w-16 h-16 mx-auto">
              <svg
                className="animate-spin"
                style={{ color: 'var(--accent-blue)' }}
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            </div>
          </div>

          {/* Status text */}
          <h1 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            AtlasEngine
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {status === 'idle'
              ? 'Initializing...'
              : status === 'bootstrapReady'
                ? (setupLoading ? 'Preparing setup...' : 'Finishing startup...')
                : status === 'ready'
                  ? 'Configuring...'
                  : 'Starting backend...'}
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (isTauri && status === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4" style={{ background: 'var(--review-shell-bg)' }}>
        <div
          className="text-center max-w-md w-full"
          style={{
            background: 'var(--review-panel-bg)',
            border: '1px solid var(--review-shell-border)',
            borderRadius: 24,
            boxShadow: 'var(--review-panel-shadow)',
            padding: '32px 28px',
          }}
        >
          {/* Error icon */}
          <div className="mb-6">
            <div className="w-16 h-16 mx-auto" style={{ color: 'var(--accent-red)' }}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
          </div>

          {/* Error message */}
          <h1 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Failed to Start
          </h1>
          <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
            {error || 'Unable to connect to the backend server.'}
          </p>

          {/* Retry button */}
          <button
            onClick={retry}
            style={{
              ...getReviewActionButtonStyle({ tone: 'blue', active: true }),
              minHeight: 40,
              padding: '0 18px',
              borderRadius: 12,
              fontSize: 'var(--text-sm)',
            }}
          >
            Retry
          </button>

          {/* Help text */}
          <p className="text-xs mt-6" style={{ color: 'var(--text-tertiary)' }}>
            If the problem persists, try restarting the application.
          </p>
        </div>
      </div>
    );
  }

  // In browser mode or when ready (and setup complete), render children
  return <>{children}</>;
}

export default BackendLoader;
