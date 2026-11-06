import { test, expect } from '@playwright/test';

import type { GitHubInstallation } from '../../services/githubApi';
import { findNewInstallations } from '../githubConnectUtils';

function buildInstallation(overrides: Partial<GitHubInstallation> = {}): GitHubInstallation {
  return {
    id: 'integration-1',
    installationId: 123,
    accountLogin: 'AtlasAIEngine',
    accountType: 'Organization',
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

test.describe('githubConnectUtils', () => {
  test('findNewInstallations ignores refreshed existing accounts', () => {
    const previous = [
      buildInstallation({
        tokenExpiresAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }),
    ];
    const updated = [
      buildInstallation({
        tokenExpiresAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-01T00:05:00.000Z',
      }),
    ];

    expect(findNewInstallations(previous, updated)).toEqual([]);
  });

  test('findNewInstallations returns only genuinely new accounts', () => {
    const previous = [buildInstallation()];
    const updated = [
      buildInstallation({
        tokenExpiresAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-01T00:05:00.000Z',
      }),
      buildInstallation({
        id: 'integration-2',
        installationId: 456,
        accountLogin: 'AnotherOrg',
      }),
    ];

    expect(findNewInstallations(previous, updated)).toEqual([
      expect.objectContaining({
        installationId: 456,
        accountLogin: 'AnotherOrg',
      }),
    ]);
  });
});
