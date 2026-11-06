import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../githubService.js', () => ({
  default: {
    getPullRequestFiles: vi.fn(),
    submitPullRequestReview: vi.fn(),
  },
}));

vi.mock('../reviewOutcomeService.js', async () => {
  const actual = await vi.importActual('../reviewOutcomeService.js');
  return {
    default: {
      ...actual.default,
      listOutcomes: vi.fn(),
    },
  };
});

vi.mock('../reviewPublicationService.js', () => ({
  REVIEW_DECISION_PUBLICATION_KEY: '__review_decision__',
  default: {
    listPublications: vi.fn(),
    upsertPublication: vi.fn(),
  },
}));

import githubService from '../githubService.js';
import reviewOutcomeService from '../reviewOutcomeService.js';
import reviewPublicationService from '../reviewPublicationService.js';
import prReviewPublishService from '../prReviewPublishService.js';

describe('prReviewPublishService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewOutcomeService.listOutcomes.mockResolvedValue({
      byRecommendationKey: {},
      outcomes: [],
      telemetry: {},
    });
    reviewPublicationService.listPublications.mockResolvedValue({
      byRecommendationKey: {},
      publications: [],
      totalPublished: 0,
      latestAction: null,
    });
    reviewPublicationService.upsertPublication.mockResolvedValue({
      recommendationKey: 'issue|high|fix the bug|there is a bug.|src/example.ts|12|',
      action: 'request_changes',
      githubReviewId: '2001',
    });
    githubService.getPullRequestFiles.mockResolvedValue([
      {
        filename: 'src/example.ts',
        patch: '@@ -10,3 +10,4 @@\n context\n-old line\n+new line\n another line',
      },
    ]);
    githubService.submitPullRequestReview.mockResolvedValue({
      event: 'REQUEST_CHANGES',
      githubReviewId: '2001',
      htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-1',
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-03-09T12:00:00.000Z',
    });
  });

  it('publishes comment-eligible recommendations and skips unsupported anchors', async () => {
    const publishedRecommendation = {
      type: 'issue',
      severity: 'high',
      title: 'Fix the bug',
      description: 'There is a bug.',
      file: 'src/example.ts',
      line: 12,
      patchAnchor: { file: 'src/example.ts', line: 12, startLine: 12, endLine: 12, status: 'exact' },
      commentEligible: true,
    };
    const skippedRecommendation = {
      type: 'issue',
      severity: 'medium',
      title: 'Missing anchor',
      description: 'The issue points outside the diff.',
      file: 'src/example.ts',
      line: 99,
      commentEligible: true,
    };
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [publishedRecommendation, skippedRecommendation],
      },
    };

    const result = await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'request_changes',
      recommendationKeys: [],
      body: undefined,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'REQUEST_CHANGES',
        body: expect.stringContaining('Atlas requested changes and posted 1 inline finding for this pull request.'),
        commitId: 'abc123',
        comments: [
          expect.objectContaining({
            path: 'src/example.ts',
            line: 12,
            side: 'RIGHT',
          }),
        ],
      })
    );
    expect(reviewPublicationService.upsertPublication).toHaveBeenCalledTimes(3);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'published',
        line: 12,
      }),
      expect.objectContaining({
        status: 'published',
        line: 99,
      }),
    ]));
    expect(result.publication.totalPublished).toBe(0);
  });

  it('publishes legacy recommendations in the PR review body when no exact patch anchor exists', async () => {
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Legacy inline anchor',
            description: 'Still has only file + line.',
            file: 'src/example.ts',
            line: 12,
            commentEligible: true,
          },
        ],
      },
    };

    const result = await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      body: undefined,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        comments: [],
        body: expect.stringContaining('Additional findings: 1'),
      }),
    );
    const body = githubService.submitPullRequestReview.mock.calls[0][4].body;
    expect(body).toContain('**[HIGH] Legacy inline anchor**');
    expect(body).toContain('Still has only file + line.');
    expect(body).toContain('Source: `src/example.ts:12`');
  });

  it('publishes source-line findings inline when stale patch metadata says the file is outside the diff', async () => {
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'medium',
            title: 'Stale patch status',
            description: 'The source line is still present in the live PR patch.',
            file: 'src/example.ts',
            line: 12,
            patchAnchor: {
              file: 'src/example.ts',
              line: null,
              startLine: null,
              endLine: null,
              status: 'file_not_in_diff',
            },
            commentEligible: false,
          },
        ],
      },
    };

    const result = await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      body: undefined,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        body: expect.stringContaining('Atlas posted 1 inline finding for this pull request.'),
        comments: [
          expect.objectContaining({
            path: 'src/example.ts',
            line: 12,
            side: 'RIGHT',
          }),
        ],
      }),
    );
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recommendationKey: 'issue|medium|stale patch status|the source line is still present in the live pr patch.|src/example.ts|12|',
        status: 'published',
        line: 12,
      }),
    ]));
  });

  it('publishes manual line comments alongside an explicit empty recommendation selection', async () => {
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [],
      },
    };

    const result = await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      useExplicitRecommendationSelection: true,
      manualLineComments: [
        {
          id: 'lc_test_manual',
          path: 'src/example.ts',
          line: 12,
          side: 'LEFT',
          body: 'Please rename this variable before merging.',
        },
      ],
      body: undefined,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        comments: [
          expect.objectContaining({
            path: 'src/example.ts',
            line: 12,
            side: 'LEFT',
            body: 'Please rename this variable before merging.',
          }),
        ],
      })
    );
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recommendationKey: 'lc_test_manual',
        manualLineCommentId: 'lc_test_manual',
        status: 'published',
        line: 12,
      }),
    ]));
  });

  it('publishes against patchAnchor.file for renamed or moved files when the patch anchor is exact', async () => {
    githubService.getPullRequestFiles.mockResolvedValueOnce([
      {
        filename: 'src/renamed-example.ts',
        patch: '@@ -10,3 +10,4 @@\n context\n-old line\n+new line\n another line',
      },
    ]);
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Renamed file anchor',
            description: 'Uses patch file path.',
            file: 'src/example.ts',
            line: 12,
            patchAnchor: { file: 'src/renamed-example.ts', line: 12, status: 'exact' },
            commentEligible: true,
          },
        ],
      },
    };

    const result = await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      body: undefined,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        comments: [
          expect.objectContaining({
            path: 'src/renamed-example.ts',
            line: 12,
          }),
        ],
      })
    );
  });

  it('publishes fuzzy patch anchors in the review body while keeping inline comments exact-only', async () => {
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'medium',
            title: 'Nearby fuzzy anchor',
            description: 'This should not publish inline.',
            file: 'src/example.ts',
            line: 12,
            patchAnchor: {
              file: 'src/example.ts',
              line: 12,
              startLine: 12,
              endLine: 12,
              status: 'nearby_unique_line',
            },
            commentEligible: true,
          },
          {
            type: 'issue',
            severity: 'medium',
            title: 'Partial fuzzy block',
            description: 'This should not publish inline either.',
            file: 'src/example.ts',
            line: 12,
            patchAnchor: {
              file: 'src/example.ts',
              line: 12,
              startLine: 11,
              endLine: 12,
              status: 'partial_block',
            },
            commentEligible: true,
          },
        ],
      },
    };

    const result = await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      body: undefined,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        comments: [],
        body: expect.stringContaining('Additional findings: 2'),
      }),
    );
    const body = githubService.submitPullRequestReview.mock.calls[0][4].body;
    expect(body).toContain('**[MEDIUM] Nearby fuzzy anchor**');
    expect(body).toContain('**[MEDIUM] Partial fuzzy block**');
    expect(body).toContain('Source: `src/example.ts:12`');
    expect(reviewPublicationService.upsertPublication).toHaveBeenCalledTimes(3);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recommendationKey: 'issue|medium|nearby fuzzy anchor|this should not publish inline.|src/example.ts|12|',
        status: 'published',
        line: 12,
      }),
      expect.objectContaining({
        recommendationKey: 'issue|medium|partial fuzzy block|this should not publish inline either.|src/example.ts|12|',
        status: 'published',
        line: 12,
      }),
    ]));
  });

  it('publishes anchored findings inline even when commentEligible is false', async () => {
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Manual publish should still inline this',
            description: 'The finding has a valid anchor but was not pre-marked comment eligible.',
            file: 'src/example.ts',
            line: 12,
            patchAnchor: { file: 'src/example.ts', line: 12, startLine: 12, endLine: 12, status: 'exact' },
            commentEligible: false,
          },
        ],
      },
    };

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      body: undefined,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        body: expect.stringContaining('💡 **Atlas Review**'),
        comments: [
          expect.objectContaining({
            path: 'src/example.ts',
            line: 12,
            side: 'RIGHT',
          }),
        ],
      })
    );
  });

  it('publishes Atlas finding text with the user-authored comment appended and bypasses same-head dedupe when requested', async () => {
    const recommendationKey = 'issue|high|manual publish should still inline this|the finding has a valid anchor but was not pre-marked comment eligible.|src/example.ts|12|';
    reviewPublicationService.listPublications.mockResolvedValueOnce({
      byRecommendationKey: {
        [recommendationKey]: {
          recommendationKey,
          action: 'comment',
          headSha: 'abc123',
        },
      },
      publications: [
        {
          recommendationKey,
          action: 'comment',
          headSha: 'abc123',
        },
      ],
      totalPublished: 1,
      latestAction: 'comment',
    });
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Manual publish should still inline this',
            description: 'The finding has a valid anchor but was not pre-marked comment eligible.',
            file: 'src/example.ts',
            line: 12,
            patchAnchor: { file: 'src/example.ts', line: 12, startLine: 12, endLine: 12, status: 'exact' },
            commentEligible: false,
          },
        ],
      },
    };

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [recommendationKey],
      body: null,
      commentOverridesByRecommendationKey: {
        [recommendationKey]: 'Please dispose this subscription in OnDestroy.',
      },
      skipExistingPublicationCheck: true,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        body: null,
        comments: [
          expect.objectContaining({
            path: 'src/example.ts',
            line: 12,
            body: expect.stringContaining('**[HIGH] Manual publish should still inline this**'),
          }),
        ],
      })
    );
    expect(githubService.submitPullRequestReview.mock.calls[0][4].comments[0].body).toContain('**Reviewer comment**');
    expect(githubService.submitPullRequestReview.mock.calls[0][4].comments[0].body).toContain('Please dispose this subscription in OnDestroy.');
  });

  it('does not omit the generated review body when no explicit body is provided', () => {
    expect(prReviewPublishService.__testing.shouldOmitGeneratedReviewBody({
      explicitBodyProvided: false,
    })).toBe(false);

    expect(prReviewPublishService.__testing.shouldOmitGeneratedReviewBody({
      explicitBodyProvided: false,
    })).toBe(false);

    expect(prReviewPublishService.__testing.shouldOmitGeneratedReviewBody({
      explicitBodyProvided: true,
    })).toBe(true);
  });

  it('builds a compact top-level Atlas comment with collapsible summary', () => {
    const body = prReviewPublishService.__testing.buildCommentReviewBody({
      prReview: {
        reviewSummary: 'Top risks: Patrol commander UI handler can remain null.',
        reviewJson: {
          stats: {
            filesTotal: 14,
            filesAnalyzed: 14,
            omittedFiles: 0,
          },
        },
      },
      publishedCount: 5,
      skippedResults: [{ reason: 'missing_location' }],
    });

    expect(body).toContain('💡 **Atlas Review**');
    expect(body).toContain('Atlas posted 5 inline findings for this pull request.');
    expect(body).toContain('Coverage: 14 analyzed · 0 omitted');
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>Review summary</summary>');
    expect(body).toContain('- Inline findings: 5');
    expect(body).toContain('- Skipped findings: 1');
    expect(body).toContain('[Download Atlas on your machine](https://www.atlasengine.dev/)');
  });

  it('builds the same compact review format for request changes', () => {
    const body = prReviewPublishService.__testing.buildSubmissionBody({
      prReview: {
        reviewSummary: 'Top risks: Patrol commander UI handler can remain null.',
        reviewJson: {
          stats: {
            filesTotal: 14,
            filesAnalyzed: 14,
            omittedFiles: 0,
          },
        },
      },
      action: 'request_changes',
      publishedCount: 2,
      skippedResults: [],
    });

    expect(body).toContain('💡 **Atlas Review**');
    expect(body).toContain('Atlas requested changes and posted 2 inline findings for this pull request.');
    expect(body).toContain('Coverage: 14 analyzed · 0 omitted');
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>Review summary</summary>');
  });

  it('formats inline GitHub comments as readable markdown with fenced fixes', () => {
    const body = prReviewPublishService.__testing.buildRecommendationCommentBody({
      severity: 'high',
      title: 'Hole punch data path silently drops markers beyond the texture capacity',
      description: 'UIHolePunchBehaviour writes only `_textureSize * _textureSize` entries into `_colorData`. Impact: This may cause correctness, security, data integrity, or availability issues.',
      suggestedFix: 'var encodedCount = Mathf.Min(holePositions.Count, _colorData.Length);\nfor (var i = 0; i < _colorData.Length; i++)\n{\n  _colorData[i] = i < encodedCount ? new Color(0f, 0f, 0f) : new Color(0f, 0f, 0f, 0f);\n}',
      file: 'Assets/BLACK/MiniMap/Scripts/View/UIHolePunchBehaviour.cs',
    });

    expect(body).toContain('**[HIGH] Hole punch data path silently drops markers beyond the texture capacity**');
    expect(body).toContain('UIHolePunchBehaviour writes only');
    expect(body).not.toContain('This may cause correctness, security, data integrity, or availability issues');
    expect(body).toContain('**Suggested fix**');
    expect(body).toContain('```csharp');
    expect(body).toContain('var encodedCount = Mathf.Min');
  });

  it('formats non-inline findings as issue cards without anchor-specific wording', () => {
    const body = prReviewPublishService.__testing.buildSubmissionBody({
      prReview: {
        reviewSummary: 'Review summary',
        reviewJson: {
          stats: {
            filesTotal: 9,
            filesAnalyzed: 9,
            omittedFiles: 0,
          },
        },
      },
      action: 'comment',
      publishedCount: 1,
      skippedResults: [
        {
          reason: 'fuzzy_anchor',
          severity: 'high',
          title: 'Persisted/backend AA values are reinterpreted to different modes',
          description: '`graphicsSettings.AliasingType` is still cast directly from an int.',
          file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/Settings/Scripts/GraphicsSettingsData.cs',
          line: 29,
          suggestedFix: 'var remappedAliasingType = RemapLegacyAliasingValue(graphicsSettings.AliasingType);',
        },
      ],
    });

    expect(body).toContain('Additional findings: 1');
    expect(body).toContain('**[HIGH] Persisted/backend AA values are reinterpreted to different modes**');
    expect(body).toContain('Source: `Project_BLACK/BLACK_Unity/Assets/BLACK/Settings/Scripts/GraphicsSettingsData.cs:29`');
    expect(body).toContain('**Suggested fix**');
    expect(body).toContain('`var remappedAliasingType = RemapLegacyAliasingValue(graphicsSettings.AliasingType);`');
    expect(body).not.toContain('finding could not be anchored to an exact diff line');
  });

  it('builds published inline bodies by appending the reviewer comment to the Atlas finding', () => {
    const body = prReviewPublishService.__testing.buildPublishedRecommendationCommentBody(
      {
        severity: 'high',
        title: 'Null dereference risk',
        description: 'A null value can be dereferenced here.',
        suggestedFix: '',
        file: 'src/example.ts',
      },
      'Please add a null guard before reading the type.'
    );

    expect(body).toContain('**[HIGH] Null dereference risk**');
    expect(body).toContain('A null value can be dereferenced here.');
    expect(body).toContain('**Reviewer comment**');
    expect(body).toContain('Please add a null guard before reading the type.');
  });

  it('formats safe single-line fixes as GitHub suggestions', () => {
    const body = prReviewPublishService.__testing.buildPublishedRecommendationCommentBody(
      {
        severity: 'medium',
        title: 'Prefer nullish coalescing',
        description: 'This fallback should preserve empty-string values.',
        targetSnippet: 'const label = value || fallback;',
        suggestedFix: 'const label = value ?? fallback;',
        file: 'src/example.ts',
        patchLine: 12,
        patchStartLine: 12,
        patchEndLine: 12,
        patchStatus: 'exact',
      },
      '',
    );

    expect(body).toContain('**Suggested change**');
    expect(body).toContain('```suggestion');
    expect(body).toContain('const label = value ?? fallback;');
    expect(body).not.toContain('**Suggested fix**');
  });

  it('falls back to a normal suggested fix when no exact targetSnippet is available', () => {
    const body = prReviewPublishService.__testing.buildPublishedRecommendationCommentBody(
      {
        severity: 'medium',
        title: 'Prefer nullish coalescing',
        description: 'This fallback should preserve empty-string values.',
        suggestedFix: 'const label = value ?? fallback;',
        file: 'src/example.ts',
        patchLine: 12,
        patchStartLine: 12,
        patchEndLine: 12,
        patchStatus: 'exact',
      },
      '',
    );

    expect(body).toContain('**Suggested fix**');
    expect(body).not.toContain('```suggestion');
  });

  it('posts exact multi-line anchors with GitHub suggestion ranges', async () => {
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      baseSha: 'base123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Dispose both subscriptions in one teardown block',
            description: 'The paired subscriptions should be replaced together.',
            file: 'src/example.ts',
            line: 12,
            patchAnchor: {
              file: 'src/example.ts',
              line: 12,
              startLine: 11,
              endLine: 12,
              status: 'exact_block',
            },
            targetSnippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
            suggestedFix: '_contractFailedSignal?.Dispose();\n_contractStartedSignal?.Dispose();',
            commentEligible: true,
          },
        ],
      },
    };

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      body: undefined,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        comments: [
          expect.objectContaining({
            path: 'src/example.ts',
            line: 12,
            startLine: 11,
            startSide: 'RIGHT',
            body: expect.stringContaining('```suggestion'),
          }),
        ],
      }),
    );
  });

  it('does not submit a top-level PR comment when selected findings produce no inline comments', async () => {
    const recommendationKey = 'issue|high|fix the bug|there is a bug.|src/example.ts|12|';
    reviewPublicationService.listPublications.mockResolvedValueOnce({
      byRecommendationKey: {
        [recommendationKey]: {
          recommendationKey,
          action: 'comment',
          headSha: 'abc123',
        },
      },
      publications: [
        {
          recommendationKey,
          action: 'comment',
          headSha: 'abc123',
        },
      ],
      totalPublished: 1,
      latestAction: 'comment',
    });

    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Fix the bug',
            description: 'There is a bug.',
            file: 'src/example.ts',
            line: 12,
            commentEligible: true,
          },
        ],
      },
    };

    await expect(prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [recommendationKey],
      body: undefined,
    })).rejects.toMatchObject({
      code: 'ACTION_BLOCKED',
      statusCode: 409,
      blockedReason: expect.stringContaining('No new inline findings could be published'),
    });

    expect(githubService.submitPullRequestReview).not.toHaveBeenCalled();
  });

  it('does not submit a request-changes review when selected findings produce no inline comments', async () => {
    const recommendationKey = 'issue|high|fix the bug|there is a bug.|src/example.ts|12|';
    reviewPublicationService.listPublications.mockResolvedValueOnce({
      byRecommendationKey: {
        [recommendationKey]: {
          recommendationKey,
          action: 'comment',
          headSha: 'abc123',
        },
      },
      publications: [
        {
          recommendationKey,
          action: 'comment',
          headSha: 'abc123',
        },
      ],
      totalPublished: 1,
      latestAction: 'comment',
    });

    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Fix the bug',
            description: 'There is a bug.',
            file: 'src/example.ts',
            line: 12,
            commentEligible: true,
          },
        ],
      },
    };

    await expect(prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'request_changes',
      recommendationKeys: [recommendationKey],
      body: undefined,
    })).rejects.toMatchObject({
      code: 'ACTION_BLOCKED',
      statusCode: 409,
      blockedReason: expect.stringContaining('No new inline findings could be published'),
    });

    expect(githubService.submitPullRequestReview).not.toHaveBeenCalled();
  });

  it('blocks empty top-level PR comments before calling GitHub', async () => {
    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [],
      },
    };

    await expect(prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      body: null,
    })).rejects.toMatchObject({
      code: 'ACTION_BLOCKED',
      statusCode: 409,
      blockedReason: 'Add a comment before submitting.',
    });

    expect(githubService.submitPullRequestReview).not.toHaveBeenCalled();
  });

  it('blocks publishing when the review snapshot is not actionable', async () => {
    const prReview = {
      id: 'pr-1',
      githubPrNumber: 65,
      reviewStatus: 'reviewing',
      reviewedAt: null,
      updatedAt: '2026-03-09T12:00:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [],
      },
    };

    await expect(prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'comment',
      recommendationKeys: [],
      body: null,
    })).rejects.toMatchObject({
      code: 'ACTION_BLOCKED',
      statusCode: 409,
    });

    expect(githubService.submitPullRequestReview).not.toHaveBeenCalled();
  });

  it('allows free-form PR review actions before an AI review has run', async () => {
    githubService.submitPullRequestReview
      .mockResolvedValueOnce({
        event: 'COMMENT',
        githubReviewId: '3003',
        htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-3',
        state: 'COMMENTED',
        submittedAt: '2026-03-09T12:06:30.000Z',
      })
      .mockResolvedValueOnce({
        event: 'APPROVE',
        githubReviewId: '3004',
        htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-4',
        state: 'APPROVED',
        submittedAt: '2026-03-09T12:07:00.000Z',
      })
      .mockResolvedValueOnce({
        event: 'COMMENT',
        githubReviewId: '3005',
        htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-5',
        state: 'COMMENTED',
        submittedAt: '2026-03-09T12:08:00.000Z',
      });

    const unreviewedPr = {
      id: 'pr-1',
      githubPrNumber: 65,
      reviewStatus: 'none',
      headSha: 'head123',
      reviewedAt: null,
      updatedAt: '2026-03-09T12:00:00.000Z',
      reviewJson: null,
    };

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview: unreviewedPr,
      action: 'comment',
      recommendationKeys: [],
      body: 'Reviewing before Atlas has run.',
    });

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview: unreviewedPr,
      action: 'approve',
      recommendationKeys: [],
      body: null,
    });

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview: unreviewedPr,
      action: 'comment',
      recommendationKeys: [],
      body: undefined,
      useExplicitRecommendationSelection: true,
      manualLineComments: [{
        id: 'lc_unreviewed_manual',
        path: 'src/example.ts',
        line: 12,
        side: 'RIGHT',
        body: 'Please double-check this line before merge.',
      }],
    });

    expect(githubService.submitPullRequestReview).toHaveBeenNthCalledWith(
      1,
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        body: 'Reviewing before Atlas has run.',
        commitId: 'head123',
        comments: [],
      })
    );
    expect(githubService.submitPullRequestReview).toHaveBeenNthCalledWith(
      2,
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'APPROVE',
        body: null,
        commitId: 'head123',
        comments: [],
      })
    );
    expect(githubService.submitPullRequestReview).toHaveBeenNthCalledWith(
      3,
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        body: null,
        commitId: 'head123',
        comments: [
          expect.objectContaining({
            path: 'src/example.ts',
            line: 12,
            side: 'RIGHT',
            body: 'Please double-check this line before merge.',
          }),
        ],
      })
    );
  });

  it('allows stale reviews to comment, approve, and request changes', async () => {
    githubService.submitPullRequestReview
      .mockResolvedValueOnce({
        event: 'COMMENT',
        githubReviewId: '3003',
        htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-3',
        state: 'COMMENTED',
        submittedAt: '2026-03-09T12:06:30.000Z',
      })
      .mockResolvedValueOnce({
        event: 'APPROVE',
        githubReviewId: '3004',
        htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-4',
        state: 'APPROVED',
        submittedAt: '2026-03-09T12:07:00.000Z',
      })
      .mockResolvedValueOnce({
        event: 'REQUEST_CHANGES',
        githubReviewId: '3005',
        htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-5',
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-03-09T12:08:00.000Z',
      });

    const staleReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'def456',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T12:06:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [],
      },
    };

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview: staleReview,
      action: 'comment',
      recommendationKeys: [],
      body: 'Leaving a stale review comment because the current head still needs human attention.',
    });

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview: staleReview,
      action: 'approve',
      recommendationKeys: [],
      body: 'Approving stale review because only docs changed after the last run.',
    });

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview: staleReview,
      action: 'request_changes',
      recommendationKeys: [],
      body: 'Stale review still shows a correctness regression that should block merge.',
    });

    expect(githubService.submitPullRequestReview).toHaveBeenNthCalledWith(
      1,
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'COMMENT',
        body: 'Leaving a stale review comment because the current head still needs human attention.',
        commitId: 'def456',
      }),
    );
    expect(githubService.submitPullRequestReview).toHaveBeenNthCalledWith(
      2,
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'APPROVE',
        body: 'Approving stale review because only docs changed after the last run.',
        commitId: 'def456',
      }),
    );
    expect(githubService.submitPullRequestReview).toHaveBeenNthCalledWith(
      3,
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'REQUEST_CHANGES',
        body: 'Stale review still shows a correctness regression that should block merge.',
        commitId: 'def456',
      }),
    );
  });

  it('treats already-published findings as idempotent and still allows approve-only submission', async () => {
    const recommendationKey = 'issue|high|fix the bug|there is a bug.|src/example.ts|12|';
    githubService.submitPullRequestReview.mockResolvedValueOnce({
      event: 'APPROVE',
      githubReviewId: '3002',
      htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-2',
      state: 'APPROVED',
      submittedAt: '2026-03-09T12:05:00.000Z',
    });
    reviewPublicationService.listPublications
      .mockResolvedValueOnce({
        byRecommendationKey: {
          [recommendationKey]: {
            recommendationKey,
            action: 'comment',
            headSha: 'abc123',
          },
        },
        publications: [
          {
            recommendationKey,
            action: 'comment',
            headSha: 'abc123',
          },
        ],
        totalPublished: 1,
        latestAction: 'comment',
      })
      .mockResolvedValueOnce({
        byRecommendationKey: {
          [recommendationKey]: {
            recommendationKey,
            action: 'comment',
            headSha: 'abc123',
          },
        },
        publications: [
          {
            recommendationKey,
            action: 'comment',
            headSha: 'abc123',
          },
        ],
        totalPublished: 1,
        latestAction: 'comment',
      });

    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Fix the bug',
            description: 'There is a bug.',
            file: 'src/example.ts',
            line: 12,
            commentEligible: true,
          },
        ],
      },
    };

    const result = await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'approve',
      recommendationKeys: [recommendationKey],
      body: null,
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'APPROVE',
        commitId: 'abc123',
        comments: [],
      })
    );
    expect(reviewPublicationService.upsertPublication).toHaveBeenCalledWith(
      {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
      },
      expect.objectContaining({
        recommendationKey: '__review_decision__',
        action: 'approve',
        githubReviewId: '3002',
        headSha: 'abc123',
      })
    );
    expect(result.results).toEqual([
      expect.objectContaining({
        recommendationKey,
        status: 'already_published',
        reason: 'already_published_for_current_head',
      }),
    ]);
    expect(result.reviewSubmission).toEqual(expect.objectContaining({
      event: 'APPROVE',
      commentCount: 0,
    }));
  });

  it('treats an explicit blank body as approve without a summary comment', async () => {
    githubService.submitPullRequestReview.mockResolvedValueOnce({
      event: 'APPROVE',
      githubReviewId: '3003',
      htmlUrl: 'https://github.com/example/repo/pull/65#pullrequestreview-3',
      state: 'APPROVED',
      submittedAt: '2026-03-09T12:06:00.000Z',
    });

    const prReview = {
      id: 'pr-1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      reviewStatus: 'reviewed',
      reviewHeadSha: 'abc123',
      headSha: 'abc123',
      reviewedAt: '2026-03-09T11:59:00.000Z',
      updatedAt: '2026-03-09T11:59:00.000Z',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [],
      },
    };

    await prReviewPublishService.publishReview({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview,
      action: 'approve',
      recommendationKeys: [],
      body: '   ',
    });

    expect(githubService.submitPullRequestReview).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      65,
      expect.objectContaining({
        event: 'APPROVE',
        body: null,
        commitId: 'abc123',
        comments: [],
      })
    );
  });

  it('includes skipped finding details in the fallback review body', () => {
    const body = prReviewPublishService.__testing.buildSubmissionBody({
      prReview: {
        displayId: 'PR-001',
        githubPrNumber: 65,
        reviewSummary: 'Review summary',
      },
      action: 'comment',
      publishedCount: 0,
      skippedResults: [
        {
          title: 'Missing anchor',
          path: 'src/example.ts',
          line: 99,
          reason: 'anchor_unavailable',
        },
        {
          title: 'No location',
          reason: 'missing_location',
        },
      ],
    });

    expect(body).toContain('💡 **Atlas Review**');
    expect(body).toContain('Atlas posted 0 inline findings for this pull request.');
    expect(body).toContain('Coverage: 0 analyzed');
    expect(body).toContain('Skipped findings: 2');
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>Review summary</summary>');
  });
});
