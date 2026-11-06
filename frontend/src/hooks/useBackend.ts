/**
 * useBackend Hook
 * Manages backend discovery and connection for the Tauri desktop app.
 * In browser mode, immediately returns ready with default/env URL.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getBrowserDefaultApiBaseUrl } from '@/utils/apiBaseUrl';
import { isTauriEnvironment } from '@/utils/tauri';

/** Backend connection status states */
export type BackendStatus =
  | 'idle'
  | 'connecting'
  | 'bootstrapReady'
  | 'ready'
  | 'error';

export interface UseBackendResult {
  /** Whether running in Tauri desktop app */
  isTauri: boolean;
  /** Current backend connection status */
  status: BackendStatus;
  /** Backend port (only set in Tauri mode) */
  port: number | null;
  /** Error message if status is 'error' */
  error: string | null;
  /** The API base URL to use for requests */
  apiBaseUrl: string;
  /** Retry connection to backend */
  retry: () => void;
}

/** Default API base URL for browser mode */
const DESKTOP_BACKEND_PORT = import.meta.env.VITE_DESKTOP_BACKEND_PORT;
const DEFAULT_API_BASE_URL = import.meta.env.VITE_API_BASE_URL
  || (DESKTOP_BACKEND_PORT ? `http://127.0.0.1:${DESKTOP_BACKEND_PORT}/api` : getBrowserDefaultApiBaseUrl());

/** Health check polling interval in ms */
const HEALTH_CHECK_INTERVAL = 500;

/** Connection timeout in ms */
const IS_WINDOWS_CLIENT = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
const CONNECTION_TIMEOUT = import.meta.env.DEV ? 45000 : (IS_WINDOWS_CLIENT ? 90000 : 30000);

/** Fallback backend port for desktop dev when IPC is unavailable */
const DEV_FALLBACK_PORT = Number(import.meta.env.VITE_DESKTOP_BACKEND_PORT || 3001);

function isLocalDevUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const { protocol, hostname } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function getInvoke() {
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    if (w.__TAURI_INTERNALS__?.invoke) {
      return w.__TAURI_INTERNALS__.invoke;
    }
  }
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke;
}

async function readBackendStatus(
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
): Promise<{ ready?: boolean; last_error?: string | null } | null> {
  const resolvedInvoke = invoke ?? (isTauriEnvironment() ? await getInvoke() : null);
  if (!resolvedInvoke) return null;
  return await withTimeout(
    resolvedInvoke('backend_health') as Promise<{ ready?: boolean; last_error?: string | null } | null>,
    2000,
    'backend_health'
  );
}

export function useBackend(): UseBackendResult {
  const [isTauri] = useState(() => isTauriEnvironment());
  const [status, setStatus] = useState<BackendStatus>(() => isTauri ? 'idle' : 'ready');
  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => {
    // In browser mode, use environment URL or default immediately
    return isTauri ? '' : DEFAULT_API_BASE_URL;
  });
  const apiBaseUrlRef = useRef(apiBaseUrl);

  const mountedRef = useRef(true);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const devFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const timeoutHandledRef = useRef(false);
  const invokeRef = useRef<null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)>(null);

  useEffect(() => {
    apiBaseUrlRef.current = apiBaseUrl;
  }, [apiBaseUrl]);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (devFallbackRef.current) {
      clearTimeout(devFallbackRef.current);
      devFallbackRef.current = null;
    }
    timeoutHandledRef.current = false;
    invokeRef.current = null;
  }, []);

  // Connect to backend (Tauri mode only)
  const connect = useCallback(async () => {
    if (!isTauri) return;

    cleanup();
    attemptRef.current += 1;
    const currentAttempt = attemptRef.current;
    const allowDevFallback = DEV_FALLBACK_PORT > 0 && isLocalDevUrl();

    setStatus('connecting');
    setError(null);
    timeoutHandledRef.current = false;

    const tryFallbackHealth = async (): Promise<boolean> => {
      if (!allowDevFallback) return false;
      if (apiBaseUrlRef.current) return true;
      const fallbackBaseUrl = `http://127.0.0.1:${DEV_FALLBACK_PORT}/api`;
      try {
        const response = await fetch(`http://127.0.0.1:${DEV_FALLBACK_PORT}/health`, {
          method: 'GET',
        });
        if (response.ok) {
          setPort(DEV_FALLBACK_PORT);
          setApiBaseUrl(fallbackBaseUrl);
          cleanup();
          setStatus('ready');
          return true;
        }
      } catch (err) {
      }
      return false;
    };

    if (allowDevFallback) {
      devFallbackRef.current = setTimeout(() => {
        if (!mountedRef.current || currentAttempt !== attemptRef.current) return;
        void tryFallbackHealth();
      }, 3000);
    }

    // Poll for backend port. On desktop we expose the port as soon as the
    // bootstrap listener is live, then keep polling backend_health until the
    // full runtime finishes initialization.
    const startTime = Date.now();

    const checkPort = async () => {
      if (!mountedRef.current || currentAttempt !== attemptRef.current) return;

      try {
        if (!invokeRef.current) {
          invokeRef.current = await withTimeout(getInvoke(), 2000, 'load invoke');
        }

        const backendPort = await withTimeout(
          invokeRef.current('get_backend_port') as Promise<number | null>,
          2000,
          'get_backend_port'
        );

        if (!mountedRef.current || currentAttempt !== attemptRef.current) return;

        if (backendPort !== null) {
          setPort(backendPort);
          const baseUrl = `http://127.0.0.1:${backendPort}/api`;
          setApiBaseUrl(baseUrl);
          setError(null);
          let backendReady = false;
          try {
            const health = await readBackendStatus(invokeRef.current);
            backendReady = Boolean(health?.ready);
          } catch {
            backendReady = false;
          }

          if (!mountedRef.current || currentAttempt !== attemptRef.current) return;

          if (backendReady) {
            cleanup();
            setStatus('ready');
          } else {
            setStatus('bootstrapReady');
          }
          return;
        }

        const health = await readBackendStatus(invokeRef.current);
        if (!mountedRef.current || currentAttempt !== attemptRef.current) return;
        if (health?.last_error) {
          cleanup();
          setError(health.last_error);
          setStatus('error');
          return;
        }
      } catch (err) {
        invokeRef.current = null;
      }

      // Fallback for desktop dev when IPC is unavailable
      if (await tryFallbackHealth()) {
        return;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= CONNECTION_TIMEOUT && !timeoutHandledRef.current) {
        timeoutHandledRef.current = true;
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        if (mountedRef.current && currentAttempt === attemptRef.current) {
          // Try to get the actual error from the Rust backend
          let errorMsg = 'Backend startup timed out.';
          try {
            const health = await readBackendStatus(invokeRef.current);
            if (health?.last_error) {
              errorMsg = health.last_error;
            }
          } catch { /* use fallback message */ }
          setError(errorMsg);
          setStatus('error');
        }
      }
    };

    // Set timeout for connection
    timeoutRef.current = setTimeout(async () => {
      if (!mountedRef.current || currentAttempt !== attemptRef.current) return;
      timeoutHandledRef.current = true;
      timeoutRef.current = null;
      let errorMsg = 'Backend startup timed out.';
      try {
        const health = await readBackendStatus(invokeRef.current);
        if (health?.last_error) {
          errorMsg = health.last_error;
        }
      } catch { /* use fallback message */ }
      if (mountedRef.current && currentAttempt === attemptRef.current) {
        setError(errorMsg);
        setStatus('error');
      }
    }, CONNECTION_TIMEOUT);

    // Initial check
    void checkPort();

    // If not ready yet, start polling
    if (pollingRef.current === null) {
      pollingRef.current = setInterval(() => {
        void checkPort();
      }, HEALTH_CHECK_INTERVAL);
    }
  }, [isTauri, cleanup]);

  // Retry function for manual retry — actually restarts the backend process
  const retry = useCallback(async () => {
    if (!isTauri) return;
    setStatus('connecting');
    setError(null);
    try {
      const invoke = invokeRef.current || await getInvoke();
      invokeRef.current = invoke;
      const newPort = await invoke('restart_backend') as number;
      if (mountedRef.current) {
        setPort(newPort);
        setApiBaseUrl(`http://127.0.0.1:${newPort}/api`);
        setStatus('ready');
        return;
      }
    } catch (err) {
      if (mountedRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Backend restart failed: ${msg}`);
        setStatus('error');
      }
    }
  }, [isTauri]);

  // Auto-connect on mount in Tauri mode
  useEffect(() => {
    mountedRef.current = true;
    if (isTauri) {
      connect();
    }

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [isTauri, connect, cleanup]);

  return {
    isTauri,
    status,
    port,
    error,
    apiBaseUrl,
    retry,
  };
}

export default useBackend;
