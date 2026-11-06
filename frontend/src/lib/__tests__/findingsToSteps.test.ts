/**
 * findingsToSteps unit tests.
 *
 * Phase 11 — pure helper; the contract is exact path matching with
 * lowest-step-index tiebreak and an orphan bucket for unmatched findings.
 */

import { test, expect } from '@playwright/test';
import { mapFindingsToSteps } from '../findingsToSteps';

interface Step { files?: Array<{ path: string }> }
interface Finding { id: string; file?: string | null }

test.describe('mapFindingsToSteps', () => {
  test('standard: each finding lands in exactly one step', () => {
    const steps: Step[] = [
      { files: [{ path: 'a.ts' }, { path: 'b.ts' }] },
      { files: [{ path: 'c.ts' }] },
    ];
    const findings: Finding[] = [
      { id: 'f-1', file: 'a.ts' },
      { id: 'f-2', file: 'c.ts' },
      { id: 'f-3', file: 'b.ts' },
    ];

    const result = mapFindingsToSteps(steps, findings);

    expect(result.stepFindings).toHaveLength(2);
    expect(result.stepFindings[0].map((f) => f.id).sort()).toEqual(['f-1', 'f-3']);
    expect(result.stepFindings[1].map((f) => f.id)).toEqual(['f-2']);
    expect(result.findingsWithoutStep).toEqual([]);
  });

  test('orphan: finding whose path is in no step ends up in findingsWithoutStep', () => {
    const steps: Step[] = [{ files: [{ path: 'a.ts' }] }];
    const findings: Finding[] = [
      { id: 'f-1', file: 'a.ts' },
      { id: 'f-orphan', file: 'unknown.ts' },
      { id: 'f-no-file', file: null },
    ];

    const result = mapFindingsToSteps(steps, findings);

    expect(result.stepFindings[0].map((f) => f.id)).toEqual(['f-1']);
    expect(result.findingsWithoutStep.map((f) => f.id).sort()).toEqual(['f-no-file', 'f-orphan']);
  });

  test('multi-step path collision: finding lands in the lowest-index step', () => {
    const steps: Step[] = [
      { files: [{ path: 'shared.ts' }] }, // step 0
      { files: [{ path: 'shared.ts' }] }, // step 1 — also has the path
      { files: [{ path: 'other.ts' }] },  // step 2
    ];
    const findings: Finding[] = [
      { id: 'f-shared', file: 'shared.ts' },
    ];

    const result = mapFindingsToSteps(steps, findings);

    expect(result.stepFindings[0].map((f) => f.id)).toEqual(['f-shared']);
    expect(result.stepFindings[1]).toEqual([]);
    expect(result.stepFindings[2]).toEqual([]);
    expect(result.findingsWithoutStep).toEqual([]);
  });

  test('empty steps + non-empty findings → all findings orphan', () => {
    const findings: Finding[] = [
      { id: 'f-1', file: 'a.ts' },
      { id: 'f-2', file: 'b.ts' },
    ];

    const result = mapFindingsToSteps([], findings);

    expect(result.stepFindings).toEqual([]);
    expect(result.findingsWithoutStep.map((f) => f.id)).toEqual(['f-1', 'f-2']);
  });

  test('empty findings + non-empty steps → all stepFindings empty arrays, no orphans', () => {
    const steps: Step[] = [
      { files: [{ path: 'a.ts' }] },
      { files: [{ path: 'b.ts' }] },
    ];

    const result = mapFindingsToSteps(steps, []);

    expect(result.stepFindings).toEqual([[], []]);
    expect(result.findingsWithoutStep).toEqual([]);
  });

  test('preserves stable ordering of findings within a step (input order)', () => {
    // Tiebreak among multiple findings in the same step is "input order".
    const steps: Step[] = [{ files: [{ path: 'a.ts' }, { path: 'b.ts' }] }];
    const findings: Finding[] = [
      { id: 'first', file: 'a.ts' },
      { id: 'second', file: 'b.ts' },
      { id: 'third', file: 'a.ts' },
    ];

    const result = mapFindingsToSteps(steps, findings);

    expect(result.stepFindings[0].map((f) => f.id)).toEqual(['first', 'second', 'third']);
  });
});
