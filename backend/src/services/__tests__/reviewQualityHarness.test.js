/**
 * Tests for reviewQualityHarness.scoreFixture (no AI calls required)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import harness from '../reviewQualityHarness.js';
import reviewService from '../reviewService.js';

const { scoreFixture } = harness;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reviewService verifier decision mapping', () => {
  it('demotes unsupported high/critical findings under demote policy', () => {
    const rec = {
      type: 'issue',
      severity: 'critical',
      title: 'Critical auth gap',
      description: 'Auth bypass path.',
      file: 'src/auth.ts',
      line: 42,
    };
    const mapped = reviewService.__testing.applyVerifierDecisionToRecommendation(rec, {
      decision: 'unsupported',
      unsupportedPolicy: 'demote',
    });

    expect(mapped?.type).toBe('suggestion');
    expect(mapped?.severity).toBe('medium');
    expect(mapped?.verifierDecision).toBe('unsupported');
  });

  it('hides unsupported findings under hide policy', () => {
    const rec = {
      type: 'issue',
      severity: 'high',
      title: 'High timeout gap',
      description: 'Timeout path missing.',
      file: 'src/api.ts',
      line: 21,
    };
    const mapped = reviewService.__testing.applyVerifierDecisionToRecommendation(rec, {
      decision: 'unsupported',
      unsupportedPolicy: 'hide',
    });
    expect(mapped).toBeNull();
  });
});

describe('reviewService PR mode selection', () => {
  it('auto-selects agentic discovery for non-trivial PRs on cli-agentic providers', () => {
    const effectiveMode = reviewService.__testing.resolveEffectivePrReviewRequestedMode('auto', {
      reviewProfile: { id: 'generic', stackFamily: 'generic' },
      projectPath: '/tmp/ExampleProject',
      providerData: {
        provider: { type: 'anthropic', source: 'cli_detected', model: 'claude-sonnet-4-6' },
        apiKey: 'sk-test',
      },
      executionModeOrder: null,
      fileCount: 12,
      totalAdditions: 120,
      totalDeletions: 40,
    });

    expect(effectiveMode).toBe('agentic_discovery');
  });

  it('keeps explicit full mode even when discovery would be eligible', () => {
    const effectiveMode = reviewService.__testing.resolveEffectivePrReviewRequestedMode('full', {
      reviewProfile: { id: 'generic', stackFamily: 'generic' },
      projectPath: '/tmp/ExampleProject',
      providerData: {
        provider: { type: 'anthropic', source: 'cli_detected', model: 'claude-sonnet-4-6' },
        apiKey: 'sk-test',
      },
      executionModeOrder: null,
      fileCount: 12,
      totalAdditions: 120,
      totalDeletions: 40,
    });

    expect(effectiveMode).toBe('full');
  });

  it('keeps auto on low-signal PRs or non-cli-agentic providers', () => {
    const tinyGenericMode = reviewService.__testing.resolveEffectivePrReviewRequestedMode('auto', {
      reviewProfile: { id: 'generic', stackFamily: 'generic' },
      projectPath: '/tmp/repo',
      providerData: {
        provider: { type: 'anthropic', source: 'cli_detected', model: 'claude-sonnet-4-6' },
        apiKey: 'sk-test',
      },
      executionModeOrder: null,
      fileCount: 1,
      totalAdditions: 3,
      totalDeletions: 2,
    });
    const apiOnlyMode = reviewService.__testing.resolveEffectivePrReviewRequestedMode('auto', {
      reviewProfile: { id: 'unity_csharp', stackFamily: 'unity' },
      projectPath: '/tmp/ExampleProject',
      providerData: {
        provider: { type: 'anthropic', source: 'manual', model: 'claude-sonnet-4-6' },
        apiKey: 'sk-test',
      },
      executionModeOrder: ['api'],
      fileCount: 12,
      totalAdditions: 120,
      totalDeletions: 40,
    });

    expect(tinyGenericMode).toBe('auto');
    expect(apiOnlyMode).toBe('auto');
  });
});

describe('reviewQualityHarness.scoreFixture', () => {
  it('passes when review meets all golden expectations', () => {
    const review = {
      summary: 'This change adds a user search endpoint with a SQL injection vulnerability.',
      riskLevel: 'high',
      recommendations: [
        {
          type: 'issue',
          severity: 'critical',
          title: 'SQL injection risk',
          description: 'String interpolation in SQL query allows injection attacks.',
          file: 'src/routes/users.js',
          line: 13,
        },
      ],
    };

    const golden = {
      mustMentionKeywords: ['sql', 'injection'],
      minIssues: 1,
      minHighSeverity: 1,
      minRiskLevel: 'high',
      mustFlagFiles: ['src/routes/users.js'],
    };

    const result = scoreFixture(review, golden);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(result.total);
  });

  it('fails when keywords are not mentioned', () => {
    const review = {
      summary: 'Added a search endpoint.',
      riskLevel: 'low',
      recommendations: [],
    };

    const golden = {
      mustMentionKeywords: ['sql', 'injection'],
      minIssues: 0,
    };

    const result = scoreFixture(review, golden);
    expect(result.pass).toBe(false);
    // 2 keyword checks fail, 1 minIssues check passes
    expect(result.passed).toBe(1);
    expect(result.total).toBe(3);
  });

  it('fails when issue count is below minimum', () => {
    const review = {
      summary: 'Looks good.',
      riskLevel: 'low',
      recommendations: [
        { type: 'praise', severity: 'low', title: 'Nice code', description: 'Clean.', file: null },
      ],
    };

    const golden = {
      minIssues: 1,
    };

    const result = scoreFixture(review, golden);
    expect(result.pass).toBe(false);
    const issueCheck = result.checks.find(c => c.name.startsWith('minIssues'));
    expect(issueCheck.pass).toBe(false);
    expect(issueCheck.detail).toBe('found 0');
  });

  it('fails when issue count exceeds false-positive ceiling', () => {
    const review = {
      summary: 'Simple refactor.',
      riskLevel: 'low',
      recommendations: [
        {
          type: 'issue',
          severity: 'medium',
          title: 'False alarm',
          description: 'This should not be an issue.',
          file: 'src/utils/math.ts',
          line: 3,
        },
      ],
    };

    const result = scoreFixture(review, {
      minIssues: 0,
      maxIssues: 0,
      maxRecommendations: 2,
    });
    expect(result.pass).toBe(false);
    const maxIssueCheck = result.checks.find(c => c.name.startsWith('maxIssues'));
    expect(maxIssueCheck?.pass).toBe(false);
    expect(maxIssueCheck?.detail).toBe('found 1');
  });

  it('fails when risk level is below minimum', () => {
    const review = {
      summary: 'Minor change.',
      riskLevel: 'low',
      recommendations: [],
    };

    const golden = {
      minRiskLevel: 'high',
    };

    const result = scoreFixture(review, golden);
    expect(result.pass).toBe(false);
    const riskCheck = result.checks.find(c => c.name.startsWith('riskLevel'));
    expect(riskCheck.pass).toBe(false);
    expect(riskCheck.detail).toBe('got low');
  });

  it('passes when risk level equals minimum', () => {
    const review = {
      summary: 'Risky change.',
      riskLevel: 'high',
      recommendations: [],
    };

    const golden = {
      minRiskLevel: 'high',
    };

    const result = scoreFixture(review, golden);
    expect(result.pass).toBe(true);
  });

  it('fails when required files are not flagged', () => {
    const review = {
      summary: 'Code change.',
      riskLevel: 'medium',
      recommendations: [
        { type: 'issue', severity: 'medium', title: 'Problem', description: 'Issue.', file: 'other.js' },
      ],
    };

    const golden = {
      mustFlagFiles: ['src/config.js'],
    };

    const result = scoreFixture(review, golden);
    expect(result.pass).toBe(false);
  });

  it('passes for clean-code fixture with no requirements', () => {
    const review = {
      summary: 'Well-written utility.',
      riskLevel: 'low',
      recommendations: [
        { type: 'praise', severity: 'low', title: 'Good documentation', description: 'Well documented.', file: 'src/utils/format.ts' },
      ],
    };

    const golden = {
      mustMentionKeywords: [],
      minIssues: 0,
      minHighSeverity: 0,
      minRiskLevel: 'low',
      mustFlagFiles: [],
    };

    const result = scoreFixture(review, golden);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('keyword matching is case-insensitive', () => {
    const review = {
      summary: 'XSS via DangerouslySetInnerHTML.',
      riskLevel: 'high',
      recommendations: [],
    };

    const golden = {
      mustMentionKeywords: ['xss', 'dangerously'],
    };

    const result = scoreFixture(review, golden);
    expect(result.pass).toBe(true);
  });

  it('returns score=1 when no golden checks defined', () => {
    const review = {
      summary: 'Some change.',
      riskLevel: 'low',
      recommendations: [],
    };

    const result = scoreFixture(review, {});
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('accepts semantic bug-class matches when fixture intent is satisfied without exact wording', () => {
    const review = {
      summary: 'The new event handler is never removed during teardown, so the component can receive duplicate callbacks after it is destroyed.',
      riskLevel: 'medium',
      recommendations: [
        {
          type: 'issue',
          severity: 'medium',
          title: 'FeatureVisited subscription is never removed',
          description: 'The event handler remains active after OnDestroy, leaving teardown incomplete.',
          file: 'Assets/Scripts/CombatHintMarker.cs',
          line: 17,
        },
      ],
    };

    const result = scoreFixture(review, {
      mustMentionKeywords: ['unsubscribe', 'cleanup'],
      minIssues: 1,
    }, {
      bugClass: 'missing_unsubscribe',
    });

    expect(result.pass).toBe(true);
    expect(result.checks[0].detail).toContain('semantic bug class');
    expect(result.checks[1].detail).toContain('semantic bug class');
  });

  it('scores candidate findings separately from promoted findings', () => {
    const review = {
      summary: 'The review found one promoted issue and kept one plausible follow-up candidate.',
      riskLevel: 'medium',
      recommendations: [
        {
          type: 'issue',
          severity: 'medium',
          title: 'Storm completion text is hardcoded',
          description: 'The timer still renders a hardcoded English string.',
          file: 'Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
          line: 93,
        },
      ],
      candidateFindings: [
        {
          type: 'issue',
          severity: 'medium',
          title: 'Storm init signal can be missed',
          description: 'Moving signal subscription into Start can miss an early dispatch.',
          file: 'Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
          line: 47,
          verifierDecision: 'supported',
          promotedFromCandidate: true,
        },
        {
          type: 'issue',
          severity: 'medium',
          title: 'Clamp helper may return infinity at minimap center',
          description: 'The distance correction path still needs callee verification.',
          file: 'Assets/BLACK/MiniMap/Scripts/View/ExitStaticIndicatorView.cs',
          line: 258,
          verifierDecision: 'needs_more_context',
        },
      ],
    };

    const result = scoreFixture(review, {
      minCandidateFindings: 2,
      minPromotedCandidateFindings: 1,
      maxRemainingCandidateFindings: 1,
      mustMatchBugClassesInCandidates: ['unity.lifecycle_signal_handoff', 'unity.math_edge_divide_by_zero'],
    });

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name.startsWith('minCandidateFindings'))?.detail).toBe('found 2');
    expect(result.checks.find((check) => check.name.startsWith('minPromotedCandidateFindings'))?.detail).toBe('found 1');
    expect(result.checks.find((check) => check.name.startsWith('maxRemainingCandidateFindings'))?.detail).toBe('found 1');
    expect(result.checks.find((check) => check.name === 'candidate matches bug class "unity.lifecycle_signal_handoff"')?.pass).toBe(true);
    expect(result.checks.find((check) => check.name === 'candidate matches bug class "unity.math_edge_divide_by_zero"')?.pass).toBe(true);
  });

  it('accepts any matching semantic candidate family when a fixture supports multiple plausible candidate concerns', () => {
    const review = {
      summary: 'The review kept one plausible runtime edge-case candidate.',
      riskLevel: 'medium',
      recommendations: [
        {
          type: 'issue',
          severity: 'medium',
          title: 'Storm label remains hardcoded',
          description: 'The storm label still uses a hardcoded string.',
          file: 'Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
          line: 88,
        },
      ],
      candidateFindings: [
        {
          type: 'suggestion',
          severity: 'medium',
          title: 'Radial clamp can produce a non-finite correction value at the exact minimap center',
          description: 'The correction term divides by relativePos.magnitude and can return infinity.',
          file: 'Assets/BLACK/MiniMap/Scripts/View/MapViewBase.cs',
          line: 12,
        },
      ],
    };

    const result = scoreFixture(review, {
      minCandidateFindings: 1,
      mustMatchAnyBugClassesInCandidates: ['unity.lifecycle_signal_handoff', 'unity.math_edge_divide_by_zero'],
    });

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name.startsWith('candidate matches one of bug classes'))?.detail)
      .toContain('unity.math_edge_divide_by_zero');
  });

  it('accepts a matching semantic family anywhere in findings when candidate-focused fixtures allow direct issues to satisfy the core concern', () => {
    const review = {
      summary: 'The review found the late registration bug directly.',
      riskLevel: 'high',
      recommendations: [
        {
          type: 'issue',
          severity: 'high',
          title: 'Existing fake bots are still skipped by the new backfill path',
          description: 'Late tracker setup still misses already-present bots because the backfill path only replays characters.',
          file: 'Assets/BLACK/GameAnalytics/Scripts/HeatMap/HeatMapAnalyticsTracker.cs',
          line: 107,
        },
      ],
      candidateFindings: [],
    };

    const result = scoreFixture(review, {
      mustMatchAnyBugClassesInFindings: ['unity.lifecycle_signal_handoff'],
      maxRemainingCandidateFindings: 0,
    });

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name.startsWith('review matches one of bug classes'))?.detail)
      .toContain('unity.lifecycle_signal_handoff');
  });

  it('passes a PR parity fixture when verification, coverage, and comment readiness are present', () => {
    const review = {
      summary: 'This PR removes a session guard from the admin delete route and leaves GitHub checks failing.',
      riskLevel: 'high',
      verificationStatus: {
        summary: 'GitHub checks: state=failure total=3',
        lines: [
          'GitHub checks: state=failure total=3',
          'Failing contexts: ci/build, ci/lint',
        ],
      },
      recommendations: [
        {
          type: 'issue',
          severity: 'high',
          title: 'Admin delete route no longer requires a session',
          description: 'The route now executes without authentication, which can expose destructive actions to unauthorized users.',
          file: 'src/routes/admin.ts',
          line: 42,
          commentEligible: true,
        },
      ],
      stats: {
        filesDeepReviewed: 5,
        filesTotal: 5,
        commentEligibility: {
          totalFindings: 1,
          eligibleFindings: 1,
          withheldFindings: 0,
        },
      },
    };

    const result = scoreFixture(review, {
      mustMentionKeywords: ['session', 'checks'],
      minIssues: 1,
      minCommentEligibleIssues: 1,
      maxWithheldFindings: 0,
      minDeepCoverageRate: 0.9,
      requireVerificationSummary: true,
      minRiskLevel: 'high',
      mustFlagFiles: ['src/routes/admin.ts'],
    });

    expect(result.pass).toBe(true);
  });

  it('fails a PR parity fixture when findings are withheld and verification context is missing', () => {
    const review = {
      summary: 'This PR changes the admin route.',
      riskLevel: 'medium',
      recommendations: [
        {
          type: 'issue',
          severity: 'medium',
          title: 'Auth note',
          description: 'The route may need more guard coverage.',
          file: 'src/routes/admin.ts',
          line: 18,
          commentEligible: false,
        },
      ],
      stats: {
        filesDeepReviewed: 2,
        filesTotal: 5,
        commentEligibility: {
          totalFindings: 1,
          eligibleFindings: 0,
          withheldFindings: 1,
        },
      },
    };

    const result = scoreFixture(review, {
      minIssues: 1,
      minCommentEligibleIssues: 1,
      maxWithheldFindings: 0,
      minDeepCoverageRate: 0.7,
      requireVerificationSummary: true,
    });

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name.startsWith('minCommentEligibleIssues'))?.pass).toBe(false);
    expect(result.checks.find((check) => check.name.startsWith('maxWithheldFindings'))?.pass).toBe(false);
    expect(result.checks.find((check) => check.name.startsWith('deepCoverageRate'))?.pass).toBe(false);
    expect(result.checks.find((check) => check.name === 'verificationSummaryPresent')?.pass).toBe(false);
  });

  it('fails when recommendation count exceeds verbosity budget', () => {
    const review = {
      summary: 'Small refactor.',
      riskLevel: 'low',
      recommendations: [
        { type: 'suggestion', severity: 'low', title: 'A', description: 'Use const.', file: 'a.ts' },
        { type: 'suggestion', severity: 'low', title: 'B', description: 'Rename var.', file: 'a.ts' },
        { type: 'suggestion', severity: 'low', title: 'C', description: 'Simplify.', file: 'a.ts' },
      ],
    };

    const result = scoreFixture(review, { maxRecommendations: 2 });
    expect(result.pass).toBe(false);
    const check = result.checks.find(c => c.name.startsWith('maxRecommendations'));
    expect(check?.pass).toBe(false);
    expect(check?.detail).toBe('found 3');
  });

  it('fails issue evidence ratio checks when issue lacks file/line', () => {
    const review = {
      summary: 'Potential bug in route handler.',
      riskLevel: 'medium',
      recommendations: [
        { type: 'issue', severity: 'medium', title: 'Bug', description: 'Might fail.', file: null, line: null },
      ],
    };

    const result = scoreFixture(review, {
      minIssues: 1,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 1,
    });
    expect(result.pass).toBe(false);
    const fileRatioCheck = result.checks.find(c => c.name.startsWith('issueFileRatio'));
    const lineRatioCheck = result.checks.find(c => c.name.startsWith('issueLineRatio'));
    expect(fileRatioCheck?.pass).toBe(false);
    expect(lineRatioCheck?.pass).toBe(false);
  });

  it('fails high severity impact and actionable checks when details are weak', () => {
    const review = {
      summary: 'Security-related update.',
      riskLevel: 'high',
      recommendations: [
        { type: 'issue', severity: 'high', title: 'Bad auth', description: 'Not good.', file: 'src/auth.ts', line: 10 },
      ],
    };

    const result = scoreFixture(review, {
      minActionableRatio: 1,
      requireImpactForHighSeverity: true,
    });
    expect(result.pass).toBe(false);
    const actionableCheck = result.checks.find(c => c.name.startsWith('actionableRatio'));
    const impactCheck = result.checks.find(c => c.name === 'highSeverityImpactLanguage');
    expect(actionableCheck?.pass).toBe(false);
    expect(impactCheck?.pass).toBe(false);
  });
});

describe('reviewQualityHarness.listFixtures', () => {
  it('returns fixtures with scenario and context metadata', () => {
    const fixtures = harness.listFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    for (const f of fixtures) {
      expect(f.id).toBeDefined();
      expect(f.label).toBeDefined();
      expect(f.golden).toBeDefined();
      expect(f.context).toBeDefined();
      expect(f.context.fileCount).toBeGreaterThan(0);
      expect(f.scenario).toBeDefined();
      expect(typeof f.scenario.key).toBe('string');
    }
  });

  it('filters fixtures by PR review set and surface', () => {
    const fixtures = harness.listFixtures({ fixtureSet: 'pr_review', surface: 'pr_review' });
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    expect(fixtures.every((fixture) => fixture.surface === 'pr_review')).toBe(true);
    expect(fixtures.every((fixture) => fixture.fixtureSet === 'pr_review')).toBe(true);
    expect(fixtures.map((fixture) => fixture.id)).toContain('pr-unity-lifecycle-regression');
    expect(fixtures.map((fixture) => fixture.id)).toContain('pr-unity-low-signal-asset-churn');
  });

  it('loads Project Black real PR fixtures from checked-in snapshot files', () => {
    const fixtures = harness.listFixtures({ fixtureSet: 'project_black_real_prs', surface: 'pr_review' });
    expect(fixtures.length).toBeGreaterThanOrEqual(7);
    expect(fixtures.every((fixture) => fixture.surface === 'pr_review')).toBe(true);
    expect(fixtures.every((fixture) => fixture.fixtureSet === 'project_black_real_prs')).toBe(true);
    expect(fixtures.map((fixture) => fixture.id)).toContain('project-black-pr-9173-ftue-runtime-tracer-cleanup');
    expect(fixtures.map((fixture) => fixture.id)).toContain('project-black-pr-8909-blitz-pooled-reset-control');
    expect(fixtures.map((fixture) => fixture.id)).toContain('project-black-pr-8984-pve-actor-pooled-reset-positive');
    expect(fixtures.map((fixture) => fixture.id)).toContain('project-black-pr-0147-door-editor-api-runtime');
    expect(fixtures.map((fixture) => fixture.id)).toContain('project-black-pr-9179-sheet-validation-asset-fix');
    expect(fixtures.map((fixture) => fixture.id)).toContain('project-black-pr-9059-team-size-trios');
    expect(fixtures.map((fixture) => fixture.id)).toContain('project-black-pr-9161-validation-bypass-control');
    const controlFixture = fixtures.find((fixture) => fixture.id === 'project-black-pr-9161-validation-bypass-control');
    expect(controlFixture?.golden.maxIssues).toBe(0);
    const editorApiFixture = fixtures.find((fixture) => fixture.id === 'project-black-pr-0147-door-editor-api-runtime');
    expect(editorApiFixture?.benchmarkDimensions).toEqual({
      stack: 'unity',
      bugClass: 'unity.editor_api_in_runtime_path',
      evaluationFocus: 'direct_findings',
    });
  });

  it('marks low-risk negative fixtures with maxIssues=0 for false-positive control', () => {
    const fixtures = harness.listFixtures();
    const negativeIds = ['clean-code', 'lockfile-config-churn', 'tiny-safe-refactor'];
    for (const fixtureId of negativeIds) {
      const fixture = fixtures.find((entry) => entry.id === fixtureId);
      expect(fixture).toBeDefined();
      expect(fixture.golden.minIssues).toBe(0);
      expect(fixture.golden.maxIssues).toBe(0);
      expect(fixture.golden.minRiskLevel).toBe('low');
    }
  });
});

describe('reviewQualityHarness.compareQualityModes', () => {
  it('returns baseline and improved dry-run summaries', async () => {
    const result = await harness.compareQualityModes({ fixtureIds: ['clean-code'], dryRun: true });
    expect(result.baseline.mode).toBe('v1');
    expect(result.improved.mode).toBe('v2');
    expect(result.baseline.summary.qualityMode).toBe('v1');
    expect(result.improved.summary.qualityMode).toBe('v2');
    expect(typeof result.delta.avgScore).toBe('number');
    expect(result.rolloutGate).toBeDefined();
    expect(result.rolloutGate.recommendation).toBe('keep_canary');
    expect(result.tuningSignals).toBeDefined();
    expect(result.tuningSignals.adaptiveThresholds.fastPathMaxFiles).toBeGreaterThan(0);
    expect(typeof result.baseline.metrics.durationP50Ms).toBe('number');
    expect(typeof result.baseline.metrics.durationP95Ms).toBe('number');
    expect(typeof result.improved.metrics.firstSignalDataRate).toBe('number');
    expect(typeof result.improved.metrics.chunkCadencePerMinute).toBe('number');
    expect(typeof result.improved.metrics.fastPathCoverageRate).toBe('number');
    expect(typeof result.improved.metrics.deepScopePressureRate).toBe('number');
    expect(typeof result.improved.metrics.deepCoverageRate).toBe('number');
    expect(result.tuningSignals.indicators.fastPathCoverage).toBeDefined();
    expect(Array.isArray(result.tuningSignals.recommendations)).toBe(true);
    expect(['pass', 'warn', 'fail']).toContain(result.rolloutGate.status);
    expect(Array.isArray(result.rolloutGate.reasonCodes)).toBe(true);
  });

  it('supports PR fixture-set dry-run comparisons with prompt-budget metrics', async () => {
    const result = await harness.compareQualityModes({
      fixtureSet: 'pr_review',
      surface: 'pr_review',
      dryRun: true,
    });

    expect(result.baseline.summary.fixtureSet).toBe('pr_review');
    expect(result.baseline.summary.surface).toBe('pr_review');
    expect(result.baseline.metrics.avgPromptChars).toBeGreaterThan(0);
    expect(result.improved.metrics.promptContextSampleCount).toBeGreaterThanOrEqual(0);
    expect(typeof result.delta.avgPromptChars).toBe('number');
  });
});

describe('reviewQualityHarness.compareBenchmarkVariants', () => {
  it('compares control vs candidate variants on PR fixtures in dry-run mode', async () => {
    const result = await harness.compareBenchmarkVariants({
      fixtureSet: 'pr_review',
      surface: 'pr_review',
      dryRun: true,
      baseline: {
        label: 'control',
      },
      candidate: {
        label: 'candidate',
        promptMetadataOverrides: {
          additionalPromptContextBlocks: [
            {
              id: 'unity_stack_signals',
              title: '### Atlas Local Context: Unity Stack Signals',
              lines: ['Unity editor version: 6000.0.20f1'],
            },
          ],
        },
      },
    });

    expect(result.baseline.mode).toBe('control');
    expect(result.improved.mode).toBe('candidate');
    expect(result.baseline.summary.fixtureSet).toBe('pr_review');
    expect(result.improved.summary.surface).toBe('pr_review');
    expect(result.improved.metrics.avgPromptChars).toBeGreaterThan(result.baseline.metrics.avgPromptChars);
    expect(result.delta.avgPromptChars).toBeGreaterThan(0);
    expect(Array.isArray(result.fixtureComparison)).toBe(true);
    expect(result.fixtureComparison).toHaveLength(result.baseline.summary.total);
    expect(result.fixtureComparisonSummary.promptCharsIncreased).toBeGreaterThan(0);
    expect(result.fixtureComparison[0]).toMatchObject({
      baseline: expect.objectContaining({
        promptLength: expect.any(Number),
      }),
      improved: expect.objectContaining({
        promptLength: expect.any(Number),
      }),
      delta: expect.objectContaining({
        promptLength: expect.any(Number),
      }),
    });
  });

  it('builds bug-class comparison summaries for Project Black fixture runs', async () => {
    const result = await harness.compareBenchmarkVariants({
      fixtureIds: [
        'project-black-pr-9173-ftue-runtime-tracer-cleanup',
        'project-black-pr-8909-blitz-pooled-reset-control',
        'project-black-pr-8984-pve-actor-pooled-reset-positive',
        'project-black-pr-0147-door-editor-api-runtime',
      ],
      fixtureSet: 'project_black_real_prs',
      surface: 'pr_review',
      dryRun: true,
      baseline: {
        label: 'control',
      },
      candidate: {
        label: 'candidate',
        pipelineFeatures: {
          unitySemanticVerifier: {
            enabled: true,
          },
        },
      },
    });

    expect(result.fixtureComparisonDimensions.bugClass).toMatchObject({
      'unity.editor_api_in_runtime_path': expect.objectContaining({
        totalFixtures: 1,
        fixtureIds: ['project-black-pr-0147-door-editor-api-runtime'],
      }),
      'unity.missing_unsubscribe': expect.objectContaining({
        totalFixtures: 1,
        fixtureIds: ['project-black-pr-9173-ftue-runtime-tracer-cleanup'],
      }),
      'unity.pooled_state_not_reset': expect.objectContaining({
        totalFixtures: 2,
        fixtureIds: expect.arrayContaining([
          'project-black-pr-8909-blitz-pooled-reset-control',
          'project-black-pr-8984-pve-actor-pooled-reset-positive',
        ]),
      }),
    });
    expect(result.delta.avgPromptChars).toBeGreaterThanOrEqual(0);
    expect(result.fixtureComparisonSummary.promptCharsIncreased).toBeGreaterThanOrEqual(0);
  });

  it('groups fixture comparisons by evaluation focus so candidate-generation fixtures can be benchmarked separately', async () => {
    const result = await harness.compareBenchmarkVariants({
      fixtureIds: [
        'project-black-pr-9173-ftue-runtime-tracer-cleanup',
        'project-black-pr-9174-heatmap-registration-candidate-ordering',
        'project-black-pr-9059-team-size-candidate-control',
        'project-black-pr-9180-minimap-map-events-candidate-discovery',
      ],
      fixtureSet: 'project_black_real_prs',
      surface: 'pr_review',
      dryRun: true,
      baseline: {
        label: 'control',
      },
      candidate: {
        label: 'candidate',
      },
    });

    expect(result.fixtureComparisonDimensions.evaluationFocus).toMatchObject({
      direct_findings: expect.objectContaining({
        totalFixtures: 1,
        fixtureIds: ['project-black-pr-9173-ftue-runtime-tracer-cleanup'],
      }),
      candidate_generation: expect.objectContaining({
        totalFixtures: 3,
        fixtureIds: expect.arrayContaining([
          'project-black-pr-9174-heatmap-registration-candidate-ordering',
          'project-black-pr-9059-team-size-candidate-control',
          'project-black-pr-9180-minimap-map-events-candidate-discovery',
        ]),
      }),
    });
  });

  it('can resolve prompt-context signals through the harness benchmark path', async () => {
    vi.spyOn(reviewService.__testing, 'collectPromptContextSignals').mockResolvedValue({
      commitMessages: ['feat: benchmark prompt context'],
      queuedCommitShas: [],
      verificationStatus: null,
      requestedReviewers: [],
      assignees: [],
      reviewThreads: [],
      priorFindingHints: [],
      fileRiskContext: [],
      claudeConventions: [],
      projectMetadata: {
        projectType: 'unity',
        configFile: 'ProjectSettings/ProjectVersion.txt',
        availableChecks: { lint: false, unit: false, e2e: false },
      },
      dismissedPatterns: [],
      additionalBlocks: [
        {
          id: 'native_history_findings',
          title: '### Atlas Local Context: Native Review History',
          lines: ['exact-path [high issue] Assets/Scripts/Foo.cs: Missing cleanup symmetry (addressed 2x, dismissed 0x)'],
        },
      ],
    });

    const result = await harness.compareBenchmarkVariants({
      fixtureIds: ['project-black-pr-9173-ftue-runtime-tracer-cleanup'],
      fixtureSet: 'project_black_real_prs',
      surface: 'pr_review',
      dryRun: true,
      baseline: {
        label: 'control',
      },
      candidate: {
        label: 'candidate',
        promptContext: {
          enabled: true,
          cacheProjectId: 'harness',
        },
      },
    });

    expect(reviewService.__testing.collectPromptContextSignals).toHaveBeenCalledTimes(1);
    expect(result.improved.metrics.avgPromptChars).toBeGreaterThan(result.baseline.metrics.avgPromptChars);
    expect(result.improved.metrics.avgPromptContextUsedChars).toBeGreaterThan(result.baseline.metrics.avgPromptContextUsedChars);
    expect(result.fixtureComparisonSummary.promptCharsIncreased).toBe(1);
  });
});

describe('reviewQualityHarness.compareRoutingStrategies', () => {
  it('returns strategy matrix payload in dry-run mode', async () => {
    const result = await harness.compareRoutingStrategies({
      fixtureIds: ['clean-code'],
      dryRun: true,
      strategies: ['latency_first', 'smart'],
      qualityMode: 'v2',
    });
    expect(result.qualityMode).toBe('v2');
    expect(result.strategies).toHaveLength(2);
    expect(result.strategies[0].strategy).toBe('latency_first');
    expect(result.strategies[1].strategy).toBe('smart');
    expect(result.recommendation).toBeDefined();
  });
});

describe('reviewQualityHarness.summarizeHarnessMetrics', () => {
  it('computes duration percentiles and pressure indicators from result context', () => {
    const metrics = harness.summarizeHarnessMetrics([
      {
        status: 'pass',
        durationMs: 120,
        promptLength: 1800,
        promptContextTelemetry: { usedChars: 420, budgetChars: 1200, truncated: false },
        localVerification: {
          bundleEntryCount: 2,
          suppressedCount: 1,
          activeEntryCount: 1,
          productionPathCount: 1,
          suppressionRate: 0.5,
          productionPathRate: 1,
        },
        score: { score: 1, passed: 4, total: 4 },
        context: {
          fileCount: 2,
          diffChars: 1500,
          highRiskHint: false,
          recommendationBudget: 2,
        },
        review: {
          recommendationCount: 1,
          parseMode: 'strict_json',
          parseRecovered: false,
          recommendations: [
            { type: 'suggestion', severity: 'low', title: 'nit' },
          ],
          reviewTier: 'full',
          isPartial: false,
          firstSignalMs: 40,
          chunkCount: 2,
          filesTotal: 2,
          omittedFiles: 0,
        },
      },
      {
        status: 'fail',
        durationMs: 320,
        promptLength: 2600,
        promptContextTelemetry: { usedChars: 1100, budgetChars: 1200, truncated: true },
        localVerification: {
          bundleEntryCount: 2,
          suppressedCount: 0,
          activeEntryCount: 2,
          productionPathCount: 1,
          suppressionRate: 0,
          productionPathRate: 0.5,
        },
        score: { score: 0.5, passed: 2, total: 4 },
        context: {
          fileCount: 40,
          diffChars: 220000,
          highRiskHint: true,
          recommendationBudget: 4,
        },
        review: {
          recommendationCount: 5,
          parseMode: 'section_salvage',
          parseRecovered: true,
          recommendations: [
            { type: 'issue', severity: 'high', title: 'risk' },
            { type: 'suggestion', severity: 'medium', title: 'follow-up' },
          ],
          reviewTier: 'partial',
          isPartial: true,
          firstSignalMs: null,
          chunkCount: 5,
          filesTotal: 40,
          omittedFiles: 10,
        },
      },
    ], {
      fastPathMaxFiles: 12,
      fastPathMaxDiffChars: 20000,
      preferQualityOnHighRisk: true,
    });

    expect(metrics.fixtures).toBe(2);
    expect(metrics.durationP50Ms).toBe(120);
    expect(metrics.durationP95Ms).toBe(320);
    expect(metrics.avgPromptChars).toBe(2200);
    expect(metrics.promptCharsP95).toBe(2600);
    expect(metrics.avgPromptContextUsedChars).toBe(760);
    expect(metrics.avgPromptContextUtilization).toBeCloseTo((420 / 1200 + 1100 / 1200) / 2, 5);
    expect(metrics.promptContextTruncatedRate).toBe(0.5);
    expect(metrics.parseRecoveryRate).toBe(0.5);
    expect(metrics.strictParseRate).toBe(0.5);
    expect(metrics.parseModeCounts).toMatchObject({
      strict_json: 1,
      section_salvage: 1,
    });
    expect(metrics.localVerificationCoverageRate).toBe(1);
    expect(metrics.localVerificationSuppressionRate).toBe(0.25);
    expect(metrics.localVerificationProductionPathRate).toBe(0.75);
    expect(metrics.fastPathCoverageRate).toBe(0.5);
    expect(metrics.deepScopePressureRate).toBe(0.5);
    expect(metrics.recommendationBudgetPressureRate).toBe(0.5);
    expect(metrics.recommendationBudgetPressureCount).toBe(1);
    expect(metrics.partialRate).toBe(0.5);
    expect(metrics.firstSignalDataRate).toBe(0.5);
    expect(metrics.firstSignalP95Ms).toBe(40);
    expect(metrics.chunkCadencePerMinute).toBeGreaterThan(0);
    expect(metrics.omittedCoverageRate).toBeCloseTo(0.125, 3);
    expect(metrics.deepCoverageRate).toBeCloseTo(0.875, 3);
    expect(metrics.highRiskFixtureCount).toBe(1);
    expect(metrics.highRiskIssueCoverageRate).toBe(1);
    expect(metrics.scenarioMatrix['small:low_risk'].fixtures).toBe(1);
    expect(metrics.scenarioMatrix['large:high_risk'].fixtures).toBe(1);
  });

  it('normalizes precision metrics from nested review.stats payloads', () => {
    const metrics = harness.summarizeHarnessMetrics([
      {
        status: 'pass',
        durationMs: 100,
        score: { score: 1, passed: 3, total: 3 },
        context: {
          fileCount: 2,
          diffChars: 1200,
          highRiskHint: false,
          recommendationBudget: 2,
        },
        review: {
          recommendationCount: 1,
          recommendations: [{ type: 'issue', severity: 'medium', title: 'A' }],
          reviewTier: 'full',
          isPartial: false,
          firstSignalMs: 30,
          chunkCount: 2,
          filesTotal: 2,
          omittedFiles: 0,
          stats: {
            issuesTotal: 4,
            issuesGrounded: 2,
            issuesDemoted: 1,
            issuesSuppressed: 1,
            verifierSupported: 1,
            verifierUnsupported: 2,
            verifierNeedsMoreContext: 1,
            reviewOutcomeTelemetry: {
              issueTotal: 4,
              issueDismissed: 2,
              issueAddressed: 2,
            },
          },
        },
      },
      {
        status: 'pass',
        durationMs: 140,
        score: { score: 1, passed: 3, total: 3 },
        context: {
          fileCount: 1,
          diffChars: 800,
          highRiskHint: false,
          recommendationBudget: 2,
        },
        review: {
          recommendationCount: 0,
          recommendations: [],
          reviewTier: 'full',
          isPartial: false,
          firstSignalMs: 25,
          chunkCount: 1,
          filesTotal: 1,
          omittedFiles: 0,
          stats: {
            issuesTotal: 2,
            issuesGrounded: 2,
            issuesDemoted: 0,
            issuesSuppressed: 0,
            verifierSupported: 2,
            verifierUnsupported: 0,
            verifierNeedsMoreContext: 0,
            reviewOutcomeTelemetry: {
              issueTotal: 2,
              issueDismissed: 0,
              issueAddressed: 2,
            },
          },
        },
      },
    ]);

    expect(metrics.unsupportedIssueSampleCount).toBe(2);
    expect(metrics.unsupportedIssueRate).toBeCloseTo(0.25, 5);
    expect(metrics.lowEvidenceIssueSampleCount).toBe(2);
    expect(metrics.lowEvidenceIssueRate).toBeCloseTo(0.25, 5);
    expect(metrics.dismissedIssueSampleCount).toBe(2);
    expect(metrics.dismissedIssueRate).toBeCloseTo(0.25, 5);
    expect(metrics.uncorroboratedHighRiskSampleCount).toBe(0);
    expect(metrics.uncorroboratedHighRiskRate).toBe(0);
    expect(metrics.outcomeSuppressionSampleCount).toBe(0);
    expect(metrics.outcomeSuppressionRate).toBe(0);
  });
});

describe('reviewQualityHarness.evaluateRolloutGate', () => {
  it('passes when improved metrics meet rollout thresholds', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 8,
          passRate: 0.75,
          avgScore: 0.8,
          errorRate: 0.125,
          timeoutOrDeadlineErrorRate: 0.125,
          partialRate: 0.125,
        },
      },
      improved: {
        metrics: {
          fixtures: 8,
          passRate: 0.875,
          avgScore: 0.9,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.125,
          durationP95Ms: 85000,
          omittedCoverageSampleCount: 8,
          deepCoverageRate: 0.8,
          highRiskFixtureCount: 3,
          highRiskIssueCoverageRate: 1,
          firstSignalSampleCount: 8,
          firstSignalDataRate: 0.5,
          firstSignalP95Ms: 60000,
          chunkCadenceSampleCount: 8,
          chunkCadencePerMinute: 0.75,
        },
      },
      delta: {
        passRate: 0.125,
        avgScore: 0.1,
      },
    }, {
      minCompletedFixtures: 6,
      maxTimeoutOrDeadlineErrorRate: 0.05,
      maxPartialRate: 0.2,
      maxErrorRateRegression: 0.0,
      minHighRiskIssueCoverageRate: 0.75,
    });

    expect(gate.passed).toBe(true);
    expect(gate.recommendation).toBe('promote_default');
    expect(gate.status).toBe('pass');
    expect(gate.reasonCodes).toEqual([]);
    expect(gate.checks.every((check) => check.pass)).toBe(true);
  });

  it('fails when timeout/deadline rate exceeds threshold', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 8,
          passRate: 0.75,
          avgScore: 0.8,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.0,
        },
      },
      improved: {
        metrics: {
          fixtures: 8,
          passRate: 0.875,
          avgScore: 0.9,
          errorRate: 0.125,
          timeoutOrDeadlineErrorRate: 0.125,
          partialRate: 0.0,
          highRiskFixtureCount: 4,
          highRiskIssueCoverageRate: 0.75,
        },
      },
      delta: {
        passRate: 0.125,
        avgScore: 0.1,
      },
    }, {
      minCompletedFixtures: 6,
      maxTimeoutOrDeadlineErrorRate: 0.05,
      maxPartialRate: 0.2,
      maxErrorRateRegression: 0.2,
      minHighRiskIssueCoverageRate: 0.75,
    });

    expect(gate.passed).toBe(false);
    expect(gate.recommendation).toBe('keep_canary');
    expect(gate.status).toBe('fail');
    expect(gate.reasonCodes).toContain('gate_timeout_rate_exceeded');
    const timeoutCheck = gate.checks.find((check) => check.id === 'timeout_rate');
    expect(timeoutCheck?.pass).toBe(false);
  });

  it('fails rollout gate when high-risk issue coverage drops below floor', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 10,
          passRate: 0.8,
          avgScore: 0.85,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.0,
          highRiskFixtureCount: 5,
          highRiskIssueCoverageRate: 0.8,
        },
      },
      improved: {
        metrics: {
          fixtures: 10,
          passRate: 0.85,
          avgScore: 0.86,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.0,
          highRiskFixtureCount: 5,
          highRiskIssueCoverageRate: 0.4,
        },
      },
      delta: {
        passRate: 0.05,
        avgScore: 0.01,
      },
    }, {
      minCompletedFixtures: 5,
      maxTimeoutOrDeadlineErrorRate: 0.2,
      maxPartialRate: 0.2,
      maxErrorRateRegression: 0.1,
      minHighRiskIssueCoverageRate: 0.75,
    });

    expect(gate.passed).toBe(false);
    const highRiskCheck = gate.checks.find((check) => check.id === 'high_risk_issue_coverage');
    expect(highRiskCheck?.pass).toBe(false);
    expect(gate.status).toBe('fail');
    expect(gate.reasonCodes).toContain('gate_high_risk_issue_coverage_below_floor');
  });

  it('fails rollout gate when deep coverage drops below the configured minimum', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 8,
          passRate: 0.75,
          avgScore: 0.8,
          errorRate: 0.0,
        },
      },
      improved: {
        metrics: {
          fixtures: 8,
          passRate: 0.8,
          avgScore: 0.82,
          errorRate: 0.0,
          durationP95Ms: 90000,
          omittedCoverageSampleCount: 8,
          deepCoverageRate: 0.5,
        },
      },
      delta: {
        passRate: 0.05,
        avgScore: 0.02,
      },
    }, {
      minCompletedFixtures: 5,
      maxDurationP95Ms: 120000,
      minDeepCoverageRate: 0.7,
      maxTimeoutOrDeadlineErrorRate: 0.2,
      maxPartialRate: 0.5,
      maxErrorRateRegression: 0.2,
      minHighRiskIssueCoverageRate: 0.5,
    });

    expect(gate.passed).toBe(false);
    const deepCoverageCheck = gate.checks.find((check) => check.id === 'deep_coverage');
    expect(deepCoverageCheck?.pass).toBe(false);
    expect(gate.status).toBe('fail');
    expect(gate.reasonCodes).toContain('gate_deep_coverage_below_floor');
  });

  it('returns warn when only non-critical throughput checks miss thresholds', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 8,
          passRate: 0.8,
          avgScore: 0.82,
          errorRate: 0.0,
        },
      },
      improved: {
        metrics: {
          fixtures: 8,
          passRate: 0.8,
          avgScore: 0.82,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.0,
          durationP95Ms: 90000,
          omittedCoverageSampleCount: 8,
          deepCoverageRate: 0.9,
          highRiskFixtureCount: 4,
          highRiskIssueCoverageRate: 0.9,
          firstSignalSampleCount: 8,
          firstSignalDataRate: 0.1,
          firstSignalP95Ms: 50000,
          chunkCadenceSampleCount: 8,
          chunkCadencePerMinute: 0.4,
        },
      },
      delta: {
        passRate: 0.0,
        avgScore: 0.0,
      },
    }, {
      minCompletedFixtures: 5,
      minPassRateDelta: 0.0,
      minAvgScoreDelta: 0.0,
      maxDurationP95Ms: 120000,
      maxTimeoutOrDeadlineErrorRate: 0.05,
      maxPartialRate: 0.2,
      minDeepCoverageRate: 0.7,
      maxErrorRateRegression: 0.0,
      minHighRiskIssueCoverageRate: 0.75,
      minFirstSignalDataRate: 0.25,
      maxFirstSignalP95Ms: 90000,
      minChunkCadencePerMinute: 0.5,
    });

    expect(gate.passed).toBe(false);
    expect(gate.status).toBe('warn');
    expect(gate.recommendation).toBe('hold_canary');
    expect(gate.reasonCodes).toContain('gate_first_signal_data_low');
    expect(gate.reasonCodes).toContain('gate_chunk_cadence_low');
  });

  it('fails safely when telemetry samples are missing for required gate checks', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 8,
          passRate: 0.75,
          avgScore: 0.8,
          errorRate: 0.0,
        },
      },
      improved: {
        metrics: {
          fixtures: 8,
          passRate: 0.82,
          avgScore: 0.84,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.0,
          durationP95Ms: 90000,
          omittedCoverageSampleCount: 0,
          deepCoverageRate: 0,
          highRiskFixtureCount: 4,
          highRiskIssueCoverageRate: 0.9,
          firstSignalSampleCount: 0,
          firstSignalDataRate: 0,
          firstSignalP95Ms: 0,
          chunkCadenceSampleCount: 0,
          chunkCadencePerMinute: 0,
        },
      },
      delta: {
        passRate: 0.07,
        avgScore: 0.04,
      },
    }, {
      minCompletedFixtures: 5,
      minPassRateDelta: 0.0,
      minAvgScoreDelta: 0.0,
      maxDurationP95Ms: 120000,
      maxTimeoutOrDeadlineErrorRate: 0.05,
      maxPartialRate: 0.2,
      minDeepCoverageRate: 0.7,
      maxErrorRateRegression: 0.0,
      minHighRiskIssueCoverageRate: 0.75,
      minFirstSignalDataRate: 0.25,
      maxFirstSignalP95Ms: 90000,
      minChunkCadencePerMinute: 0.5,
    });

    expect(gate.passed).toBe(false);
    expect(gate.status).toBe('fail');
    expect(gate.reasonCodes).toContain('gate_telemetry_missing_deep_coverage');
    expect(gate.reasonCodes).toContain('gate_telemetry_missing_first_signal');
    expect(gate.reasonCodes).toContain('gate_telemetry_missing_chunk_cadence');
  });

  it('emits deterministic precision reason codes when precision thresholds are exceeded', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 8,
          passRate: 0.75,
          avgScore: 0.8,
          errorRate: 0.0,
        },
      },
      improved: {
        metrics: {
          fixtures: 8,
          passRate: 0.8,
          avgScore: 0.82,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.0,
          durationP95Ms: 90000,
          omittedCoverageSampleCount: 8,
          deepCoverageRate: 0.9,
          highRiskFixtureCount: 4,
          highRiskIssueCoverageRate: 0.9,
          firstSignalSampleCount: 8,
          firstSignalDataRate: 0.5,
          firstSignalP95Ms: 60000,
          chunkCadenceSampleCount: 8,
          chunkCadencePerMinute: 0.75,
          unsupportedIssueSampleCount: 8,
          unsupportedIssueRate: 0.7,
          lowEvidenceIssueSampleCount: 8,
          lowEvidenceIssueRate: 0.7,
          dismissedIssueSampleCount: 8,
          dismissedIssueRate: 0.9,
          uncorroboratedHighRiskSampleCount: 8,
          uncorroboratedHighRiskRate: 0.9,
          outcomeSuppressionSampleCount: 8,
          outcomeSuppressionRate: 0.9,
        },
      },
      delta: {
        passRate: 0.05,
        avgScore: 0.02,
      },
    }, {
      minCompletedFixtures: 5,
      maxDurationP95Ms: 120000,
      maxTimeoutOrDeadlineErrorRate: 0.05,
      maxPartialRate: 0.2,
      minDeepCoverageRate: 0.7,
      maxErrorRateRegression: 0.0,
      minHighRiskIssueCoverageRate: 0.75,
      minFirstSignalDataRate: 0.25,
      maxFirstSignalP95Ms: 90000,
      minChunkCadencePerMinute: 0.5,
      maxUnsupportedIssueRate: 0.45,
      maxLowEvidenceIssueRate: 0.55,
      maxDismissedIssueRate: 0.6,
      maxUncorroboratedHighRiskRate: 0.5,
      maxOutcomeSuppressionRate: 0.75,
    });

    expect(gate.passed).toBe(false);
    expect(gate.status).toBe('fail');
    expect(gate.reasonCodes).toContain('gate_precision_unsupported_issue_rate_high');
    expect(gate.reasonCodes).toContain('gate_precision_low_evidence_issue_rate_high');
    expect(gate.reasonCodes).toContain('gate_precision_dismissed_issue_rate_high');
    expect(gate.reasonCodes).toContain('gate_precision_uncorroborated_high_risk_rate_high');
    expect(gate.reasonCodes).toContain('gate_precision_outcome_suppression_rate_high');
  });

  it('treats missing precision telemetry as neutral for rollout gating', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 8,
          passRate: 0.75,
          avgScore: 0.8,
          errorRate: 0.0,
        },
      },
      improved: {
        metrics: {
          fixtures: 8,
          passRate: 0.8,
          avgScore: 0.82,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.0,
          durationP95Ms: 90000,
          omittedCoverageSampleCount: 8,
          deepCoverageRate: 0.9,
          highRiskFixtureCount: 4,
          highRiskIssueCoverageRate: 0.9,
          firstSignalSampleCount: 8,
          firstSignalDataRate: 0.5,
          firstSignalP95Ms: 60000,
          chunkCadenceSampleCount: 8,
          chunkCadencePerMinute: 0.75,
          unsupportedIssueSampleCount: 0,
          unsupportedIssueRate: 0,
          lowEvidenceIssueSampleCount: 0,
          lowEvidenceIssueRate: 0,
          dismissedIssueSampleCount: 0,
          dismissedIssueRate: 0,
          uncorroboratedHighRiskSampleCount: 0,
          uncorroboratedHighRiskRate: 0,
          outcomeSuppressionSampleCount: 0,
          outcomeSuppressionRate: 0,
        },
      },
      delta: {
        passRate: 0.05,
        avgScore: 0.02,
      },
    }, {
      minCompletedFixtures: 5,
      maxDurationP95Ms: 120000,
      maxTimeoutOrDeadlineErrorRate: 0.05,
      maxPartialRate: 0.2,
      minDeepCoverageRate: 0.7,
      maxErrorRateRegression: 0.0,
      minHighRiskIssueCoverageRate: 0.75,
      minFirstSignalDataRate: 0.25,
      maxFirstSignalP95Ms: 90000,
      minChunkCadencePerMinute: 0.5,
    });

    expect(gate.passed).toBe(true);
    expect(gate.status).toBe('pass');
    expect(gate.reasonCodes).toEqual([]);
    const unsupportedCheck = gate.checks.find((check) => check.id === 'precision_unsupported_issue_rate');
    const lowEvidenceCheck = gate.checks.find((check) => check.id === 'precision_low_evidence_issue_rate');
    const dismissedCheck = gate.checks.find((check) => check.id === 'precision_dismissed_issue_rate');
    const corroborationCheck = gate.checks.find((check) => check.id === 'precision_uncorroborated_high_risk_rate');
    const suppressionCheck = gate.checks.find((check) => check.id === 'precision_outcome_suppression_rate');
    expect(unsupportedCheck?.detail).toContain('n/a');
    expect(lowEvidenceCheck?.detail).toContain('n/a');
    expect(dismissedCheck?.detail).toContain('n/a');
    expect(corroborationCheck?.detail).toContain('n/a');
    expect(suppressionCheck?.detail).toContain('n/a');
  });

  it('evaluates medium verifier coverage threshold when enabled', () => {
    const gate = harness.evaluateRolloutGate({
      baseline: {
        metrics: {
          fixtures: 8,
          passRate: 0.75,
          avgScore: 0.8,
          errorRate: 0.0,
        },
      },
      improved: {
        metrics: {
          fixtures: 8,
          passRate: 0.8,
          avgScore: 0.82,
          errorRate: 0.0,
          timeoutOrDeadlineErrorRate: 0.0,
          partialRate: 0.0,
          durationP95Ms: 90000,
          omittedCoverageSampleCount: 8,
          deepCoverageRate: 0.9,
          highRiskFixtureCount: 4,
          highRiskIssueCoverageRate: 0.9,
          firstSignalSampleCount: 8,
          firstSignalDataRate: 0.5,
          firstSignalP95Ms: 60000,
          chunkCadenceSampleCount: 8,
          chunkCadencePerMinute: 0.75,
          mediumVerifierSampleCount: 10,
          mediumVerifierCoverageRate: 0.2,
        },
      },
      delta: {
        passRate: 0.05,
        avgScore: 0.02,
      },
    }, {
      minCompletedFixtures: 5,
      maxDurationP95Ms: 120000,
      maxTimeoutOrDeadlineErrorRate: 0.05,
      maxPartialRate: 0.2,
      minDeepCoverageRate: 0.7,
      maxErrorRateRegression: 0.0,
      minHighRiskIssueCoverageRate: 0.75,
      minFirstSignalDataRate: 0.25,
      maxFirstSignalP95Ms: 90000,
      minChunkCadencePerMinute: 0.5,
      minMediumVerifierCoverageRate: 0.6,
    });

    expect(gate.passed).toBe(false);
    expect(gate.status).toBe('warn');
    expect(gate.reasonCodes).toContain('gate_medium_verifier_coverage_low');
    const mediumCheck = gate.checks.find((check) => check.id === 'medium_verifier_coverage');
    expect(mediumCheck?.pass).toBe(false);
  });
});
