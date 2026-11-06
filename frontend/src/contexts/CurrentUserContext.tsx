import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchReviewSync, ensureGuestSyncSession } from '@/services/api';
import { GITHUB_CONNECTION_CHANGED_EVENT } from '@/constants/githubEvents';

export interface CurrentUser {
  userId: string;
  email: string | null;
  github_login: string | null;
  github_avatar_url: string | null;
  isGuest: boolean;
}

interface CurrentUserContextValue {
  user: CurrentUser | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<CurrentUser | null>;
  /** Called after a successful sign-in to update the cached user + session auth token. */
  onSignedIn: (next: { authToken?: string | null; user?: CurrentUser | null }) => void;
  /** Calls /github/unlink and refreshes the user state. */
  signOut: () => Promise<void>;
}

const CurrentUserContext = createContext<CurrentUserContextValue | null>(null);

interface ProviderProps {
  children: ReactNode;
}

export function CurrentUserProvider({ children }: ProviderProps) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const refresh = useCallback(async (): Promise<CurrentUser | null> => {
    setLoading(true);
    setError(null);
    try {
      await ensureGuestSyncSession();
      const result = await fetchReviewSync<{ success: boolean; user: CurrentUser }>('/review-sync/me');
      const next = result?.user || null;
      setUser(next);
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || 'Failed to load user');
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const onSignedIn = useCallback(
    ({ user: nextUser }: { authToken?: string | null; user?: CurrentUser | null }) => {
      if (nextUser) {
        setUser(nextUser);
      } else {
        void refresh();
      }
    },
    [refresh]
  );

  const signOut = useCallback(async () => {
    try {
      await fetchReviewSync('/review-sync/github/unlink', { method: 'POST' });
    } catch {
      // Even if the server call fails, refresh to reflect local truth.
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleGitHubConnectionChanged = () => {
      void refresh();
    };
    window.addEventListener(GITHUB_CONNECTION_CHANGED_EVENT, handleGitHubConnectionChanged);
    return () => {
      window.removeEventListener(GITHUB_CONNECTION_CHANGED_EVENT, handleGitHubConnectionChanged);
    };
  }, [refresh]);

  const value = useMemo<CurrentUserContextValue>(
    () => ({ user, loading, error, refresh, onSignedIn, signOut }),
    [user, loading, error, refresh, onSignedIn, signOut]
  );

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserContextValue {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) {
    throw new Error('useCurrentUser must be used within a CurrentUserProvider');
  }
  return ctx;
}
