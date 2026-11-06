/**
 * useSetupStatus Hook
 * Manages setup wizard state for first-run experience
 */

import { useState, useEffect, useCallback } from 'react';
import { mcpApi, settingsApi } from '@/services/api';
import { MCP_AUTO_SELECTED_AGENTS_KEY } from '@/constants/mcpSettings';

const SETUP_COMPLETED_KEY = 'setup_completed';
const SETUP_WIZARD_BROWSER_OVERRIDE_KEY = 'atlas_force_setup_wizard';
const SETUP_PROVIDERS_BROWSER_OVERRIDE_KEY = 'atlas_setup_providers_override';

/**
 * Removes Atlas-managed MCP/global config during reset flows.
 * `buildIfNeeded=true` preserves sign-out behavior by letting the setup layer
 * materialize any missing wrapper before cleanup. The default stays `false`
 * so dev/test resets do not create files solely to remove them again.
 *
 * @param {boolean} [buildIfNeeded=false] When true, allows the setup layer to
 * materialize any missing wrapper before cleanup. Leave false for local reset
 * flows that should avoid creating config files solely to remove them.
 */
export async function removeManagedIntegrationsForReset(buildIfNeeded = false) {
  await mcpApi.removeIntegrations({ buildIfNeeded }).catch((err) => {
    console.warn('Failed to remove Atlas-managed integrations during setup reset:', err);
  });
}

export async function clearPersistedSetupStateForReset() {
  await settingsApi.delete(SETUP_COMPLETED_KEY);
  await settingsApi.delete('setup_completed_at');
  await settingsApi.delete(MCP_AUTO_SELECTED_AGENTS_KEY).catch(() => {});
}

export interface UseSetupStatusResult {
  /** Whether the setup has been completed */
  isComplete: boolean;
  /** Whether the status is still loading */
  isLoading: boolean;
  /** Any error that occurred */
  error: string | null;
  /** Mark setup as complete */
  markComplete: () => Promise<void>;
  /** Reset setup (for testing) */
  resetSetup: () => Promise<void>;
}

export function useSetupStatus(apiReady: boolean = true): UseSetupStatusResult {
  const [isComplete, setIsComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check setup status only when API is ready (URL is configured)
  useEffect(() => {
    if (apiReady) {
      checkStatus();
    }
  }, [apiReady]);

  const checkStatus = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await settingsApi.get(SETUP_COMPLETED_KEY);
      // Check if value is 'true' (stored as string)
      setIsComplete(result.exists && result.value === 'true');
    } catch (err) {
      console.error('Failed to check setup status:', err);
      // On error, assume setup is complete to avoid blocking the app
      // This prevents a broken API from forcing the wizard to show every time
      setIsComplete(true);
      setError('Failed to check setup status');
    } finally {
      setIsLoading(false);
    }
  };

  const markComplete = useCallback(async () => {
    try {
      await settingsApi.set(SETUP_COMPLETED_KEY, 'true');
      // Also store the completion timestamp
      await settingsApi.set('setup_completed_at', new Date().toISOString());
      setIsComplete(true);
    } catch (err) {
      console.error('Failed to mark setup as complete:', err);
      setError('Failed to save setup status');
      throw err;
    }
  }, []);

  const resetSetup = useCallback(async () => {
    try {
      // Test/dev reset should not create MCP config files solely so they can be removed.
      await removeManagedIntegrationsForReset();
      await clearPersistedSetupStateForReset();
      setIsComplete(false);
    } catch (err) {
      console.error('Failed to reset setup:', err);
      setError('Failed to reset setup status');
      throw err;
    }
  }, []);

  return {
    isComplete,
    isLoading,
    error,
    markComplete,
    resetSetup,
  };
}

export default useSetupStatus;

// Export utility functions for testing/development
// These can be called from browser console: AtlasEngine.resetSetup()
if (typeof window !== 'undefined') {
  (window as any).AtlasEngine = (window as any).AtlasEngine || {};
  (window as any).AtlasEngine.resetSetup = async () => {
    try {
      // Browser helper follows the same no-side-effects policy as resetSetup().
      await removeManagedIntegrationsForReset();
      await clearPersistedSetupStateForReset();
      console.log('Setup reset. Reload the page to see the wizard.');
      window.location.reload();
    } catch (err) {
      console.error('Failed to reset setup:', err);
    }
  };
  (window as any).AtlasEngine.showSetupWizard = () => {
    try {
      window.localStorage.setItem(SETUP_WIZARD_BROWSER_OVERRIDE_KEY, '1');
      window.location.reload();
    } catch (err) {
      console.error('Failed to force setup wizard:', err);
    }
  };
  (window as any).AtlasEngine.showSetupWizardNoCli = () => {
    try {
      window.localStorage.setItem(SETUP_WIZARD_BROWSER_OVERRIDE_KEY, '1');
      window.localStorage.setItem(SETUP_PROVIDERS_BROWSER_OVERRIDE_KEY, 'none');
      window.location.reload();
    } catch (err) {
      console.error('Failed to force setup wizard no-CLI mode:', err);
    }
  };
  (window as any).AtlasEngine.hideSetupWizard = () => {
    try {
      window.localStorage.removeItem(SETUP_WIZARD_BROWSER_OVERRIDE_KEY);
      window.localStorage.removeItem(SETUP_PROVIDERS_BROWSER_OVERRIDE_KEY);
      const params = new URLSearchParams(window.location.search);
      params.delete('setupWizard');
      params.delete('setupProviders');
      const search = params.toString();
      const nextUrl = search ? `${window.location.pathname}?${search}` : window.location.pathname;
      window.history.replaceState({}, '', nextUrl);
      window.location.reload();
    } catch (err) {
      console.error('Failed to clear forced setup wizard:', err);
    }
  };
}
