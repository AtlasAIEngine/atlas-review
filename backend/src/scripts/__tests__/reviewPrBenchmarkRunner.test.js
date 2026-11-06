import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
const backendRoot = fileURLToPath(new URL('../../../', import.meta.url));
import {
  DEFAULT_OUT_DIR,
  buildBenchmarkScorecard,
  loadVariantConfig,
  parseArgs,
} from '../reviewPrBenchmarkRunner.js';

describe('reviewPrBenchmarkRunner.parseArgs', () => {
  it('uses PR review defaults', () => {
    const args = parseArgs([]);

    expect(args).toMatchObject({
      dryRun: false,
      fixtureIds: null,
      fixtureSet: 'pr_review',
      surface: 'pr_review',
      outDir: DEFAULT_OUT_DIR,
      baselineLabel: 'control',
      candidateLabel: 'candidate',
    });
  });

  it('parses fixture filters and config paths', () => {
    const args = parseArgs([
      '--dry-run',
      '--fixtures', 'pr-unity-lifecycle-regression,pr-unity-asmdef-package-regression',
      '--fixture-set', 'pr_review',
      '--surface', 'pr_review',
      '--baseline-config', 'tmp/control.json',
      '--candidate-config', 'tmp/candidate.json',
      '--baseline-label', 'before',
      '--candidate-label', 'after',
      '--provider-id', 'cli_openai',
      '--out-dir', 'tmp/benchmarks',
    ]);

    expect(args).toMatchObject({
      dryRun: true,
      fixtureIds: [
        'pr-unity-lifecycle-regression',
        'pr-unity-asmdef-package-regression',
      ],
      fixtureSet: 'pr_review',
      surface: 'pr_review',
      baselineConfigPath: 'tmp/control.json',
      candidateConfigPath: 'tmp/candidate.json',
      baselineLabel: 'before',
      candidateLabel: 'after',
      preferredProviderId: 'cli_openai',
      outDir: 'tmp/benchmarks',
    });
  });
});

describe('reviewPrBenchmarkRunner.buildBenchmarkScorecard', () => {
  it('summarizes fixture and prompt-budget deltas', () => {
    const scorecard = buildBenchmarkScorecard({
      delta: {
        avgPromptChars: 82,
        avgPromptContextUsedChars: 64,
        promptContextTruncatedRate: 0,
        localVerificationCoverageRate: 0.5,
        localVerificationSuppressionRate: -0.25,
        localVerificationProductionPathRate: 0.2,
      },
      fixtureComparisonSummary: {
        totalFixtures: 4,
        scoreImproved: 2,
        scoreRegressed: 1,
        passImproved: 1,
        passRegressed: 0,
        findingCountIncreased: 2,
        findingCountDecreased: 1,
        candidateCountIncreased: 1,
        candidateCountDecreased: 0,
        promotedCandidateCountIncreased: 1,
        promotedCandidateCountDecreased: 0,
        promptCharsIncreased: 4,
        promptCharsDecreased: 0,
        truncationIntroduced: 0,
        truncationResolved: 1,
      },
      fixtureComparisonDimensions: {
        bugClass: {
          'unity.editor_api_in_runtime_path': {
            totalFixtures: 1,
            scoreImproved: 1,
            scoreRegressed: 0,
          },
        },
        evaluationFocus: {
          candidate_generation: {
            totalFixtures: 1,
            scoreImproved: 1,
            scoreRegressed: 0,
          },
        },
      },
    });

    expect(scorecard).toEqual({
      totalFixtures: 4,
      scoreImprovedFixtures: 2,
      scoreRegressedFixtures: 1,
      passImprovedFixtures: 1,
      passRegressedFixtures: 0,
      findingCountIncreasedFixtures: 2,
      findingCountDecreasedFixtures: 1,
      candidateCountIncreasedFixtures: 1,
      candidateCountDecreasedFixtures: 0,
      promotedCandidateCountIncreasedFixtures: 1,
      promotedCandidateCountDecreasedFixtures: 0,
      promptCharsIncreasedFixtures: 4,
      promptCharsDecreasedFixtures: 0,
      truncationIntroducedFixtures: 0,
      truncationResolvedFixtures: 1,
      avgPromptCharsDelta: 82,
      avgPromptContextUsedCharsDelta: 64,
      promptContextTruncatedRateDelta: 0,
      localVerificationCoverageRateDelta: 0.5,
      localVerificationSuppressionRateDelta: -0.25,
      localVerificationProductionPathRateDelta: 0.2,
      promptBudgetMaxDeltaChars: 60,
      promptBudgetStatus: 'over_budget',
      bugClassSummary: {
        'unity.editor_api_in_runtime_path': {
          totalFixtures: 1,
          scoreImproved: 1,
          scoreRegressed: 0,
        },
      },
      evaluationFocusSummary: {
        candidate_generation: {
          totalFixtures: 1,
          scoreImproved: 1,
          scoreRegressed: 0,
        },
      },
      candidateGenerationSummary: {
        totalFixtures: 1,
        scoreImproved: 1,
        scoreRegressed: 0,
      },
    });
  });
});

describe('reviewPrBenchmarkRunner.loadVariantConfig', () => {
  it('accepts pipeline feature toggles', async () => {
    const variant = await loadVariantConfig(
      'config/review-harness-benchmarks/pr-review/unity-semantic-verifier.json',
      { cwd: backendRoot }
    );

    expect(variant.config).toMatchObject({
      pipelineFeatures: {
        unitySemanticVerifier: {
          enabled: true,
        },
      },
    });
  });

  it('accepts an explicit PR review mode', async () => {
    const variant = await loadVariantConfig(
      'config/review-harness-benchmarks/pr-review/terminal-like-pr-review.json',
      { cwd: backendRoot }
    );

    expect(variant.config).toMatchObject({
      prReviewMode: 'agentic_discovery',
    });
  });
});
