import { test, expect } from '@playwright/test';

import { resolveGitHubApiAuthToken } from '../../services/githubAuthToken';

function installLocalStorageShim() {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, String(value)),
    },
  });
}

test.describe('githubApi auth', () => {
  test.beforeEach(() => {
    installLocalStorageShim();
    localStorage.clear();
  });

  test('prefers the review-sync session over a legacy auth token', () => {
    localStorage.setItem('auth_token', 'legacy-admin-token');
    localStorage.setItem('review_sync_auth_token', 'review-sync-token');

    expect(resolveGitHubApiAuthToken()).toBe('review-sync-token');
  });

  test('falls back to the legacy auth token when no review-sync session exists', () => {
    localStorage.setItem('auth_token', 'legacy-admin-token');

    expect(resolveGitHubApiAuthToken()).toBe('legacy-admin-token');
  });
});
