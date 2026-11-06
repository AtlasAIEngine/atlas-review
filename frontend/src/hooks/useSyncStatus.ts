/**
 * useSyncStatus Hook
 * Fetches and subscribes to real-time GitHub sync status for a project.
 * Keeps UI state aligned with backend queue lifecycle snapshots.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import githubApi, {
  type ProjectSyncStatusResponse,
  type SyncLifecycleSnapshot,
  type SyncLifecycleState,
} from '@/services/githubApi';
import { getApiBaseUrl, getSocketAuth } from '@/services/api';

const ACTIVE_LIFECYCLE_STATES = new Set<SyncLifecycleState>(['queued', 'processing', 'retrying']);

interface SyncQueueSummary {
  total: number;
  queued: number;
  processing: number;
  retrying: number;
}

export interface SyncStatus {
  status: 'idle' | 'syncing' | 'synced' | 'error' | 'disabled';
  isSyncing: boolean;
  lastSyncAt: string | null;
  lastSyncSha: string | null;
  webhookConfigured: boolean;
  currentJob: {
    id: string;
    type: 'push' | 'pull';
    status: 'pending' | 'processing' | string;
    lifecycleState: SyncLifecycleState;
    retryCount: number;
    reason: string | null;
  } | null;
  lifecycle: SyncLifecycleSnapshot | null;
  lastOutcome: SyncLifecycleSnapshot | null;
  queue: SyncQueueSummary;
  maxRetries: number;
  message: string | null;
  error: string | null;
}

interface UseSyncStatusOptions {
  /** Whether to enable the hook (default: true) */
  enabled?: boolean;
}

interface UseSyncStatusResult {
  status: SyncStatus | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

function buildLifecycleMessage(lifecycle: SyncLifecycleSnapshot | null): string | null {
  if (!lifecycle) return null;

  if (lifecycle.state === 'queued') {
    return lifecycle.reason || 'Sync queued';
  }
  if (lifecycle.state === 'processing') {
    return lifecycle.reason || 'Sync in progress';
  }
  if (lifecycle.state === 'retrying') {
    const retryLabel = `Retry ${lifecycle.retry.count}/${lifecycle.retry.max}`;
    if (lifecycle.retry.nextAttemptAt) {
      return `${retryLabel} scheduled`;
    }
    return lifecycle.reason || retryLabel;
  }
  if (lifecycle.state === 'superseded') {
    return lifecycle.reason || 'Sync superseded by a newer commit';
  }
  if (lifecycle.state === 'failed') {
    return lifecycle.reason || 'Sync failed';
  }
  return lifecycle.reason || null;
}

function getFallbackSyncStatus(data: ProjectSyncStatusResponse): SyncStatus['status'] {
  const normalized = String(data.status || '').trim().toLowerCase();
  if (normalized === 'disabled') return 'disabled';
  if (normalized === 'syncing') return 'syncing';
  if (normalized === 'synced') return 'synced';
  if (normalized === 'error') return 'error';
  return 'idle';
}

function toSyncStatus(data: ProjectSyncStatusResponse, previous: SyncStatus | null): SyncStatus {
  const currentLifecycle = data.lifecycle?.current || data.currentJob?.lifecycle || null;
  const lastOutcome = data.lifecycle?.lastOutcome || previous?.lastOutcome || null;
  const queue = data.lifecycle?.pending || previous?.queue || {
    total: 0,
    queued: 0,
    processing: 0,
    retrying: 0,
  };

  const activeLifecycle = currentLifecycle && ACTIVE_LIFECYCLE_STATES.has(currentLifecycle.state)
    ? currentLifecycle
    : null;

  const fallbackStatus = getFallbackSyncStatus(data);
  const isSyncing = Boolean(
    activeLifecycle ||
    fallbackStatus === 'syncing' ||
    data.currentJob?.status === 'processing' ||
    data.currentJob?.status === 'pending'
  );

  let status: SyncStatus['status'] = fallbackStatus;
  if (!data.syncEnabled) {
    status = 'disabled';
  } else if (isSyncing) {
    status = 'syncing';
  } else if (
    currentLifecycle?.state === 'failed' ||
    lastOutcome?.state === 'failed' ||
    fallbackStatus === 'error'
  ) {
    status = 'error';
  } else if (
    currentLifecycle?.state === 'completed' ||
    currentLifecycle?.state === 'superseded' ||
    lastOutcome?.state === 'completed' ||
    lastOutcome?.state === 'superseded' ||
    fallbackStatus === 'synced'
  ) {
    status = 'synced';
  } else {
    status = 'idle';
  }

  const resolvedLastSyncAt = data.lastSyncAt
    || currentLifecycle?.timestamps?.completedAt
    || lastOutcome?.timestamps?.completedAt
    || previous?.lastSyncAt
    || null;
  const resolvedLastSyncSha = data.lastSyncSha
    || currentLifecycle?.commitSha
    || lastOutcome?.commitSha
    || previous?.lastSyncSha
    || null;

  const message = buildLifecycleMessage(activeLifecycle || currentLifecycle || lastOutcome);
  const error = status === 'error'
    ? (currentLifecycle?.reason || lastOutcome?.reason || previous?.error || null)
    : null;

  return {
    status,
    isSyncing,
    lastSyncAt: resolvedLastSyncAt,
    lastSyncSha: resolvedLastSyncSha,
    webhookConfigured: Boolean(data.webhookConfigured),
    currentJob: data.currentJob ? {
      id: data.currentJob.id,
      type: (data.currentJob.type === 'push' ? 'push' : 'pull'),
      status: data.currentJob.status,
      lifecycleState: data.currentJob.lifecycle?.state || (activeLifecycle?.state || 'queued'),
      retryCount: Number(data.currentJob.retryCount || 0),
      reason: data.currentJob.reason || null,
    } : null,
    lifecycle: activeLifecycle,
    lastOutcome,
    queue: {
      total: Number(queue.total || 0),
      queued: Number(queue.queued || 0),
      processing: Number(queue.processing || 0),
      retrying: Number(queue.retrying || 0),
    },
    maxRetries: Number(data.lifecycle?.maxRetries || previous?.maxRetries || 3),
    message,
    error,
  };
}

function applyLifecycleUpdate(
  previous: SyncStatus | null,
  lifecycle: SyncLifecycleSnapshot
): SyncStatus {
  const isActive = ACTIVE_LIFECYCLE_STATES.has(lifecycle.state);
  const isTerminal = lifecycle.state === 'completed' || lifecycle.state === 'failed' || lifecycle.state === 'superseded';

  const nextStatus: SyncStatus['status'] = isActive
    ? 'syncing'
    : lifecycle.state === 'failed'
      ? 'error'
      : lifecycle.state === 'completed' || lifecycle.state === 'superseded'
        ? 'synced'
        : (previous?.status || 'idle');

  return {
    status: nextStatus,
    isSyncing: isActive,
    lastSyncAt: lifecycle.timestamps.completedAt || previous?.lastSyncAt || null,
    lastSyncSha: lifecycle.commitSha || previous?.lastSyncSha || null,
    webhookConfigured: previous?.webhookConfigured || false,
    currentJob: isActive ? {
      id: lifecycle.jobId || 'sync-job',
      type: lifecycle.syncType === 'push' ? 'push' : 'pull',
      status: lifecycle.state === 'processing' ? 'processing' : 'pending',
      lifecycleState: lifecycle.state,
      retryCount: lifecycle.retry.count,
      reason: lifecycle.reason,
    } : null,
    lifecycle: isActive ? lifecycle : null,
    lastOutcome: isTerminal ? lifecycle : (previous?.lastOutcome || null),
    queue: previous?.queue || {
      total: 0,
      queued: 0,
      processing: 0,
      retrying: 0,
    },
    maxRetries: previous?.maxRetries || lifecycle.retry.max || 3,
    message: buildLifecycleMessage(lifecycle),
    error: lifecycle.state === 'failed' ? (lifecycle.reason || 'Sync failed') : null,
  };
}

export function useSyncStatus(
  projectId: string | null,
  options: UseSyncStatusOptions = {}
): UseSyncStatusResult {
  const { enabled = true } = options;

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const socketRef = useRef<Socket | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!projectId || !enabled) {
      setStatus(null);
      setLoading(false);
      return;
    }

    try {
      const data = await githubApi.getProjectSyncStatus(projectId);
      if (mountedRef.current) {
        setStatus((previous) => toSyncStatus(data, previous));
      }
    } catch (err: any) {
      if (mountedRef.current) {
        if (err.response?.status === 404) {
          setStatus({
            status: 'disabled',
            isSyncing: false,
            lastSyncAt: null,
            lastSyncSha: null,
            webhookConfigured: false,
            currentJob: null,
            lifecycle: null,
            lastOutcome: null,
            queue: {
              total: 0,
              queued: 0,
              processing: 0,
              retrying: 0,
            },
            maxRetries: 3,
            message: null,
            error: null,
          });
        } else {
          setStatus((previous) => previous ? {
            ...previous,
            status: 'error',
            isSyncing: false,
            lifecycle: null,
            message: null,
            error: err.response?.data?.error || err.message || 'Failed to fetch sync status',
          } : null);
        }
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [projectId, enabled]);

  const scheduleRefetch = useCallback((delayMs = 400) => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      fetchStatus();
    }, delayMs);
  }, [fetchStatus]);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    fetchStatus();

    return () => {
      mountedRef.current = false;
    };
  }, [fetchStatus]);

  // WebSocket subscription for real-time updates
  useEffect(() => {
    if (!projectId || !enabled) {
      return;
    }

    const wsUrl = getApiBaseUrl().replace(/\/api$/, '');
    const socket = io(wsUrl, {
      transports: ['websocket'],
      auth: getSocketAuth(),
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join-project', projectId);
      scheduleRefetch(0);
    });

    const onLifecycle = (payload: any) => {
      const lifecycle = payload?.lifecycle || payload;
      if (!lifecycle || lifecycle.projectId !== projectId) return;
      setStatus((previous) => applyLifecycleUpdate(previous, lifecycle));
      scheduleRefetch();
    };

    socket.on('sync-lifecycle', onLifecycle);
    socket.on('sync-queued', onLifecycle);
    socket.on('sync-retrying', onLifecycle);
    socket.on('sync-started', onLifecycle);
    socket.on('sync-complete', onLifecycle);
    socket.on('sync-error', onLifecycle);

    return () => {
      socket.off('sync-lifecycle', onLifecycle);
      socket.off('sync-queued', onLifecycle);
      socket.off('sync-retrying', onLifecycle);
      socket.off('sync-started', onLifecycle);
      socket.off('sync-complete', onLifecycle);
      socket.off('sync-error', onLifecycle);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [projectId, enabled, scheduleRefetch]);

  // Poll fallback while sync is active (covers missed socket updates)
  useEffect(() => {
    if (!projectId || !enabled || !status?.isSyncing) {
      return;
    }

    const interval = window.setInterval(() => {
      fetchStatus();
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [projectId, enabled, status?.isSyncing, fetchStatus]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const refetch = useCallback(async () => {
    setLoading(true);
    await fetchStatus();
  }, [fetchStatus]);

  return { status, loading, refetch };
}

export default useSyncStatus;
