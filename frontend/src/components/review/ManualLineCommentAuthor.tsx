import { useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import { GITHUB_CONNECTION_CHANGED_EVENT } from '@/constants/githubEvents';
import githubApi from '@/services/githubApi';
import {
  getCachedConnectedGitHubAuthor,
  invalidateConnectedGitHubAuthorCache,
  loadConnectedGitHubAuthorFrom,
  type GitHubCommentAuthor,
} from './manualLineCommentAuthorCache';

export async function loadConnectedGitHubAuthor(): Promise<GitHubCommentAuthor | null> {
  return loadConnectedGitHubAuthorFrom(() => githubApi.getInstallations({ summary: true }));
}

export function ManualLineCommentAuthor({ line }: { line?: number | null }) {
  const { user } = useCurrentUser();
  const [connectedGitHubAuthor, setConnectedGitHubAuthor] = useState<GitHubCommentAuthor | null>(
    getCachedConnectedGitHubAuthor()
  );
  const [authorRefreshNonce, setAuthorRefreshNonce] = useState(0);
  const currentUserAuthor = useMemo<GitHubCommentAuthor | null>(() => {
    if (!user || user.isGuest) return null;
    const login = user.github_login || user.email || '';
    if (!login) return null;
    return {
      login,
      avatarUrl: user.github_avatar_url || null,
    };
  }, [user]);
  const author = connectedGitHubAuthor || currentUserAuthor;
  const label = author?.login || 'You';
  const avatarUrl = author?.avatarUrl || null;
  const initial = String(label || 'Y').slice(0, 1).toUpperCase();

  useEffect(() => {
    if (connectedGitHubAuthor) return;
    let cancelled = false;
    loadConnectedGitHubAuthor().then((nextAuthor) => {
      if (!cancelled) setConnectedGitHubAuthor(nextAuthor);
    });
    return () => {
      cancelled = true;
    };
  }, [authorRefreshNonce, connectedGitHubAuthor]);

  useEffect(() => {
    const handleGitHubConnectionChanged = () => {
      invalidateConnectedGitHubAuthorCache();
      setConnectedGitHubAuthor(null);
      setAuthorRefreshNonce((value) => value + 1);
    };

    window.addEventListener(GITHUB_CONNECTION_CHANGED_EVENT, handleGitHubConnectionChanged);
    return () => {
      window.removeEventListener(GITHUB_CONNECTION_CHANGED_EVENT, handleGitHubConnectionChanged);
    };
  }, []);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 'var(--space-2)',
      fontFamily: 'var(--font-sans)',
    }}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          width={24}
          height={24}
          style={{
            display: 'block',
            width: 24,
            height: 24,
            borderRadius: '50%',
            flex: '0 0 auto',
            background: 'var(--bg-hover)',
          }}
        />
      ) : (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: '50%',
          flex: '0 0 auto',
          background: 'var(--bg-hover)',
          color: 'var(--text-secondary)',
          fontSize: 11,
          fontWeight: 700,
        }}>
          {initial}
        </span>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          minWidth: 0,
          flexWrap: 'wrap',
        }}>
          <span style={{
            color: 'var(--text-primary)',
            fontSize: 12,
            fontWeight: 700,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 180,
          }}>
            {label}
          </span>
          <span style={{
            color: 'var(--text-tertiary)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            Your line comment{line ? ` · L${line}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
