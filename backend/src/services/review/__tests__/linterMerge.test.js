import { describe, expect, it } from 'vitest';
import { mergeDeterministicFindingsIntoReview } from '../linter/linterMerge.js';

describe('mergeDeterministicFindingsIntoReview', () => {
  const baseFinding = {
    file: 'src/foo.ts',
    line: 42,
    severity: 'medium',
    ruleId: 'no-unused-vars',
    message: 'bar is never used',
    source: 'eslint',
    category: 'correctness',
    confidence: 'high',
  };

  it('returns original result when no findings', () => {
    const review = { recommendations: [{ type: 'issue', title: 'test' }] };
    const result = mergeDeterministicFindingsIntoReview(review, []);
    expect(result.recommendations).toHaveLength(1);
  });

  it('appends standalone deterministic findings', () => {
    const review = { recommendations: [] };
    const result = mergeDeterministicFindingsIntoReview(review, [baseFinding]);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].type).toBe('issue');
    expect(result.recommendations[0].confidence).toBe('high');
    expect(result.recommendations[0].corroboration.sourceClass).toBe('deterministic_tool');
    expect(result.recommendations[0].corroboration.sourceName).toBe('eslint:no-unused-vars');
  });

  it('deduplicates against AI findings at same file:line', () => {
    const review = {
      recommendations: [
        {
          type: 'issue',
          title: 'Unused var',
          description: 'bar is declared but never used.',
          file: 'src/foo.ts',
          line: 42,
          severity: 'medium',
        },
      ],
    };
    const result = mergeDeterministicFindingsIntoReview(review, [baseFinding]);
    // Should not add a duplicate
    expect(result.recommendations).toHaveLength(1);
    expect(result.stats.deterministicMerge.deduplicated).toBe(1);
    expect(result.stats.deterministicMerge.merged).toBe(0);
  });

  it('deduplicates within line window', () => {
    const review = {
      recommendations: [
        {
          type: 'issue',
          title: 'Unused variable',
          description: 'bar is declared but never used.',
          file: 'src/foo.ts',
          line: 44,
          severity: 'medium',
        },
      ],
    };
    const result = mergeDeterministicFindingsIntoReview(review, [baseFinding], { lineWindow: 3 });
    expect(result.recommendations).toHaveLength(1);
    expect(result.stats.deterministicMerge.deduplicated).toBe(1);
  });

  it('does not deduplicate beyond line window', () => {
    const review = {
      recommendations: [
        {
          type: 'issue',
          title: 'Unused variable',
          description: 'bar is declared but never used.',
          file: 'src/foo.ts',
          line: 100,
          severity: 'medium',
        },
      ],
    };
    const result = mergeDeterministicFindingsIntoReview(review, [baseFinding]);
    expect(result.recommendations).toHaveLength(2);
    expect(result.stats.deterministicMerge.merged).toBe(1);
  });

  it('keeps distinct AI findings on the same line', () => {
    const review = {
      recommendations: [
        {
          type: 'issue',
          title: 'Missing null guard',
          description: 'response.body can be null before reading id.',
          file: 'src/foo.ts',
          line: 42,
          severity: 'medium',
        },
      ],
    };
    const result = mergeDeterministicFindingsIntoReview(review, [baseFinding]);
    expect(result.recommendations).toHaveLength(2);
    expect(result.stats.deterministicMerge.merged).toBe(1);
    expect(result.stats.deterministicMerge.deduplicated).toBe(0);
  });

  it('populates evidence and corroboration on merged findings', () => {
    const review = { recommendations: [] };
    const result = mergeDeterministicFindingsIntoReview(review, [baseFinding]);
    const rec = result.recommendations[0];
    expect(rec.evidence.file).toBe('src/foo.ts');
    expect(rec.evidence.line).toBe(42);
    expect(rec.corroboration.status).toBe('supported');
    expect(rec.corroboration.confidence).toBe('high');
  });

  it('carries local verification evidence into merged recommendations', () => {
    const review = { recommendations: [] };
    const result = mergeDeterministicFindingsIntoReview(review, [{
      ...baseFinding,
      ruleId: 'unity.editor_api_in_runtime_path',
      message: 'Runtime code references UnityEditor APIs.',
      source: 'unity-semantic',
      evidenceSummary: 'production path; runtime-capable asmdef Assets/Scripts/Gameplay/Gameplay.Runtime.asmdef; 1 nearby runtime reference',
    }]);

    const rec = result.recommendations[0];
    expect(rec.description).toContain('Local verification: production path; runtime-capable asmdef');
    expect(rec.evidence.reasoning).toContain('Local verification: production path; runtime-capable asmdef');
  });

  it('tracks merge stats', () => {
    const review = { recommendations: [] };
    const result = mergeDeterministicFindingsIntoReview(review, [baseFinding, { ...baseFinding, line: 99 }]);
    expect(result.stats.deterministicMerge.total).toBe(2);
    expect(result.stats.deterministicMerge.merged).toBe(2);
    expect(result.stats.deterministicMerge.deduplicated).toBe(0);
  });

  it('keeps medium-confidence candidate evidence out of direct findings', () => {
    const review = { recommendations: [] };
    const result = mergeDeterministicFindingsIntoReview(review, [{
      ...baseFinding,
      ruleId: 'unity.pooled_state_not_reset',
      confidence: 'medium',
      promotionMode: 'candidate_evidence',
    }]);

    expect(result.recommendations).toHaveLength(0);
    expect(result.stats.deterministicMerge).toMatchObject({
      merged: 0,
      deduplicated: 0,
      candidateEvidenceSkipped: 1,
      total: 1,
    });
  });
});
