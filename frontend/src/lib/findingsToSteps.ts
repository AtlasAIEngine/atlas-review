/**
 * findingsToSteps — pure mapping from review findings to walkthrough steps.
 *
 * Phase 11 — walkthrough is generated independently from review, so the UI
 * needs a deterministic, side-effect-free way to overlay findings onto
 * walkthrough steps at read time.
 *
 * Contract:
 *   - Input: an ordered array of walkthrough steps (each with a `files`
 *     array) and a flat array of findings (each with an optional `file`
 *     path).
 *   - Output: a parallel array `stepFindings` aligned to the input steps,
 *     plus an `findingsWithoutStep` bucket for findings whose path doesn't
 *     match any step.
 *   - Matching is by exact string equality on `file` ↔ `step.files[i].path`.
 *   - When a path appears in multiple steps, the LOWEST step index wins
 *     (stable, predictable for keyboard navigation).
 *   - Findings without a `file` always end up in `findingsWithoutStep`.
 *
 * Zero I/O. Zero async. Zero React. Suitable for direct use under
 * `useMemo` to avoid the "infinite re-render via derived array" trap
 * documented in CLAUDE.md.
 */

export interface FindingsToStepsStepInput {
  files?: Array<{ path?: string | null }> | null;
}

export interface FindingsToStepsFinding {
  file?: string | null;
}

export interface FindingsToStepsResult<F extends FindingsToStepsFinding> {
  /** Aligned 1:1 with the input `steps` array. */
  stepFindings: F[][];
  /** Findings whose `file` is missing or matches no step. */
  findingsWithoutStep: F[];
}

/**
 * Map each finding to the lowest-index step containing its file path.
 * Findings with no matching step accumulate in `findingsWithoutStep`.
 *
 * @param steps walkthrough steps in display order
 * @param findings flat array of findings (e.g. ReviewRecommendation[])
 */
export function mapFindingsToSteps<S extends FindingsToStepsStepInput, F extends FindingsToStepsFinding>(
  steps: readonly S[],
  findings: readonly F[],
): FindingsToStepsResult<F> {
  const stepFindings: F[][] = [];
  for (let i = 0; i < steps.length; i += 1) {
    stepFindings.push([]);
  }

  // Build path → lowest-index map once. If a path appears in multiple
  // steps, the first (lowest) index wins.
  const pathToStepIndex = new Map<string, number>();
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex];
    const files = Array.isArray(step?.files) ? step.files : [];
    for (const file of files) {
      const path = typeof file?.path === 'string' ? file.path : '';
      if (!path) continue;
      if (!pathToStepIndex.has(path)) {
        pathToStepIndex.set(path, stepIndex);
      }
    }
  }

  const findingsWithoutStep: F[] = [];
  for (const finding of findings) {
    const filePath = typeof finding?.file === 'string' ? finding.file : '';
    if (!filePath) {
      findingsWithoutStep.push(finding);
      continue;
    }
    const stepIndex = pathToStepIndex.get(filePath);
    if (stepIndex == null) {
      findingsWithoutStep.push(finding);
      continue;
    }
    stepFindings[stepIndex].push(finding);
  }

  return { stepFindings, findingsWithoutStep };
}
