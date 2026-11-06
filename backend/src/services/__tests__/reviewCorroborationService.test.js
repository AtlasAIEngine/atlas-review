import { describe, it, expect } from 'vitest';
import reviewCorroborationService from '../reviewCorroborationService.js';

const BASE_HIGH_RISK_RECOMMENDATION = Object.freeze({
  type: 'issue',
  severity: 'high',
  title: 'Missing auth guard',
  description: 'Route handler can execute without verifying session token.',
  file: 'src/routes/auth.js',
  line: 27,
});

describe('reviewCorroborationService deterministic source adapter', () => {
  it('uses deterministic source evaluator outcome when supported', () => {
    const evaluation = reviewCorroborationService.evaluateRecommendationCorroboration(
      BASE_HIGH_RISK_RECOMMENDATION,
      {
        sourceEvaluator: () => ({
          status: 'supported',
          reason: 'semgrep_match',
          confidence: 'high',
          sourceClass: 'deterministic_tool',
          sourceName: 'semgrep',
        }),
      }
    );

    expect(evaluation).toMatchObject({
      status: 'supported',
      reason: 'semgrep_match',
      confidence: 'high',
      sourceClass: 'deterministic_tool',
      sourceName: 'semgrep',
    });
  });

  it('falls back to verifier decision when source evaluator errors', () => {
    const evaluation = reviewCorroborationService.evaluateRecommendationCorroboration(
      {
        ...BASE_HIGH_RISK_RECOMMENDATION,
        verifierDecision: 'supported',
      },
      {
        sourceEvaluator: () => {
          throw new Error('tool unavailable');
        },
      }
    );

    expect(evaluation).toMatchObject({
      status: 'supported',
      reason: 'verifier_supported',
      sourceClass: 'verifier',
    });
  });

  it('propagates source metadata into recommendation corroboration payload', () => {
    const applied = reviewCorroborationService.applyCorroborationToRecommendation(
      BASE_HIGH_RISK_RECOMMENDATION,
      {
        status: 'supported',
        reason: 'eslint_security_rule',
        confidence: 'high',
        sourceClass: 'deterministic_tool',
        sourceName: 'eslint-security',
      }
    );

    expect(applied.recommendation.corroboration).toMatchObject({
      status: 'supported',
      reason: 'eslint_security_rule',
      confidence: 'high',
      sourceClass: 'deterministic_tool',
      sourceName: 'eslint-security',
    });
  });

  it('keeps backward-compatible fallback when no source evaluator is provided', () => {
    const evaluation = reviewCorroborationService.evaluateRecommendationCorroboration({
      ...BASE_HIGH_RISK_RECOMMENDATION,
      line: null,
      evidenceSnippet: null,
      evidence: null,
      verifierDecision: null,
    });

    expect(evaluation).toMatchObject({
      status: 'unsupported',
      reason: 'missing_corroboration',
      sourceClass: 'none',
    });
  });

  it('treats verifier needs_more_context as inconclusive instead of unsupported', () => {
    const evaluation = reviewCorroborationService.evaluateRecommendationCorroboration({
      ...BASE_HIGH_RISK_RECOMMENDATION,
      verifierDecision: 'needs_more_context',
    });

    expect(evaluation).toMatchObject({
      status: 'inconclusive',
      reason: 'verifier_needs_more_context',
      sourceClass: 'verifier',
    });
  });

  it('does not inject unsupported confidence when downgrade is disabled', () => {
    const applied = reviewCorroborationService.applyCorroborationToRecommendation(
      {
        ...BASE_HIGH_RISK_RECOMMENDATION,
        confidence: null,
      },
      {
        status: 'unsupported',
        reason: 'verifier_unsupported',
        confidence: 'low',
      },
      {
        downgradeOnUnsupported: false,
      }
    );

    expect(applied.recommendation.corroboration?.status).toBe('unsupported');
    expect(applied.recommendation.confidence).toBeNull();
  });

  it('aggregates corroboration source counters into review stats', () => {
    const review = {
      summary: 'Corroboration source counters',
      riskLevel: 'high',
      changeGroups: [],
      recommendations: [
        {
          ...BASE_HIGH_RISK_RECOMMENDATION,
          title: 'Missing auth guard',
        },
        {
          ...BASE_HIGH_RISK_RECOMMENDATION,
          title: 'Missing rate limiter',
          file: 'src/routes/rateLimit.js',
        },
      ],
      stats: {},
    };

    const applied = reviewCorroborationService.applyCorroborationToReview(review, {
      sourceEvaluator: (recommendation) => ({
        status: 'supported',
        reason: 'deterministic_rule_match',
        confidence: 'high',
        sourceClass: 'deterministic_tool',
        sourceName: recommendation.file.includes('rateLimit') ? 'eslint-security' : 'semgrep',
      }),
    });

    expect(applied.review.stats.corroborationSourceClassCounts).toEqual({
      deterministic_tool: 2,
    });
    expect(applied.review.stats.corroborationSourceNameCounts).toEqual({
      'eslint-security': 1,
      semgrep: 1,
    });
    expect(applied.review.stats.corroboration.sourceClassCounts).toEqual({
      deterministic_tool: 2,
    });
    expect(applied.review.stats.corroboration.sourceNameCounts).toEqual({
      'eslint-security': 1,
      semgrep: 1,
    });
  });
});
