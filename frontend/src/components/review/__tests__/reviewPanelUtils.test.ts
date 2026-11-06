import { expect, test } from '@playwright/test';
import {
  buildFixIssueContext,
  buildRecommendationCopyText,
  formatPersistedFailureMessage,
  formatRecommendationLocation,
  getRecommendationFingerprint,
  getReviewDiffRecommendations,
} from '../reviewPanelUtils';

test.describe('review panel location text', () => {
  const recommendation = {
    type: 'issue' as const,
    severity: 'medium' as const,
    title: 'RegisterExistingCharacters does not subscribe HitReceived for pre-existing bots',
    description: 'RegisterExistingCharacters calls OnBotCharacterAdded without subscribing the bot kill handler.',
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
    targetSnippet: 'foreach (var bot in _blackSceneService.BotActors)',
  };

  test('formats recommendation locations from diff anchors when available', () => {
    expect(formatRecommendationLocation(recommendation)).toBe(
      'Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs:114-120'
    );
  });

  test('keeps source context alongside the primary anchor in fix prompts', () => {
    const context = buildFixIssueContext(recommendation);

    expect(context).toContain(
      'Location: Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs:114-120'
    );
    expect(context).toContain(
      'Source context: Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs:107'
    );
  });

  test('uses the displayed anchor in copied recommendation text', () => {
    const text = buildRecommendationCopyText(recommendation);

    expect(text).toContain(
      'Location: Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs:114-120'
    );
    expect(text).not.toContain(
      'Location: Project_BLACK/BLACK_Unity/Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs:107'
    );
  });
});

test.describe('review failure formatting', () => {
  test('summarizes Claude telemetry-only failures instead of showing raw JSON', () => {
    const raw = 'Claude CLI-agentic error (exit 1): {"service_tier":"standard","terminal_reason":"completed","request_id":"req_123"} [class=invalid_request] Attempts: anthropic/claude-sonnet-4-6 (anthropic_cli_agentic:failed/invalid_request)';

    const message = formatPersistedFailureMessage(raw);

    expect(message).toContain('Claude CLI failed before returning a readable error');
    expect(message).toContain('claude doctor');
    expect(message).not.toContain('service_tier');
    expect(message).not.toContain('Attempts:');
  });

  test('summarizes provider credit failures', () => {
    const raw = 'Claude CLI-agentic error (exit 1): Credit balance is too low to access the Anthropic API. [class=quota]';

    const message = formatPersistedFailureMessage(raw);

    expect(message).toBe('Claude credits or quota are exhausted. Check Claude credits or Anthropic Console billing, then retry.');
  });

  test('summarizes Claude system-init-only failures instead of showing raw JSON', () => {
    const raw = 'Claude CLI-agent error: {"type":"system","subtype":"init","cwd":"/tmp/atlas-review-source","session_id":"session-test","tools":["Task","Bash","Read"],"model":"claude-sonnet-4-6"}';

    const message = formatPersistedFailureMessage(raw);

    expect(message).toContain('Claude CLI started but exited before returning a review');
    expect(message).toContain('claude doctor');
    expect(message).not.toContain('"type":"system"');
    expect(message).not.toContain('session-test');
  });
});

test.describe('getReviewDiffRecommendations', () => {
  test('includes candidate findings in the diff annotation model without duplicating promoted findings', () => {
    const promoted = {
      type: 'issue' as const,
      severity: 'high' as const,
      title: 'Promoted finding',
      description: 'Already verified',
      file: 'src/game.ts',
      line: 12,
    };
    const candidate = {
      type: 'suggestion' as const,
      severity: 'low' as const,
      title: 'Candidate finding',
      description: 'Needs verification',
      file: 'src/hints.ts',
      line: 42,
      patchAnchor: {
        file: 'src/hints.ts',
        line: 44,
        status: 'exact' as const,
      },
    };

    const recommendations = getReviewDiffRecommendations({
      recommendations: [promoted],
      candidateFindings: [candidate, candidate],
    });

    expect(recommendations).toEqual([promoted, candidate]);
  });
});

test.describe('candidate fingerprint set membership', () => {
  test('Set membership survives keys whose trailing parts are empty (`||` at end)', () => {
    // Both candidates produce keys that end in `|` (empty trailing parts).
    // The earlier implementation joined keys with `||` and split back, which
    // collapsed the trailing pipes and shifted parts across keys, making
    // candidateFindingFingerprintSet.has(key) return false for valid keys —
    // and the auto-filter effect then snapped the right pane back to a
    // promoted finding the moment a candidate was clicked.
    const anchored = {
      type: 'issue' as const,
      severity: 'low' as const,
      title: 'Anchored candidate',
      description: 'Has file but no suggestedFix',
      file: 'src/hints.ts',
      line: 27,
    };
    const ungrounded = {
      type: 'issue' as const,
      severity: 'low' as const,
      title: 'Ungrounded candidate',
      description: 'No file, no line',
    };
    const keys = [anchored, ungrounded].map(getRecommendationFingerprint);
    const set = new Set(keys);

    expect(set.has(getRecommendationFingerprint(anchored))).toBe(true);
    expect(set.has(getRecommendationFingerprint(ungrounded))).toBe(true);
  });
});
