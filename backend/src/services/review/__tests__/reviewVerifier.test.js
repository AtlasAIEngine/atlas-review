import { describe, expect, it } from 'vitest';

import { runCandidateFindingPromotionPass } from '../reviewVerifier.js';

describe('runCandidateFindingPromotionPass', () => {
  it('promotes supported candidate findings into recommendations and retains verifier metadata', async () => {
    const review = {
      summary: 'Test review',
      riskLevel: 'medium',
      recommendations: [],
      candidateFindings: [
        {
          type: 'issue',
          severity: 'medium',
          confidence: 'medium',
          title: 'Possible init ordering regression',
          description: 'Init moved and may miss the first signal dispatch.',
          file: 'src/view.ts',
          line: 12,
          evidence: {
            file: 'src/view.ts',
            line: 12,
            snippet: 'Start();',
            reasoning: 'Subscription now happens after construction.',
          },
        },
      ],
      stats: {},
    };

    const result = await runCandidateFindingPromotionPass(review, {
      verifyCandidate: async () => ({
        decision: 'supported',
        reason: 'Diff clearly moves subscription later in lifecycle.',
      }),
    });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      title: 'Possible init ordering regression',
      promotedFromCandidate: true,
      verifierDecision: 'supported',
    });
    expect(result.candidateFindings[0]).toMatchObject({
      verifierDecision: 'supported',
    });
    expect(result.stats.candidateFindingPromotion).toMatchObject({
      totalCandidates: 1,
      checked: 1,
      promoted: 1,
      supported: 1,
    });
  });

  it('keeps unsupported candidates out of recommendations', async () => {
    const review = {
      summary: 'Test review',
      riskLevel: 'low',
      recommendations: [],
      candidateFindings: [
        {
          type: 'issue',
          severity: 'high',
          confidence: 'medium',
          title: 'Possible divide by zero',
          description: 'Computed correction may divide by zero at center.',
          file: 'src/map.ts',
          line: 20,
          evidence: {
            file: 'src/map.ts',
            line: 20,
            snippet: 'radius / relativePos.magnitude',
            reasoning: 'No explicit zero guard is visible.',
          },
        },
      ],
      stats: {},
    };

    const result = await runCandidateFindingPromotionPass(review, {
      verifyCandidate: async () => ({
        decision: 'unsupported',
        reason: 'The surrounding guard prevents the division on the changed path.',
      }),
    });

    expect(result.recommendations).toEqual([]);
    expect(result.candidateFindings[0]).toMatchObject({
      verifierDecision: 'unsupported',
    });
    expect(result.stats.candidateFindingPromotion).toMatchObject({
      promoted: 0,
      unsupported: 1,
    });
  });
});
