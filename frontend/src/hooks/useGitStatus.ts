/**
 * useGitStatus Hook
 * Fetches and polls Git status for a project.
 * Used by GitHubPopover for real-time status display.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import githubApi, { type GitStatus } from '@/services/githubApi';

interface UseGitStatusOptions {
  /** Polling interval in milliseconds (default: 10000 = 10s) */
  pollInterval?: number;
  /** Whether to enable polling (default: true) */
  enablePolling?: boolean;
}

interface UseGitStatusResult {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useGitStatus(
  projectId: string | null,
  options: UseGitStatusOptions = {}
): UseGitStatusResult {
  const { pollInterval = 10000, enablePolling = true } = options;

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    if (!projectId) {
      setStatus(null);
      setLoading(false);
      return;
    }

    try {
      const data = await githubApi.getGitStatus(projectId);
      if (mountedRef.current) {
        setStatus(data);
        setError(null);
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err.response?.data?.error || err.message || 'Failed to fetch git status');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [projectId]);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    fetchStatus();

    return () => {
      mountedRef.current = false;
    };
  }, [fetchStatus]);

  // Polling
  useEffect(() => {
    if (!enablePolling || !projectId) return;

    const interval = setInterval(fetchStatus, pollInterval);
    return () => clearInterval(interval);
  }, [fetchStatus, pollInterval, enablePolling, projectId]);

  // When polling is re-enabled (for example, when the GitHub popover opens),
  // fetch immediately instead of waiting for the next interval tick.
  useEffect(() => {
    if (!enablePolling || !projectId) return;
    fetchStatus();
  }, [enablePolling, projectId, fetchStatus]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchStatus();
  }, [fetchStatus]);

  return { status, loading, error, refresh };
}

export default useGitStatus;
