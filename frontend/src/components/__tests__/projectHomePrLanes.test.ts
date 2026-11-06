import { test, expect } from '@playwright/test';

import {
  buildProjectHomePrLanes,
  selectPrimaryGitHubUserLogin,
} from '../projectHomePrLanes';
import type { PRCardData } from '../review/PRCard';

function pr(overrides: Partial<PRCardData> & Pick<PRCardData, 'id' | 'author'>): PRCardData {
  return {
    repo: 'project',
    repoLabel: 'Project',
    number: 1,
    title: 'Test PR',
    additions: 0,
    deletions: 0,
    relativeTime: '1h',
    high: 0,
    med: 0,
    low: 0,
    status: 'open',
    ...overrides,
  };
}

test.describe('ProjectHome PR lanes', () => {
  test('prefers the newest connected GitHub user over a stale signed-in profile', () => {
    expect(selectPrimaryGitHubUserLogin(['avinash-atlas', 'AvinashP'], 'AvinashP')).toBe('avinash-atlas');
  });

  test('does not place stale self-authored PRs in Your PRs after account switch', () => {
    const lanes = buildProjectHomePrLanes({
      primaryGitHubUserLogin: 'avinash-atlas',
      matchesPrSearch: () => true,
      prCards: [
        pr({ id: 'old-account-pr', author: 'AvinashP', isSelfAuthored: true }),
        pr({ id: 'new-account-pr', author: 'avinash-atlas' }),
        pr({ id: 'review-request', author: 'teammate', requestedReviewers: ['avinash-atlas'] }),
      ],
    });

    expect(lanes.yours.map((item) => item.id)).toEqual(['new-account-pr']);
    expect(lanes.ready.map((item) => item.id)).toEqual(['review-request']);
    expect(lanes.others.map((item) => item.id)).toEqual(['old-account-pr']);
  });
});
