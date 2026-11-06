const REVIEW_SYNC_AUTH_TOKEN_STORAGE_KEY = 'review_sync_auth_token';

function getStoredToken(key: string): string | null {
  try {
    const token = localStorage.getItem(key);
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function getReviewSyncAuthToken(): string | null {
  return getStoredToken(REVIEW_SYNC_AUTH_TOKEN_STORAGE_KEY);
}

function getLegacyAuthToken(): string | null {
  return getStoredToken('auth_token');
}

export function resolveGitHubApiAuthToken(): string | null {
  return getReviewSyncAuthToken() || getLegacyAuthToken();
}
