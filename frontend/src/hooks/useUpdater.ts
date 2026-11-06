/**
 * useUpdater Hook
 * Manages auto-update functionality for the Tauri desktop app.
 * No-op when running in browser environment.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { isTauriEnvironment } from '@/utils/tauri';

const AUTO_CHECK_DELAY_MS = 3000;
const AUTO_CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const AUTO_CHECK_INTERVAL_MS = AUTO_CHECK_COOLDOWN_MS;
const UP_TO_DATE_TOAST_DURATION_MS = 15000;

/** Information about an available update */
export interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
  currentVersion: string;
}

/** Download progress information */
export interface DownloadProgress {
  downloaded: number;
  total: number | null;
  percent: number | null;
}

/** Update status states */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up_to_date'
  | 'downloading'
  | 'ready'
  | 'error';

interface CheckForUpdateOptions {
  userInitiated?: boolean;
}

export interface UseUpdaterResult {
  /** Whether running in Tauri desktop app */
  isTauri: boolean;
  /** Current update status */
  status: UpdateStatus;
  /** Information about available update */
  updateInfo: UpdateInfo | null;
  /** Download progress (0-100) */
  downloadProgress: number | null;
  /** Error message if status is 'error' */
  error: string | null;
  /** Check for updates manually */
  checkForUpdate: (options?: CheckForUpdateOptions) => Promise<void>;
  /** Download and install the update */
  downloadUpdate: () => Promise<void>;
  /** Dismiss the update notification */
  dismiss: () => void;
}

export function useUpdater(): UseUpdaterResult {
  const [isTauri] = useState(() => isTauriEnvironment());
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const statusRef = useRef<UpdateStatus>('idle');
  const lastCheckStartedAtRef = useRef<number | null>(null);
  const listenersRef = useRef<Array<() => void>>([]);

  const updateStatus = useCallback((nextStatus: UpdateStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const shouldRunAutomaticCheck = useCallback(() => {
    const currentStatus = statusRef.current;
    if (currentStatus !== 'idle') {
      return false;
    }

    const lastCheckStartedAt = lastCheckStartedAtRef.current;
    if (lastCheckStartedAt === null) {
      return true;
    }

    return (Date.now() - lastCheckStartedAt) >= AUTO_CHECK_COOLDOWN_MS;
  }, []);

  // Define callbacks first so they can be used in effects
  const checkForUpdate = useCallback(async (options: CheckForUpdateOptions = {}) => {
    if (!isTauri) return;
    const userInitiated = options.userInitiated === true;
    const currentStatus = statusRef.current;

    if (!userInitiated && currentStatus !== 'idle') {
      return;
    }

    if (currentStatus === 'checking' || currentStatus === 'downloading' || currentStatus === 'ready') {
      return;
    }

    lastCheckStartedAtRef.current = Date.now();
    updateStatus('checking');
    setError(null);

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<UpdateInfo | null>('check_for_update');

      if (!mountedRef.current) return;

      if (result) {
        setUpdateInfo(result);
        updateStatus('available');
      } else {
        setUpdateInfo(null);
        updateStatus(userInitiated ? 'up_to_date' : 'idle');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to check for updates';

      if (userInitiated) {
        console.error('Manual update check failed:', err);
        setError(message);
        updateStatus('error');
        return;
      }

      // Log the error but don't show it to users for automatic background checks
      // This prevents showing "Update failed" banner when update server is unreachable
      // (404, network errors, etc.)
      console.warn('Update check failed (non-blocking):', err);
      // Reset to idle instead of showing error - updates are optional
      updateStatus('idle');
    }
  }, [isTauri, updateStatus]);

  const downloadUpdate = useCallback(async () => {
    if (!isTauri || !updateInfo) return;

    updateStatus('downloading');
    setDownloadProgress(0);
    setError(null);

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('download_and_install');

      // If we get here, something went wrong (should restart)
      if (!mountedRef.current) return;
      updateStatus('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to download update';
      console.error('Failed to download update:', err);
      setError(message);
      updateStatus('error');
      setDownloadProgress(null);
    }
  }, [isTauri, updateInfo, updateStatus]);

  const dismiss = useCallback(() => {
    updateStatus('idle');
    setUpdateInfo(null);
    setDownloadProgress(null);
    setError(null);
  }, [updateStatus]);

  // Set up event listeners for Tauri events
  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // Listen for download progress events
        const unlistenProgress = await listen<DownloadProgress>(
          'update-download-progress',
          (event) => {
            if (mountedRef.current) {
              setDownloadProgress(event.payload.percent ?? 0);
            }
          }
        );
        if (cancelled) {
          unlistenProgress();
          return;
        }
        listenersRef.current.push(unlistenProgress);

        const unlistenMenuCheck = await listen(
          'menu-check-for-updates',
          () => {
            void checkForUpdate({ userInitiated: true });
          }
        );
        if (cancelled) {
          unlistenMenuCheck();
          return;
        }
        listenersRef.current.push(unlistenMenuCheck);
      } catch (err) {
        console.error('Failed to set up update event listeners:', err);
      }
    };

    void setupListeners();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      for (const unlisten of listenersRef.current.splice(0)) {
        try {
          unlisten();
        } catch {
          // noop
        }
      }
    };
  }, [isTauri, checkForUpdate]);

  // Schedule automatic checks on startup, on interval, and when the app returns
  // to the foreground. All automatic checks share the same cooldown.
  useEffect(() => {
    if (!isTauri) return;

    const runAutomaticCheck = () => {
      if (!shouldRunAutomaticCheck()) {
        return;
      }
      void checkForUpdate();
    };

    const startupTimer = window.setTimeout(() => {
      runAutomaticCheck();
    }, AUTO_CHECK_DELAY_MS);

    const intervalId = window.setInterval(() => {
      runAutomaticCheck();
    }, AUTO_CHECK_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runAutomaticCheck();
      }
    };

    const handleWindowFocus = () => {
      runAutomaticCheck();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [isTauri, checkForUpdate, shouldRunAutomaticCheck]);

  useEffect(() => {
    if (!isTauri) return;

    const enabled = status !== 'checking' && status !== 'downloading' && status !== 'ready';

    let cancelled = false;

    const updateMenuState = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        if (!cancelled) {
          await invoke('set_check_for_updates_menu_enabled', { enabled });
        }
      } catch (err) {
        console.error('Failed to update check-for-updates menu state:', err);
      }
    };

    void updateMenuState();

    return () => {
      cancelled = true;
    };
  }, [isTauri, status]);

  useEffect(() => {
    if (!isTauri || status !== 'up_to_date') {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      if (mountedRef.current) {
        dismiss();
      }
    }, UP_TO_DATE_TOAST_DURATION_MS);

    return () => window.clearTimeout(timer);
  }, [dismiss, isTauri, status]);

  return {
    isTauri,
    status,
    updateInfo,
    downloadProgress,
    error,
    checkForUpdate,
    downloadUpdate,
    dismiss,
  };
}

export default useUpdater;
