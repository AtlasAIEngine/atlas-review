import type { GitHubInstallation } from '@/services/githubApi';

export type GitHubCommentAuthor = {
  login: string;
  avatarUrl: string | null;
};

export type GitHubInstallationsLoader = () => Promise<GitHubInstallation[]>;

let cachedConnectedGitHubAuthor: GitHubCommentAuthor | null | undefined;
let connectedGitHubAuthorPromise: Promise<GitHubCommentAuthor | null> | null = null;
// Bumped on every invalidation so an in-flight load that started before the
// invalidate cannot commit stale data or clobber a load that started after.
let cacheGeneration = 0;

export function invalidateConnectedGitHubAuthorCache(): void {
  cachedConnectedGitHubAuthor = undefined;
  connectedGitHubAuthorPromise = null;
  cacheGeneration += 1;
}

export async function loadConnectedGitHubAuthorFrom(
  loadInstallations: GitHubInstallationsLoader
): Promise<GitHubCommentAuthor | null> {
  if (cachedConnectedGitHubAuthor !== undefined) return cachedConnectedGitHubAuthor;
  if (connectedGitHubAuthorPromise) return connectedGitHubAuthorPromise;

  const startGeneration = cacheGeneration;
  const inFlight: Promise<GitHubCommentAuthor | null> = loadInstallations()
    .then((installations) => {
      const activeUserInstallation = installations.find((installation) => (
        installation.isActive && installation.accountType === 'User' && installation.accountLogin
      ));
      const anyUserInstallation = installations.find((installation) => (
        installation.accountType === 'User' && installation.accountLogin
      ));
      const installation = activeUserInstallation || anyUserInstallation || null;
      const author: GitHubCommentAuthor | null = installation
        ? {
            login: installation.accountLogin,
            avatarUrl: installation.avatarUrl || null,
          }
        : null;
      if (startGeneration === cacheGeneration) {
        cachedConnectedGitHubAuthor = author;
      }
      return author;
    })
    .catch(() => null)
    .finally(() => {
      if (connectedGitHubAuthorPromise === inFlight) {
        connectedGitHubAuthorPromise = null;
      }
    });

  connectedGitHubAuthorPromise = inFlight;
  return inFlight;
}

export function getCachedConnectedGitHubAuthor(): GitHubCommentAuthor | null {
  return cachedConnectedGitHubAuthor || null;
}
