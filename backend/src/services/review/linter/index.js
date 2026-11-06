/**
 * Linter Pre-Pass — Public API
 */

export { runLinterPrePass } from './linterRunner.js';
export { mergeDeterministicFindingsIntoReview } from './linterMerge.js';
export { detectAvailableLinters } from './linterDetection.js';
export { buildChangedLineIndex, filterAnchoredFindings, isFindingAnchoredToDiff, resolveCanonicalDiffPath } from './linterDiffAnchors.js';
export * as dotnetFormatAdapter from './dotnetFormatAdapter.js';
export {
  REVIEW_LINTER_ENABLED,
  REVIEW_LINTER_DEADLINE_MS,
  REVIEW_LINTER_PROMPT_CONTEXT_MAX_LINES,
  REVIEW_LINTER_CORROBORATION_LINE_WINDOW,
  LINTER_IDS,
  normalizeLinterSeverity,
  compareSeverity,
  isSecurityRule,
  classifyCategory,
} from './linterConstants.js';
