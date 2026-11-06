import { describe, it, expect } from 'vitest';

import {
  DEFAULT_MANIFEST_PATH,
  buildRepeatedMatrixEntry,
  filterManifestCandidates,
  parseMatrixArgs,
  rankMatrixCandidates,
  buildMatrixSummary,
} from '../reviewPrBenchmarkMatrix.js';

describe('reviewPrBenchmarkMatrix.parseMatrixArgs', () => {
  it('uses PR benchmark defaults', () => {
    const args = parseMatrixArgs([]);

    expect(args).toMatchObject({
      dryRun: false,
      fixtureIds: null,
      fixtureSet: 'pr_review',
      surface: 'pr_review',
      manifestPath: DEFAULT_MANIFEST_PATH,
      candidateIds: null,
      baselineLabel: 'control',
    });
  });

  it('parses fixture and candidate filters', () => {
    const args = parseMatrixArgs([
      '--dry-run',
      '--fixtures', 'pr-unity-lifecycle-regression',
      '--candidate-ids', 'unity_stack_signals,historical_review_learnings',
      '--manifest', 'tmp/manifest.json',
      '--baseline-config', 'tmp/control.json',
      '--baseline-label', 'before',
      '--provider-id', 'cli_openai',
      '--repeat', '3',
    ]);

    expect(args).toMatchObject({
      dryRun: true,
      fixtureIds: ['pr-unity-lifecycle-regression'],
      candidateIds: ['unity_stack_signals', 'historical_review_learnings'],
      manifestPath: 'tmp/manifest.json',
      baselineConfigPath: 'tmp/control.json',
      baselineLabel: 'before',
      preferredProviderId: 'cli_openai',
      repeat: 3,
    });
  });
});

describe('reviewPrBenchmarkMatrix helpers', () => {
  it('filters manifest candidates by id allowlist', () => {
    const filtered = filterManifestCandidates([
      { id: 'unity_stack_signals' },
      { id: 'historical_review_learnings' },
    ], ['historical_review_learnings']);

    expect(filtered).toEqual([{ id: 'historical_review_learnings' }]);
  });

  it('ranks candidates by score gains before prompt cost', () => {
    const ranked = rankMatrixCandidates([
      {
        id: 'low_cost_small_gain',
        scorecard: {
          scoreImprovedFixtures: 1,
          scoreRegressedFixtures: 0,
          passImprovedFixtures: 0,
          passRegressedFixtures: 0,
          truncationIntroducedFixtures: 0,
          avgPromptCharsDelta: 20,
        },
      },
      {
        id: 'higher_gain_higher_cost',
        scorecard: {
          scoreImprovedFixtures: 2,
          scoreRegressedFixtures: 0,
          passImprovedFixtures: 1,
          passRegressedFixtures: 0,
          truncationIntroducedFixtures: 0,
          avgPromptCharsDelta: 80,
        },
      },
    ]);

    expect(ranked.map((entry) => entry.id)).toEqual([
      'higher_gain_higher_cost',
      'low_cost_small_gain',
    ]);
  });

  it('builds a compact matrix summary', () => {
    const summary = buildMatrixSummary([
      {
        id: 'unity_stack_signals',
        label: 'Unity Stack Signals',
        scorecard: {
          scoreImprovedFixtures: 2,
          scoreRegressedFixtures: 0,
          passImprovedFixtures: 1,
          passRegressedFixtures: 0,
          truncationIntroducedFixtures: 0,
          avgPromptCharsDelta: 82,
          promptBudgetStatus: 'over_budget',
          bugClassSummary: {
            'unity.missing_unsubscribe': {
              totalFixtures: 1,
              scoreImproved: 1,
            },
          },
        },
      },
      {
        id: 'historical_review_learnings',
        label: 'Historical Review Learnings',
        scorecard: {
          scoreImprovedFixtures: 1,
          scoreRegressedFixtures: 0,
          passImprovedFixtures: 0,
          passRegressedFixtures: 0,
          truncationIntroducedFixtures: 0,
          avgPromptCharsDelta: 64,
          promptBudgetStatus: 'over_budget',
          bugClassSummary: {},
        },
      },
    ]);

    expect(summary).toMatchObject({
      candidateCount: 2,
      leader: {
        id: 'unity_stack_signals',
      },
      lowestPromptDelta: {
        id: 'historical_review_learnings',
        avgPromptCharsDelta: 64,
      },
      budgetStatusCounts: {
        within_budget: 0,
        over_budget: 2,
      },
      bugClassSummary: {
        unity_stack_signals: {
          'unity.missing_unsubscribe': {
            totalFixtures: 1,
            scoreImproved: 1,
          },
        },
        historical_review_learnings: {},
      },
      rankedCandidateIds: ['unity_stack_signals', 'historical_review_learnings'],
    });
  });

  it('aggregates repeated runs for a candidate', () => {
    const repeated = buildRepeatedMatrixEntry({
      candidate: {
        id: 'unity_semantic_verifier',
        label: 'Unity Semantic Verifier',
        description: 'deterministic evidence',
        source: 'deterministic_evidence',
        configPath: '/tmp/unity-semantic-verifier.json',
      },
      runs: [
        {
          scorecard: {
            scoreImprovedFixtures: 2,
            scoreRegressedFixtures: 0,
            passImprovedFixtures: 1,
            passRegressedFixtures: 0,
            avgPromptCharsDelta: 0,
            avgPromptContextUsedCharsDelta: 0,
            promptContextTruncatedRateDelta: 0,
            promptBudgetMaxDeltaChars: 60,
            promptBudgetStatus: 'within_budget',
            bugClassSummary: {
              'unity.editor_api_in_runtime_path': {
                totalFixtures: 1,
                scoreImproved: 1,
                passImproved: 1,
              },
            },
          },
        },
        {
          scorecard: {
            scoreImprovedFixtures: 1,
            scoreRegressedFixtures: 0,
            passImprovedFixtures: 1,
            passRegressedFixtures: 0,
            avgPromptCharsDelta: 0,
            avgPromptContextUsedCharsDelta: 0,
            promptContextTruncatedRateDelta: 0,
            promptBudgetMaxDeltaChars: 60,
            promptBudgetStatus: 'within_budget',
            bugClassSummary: {
              'unity.editor_api_in_runtime_path': {
                totalFixtures: 1,
                scoreImproved: 0,
                passImproved: 0,
              },
            },
          },
        },
      ],
    });

    expect(repeated.scorecard).toMatchObject({
      repeatCount: 2,
      scoreImprovedFixtures: 1.5,
      promptBudgetStatus: 'within_budget',
      noRegressionRuns: 2,
      improvementRuns: 2,
      bugClassSummary: {
        'unity.editor_api_in_runtime_path': {
          totalFixtures: 1,
          totalRuns: 2,
          improvedRuns: 1,
          regressedRuns: 0,
          avgScoreImproved: 0.5,
          avgPassImproved: 0.5,
        },
      },
    });
    expect(repeated.runs).toHaveLength(2);
  });
});
