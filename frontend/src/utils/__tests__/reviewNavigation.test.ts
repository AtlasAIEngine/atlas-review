import { expect, test } from '@playwright/test';
import {
  formatRecommendationDisplayLocation,
  formatRecommendationPatchLocation,
  formatRecommendationSourceLocation,
  getRecommendationDiffNavigationTarget,
  getRecommendationDisplayLocationLabel,
} from '../reviewNavigation';

test.describe('review navigation location formatting', () => {
  test('prefers exact block patch anchors for display and navigation', () => {
    const recommendation = {
      file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs',
      line: 107,
      sourceAnchor: {
        file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs',
        line: 107,
      },
      patchAnchor: {
        file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs',
        line: 120,
        startLine: 114,
        endLine: 120,
        status: 'exact_block' as const,
      },
    };

    expect(formatRecommendationSourceLocation(recommendation)).toBe(
      'Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs:107'
    );
    expect(formatRecommendationPatchLocation(recommendation)).toBe(
      'Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs:114-120'
    );
    expect(formatRecommendationDisplayLocation(recommendation)).toBe(
      'Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs:114-120'
    );
    expect(getRecommendationDisplayLocationLabel(recommendation)).toBe('Anchor');
    expect(getRecommendationDiffNavigationTarget(recommendation)).toEqual({
      filePath: 'Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs',
      line: 120,
    });
  });

  test('falls back to source locations when patch anchors are unavailable', () => {
    const recommendation = {
      file: 'src/example.ts',
      line: 42,
      sourceAnchor: {
        file: 'src/example.ts',
        line: 42,
      },
      patchAnchor: {
        file: 'src/example.ts',
        line: 84,
        status: 'outside_patch' as const,
      },
    };

    expect(formatRecommendationPatchLocation(recommendation)).toBe('');
    expect(formatRecommendationDisplayLocation(recommendation)).toBe('src/example.ts:42');
    expect(getRecommendationDisplayLocationLabel(recommendation)).toBe('Source');
    expect(getRecommendationDiffNavigationTarget(recommendation)).toEqual({
      filePath: 'src/example.ts',
      line: 42,
    });
  });
});
