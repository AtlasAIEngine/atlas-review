import { test, expect } from '@playwright/test';

import type { BranchReview, PrReview, ReviewRecommendation, WorkspaceReview } from '@/types';
import {
  buildRecommendationNoteDraft,
  buildProjectRecommendationNoteHistory,
  buildRecommendationNoteList,
  buildRecommendationNoteStorageKey,
  collectProjectRecommendationNoteStorageEntries,
  getRecommendationFingerprint,
  normalizeRecommendationNoteMap,
} from '../review/reviewPanelUtils';

function makeRecommendation(overrides: Partial<ReviewRecommendation> = {}): ReviewRecommendation {
  return {
    type: 'issue',
    severity: 'medium',
    title: 'Guard the null branch',
    description: 'The current branch can throw when source is null.',
    file: 'src/app.ts',
    line: 42,
    ...overrides,
  };
}

test.describe('review finding notes', () => {
  test('scopes note storage to branch and pr reviews only', () => {
    expect(buildRecommendationNoteStorageKey({
      projectId: 'proj-1',
      branchReviewId: 'br-7',
      branchName: 'feature/test-notes',
    })).toBe('atlas_review_finding_note:br:proj-1:feature/test-notes');

    expect(buildRecommendationNoteStorageKey({
      projectId: 'proj-1',
      branchReviewId: 'br-7',
    })).toBe('atlas_review_finding_note:br:proj-1:br-7');

    expect(buildRecommendationNoteStorageKey({
      projectId: 'proj-1',
      prReviewId: 'pr-7',
    })).toBe('atlas_review_finding_note:pr:proj-1:pr-7');

    expect(buildRecommendationNoteStorageKey({
      projectId: 'proj-1',
    })).toBeNull();
  });

  test('builds finding note drafts with persisted issue context', () => {
    const rec = makeRecommendation({
      sourceAnchor: {
        file: 'src/app.ts',
        line: 44,
        snippet: 'const value = source.trim();',
      },
    });

    const draft = buildRecommendationNoteDraft({
      rec,
      body: '  Needs product signoff before changing behavior  ',
      reviewType: 'branch_review',
      branchReviewId: 'br-1',
      branchName: 'feature/test-notes',
      reviewDisplayId: 'BR-001',
    });

    expect(draft).toMatchObject({
      id: getRecommendationFingerprint(rec),
      recommendationKey: getRecommendationFingerprint(rec),
      body: 'Needs product signoff before changing behavior',
      reviewType: 'branch_review',
      branchReviewId: 'br-1',
      branchName: 'feature/test-notes',
      reviewDisplayId: 'BR-001',
      findingTitle: 'Guard the null branch',
      findingType: 'issue',
      findingSeverity: 'medium',
      findingLocation: 'src/app.ts:44',
      findingSourceLocation: 'src/app.ts:44',
      findingDescription: 'The current branch can throw when source is null.',
      evidenceSnippet: 'const value = source.trim();',
    });
  });

  test('normalizes and marks saved finding notes stale when the finding disappears', () => {
    const rec = makeRecommendation();
    const key = getRecommendationFingerprint(rec);
    const notes = normalizeRecommendationNoteMap({
      [key]: {
        recommendationKey: key,
        body: '  Follow up after QA rerun  ',
        findingTitle: 'Guard the null branch',
        findingSeverity: 'medium',
        findingLocation: 'src/app.ts:42',
      },
      garbage: {
        recommendationKey: '',
        body: '   ',
      },
    });

    expect(notes).toEqual({
      [key]: {
        id: key,
        recommendationKey: key,
        body: 'Follow up after QA rerun',
        updatedAt: expect.any(String),
        findingTitle: 'Guard the null branch',
        findingSeverity: 'medium',
        findingLocation: 'src/app.ts:42',
      },
    });

    const list = buildRecommendationNoteList({
      notes,
      activeRecommendationKeys: [],
    });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      recommendationKey: key,
      active: false,
      staleReason: 'Finding is not present in the current review snapshot.',
    });
  });

  test('collects project-scoped finding note storage entries only', () => {
    const storage = {
      length: 3,
      key: (index: number) => [
        'atlas_review_finding_note:br:proj-1:feature/test-notes',
        'atlas_review_finding_note:pr:proj-2:pr-7',
        'atlas_review_private_note:br:proj-1:feature/test-notes',
      ][index] ?? null,
      getItem: (key: string) => {
        if (key === 'atlas_review_finding_note:br:proj-1:feature/test-notes') {
          return JSON.stringify({
            foo: {
              recommendationKey: 'foo',
              body: 'Keep',
              findingTitle: 'Saved finding',
            },
          });
        }
        if (key === 'atlas_review_finding_note:pr:proj-2:pr-7') {
          return JSON.stringify({
            bar: {
              recommendationKey: 'bar',
              body: 'Ignore other project',
            },
          });
        }
        return null;
      },
    };

    const entries = collectProjectRecommendationNoteStorageEntries({
      projectId: 'proj-1',
      storage,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      storageKey: 'atlas_review_finding_note:br:proj-1:feature/test-notes',
      notes: {
        foo: expect.objectContaining({
          recommendationKey: 'foo',
          body: 'Keep',
        }),
      },
    });
  });

  test('builds project-wide finding note history across branch, workspace, and pr reviews', () => {
    const branchEntryKey = 'atlas_review_finding_note:br:proj-1:feature/test-notes';
    const workspaceEntryKey = 'atlas_review_finding_note:ws:proj-1:ws-3';
    const prEntryKey = 'atlas_review_finding_note:pr:proj-1:pr-7';

    const history = buildProjectRecommendationNoteHistory({
      projectId: 'proj-1',
      storageEntries: [
        {
          storageKey: branchEntryKey,
          notes: normalizeRecommendationNoteMap({
            branchFinding: {
              recommendationKey: 'branchFinding',
              body: 'Recheck after local QA',
              reviewType: 'branch_review',
              branchName: 'feature/test-notes',
              branchReviewId: 'br-9',
              reviewDisplayId: 'BR-9',
              findingTitle: 'Branch issue',
              findingSeverity: 'high',
              findingLocation: 'src/player.ts:18-20',
            },
          }),
        },
        {
          storageKey: workspaceEntryKey,
          notes: normalizeRecommendationNoteMap({
            wsFinding: {
              recommendationKey: 'wsFinding',
              body: 'Workspace note',
              reviewType: 'workspace_review',
              workspaceReviewId: 'ws-3',
              reviewDisplayId: 'WS-3',
              findingTitle: 'Workspace issue',
              findingSeverity: 'medium',
              findingSourceLocation: 'src/workspace.ts:9',
            },
          }),
        },
        {
          storageKey: prEntryKey,
          notes: normalizeRecommendationNoteMap({
            prFinding: {
              recommendationKey: 'prFinding',
              body: 'Follow up with author',
              reviewType: 'pr_review',
              prReviewId: 'pr-7',
              githubPrNumber: 42,
              prHtmlUrl: 'https://github.com/example/repo/pull/42',
              reviewTitle: 'Fix player facing',
              findingTitle: 'PR issue',
              findingSeverity: 'low',
              findingLocation: 'src/pr.ts:44',
            },
          }),
        },
      ],
      branchReviews: [
        {
          id: 'br-9',
          branchName: 'feature/test-notes',
          baseBranch: 'main',
          displayId: 'BR-9',
        } as BranchReview,
      ],
      workspaceReviews: [
        {
          id: 'ws-3',
          branchName: 'feature/workspace',
          baseBranch: 'main',
          displayId: 'WS-3',
        } as WorkspaceReview,
      ],
      prReviews: [
        {
          id: 'pr-7',
          githubPrNumber: 42,
          htmlUrl: 'https://github.com/example/repo/pull/42',
          title: 'Fix player facing',
        } as PrReview,
      ],
      localBranchNames: ['feature/test-notes'],
    });

    expect(history).toHaveLength(3);
    expect(history.find((entry) => entry.findingTitle === 'Branch issue')).toMatchObject({
      reviewType: 'branch_review',
      reviewAvailable: true,
      reviewId: 'br-9',
      sourceLabel: 'feature/test-notes',
      locationLabel: 'src/player.ts:18-20',
      navigationFilePath: 'src/player.ts',
      navigationLine: 18,
      stale: false,
    });
    expect(history.find((entry) => entry.findingTitle === 'Workspace issue')).toMatchObject({
      reviewType: 'workspace_review',
      reviewAvailable: true,
      reviewId: 'ws-3',
      sourceLabel: 'WS-3',
      navigationFilePath: 'src/workspace.ts',
      navigationLine: 9,
      stale: false,
    });
    expect(history.find((entry) => entry.findingTitle === 'PR issue')).toMatchObject({
      reviewType: 'pr_review',
      reviewAvailable: true,
      reviewId: 'pr-7',
      sourceLabel: 'PR #42',
      sourceMeta: 'Fix player facing',
      navigationFilePath: 'src/pr.ts',
      navigationLine: 44,
      stale: false,
    });
  });

  test('marks branch finding notes historical when the branch no longer exists locally', () => {
    const history = buildProjectRecommendationNoteHistory({
      projectId: 'proj-1',
      storageEntries: [
        {
          storageKey: 'atlas_review_finding_note:br:proj-1:feature/missing',
          notes: normalizeRecommendationNoteMap({
            missingBranch: {
              recommendationKey: 'missingBranch',
              body: 'Still important',
              reviewType: 'branch_review',
              branchName: 'feature/missing',
              branchReviewId: 'br-2',
              reviewDisplayId: 'BR-2',
              findingTitle: 'Missing branch issue',
              findingLocation: 'src/missing.ts:7',
            },
          }),
        },
      ],
      branchReviews: [
        {
          id: 'br-2',
          branchName: 'feature/missing',
          baseBranch: 'main',
          displayId: 'BR-2',
        } as BranchReview,
      ],
      localBranchNames: ['feature/other'],
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      reviewAvailable: false,
      reviewId: null,
      stale: true,
      staleReason: 'Branch no longer exists locally',
    });
  });
});
