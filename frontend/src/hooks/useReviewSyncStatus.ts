import { useEffect, useState } from 'react';
import { reviewSyncApi, type ReviewSyncLocalStatus } from '@/services/api';

const REVIEW_SYNC_POLL_MS = 30000;

export function useReviewSyncStatus() {
  const [status, setStatus] = useState<ReviewSyncLocalStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const next = await reviewSyncApi.getLocalStatus();
        if (!cancelled) {
          setStatus(next);
        }
      } catch (error: any) {
        if (cancelled) return;
        if (error?.response?.status === 404) {
          setStatus(null);
          return;
        }
        setStatus((current) => current ? {
          ...current,
          state: 'error',
          lastError: error?.message || 'Failed to load cloud sync status',
        } : {
          enabled: true,
          configured: false,
          serverUrl: null,
          userId: null,
          deviceId: null,
          pendingEvents: 0,
          state: 'error',
          lastSyncedAt: null,
          lastError: error?.message || 'Failed to load cloud sync status',
          lastAttemptAt: null,
        });
      }
    };

    loadStatus();
    const intervalId = window.setInterval(loadStatus, REVIEW_SYNC_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  return { status };
}

export default useReviewSyncStatus;
