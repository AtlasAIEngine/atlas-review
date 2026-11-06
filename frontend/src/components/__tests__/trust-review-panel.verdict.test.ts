import { test, expect } from '@playwright/test';

import {
  buildReviewOutcomeProgress,
  buildPrCommentSelectionItems,
  getReviewCoverageStats,
  getReviewDiffScopeSummary,
  getRecommendationEvidencePreview,
  getRecommendationEvidenceFocus,
  getRecommendationSuggestedFixPreview,
  buildRecommendationTriageSummary,
  sanitizeRecommendationDescription,
} from '../review/reviewPanelUtils';

test.describe('review panel verdict helpers', () => {
  test('builds deterministic resolution progress for actionable findings', () => {
    expect(buildReviewOutcomeProgress(5, 2, 1)).toEqual({
      total: 5,
      addressed: 2,
      dismissed: 1,
      resolvedCount: 3,
      unresolvedCount: 2,
      percent: 60,
      label: '3/5 resolved',
    });

    expect(buildReviewOutcomeProgress(0, 4, 1)).toEqual({
      total: 0,
      addressed: 4,
      dismissed: 1,
      resolvedCount: 0,
      unresolvedCount: 0,
      percent: 0,
      label: 'No findings',
    });
  });

  test('prefers evidence snippets and clips preview to three lines', () => {
    const preview = getRecommendationEvidencePreview({
      evidence: {
        snippet: [
          'private static (object interpreter, MethodInfo getShortPath) ResolvePathMapApi()',
          '{',
          '  return cachedPathMapApi;',
          '}',
        ].join('\n'),
      },
      suggestedFix: 'const fallback = buildSafePathMapApi();',
    });

    expect(preview).toBe([
      'private static (object interpreter, MethodInfo getShortPath) ResolvePathMapApi()',
      '{',
      '  return cachedPathMapApi;',
    ].join('\n'));
  });

  test('falls back to suggested fix when evidence is unavailable', () => {
    expect(getRecommendationEvidencePreview({
      suggestedFix: 'const fallback = buildSafePathMapApi();',
    })).toBe('const fallback = buildSafePathMapApi();');
  });

  test('strips generic impact boilerplate from recommendation descriptions', () => {
    const description = [
      'The fallback condition does not just cover headless builds.',
      'As a result, Ambrose bots never use the generated path map at runtime.',
      'Impact: This may cause correctness, security, data integrity, or availability issues.',
    ].join(' ');

    expect(sanitizeRecommendationDescription(description)).toBe(
      'The fallback condition does not just cover headless builds. As a result, Ambrose bots never use the generated path map at runtime.'
    );
    expect(buildRecommendationTriageSummary(description)).toBe(
      'The fallback condition does not just cover headless builds. As a result, Ambrose bots never use the generated path map at runtime.'
    );
  });

  test('selects a highlightable focus token from multiline evidence', () => {
    const preview = [
      'var scene = EditorSceneManager.OpenScene(buildScene.path, OpenSceneMode.Single);',
      'NetworkObjectPostprocessor.BakeScene(scene);',
    ].join('\n');

    expect(getRecommendationEvidenceFocus({
      evidence: {
        snippet: preview,
      },
    }, preview)).toBe('NetworkObjectPostprocessor.BakeScene(scene);');
  });

  test('clips suggested fixes to the first few meaningful lines while preserving full-context availability', () => {
    expect(getRecommendationSuggestedFixPreview([
      'const showMetadata = !hideRoutingMetadata && (canToggleDetails ? detailsOpen : true);',
      '',
      '{showMetadata && (',
      '  <div style={{',
      "    display: 'flex',",
      "    alignItems: 'center',",
      '  }}>',
    ].join('\n'))).toEqual({
      preview: [
        'const showMetadata = !hideRoutingMetadata && (canToggleDetails ? detailsOpen : true);',
        '{showMetadata && (',
        '  <div style={{',
        "    display: 'flex',",
        "    alignItems: 'center',",
      ].join('\n'),
      truncated: true,
    });
  });

  test('builds PR comment selection items for actionable file-anchored findings', () => {
    expect(buildPrCommentSelectionItems([
      {
        type: 'suggestion',
        severity: 'high',
        title: 'Low-priority suggestion promoted by model',
        description: '',
      } as any,
      {
        type: 'issue',
        severity: 'low',
        title: 'Nit level issue',
        description: '',
        file: 'src/example.ts',
        line: 9,
      } as any,
      {
        type: 'issue',
        severity: 'high',
        title: 'Blocking issue',
        description: '',
        file: 'src/blocker.ts',
        line: 12,
      } as any,
      {
        type: 'praise',
        severity: 'low',
        title: 'Looks good',
        description: '',
      } as any,
    ])).toEqual([
      expect.objectContaining({
        title: 'Blocking issue',
        severity: 'high',
        defaultSelected: true,
        location: 'src/blocker.ts:12',
      }),
      expect.objectContaining({
        title: 'Nit level issue',
        severity: 'low',
        defaultSelected: false,
        location: 'src/example.ts:9',
      }),
    ]);
  });

  test('formats incremental diff scope details for branch reruns', () => {
    expect(getReviewDiffScopeSummary({
      stats: {
        diffScopeMode: 'delta',
        diffScopeCommitCount: 1,
        diffBaseSha: '1234567890abcdef',
        diffHeadSha: 'abcdef1234567890',
        totalChangedFiles: 3,
      },
    } as any)).toEqual({
      mode: 'delta',
      shortLabel: 'Incremental review',
      longLabel: 'Incremental review · 1 commit · 3 files · 1234567..abcdef1',
    });
  });

  test('prefers scoped file counts over full review totals for incremental summaries and coverage', () => {
    const review = {
      stats: {
        diffScopeMode: 'delta',
        diffScopeCommitCount: 1,
        diffBaseSha: '1234567890abcdef',
        diffHeadSha: 'abcdef1234567890',
        fileCount: 4,
        totalChangedFiles: 11,
        filesAnalyzed: 0,
      },
    } as any;

    expect(getReviewDiffScopeSummary(review)).toEqual({
      mode: 'delta',
      shortLabel: 'Incremental review',
      longLabel: 'Incremental review · 1 commit · 4 files · 1234567..abcdef1',
    });
    expect(getReviewCoverageStats(review)).toMatchObject({
      totalFiles: 4,
      omittedFiles: 4,
      coverageLabel: '0/4 files • 4 omitted',
    });
  });
});
