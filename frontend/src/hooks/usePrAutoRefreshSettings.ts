import { useCallback, useEffect, useState } from 'react';
import { settingsApi } from '@/services/api';

export interface PrAutoRefreshSettingsState {
  enabled: boolean;
  interval: string;
  loading: boolean;
}

type Snapshot = Omit<PrAutoRefreshSettingsState, 'loading'>;

const DEFAULT_SNAPSHOT: Snapshot = {
  enabled: false,
  interval: 'manual',
};

let cachedSnapshot: Snapshot | null = null;
let inFlightSnapshotPromise: Promise<Snapshot> | null = null;
const listeners = new Set<(snapshot: Snapshot) => void>();

function normalizeSnapshot(enabledValue: string | null, intervalValue: string | null): Snapshot {
  const normalizedEnabled = typeof enabledValue === 'string'
    ? enabledValue.trim().toLowerCase()
    : null;
  const truthy = normalizedEnabled != null && ['1', 'true', 'yes', 'on'].includes(normalizedEnabled);
  const falsy = normalizedEnabled != null && ['0', 'false', 'no', 'off'].includes(normalizedEnabled);
  return {
    enabled: falsy ? false : truthy ? true : DEFAULT_SNAPSHOT.enabled,
    interval: intervalValue || DEFAULT_SNAPSHOT.interval,
  };
}

function emitSnapshot(snapshot: Snapshot) {
  cachedSnapshot = snapshot;
  for (const listener of listeners) {
    listener(snapshot);
  }
}

async function fetchSnapshot(force = false): Promise<Snapshot> {
  if (!force && cachedSnapshot) return cachedSnapshot;
  if (!force && inFlightSnapshotPromise) return inFlightSnapshotPromise;

  inFlightSnapshotPromise = Promise.all([
    settingsApi.get('pr_auto_refresh_enabled'),
    settingsApi.get('pr_auto_refresh_interval'),
  ]).then(([enabledResult, intervalResult]) => {
    const snapshot = normalizeSnapshot(enabledResult.value, intervalResult.value);
    emitSnapshot(snapshot);
    return snapshot;
  }).catch(() => {
    if (!cachedSnapshot) {
      emitSnapshot(DEFAULT_SNAPSHOT);
      return DEFAULT_SNAPSHOT;
    }
    return cachedSnapshot;
  }).finally(() => {
    inFlightSnapshotPromise = null;
  });

  return inFlightSnapshotPromise;
}

export function usePrAutoRefreshSettings(active = true) {
  const [state, setState] = useState<PrAutoRefreshSettingsState>({
    ...(cachedSnapshot || DEFAULT_SNAPSHOT),
    loading: active && !cachedSnapshot,
  });

  useEffect(() => {
    if (!active) {
      setState((current) => ({ ...current, loading: false }));
      return undefined;
    }

    const handleSnapshot = (snapshot: Snapshot) => {
      setState({ ...snapshot, loading: false });
    };

    listeners.add(handleSnapshot);
    if (cachedSnapshot) {
      handleSnapshot(cachedSnapshot);
    } else {
      void fetchSnapshot();
    }

    return () => {
      listeners.delete(handleSnapshot);
    };
  }, [active]);

  const setEnabled = useCallback(async (nextEnabled: boolean) => {
    const previous = cachedSnapshot || {
      enabled: state.enabled,
      interval: state.interval,
    };
    emitSnapshot({
      ...previous,
      enabled: nextEnabled,
    });
    try {
      await settingsApi.set('pr_auto_refresh_enabled', String(nextEnabled));
    } catch (error) {
      emitSnapshot(previous);
      throw error;
    }
  }, [state.enabled, state.interval]);

  const setIntervalValue = useCallback(async (nextInterval: string) => {
    const previous = cachedSnapshot || {
      enabled: state.enabled,
      interval: state.interval,
    };
    emitSnapshot({
      ...previous,
      interval: nextInterval,
    });
    try {
      await settingsApi.set('pr_auto_refresh_interval', nextInterval);
    } catch (error) {
      emitSnapshot(previous);
      throw error;
    }
  }, [state.enabled, state.interval]);

  return {
    ...state,
    reload: () => fetchSnapshot(true),
    setEnabled,
    setIntervalValue,
  };
}
