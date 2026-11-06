import { expect, test } from '@playwright/test';

import type { GitHubInstallation } from '../../../services/githubApi';
import {
  invalidateConnectedGitHubAuthorCache,
  loadConnectedGitHubAuthorFrom,
} from '../manualLineCommentAuthorCache';

function buildInstallation(overrides: Partial<GitHubInstallation> = {}): GitHubInstallation {
  return {
    id: 'integration-1',
    installationId: 123,
    accountLogin: 'avinash-atlas',
    accountType: 'User',
    avatarUrl: 'https://example.com/avatar.png',
    isActive: true,
    tokenExpiresAt: '2026-04-01T00:00:00.000Z',
    reposCount: 1,
    repoAccessState: 'loaded',
    repoAccessMessage: null,
    permissions: {},
    createdAt: '2026-03-31T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

test.describe('loadConnectedGitHubAuthor', () => {
  test.afterEach(() => {
    invalidateConnectedGitHubAuthorCache();
  });

  test('does not permanently cache a transient installation load failure', async () => {
    let calls = 0;
    const loadInstallations = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('temporary GitHub outage');
      }
      return [buildInstallation()];
    };

    await expect(loadConnectedGitHubAuthorFrom(loadInstallations)).resolves.toBeNull();
    await expect(loadConnectedGitHubAuthorFrom(loadInstallations)).resolves.toEqual({
      login: 'avinash-atlas',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(calls).toBe(2);
  });

  test('keeps successful no-account lookups cached until invalidated', async () => {
    let calls = 0;
    const loadInstallations = async () => {
      calls += 1;
      return [];
    };

    await expect(loadConnectedGitHubAuthorFrom(loadInstallations)).resolves.toBeNull();
    await expect(loadConnectedGitHubAuthorFrom(loadInstallations)).resolves.toBeNull();
    expect(calls).toBe(1);

    invalidateConnectedGitHubAuthorCache();
    await expect(loadConnectedGitHubAuthorFrom(loadInstallations)).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  test('invalidation during an in-flight load does not commit stale data or clobber the next load', async () => {
    let resolveFirst: (value: GitHubInstallation[]) => void = () => {};
    let resolveSecond: (value: GitHubInstallation[]) => void = () => {};
    const firstResult = new Promise<GitHubInstallation[]>((resolve) => { resolveFirst = resolve; });
    const secondResult = new Promise<GitHubInstallation[]>((resolve) => { resolveSecond = resolve; });
    let calls = 0;
    const loadInstallations = () => {
      calls += 1;
      return calls === 1 ? firstResult : secondResult;
    };

    const firstCall = loadConnectedGitHubAuthorFrom(loadInstallations);
    invalidateConnectedGitHubAuthorCache();
    const secondCall = loadConnectedGitHubAuthorFrom(loadInstallations);
    expect(calls).toBe(2);

    resolveFirst([buildInstallation({ accountLogin: 'stale-user' })]);
    await firstCall;

    resolveSecond([buildInstallation({ accountLogin: 'fresh-user' })]);
    await expect(secondCall).resolves.toEqual({
      login: 'fresh-user',
      avatarUrl: 'https://example.com/avatar.png',
    });

    // A subsequent caller must see the fresh data (cache hit, no extra load).
    await expect(loadConnectedGitHubAuthorFrom(loadInstallations)).resolves.toEqual({
      login: 'fresh-user',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(calls).toBe(2);
  });
});
