/**
 * reviewPanelUtils — Pure utility functions and types extracted from TrustReviewPanel.
 *
 * This module contains ZERO React dependencies (no hooks, no JSX).
 * All functions are top-level helpers used by TrustReviewPanel and potentially
 * other review-related components.
 */

import type {
  ReviewResult,
  ReviewRecommendation,
  ReviewFixRecommendationStatus,
  ReviewFixRunArtifact,
  ReviewFixRunHistoryEntry,
  ReviewFixRunHistoryAction,
  ReviewLifecycleStatus,
  BranchReviewFileSummary,
  BranchReviewFileContent,
  TrustAnalyticsRateMetric,
  TrustReviewAnalytics,
  RiskLevel,
  BranchReview,
  BranchReviewDiffScope,
  WorkspaceReview,
  PrReview,
} from '@/types';
import { computeUnifiedDiff } from '@/utils/diff';
import {
  formatRecommendationDisplayLocation,
  formatRecommendationSourceLocation,
  getRecommendationPatchLine,
} from '@/utils/reviewNavigation';
import {
  buildLegacyReviewRecommendationKey,
  buildReviewRecommendationKey,
  normalizeRecommendationKeyPart,
} from '@/utils/reviewRecommendationKeys';

// ── Last-commit fallback helpers ────────────────────────────────────────

/** Returns true if the baseBranch value indicates a last-commit fallback review. */
export function isLastCommitFallbackBaseBranch(baseBranch: string | null | undefined): boolean {
  return typeof baseBranch === 'string' && baseBranch.endsWith('~last-commit');
}

/** Returns a user-friendly label for the base branch, handling the last-commit marker. */
export function formatBaseBranchLabel(baseBranch: string | null | undefined): string {
  if (!baseBranch) return 'base';
  if (isLastCommitFallbackBaseBranch(baseBranch)) return 'Last commit';
  return baseBranch;
}

export function getBranchReviewDiffScope(
  baseBranch: string | null | undefined,
  baseBranchSource?: string | null
): BranchReviewDiffScope {
  return baseBranchSource === 'last_commit' || isLastCommitFallbackBaseBranch(baseBranch)
    ? 'last_commit'
    : 'base_branch';
}

export function formatBranchReviewDiffScopeLabel(scope: BranchReviewDiffScope): string {
  return scope === 'last_commit' ? 'Last commit' : 'Base branch';
}

// ── Color maps ──────────────────────────────────────────────────────────

export const RISK_COLORS: Record<string, string> = {
  low: 'var(--accent-green)',
  medium: 'var(--accent-yellow)',
  high: 'var(--accent-red)',
  critical: 'var(--accent-red)',
};

export const RISK_BG_COLORS: Record<string, string> = {
  low: 'var(--chip-success-bg)',
  medium: 'var(--chip-warning-bg)',
  high: 'var(--chip-error-bg)',
  critical: 'var(--chip-error-bg)',
};

export const TYPE_COLORS: Record<string, { border: string; chip: string; bg: string }> = {
  issue: { border: 'var(--accent-red)', chip: 'var(--accent-red)', bg: 'var(--chip-error-bg)' },
  suggestion: { border: 'var(--accent-yellow)', chip: 'var(--accent-yellow)', bg: 'var(--chip-warning-bg)' },
  praise: { border: 'var(--accent-green)', chip: 'var(--accent-green)', bg: 'var(--chip-success-bg)' },
};

export const RISK_ORDER: Record<'low' | 'medium' | 'high' | 'critical', number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ── Types ───────────────────────────────────────────────────────────────

export type ReviewTier = 'full' | 'partial' | 'files_only' | 'failed';

export type RecommendationResolutionState = 'addressed' | 'dismissed';
export type RecommendationVerificationState =
  | 'patch_applied'
  | 'verification_pending'
  | 're_reviewing'
  | 'addressed'
  | 'still_open';

export type RecommendationResolutionEntry = {
  state: RecommendationResolutionState;
  note?: string;
  updatedAt: string;
};

export type RecommendationResolutionMap = Record<string, RecommendationResolutionEntry>;
export type RecommendationCommentEntry = {
  comment: string;
  updatedAt: string;
};
export type RecommendationCommentMap = Record<string, RecommendationCommentEntry>;
export const REVIEW_COMMENT_DRAFTS_UPDATED_EVENT = 'atlas-review-comment-drafts-updated';
export type ReviewCommentDraftKind = 'recommendation' | 'manual_line';
export type ReviewCommentDraftsUpdatedDetail = {
  kind?: ReviewCommentDraftKind;
  storageKey?: string;
  sourceId?: string;
};
export type RecommendationNoteDraft = {
  id: string;
  recommendationKey: string;
  body: string;
  updatedAt: string;
  reviewType?: 'branch_review' | 'workspace_review' | 'pr_review';
  branchReviewId?: string | null;
  workspaceReviewId?: string | null;
  branchName?: string | null;
  prReviewId?: string | null;
  githubPrNumber?: number | null;
  prHtmlUrl?: string | null;
  reviewDisplayId?: string | null;
  reviewTitle?: string | null;
  findingTitle?: string | null;
  findingType?: string | null;
  findingSeverity?: 'low' | 'medium' | 'high' | 'critical';
  findingLocation?: string | null;
  findingSourceLocation?: string | null;
  findingDescription?: string | null;
  evidenceSnippet?: string | null;
};
export type RecommendationNoteMap = Record<string, RecommendationNoteDraft>;
export type RecommendationNoteListEntry = RecommendationNoteDraft & {
  active: boolean;
  staleReason?: string;
};
export type RecommendationNoteStorageEntry = {
  storageKey: string;
  notes: RecommendationNoteMap;
};
export type RecommendationNoteHistoryEntry = RecommendationNoteDraft & {
  reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
  reviewId: string | null;
  reviewAvailable: boolean;
  sourceLabel: string;
  sourceMeta: string | null;
  locationLabel: string;
  stale: boolean;
  staleReason?: string;
  storageKey: string;
  navigationFilePath: string | null;
  navigationLine: number | null;
};
export type PrivateReviewNoteDraft = {
  id: string;
  path: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
  updatedAt: string;
  reviewType?: 'branch_review' | 'workspace_review' | 'pr_review';
  branchReviewId?: string | null;
  workspaceReviewId?: string | null;
  branchName?: string | null;
  prReviewId?: string | null;
  githubPrNumber?: number | null;
  prHtmlUrl?: string | null;
  reviewDisplayId?: string | null;
  reviewTitle?: string | null;
  snapshotLabel?: string | null;
  snapshotExcerpt?: string | null;
  snapshotLanguage?: string | null;
};
export type PrivateReviewNoteMap = Record<string, PrivateReviewNoteDraft>;
export type ManualLineCommentDraft = {
  id: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  updatedAt: string;
};
export type ManualLineCommentMap = Record<string, ManualLineCommentDraft>;
export type RecommendationOutcomeScope = { reviewType: 'changeset' | 'branch_review' | 'workspace_review' | 'pr_review'; reviewId: string };
export type ReviewFixRequest = {
  projectId: string;
  reviewType: 'changeset' | 'branch_review' | 'workspace_review' | 'pr_review';
  reviewId: string;
  recommendationKeys: string[];
  contextLabels: {
    nonGoals: 'non-goals';
  };
};
export type PrivateReviewNoteListEntry = PrivateReviewNoteDraft & {
  anchorKind: 'file' | 'line';
  stale: boolean;
  staleReason?: string;
  locationLabel: string;
};
export type PrivateReviewNoteStorageEntry = {
  storageKey: string;
  notes: PrivateReviewNoteMap;
};
export type PrivateReviewNoteHistoryEntry = PrivateReviewNoteDraft & {
  reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
  reviewId: string | null;
  reviewAvailable: boolean;
  sourceLabel: string;
  sourceMeta: string | null;
  anchorKind: 'file' | 'line';
  locationLabel: string;
  stale: boolean;
  staleReason?: string;
  storageKey: string;
};

export type ReviewCoverageStats = {
  analyzedFiles: number;
  totalFiles: number;
  omittedFiles: number;
  cacheHits: number;
  cacheMisses: number;
  coverageLabel: string;
  cacheLabel: string | null;
  focusedLabel: string;
  chunkLabel: string | null;
};

export type FixSelectionItem = {
  key: string;
  findingId?: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  location: string | null;
  defaultSelected: boolean;
};

export type RecommendationFixStatusMap = Record<string, {
  status: ReviewFixRecommendationStatus;
  updatedAt?: string;
  filePaths?: string[];
  error?: string | null;
}>;

export type ReviewDiffScopeSummary = {
  mode: 'full' | 'delta';
  shortLabel: string;
  longLabel: string;
};

export type ReviewPrecisionStats = {
  issuesTotal: number;
  issuesGrounded: number;
  issuesDemoted: number;
  issuesSuppressed: number;
  verifierSupported: number;
  verifierUnsupported: number;
  verifierNeedsMoreContext: number;
  verifierSkippedBudget: number;
  corroborationChecked: number;
  corroborationSupported: number;
  corroborationUnsupported: number;
  corroborationDowngraded: number;
  outcomeSuppressionChecked: number;
  outcomeSuppressionSuppressed: number;
  label: string | null;
  details: string | null;
};

export type ReviewFileTreeFilterId = 'all' | 'risky' | 'code_only';
export type ReviewFileTreeBucketId =
  | 'config_files'
  | 'documentation'
  | 'metadata_files'
  | 'assets_media'
  | 'baked_lighting'
  | 'generated_data'
  | 'binary_artifacts';
export type ReviewFileTreeFileClass =
  | 'code'
  | 'config'
  | 'documentation'
  | 'metadata'
  | 'asset_media'
  | 'generated'
  | 'binary_artifact'
  | 'other';

export type ReviewFileTreeSourceFile = {
  path: string;
  additions?: number | null;
  deletions?: number | null;
  status?: string | null;
  oldPath?: string | null;
  before?: string | null;
  after?: string | null;
  language?: string | null;
};

export type ReviewFileTreeEntry = {
  path: string;
  oldPath: string | null;
  fileName: string;
  directory: string | null;
  additions: number;
  deletions: number;
  status: string;
  statusLabel: string;
  fileClass: ReviewFileTreeFileClass;
  bucketId: ReviewFileTreeBucketId | null;
  bucketLabel: string | null;
  findingCount: number;
  highestFindingSeverity: RiskLevel | null;
  isRisky: boolean;
  isCode: boolean;
};

export type ReviewFileTreeBucket = {
  id: ReviewFileTreeBucketId;
  label: string;
  defaultCollapsed: boolean;
  entries: ReviewFileTreeEntry[];
};

export type ReviewFileTreeFilter = {
  id: ReviewFileTreeFilterId;
  label: string;
  count: number;
  paths: string[];
  active?: boolean;
};

export type ReviewFileTreeModel = {
  totalCount: number;
  activeFilterId: ReviewFileTreeFilterId | 'custom';
  standaloneEntries: ReviewFileTreeEntry[];
  buckets: ReviewFileTreeBucket[];
  filters: Record<ReviewFileTreeFilterId, ReviewFileTreeFilter>;
};

export type ReviewFileTreeVisibleState = {
  standaloneEntries: ReviewFileTreeEntry[];
  buckets: ReviewFileTreeBucket[];
  totalVisibleCount: number;
};

// ── Internal constants ──────────────────────────────────────────────────

const LEGACY_REVIEW_STATUS_TO_LIFECYCLE: Record<'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed', ReviewLifecycleStatus> = {
  none: 'completed',
  queued: 'queued',
  reviewing: 'running',
  reviewed: 'completed',
  failed: 'failed',
};

export const ACTIVE_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['queued', 'running', 'retrying']);
export const TERMINAL_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['partial', 'failed', 'completed']);
export const REVIEW_FIX_NON_GOALS = Object.freeze([
  'Do not mark any finding addressed from agent output alone.',
  'Do not expand the patch to unrelated findings.',
  'Do not expose the hidden transcript in v1.',
]);

const OUTCOME_SYNC_GRACE_MS = 15000;
const REVIEW_FILE_TREE_BUCKET_ORDER: ReviewFileTreeBucketId[] = [
  'config_files',
  'documentation',
  'metadata_files',
  'assets_media',
  'baked_lighting',
  'generated_data',
  'binary_artifacts',
];
const REVIEW_FILE_TREE_BUCKET_META: Record<ReviewFileTreeBucketId, { label: string; defaultCollapsed: boolean }> = {
  config_files: { label: 'Config', defaultCollapsed: true },
  documentation: { label: 'Docs & Planning', defaultCollapsed: true },
  metadata_files: { label: 'Metadata', defaultCollapsed: true },
  assets_media: { label: 'Assets & Media', defaultCollapsed: true },
  baked_lighting: { label: 'Baked Lighting', defaultCollapsed: true },
  generated_data: { label: 'Generated / Data', defaultCollapsed: true },
  binary_artifacts: { label: 'Binary / Artifacts', defaultCollapsed: true },
};
const REVIEW_FILE_TREE_CODE_EXTENSIONS = new Set([
  '.asmdef', '.asmref', '.c', '.cc', '.cginc', '.cpp', '.cs', '.css', '.go',
  '.graphql', '.gql', '.h', '.hpp', '.hlsl', '.html', '.java', '.js', '.json',
  '.jsx', '.kt', '.kts', '.lua', '.m', '.mm', '.php', '.py', '.rb', '.rs',
  '.scss', '.shader', '.sh', '.sql', '.swift', '.ts', '.tsx', '.vue',
]);
const REVIEW_FILE_TREE_SCENE_ASSET_EXTENSIONS = new Set([
  '.anim', '.asset', '.bmp', '.controller', '.dds', '.fbx', '.gif', '.jpg',
  '.jpeg', '.mat', '.mp3', '.ogg', '.playable', '.png', '.prefab', '.psd',
  '.rendertexture', '.shadergraph', '.terrainlayer', '.tga', '.tif', '.tiff',
  '.unity', '.wav', '.webm', '.woff', '.woff2',
]);
const REVIEW_FILE_TREE_NAVMESH_EXTENSIONS = new Set([
  '.pathmapasset',
]);
const REVIEW_FILE_TREE_CONFIG_FILE_NAMES = new Set([
  '.gitattributes',
  '.gitignore',
  '.editorconfig',
]);
const REVIEW_FILE_TREE_CONFIG_EXTENSIONS = new Set([
  '.cfg',
  '.conf',
  '.ini',
  '.properties',
  '.toml',
  '.xml',
  '.yaml',
  '.yml',
]);
const REVIEW_FILE_TREE_DOCUMENTATION_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.rst',
  '.txt',
]);
const REVIEW_FILE_TREE_METADATA_EXTENSIONS = new Set([
  '.iml',
  '.pbxproj',
  '.xcuserstate',
  '.xcworkspacedata',
]);
const REVIEW_FILE_TREE_GENERATED_EXTENSIONS = new Set([
  '.lock',
  '.map',
  '.snap',
]);
const REVIEW_FILE_TREE_GENERATED_FILE_NAMES = new Set([
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'podfile.lock',
  'yarn.lock',
]);
const REVIEW_FILE_TREE_BINARY_PLUGIN_EXTENSIONS = new Set([
  '.a',
  '.apk',
  '.aab',
  '.bin',
  '.bundle',
  '.dat',
  '.dll',
  '.dylib',
  '.exe',
  '.ipa',
  '.jar',
  '.lib',
  '.pak',
  '.pdb',
  '.so',
  '.wasm',
]);
const REVIEW_FILE_TREE_BAKED_LIGHTING_FILE_NAMES = new Set([
  'lightingdata.asset',
]);
const REVIEW_FILE_TREE_STATUS_LABELS: Record<string, string> = {
  A: 'Added',
  D: 'Deleted',
  M: 'Modified',
  R: 'Renamed',
};

// ── Helper functions ────────────────────────────────────────────────────

export function normalizeRiskLevel(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

export function normalizeRecommendationSeverity(rec: Pick<ReviewRecommendation, 'type' | 'severity'>): 'low' | 'medium' | 'high' | 'critical' {
  let severity = normalizeRiskLevel(rec?.severity);
  if (rec?.type !== 'issue' && (severity === 'high' || severity === 'critical')) {
    severity = 'medium';
  }
  return severity;
}

export function buildPrCommentSelectionItems(
  recommendations: ReviewRecommendation[],
  options?: {
    publishedByRecommendationKey?: Record<string, { headSha?: string | null }>;
    currentHeadSha?: string | null;
    recommendationResolutions?: RecommendationResolutionMap;
  }
): Array<{
  key: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  location: string | null;
  defaultSelected: boolean;
}> {
  const publishedByRecommendationKey = options?.publishedByRecommendationKey || {};
  const recommendationResolutions = options?.recommendationResolutions || {};
  const hasPublishedComment = (key: string) => {
    const normalizedKey = String(key || '').trim().toLowerCase();
    return Boolean(
      publishedByRecommendationKey[normalizedKey]
      || publishedByRecommendationKey[key]
    );
  };
  const actionable = Array.isArray(recommendations)
    ? recommendations.filter((rec) => {
        if (!rec || rec.type === 'praise') return false;
        if (!rec.file || !Number.isFinite(Number(getRecommendationPatchLine(rec)))) return false;
        const key = getRecommendationFingerprint(rec);
        if (hasPublishedComment(key)) {
          return false;
        }
        const resolution = getRecommendationResolutionFor(rec, recommendationResolutions);
        if (resolution?.state === 'addressed' || resolution?.state === 'dismissed') {
          return false;
        }
        return true;
      })
    : [];

  const severityRank: Record<'low' | 'medium' | 'high' | 'critical', number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return actionable
    .map((rec) => {
      const severity = normalizeRecommendationSeverity(rec);
      return {
        key: getRecommendationFingerprint(rec),
        findingId: String(rec.findingId || '').trim() || undefined,
        title: String(rec.title || 'Atlas finding').trim() || 'Atlas finding',
        severity,
        location: formatRecommendationLocation(rec),
        defaultSelected: severity !== 'low',
      };
    })
    .sort((left, right) => {
      const severityDiff = severityRank[left.severity] - severityRank[right.severity];
      if (severityDiff !== 0) return severityDiff;
      return left.title.localeCompare(right.title);
    });
}

export function buildFixSelectionItems(
  recommendations: ReviewRecommendation[],
): FixSelectionItem[] {
  const actionable = Array.isArray(recommendations)
    ? recommendations.filter((rec) => rec && rec.type !== 'praise')
    : [];
  const hasNonLowFinding = actionable.some((rec) => normalizeRecommendationSeverity(rec) !== 'low');

  const severityRank: Record<'low' | 'medium' | 'high' | 'critical', number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return actionable
    .map((rec) => {
      const severity = normalizeRecommendationSeverity(rec);
      return {
        key: getRecommendationFingerprint(rec),
        findingId: String(rec.findingId || '').trim() || undefined,
        title: String(rec.title || 'Atlas finding').trim() || 'Atlas finding',
        severity,
        location: formatRecommendationLocation(rec),
        defaultSelected: hasNonLowFinding ? severity !== 'low' : true,
      };
    })
    .sort((left, right) => {
      const severityDiff = severityRank[left.severity] - severityRank[right.severity];
      if (severityDiff !== 0) return severityDiff;
      return left.title.localeCompare(right.title);
    });
}

export function buildFixIssueContext(rec: ReviewRecommendation): string {
  const lines: string[] = [];
  const recommendationKey = getRecommendationFingerprint(rec);
  const displayLocation = formatRecommendationDisplayLocation(rec);
  const sourceLocation = formatRecommendationSourceLocation(rec);
  const evidenceSnippet = String(
    rec.sourceAnchor?.snippet
    || rec.evidence?.snippet
    || rec.evidenceSnippet
    || rec.targetSnippet
    || ''
  ).trim();
  const reasoning = String(rec.sourceAnchor?.reasoning || rec.evidence?.reasoning || '').trim();
  const whyItMatters = sanitizeRecommendationDescription(rec.description)
    || buildRecommendationTriageSummary(rec.description)
    || 'Resolve the review finding without changing unrelated behavior.';

  const findingType = String(rec.type || 'issue').trim().toLowerCase();
  const findingId = String(rec.findingId || '').trim();
  if (findingId) {
    lines.push(`Finding ID: ${findingId}`);
  }
  lines.push(`Recommendation key: ${recommendationKey}`);
  lines.push(`Type: ${findingType}`);
  lines.push(`Issue: ${String(rec.title || 'Atlas finding').trim() || 'Atlas finding'}`);
  lines.push(`Severity: ${normalizeRecommendationSeverity(rec).toUpperCase()}`);
  lines.push(`Why it matters: ${whyItMatters}`);
  if (displayLocation) {
    lines.push(`Location: ${displayLocation}`);
  }
  if (sourceLocation && sourceLocation !== displayLocation) {
    lines.push(`Source context: ${sourceLocation}`);
  }
  if (evidenceSnippet) {
    lines.push('Exact snippet / hunk:');
    lines.push('```');
    lines.push(evidenceSnippet);
    lines.push('```');
  }
  if (reasoning) {
    lines.push(`Previous review reasoning: ${reasoning}`);
  }
  const suggestedFix = String(rec.suggestedFix || '').trim();
  if (suggestedFix) {
    lines.push('Reviewer suggested fix (use as a starting hint — verify against actual code before applying):');
    lines.push('```');
    lines.push(suggestedFix);
    lines.push('```');
  }
  lines.push('Acceptance criteria:');
  lines.push('- Fix the issue described above.');
  lines.push('- Preserve the existing reset / runtime semantics unless a safe guard is required.');
  lines.push('- Add or update the smallest tests or validation steps needed.');
  lines.push('Constraints:');
  lines.push('- Keep the patch tightly scoped to the finding.');
  lines.push('- Avoid unrelated refactors, renames, or formatting-only churn.');
  lines.push('Non-goals:');
  lines.push('- Do not rewrite adjacent systems just to satisfy the finding.');
  lines.push('- Do not mark the finding addressed; leave it ready for verification.');

  return lines.join('\n');
}

export function buildFixIssueFilePaths(rec: ReviewRecommendation): string[] {
  return Array.from(new Set(
    [
      rec.file,
      rec.sourceAnchor?.file,
      rec.patchAnchor?.file,
      rec.evidence?.file,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )).sort();
}

export function getRecommendationEvidencePreview(
  rec: Pick<ReviewRecommendation, 'evidenceSnippet' | 'evidence' | 'suggestedFix'>,
  options?: {
    maxLines?: number;
    maxLineLength?: number;
  },
): string | null {
  const maxLines = Math.max(1, options?.maxLines ?? 3);
  const maxLineLength = Math.max(32, options?.maxLineLength ?? 120);
  const rawSnippet = String(rec?.evidence?.snippet || rec?.evidenceSnippet || '').trim();
  const fallbackSnippet = String(rec?.suggestedFix || '').trim();
  const source = rawSnippet || fallbackSnippet;
  if (!source) return null;

  const clippedLines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line, index, lines) => {
      if (line.trim()) return true;
      return lines.length === 1 || index === 0 || index === lines.length - 1;
    })
    .slice(0, maxLines)
    .map((line) => (
      line.length > maxLineLength
        ? `${line.slice(0, Math.max(0, maxLineLength - 1)).trimEnd()}…`
        : line
    ));

  return clippedLines.length > 0 ? clippedLines.join('\n') : null;
}

export function getRecommendationSuggestedFixPreview(
  suggestedFix: string | null | undefined,
  options?: {
    maxLines?: number;
    maxLineLength?: number;
  },
): { preview: string | null; truncated: boolean } {
  const maxLines = Math.max(1, options?.maxLines ?? 5);
  const maxLineLength = Math.max(32, options?.maxLineLength ?? 160);
  const source = String(suggestedFix || '').trim();
  if (!source) {
    return { preview: null, truncated: false };
  }

  const normalizedLines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line, index, lines) => {
      if (line.trim()) return true;
      return lines.length === 1 || index === 0 || index === lines.length - 1;
    });
  const clippedLines = normalizedLines
    .slice(0, maxLines)
    .map((line) => (
      line.length > maxLineLength
        ? `${line.slice(0, Math.max(0, maxLineLength - 1)).trimEnd()}…`
        : line
    ));

  return {
    preview: clippedLines.length > 0 ? clippedLines.join('\n') : null,
    truncated: normalizedLines.length > clippedLines.length,
  };
}

const GENERIC_IMPACT_SENTENCE = /(?:^|\s)Impact:\s*This may cause correctness, security, data integrity, or availability issues\.?/gi;
const GENERIC_RISK_SENTENCE = /This may cause correctness, security, data integrity, or availability issues\.?/gi;

export function sanitizeRecommendationDescription(description: string | null | undefined): string {
  return String(description || '')
    .replace(GENERIC_IMPACT_SENTENCE, ' ')
    .replace(GENERIC_RISK_SENTENCE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildRecommendationCopyText(
  rec: Pick<ReviewRecommendation, 'findingId' | 'type' | 'severity' | 'title' | 'description' | 'file' | 'line' | 'suggestedFix' | 'evidenceSnippet' | 'evidence'>,
): string {
  const severity = normalizeRecommendationSeverity(rec).toUpperCase();
  const type = String(rec.type || 'issue').trim().toUpperCase();
  const title = String(rec.title || '').trim() || 'Untitled finding';
  const description = sanitizeRecommendationDescription(rec.description);
  const location = formatRecommendationLocation(rec as ReviewRecommendation);
  const evidence = getRecommendationEvidencePreview(rec, { maxLines: 4, maxLineLength: 160 });
  const suggestedFix = String(rec.suggestedFix || '').trim();
  const lines = [`[${type}] ${severity} — ${title}`];
  const findingId = String(rec.findingId || '').trim();

  if (findingId) {
    lines.push('', `Finding ID: ${findingId}`);
  }

  if (description) {
    lines.push('', description);
  }
  if (location) {
    lines.push('', `Location: ${location}`);
  }
  if (evidence) {
    lines.push('', 'Evidence:', evidence);
  }
  if (suggestedFix) {
    lines.push('', 'Suggested fix:', suggestedFix);
  }

  return lines.join('\n');
}

export function buildRecommendationTriageSummary(
  description: string | null | undefined,
  options?: {
    maxSentences?: number;
    maxChars?: number;
  },
): string | null {
  const maxSentences = Math.max(1, options?.maxSentences ?? 2);
  const maxChars = Math.max(80, options?.maxChars ?? 220);
  const cleaned = sanitizeRecommendationDescription(description);
  if (!cleaned) return null;

  const sentences = cleaned.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((part) => part.trim()).filter(Boolean) || [cleaned];
  const selected: string[] = [];
  let currentLength = 0;

  for (const sentence of sentences) {
    const projectedLength = currentLength + (selected.length > 0 ? 1 : 0) + sentence.length;
    if (selected.length >= maxSentences || (selected.length > 0 && projectedLength > maxChars)) {
      break;
    }
    selected.push(sentence);
    currentLength = projectedLength;
    if (projectedLength >= maxChars) break;
  }

  const summary = (selected.length > 0 ? selected.join(' ') : cleaned).trim();
  if (summary.length <= maxChars) return summary;
  return `${summary.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function getRecommendationEvidenceFocus(
  rec: Pick<ReviewRecommendation, 'evidenceSnippet' | 'evidence'>,
  previewText?: string | null,
): string | null {
  const preview = String(previewText || '').trim();
  const rawSnippet = String(rec?.evidence?.snippet || rec?.evidenceSnippet || '').trim();
  if (!preview || !rawSnippet) return null;

  const candidates = rawSnippet
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const candidate of candidates) {
    if (candidate.length < preview.length && candidate.length <= 96 && preview.includes(candidate)) {
      return candidate;
    }
  }

  if (rawSnippet.length < preview.length && rawSnippet.length <= 96 && preview.includes(rawSnippet)) {
    return rawSnippet;
  }

  return null;
}

export function buildReviewOutcomeProgress(totalFindings: number, addressedCount: number, dismissedCount: number) {
  const total = Math.max(0, Number(totalFindings) || 0);
  const addressed = Math.max(0, Number(addressedCount) || 0);
  const dismissed = Math.max(0, Number(dismissedCount) || 0);
  const resolvedCount = Math.min(total, addressed + dismissed);
  const percent = total > 0 ? Math.max(0, Math.min(100, (resolvedCount / total) * 100)) : 0;

  return {
    total,
    addressed,
    dismissed,
    resolvedCount,
    unresolvedCount: Math.max(0, total - resolvedCount),
    percent,
    label: total > 0 ? `${resolvedCount}/${total} resolved` : 'No findings',
  };
}

export function getEffectiveReviewRiskLevel(review: Pick<ReviewResult, 'riskLevel' | 'changeGroups' | 'recommendations'>): 'low' | 'medium' | 'high' | 'critical' {
  const actionableRecommendations = (Array.isArray(review.recommendations) ? review.recommendations : [])
    .filter((rec) => rec && rec.type !== 'praise');

  // Keep UI aligned with visible actionable findings.
  if (actionableRecommendations.length > 0) {
    let highest: 'low' | 'medium' | 'high' | 'critical' = 'low';
    for (const rec of actionableRecommendations) {
      const severity = normalizeRecommendationSeverity(rec);
      if (RISK_ORDER[severity] > RISK_ORDER[highest]) {
        highest = severity;
      }
    }
    return highest;
  }

  let effective = normalizeRiskLevel(review.riskLevel);

  for (const group of Array.isArray(review.changeGroups) ? review.changeGroups : []) {
    const groupRisk = normalizeRiskLevel(group?.risk);
    if (RISK_ORDER[groupRisk] > RISK_ORDER[effective]) {
      effective = groupRisk;
    }
  }

  return effective;
}

function pathExtension(filePath: string): string {
  const normalizedPath = String(filePath || '').trim().toLowerCase();
  const slashIndex = normalizedPath.lastIndexOf('/');
  const fileName = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex) : '';
}

function baseFileName(filePath: string): string {
  const normalizedPath = String(filePath || '').trim();
  const slashIndex = normalizedPath.lastIndexOf('/');
  return slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
}

function parentDirectory(filePath: string): string | null {
  const normalizedPath = String(filePath || '').trim();
  const slashIndex = normalizedPath.lastIndexOf('/');
  return slashIndex > 0 ? normalizedPath.slice(0, slashIndex) : null;
}

function hasPathSegment(path: string, segment: string): boolean {
  return path.includes(`/${segment}/`) || path.startsWith(`${segment}/`);
}

function resolveFileTreeStatusLabel(status: string): string {
  const normalizedStatus = String(status || '').trim().charAt(0).toUpperCase() || 'M';
  return REVIEW_FILE_TREE_STATUS_LABELS[normalizedStatus] || REVIEW_FILE_TREE_STATUS_LABELS.M;
}

function compareRiskLevels(a: RiskLevel | null, b: RiskLevel | null): number {
  const left = a ? RISK_ORDER[a] : -1;
  const right = b ? RISK_ORDER[b] : -1;
  return right - left;
}

function isUnityBakedLightingArtifact(normalizedPath: string, fileName: string, extension: string): boolean {
  const isBakeFolder = normalizedPath.includes('/lightmaps/') || normalizedPath.includes('/lighting/');
  const isLikelySceneLevelPath = normalizedPath.includes('/level design/')
    || normalizedPath.includes('/levels/')
    || normalizedPath.includes('/scenes/')
    || normalizedPath.includes('/maps/');

  if (REVIEW_FILE_TREE_BAKED_LIGHTING_FILE_NAMES.has(fileName)) {
    return isBakeFolder || isLikelySceneLevelPath;
  }

  if (fileName.startsWith('lightmap-')) {
    if (extension === '.exr') {
      return isBakeFolder || isLikelySceneLevelPath;
    }
    return isBakeFolder && extension === '.png';
  }

  if (normalizedPath.includes('/lightmaps/')) {
    return extension === '.exr' || extension === '.asset';
  }

  return false;
}

export function classifyReviewFilePath(filePath: string): {
  fileClass: ReviewFileTreeFileClass;
  bucketId: ReviewFileTreeBucketId | null;
  bucketLabel: string | null;
  isCode: boolean;
} {
  const normalizedPath = String(filePath || '').trim().toLowerCase();
  const extension = pathExtension(normalizedPath);
  const fileName = baseFileName(normalizedPath);

  if (extension === '.meta') {
    return { fileClass: 'metadata', bucketId: 'metadata_files', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.metadata_files.label, isCode: false };
  }

  if (REVIEW_FILE_TREE_CONFIG_FILE_NAMES.has(fileName) || REVIEW_FILE_TREE_CONFIG_EXTENSIONS.has(extension)) {
    return { fileClass: 'config', bucketId: 'config_files', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.config_files.label, isCode: false };
  }

  if (
    REVIEW_FILE_TREE_METADATA_EXTENSIONS.has(extension)
    || normalizedPath.includes('.xcodeproj/')
    || normalizedPath.includes('.xcworkspace/')
  ) {
    return { fileClass: 'metadata', bucketId: 'metadata_files', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.metadata_files.label, isCode: false };
  }

  if (
    REVIEW_FILE_TREE_DOCUMENTATION_EXTENSIONS.has(extension)
    || hasPathSegment(normalizedPath, 'docs')
    || hasPathSegment(normalizedPath, '.planning')
    || fileName === 'readme'
    || fileName.startsWith('readme.')
    || fileName === 'changelog'
    || fileName.startsWith('changelog.')
  ) {
    return { fileClass: 'documentation', bucketId: 'documentation', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.documentation.label, isCode: false };
  }

  if (
    extension === '.xml'
    && (
      hasPathSegment(normalizedPath, 'metadata')
      || hasPathSegment(normalizedPath, 'usersettings')
      || /^\{[0-9a-f-]+\}\.xml$/.test(fileName)
    )
  ) {
    return { fileClass: 'generated', bucketId: 'generated_data', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.generated_data.label, isCode: false };
  }

  if (
    normalizedPath.includes('navmesh')
    || fileName.includes('navmesh')
    || REVIEW_FILE_TREE_NAVMESH_EXTENSIONS.has(extension)
    || fileName.includes('pathmap')
  ) {
    return { fileClass: 'generated', bucketId: 'generated_data', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.generated_data.label, isCode: false };
  }

  if (isUnityBakedLightingArtifact(normalizedPath, fileName, extension)) {
    return { fileClass: 'generated', bucketId: 'baked_lighting', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.baked_lighting.label, isCode: false };
  }

  if (
    REVIEW_FILE_TREE_BINARY_PLUGIN_EXTENSIONS.has(extension)
    || normalizedPath.includes('/plugins/')
  ) {
    return { fileClass: 'binary_artifact', bucketId: 'binary_artifacts', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.binary_artifacts.label, isCode: false };
  }

  if (
    REVIEW_FILE_TREE_GENERATED_FILE_NAMES.has(fileName)
    || REVIEW_FILE_TREE_GENERATED_EXTENSIONS.has(extension)
    || fileName.includes('.min.')
    || hasPathSegment(normalizedPath, 'dist')
    || hasPathSegment(normalizedPath, 'build')
    || hasPathSegment(normalizedPath, 'coverage')
    || hasPathSegment(normalizedPath, 'target')
    || hasPathSegment(normalizedPath, 'generated')
    || hasPathSegment(normalizedPath, '__snapshots__')
  ) {
    return { fileClass: 'generated', bucketId: 'generated_data', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.generated_data.label, isCode: false };
  }

  if (REVIEW_FILE_TREE_CODE_EXTENSIONS.has(extension)) {
    return { fileClass: 'code', bucketId: null, bucketLabel: null, isCode: true };
  }

  if (REVIEW_FILE_TREE_SCENE_ASSET_EXTENSIONS.has(extension)) {
    return { fileClass: 'asset_media', bucketId: 'assets_media', bucketLabel: REVIEW_FILE_TREE_BUCKET_META.assets_media.label, isCode: false };
  }

  return { fileClass: 'other', bucketId: null, bucketLabel: null, isCode: false };
}

function computeReviewFileStats(file: ReviewFileTreeSourceFile): { additions: number; deletions: number } {
  const additions = Number(file.additions);
  const deletions = Number(file.deletions);
  if (Number.isFinite(additions) && Number.isFinite(deletions)) {
    return {
      additions: Math.max(0, additions),
      deletions: Math.max(0, deletions),
    };
  }

  const diffLines = computeUnifiedDiff(file.before ?? null, file.after ?? null);
  let computedAdditions = 0;
  let computedDeletions = 0;
  for (const line of diffLines) {
    if (line.type === 'add') computedAdditions += 1;
    if (line.type === 'del') computedDeletions += 1;
  }
  return { additions: computedAdditions, deletions: computedDeletions };
}

function compareReviewFileTreeEntries(a: ReviewFileTreeEntry, b: ReviewFileTreeEntry): number {
  if (a.findingCount !== b.findingCount) return b.findingCount - a.findingCount;
  if (a.isRisky !== b.isRisky) return a.isRisky ? -1 : 1;
  if (a.isCode !== b.isCode) return a.isCode ? -1 : 1;
  const riskCompare = compareRiskLevels(a.highestFindingSeverity, b.highestFindingSeverity);
  if (riskCompare !== 0) return riskCompare;
  return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
}

function buildReviewFileTreeFilter(id: ReviewFileTreeFilterId, label: string, entries: ReviewFileTreeEntry[]): ReviewFileTreeFilter {
  return {
    id,
    label,
    count: entries.length,
    paths: entries.map((entry) => entry.path),
  };
}

export function buildReviewFileTree(args: {
  files: ReviewFileTreeSourceFile[];
  review: ReviewResult | null | undefined;
  recommendationResolutions?: RecommendationResolutionMap;
}): ReviewFileTreeModel {
  const recommendationResolutions = args.recommendationResolutions || {};
  const files = Array.isArray(args.files) ? args.files : [];
  const review = args.review;
  const actionableRecommendationsByFile = new Map<string, ReviewRecommendation[]>();

  for (const rec of (review?.recommendations || [])) {
    if (rec.type === 'praise' || getRecommendationResolutionFor(rec, recommendationResolutions)) {
      continue;
    }

    const recPath = String(rec.file || '').trim();
    if (!recPath) continue;

    const existing = actionableRecommendationsByFile.get(recPath);
    if (existing) {
      existing.push(rec);
    } else {
      actionableRecommendationsByFile.set(recPath, [rec]);
    }
  }

  const entries = files
    .filter((file) => file && typeof file.path === 'string' && file.path.trim().length > 0)
    .map((file) => {
      const path = String(file.path).trim();
      const oldPath = typeof file.oldPath === 'string' && file.oldPath.trim().length > 0
        ? file.oldPath.trim()
        : null;
      const { additions, deletions } = computeReviewFileStats(file);
      const classification = classifyReviewFilePath(path);
      const pathRecommendations = actionableRecommendationsByFile.get(path) || [];
      const oldPathRecommendations = oldPath ? (actionableRecommendationsByFile.get(oldPath) || []) : [];
      let highestFindingSeverity: RiskLevel | null = null;

      for (const rec of pathRecommendations) {
        const severity = normalizeRecommendationSeverity(rec);
        if (!highestFindingSeverity || RISK_ORDER[severity] > RISK_ORDER[highestFindingSeverity]) {
          highestFindingSeverity = severity;
        }
      }
      for (const rec of oldPathRecommendations) {
        const severity = normalizeRecommendationSeverity(rec);
        if (!highestFindingSeverity || RISK_ORDER[severity] > RISK_ORDER[highestFindingSeverity]) {
          highestFindingSeverity = severity;
        }
      }

      const findingCount = pathRecommendations.length + oldPathRecommendations.length;
      const isRisky = findingCount > 0;
      const bucketId = (!isRisky && findingCount === 0 && !classification.isCode)
        ? classification.bucketId
        : null;
      const status = String(file.status || '').trim().toUpperCase() || (file.before == null ? 'A' : file.after == null ? 'D' : 'M');
      return {
        path,
        oldPath,
        fileName: baseFileName(path),
        directory: parentDirectory(path),
        additions,
        deletions,
        status,
        statusLabel: resolveFileTreeStatusLabel(status),
        fileClass: classification.fileClass,
        bucketId,
        bucketLabel: bucketId ? classification.bucketLabel : null,
        findingCount,
        highestFindingSeverity,
        isRisky,
        isCode: classification.isCode,
      } satisfies ReviewFileTreeEntry;
    });

  const standaloneEntries: ReviewFileTreeEntry[] = [];
  const entriesByBucket = new Map<ReviewFileTreeBucketId, ReviewFileTreeEntry[]>();

  for (const entry of entries) {
    if (!entry.bucketId) {
      standaloneEntries.push(entry);
      continue;
    }
    const bucketEntries = entriesByBucket.get(entry.bucketId);
    if (bucketEntries) {
      bucketEntries.push(entry);
    } else {
      entriesByBucket.set(entry.bucketId, [entry]);
    }
  }

  standaloneEntries.sort(compareReviewFileTreeEntries);

  const buckets = REVIEW_FILE_TREE_BUCKET_ORDER
    .map((bucketId) => {
      const bucketEntries = entriesByBucket.get(bucketId);
      if (!bucketEntries || bucketEntries.length === 0) return null;
      bucketEntries.sort(compareReviewFileTreeEntries);
      return {
        id: bucketId,
        label: REVIEW_FILE_TREE_BUCKET_META[bucketId].label,
        defaultCollapsed: REVIEW_FILE_TREE_BUCKET_META[bucketId].defaultCollapsed,
        entries: bucketEntries,
      } satisfies ReviewFileTreeBucket;
    })
    .filter(Boolean) as ReviewFileTreeBucket[];

  return {
    totalCount: entries.length,
    activeFilterId: 'all',
    standaloneEntries,
    buckets,
    filters: {
      all: buildReviewFileTreeFilter('all', 'All', entries),
      risky: buildReviewFileTreeFilter('risky', 'Risky', entries.filter((entry) => entry.isRisky)),
      code_only: buildReviewFileTreeFilter('code_only', 'Code only', entries.filter((entry) => entry.isCode)),
    },
  };
}

export function getReviewFileTreeVisibleState(args: {
  tree: ReviewFileTreeModel;
  activePaths?: string[] | null;
}): ReviewFileTreeVisibleState {
  const activePathSet = new Set(
    (args.activePaths || [])
      .map((path) => String(path || '').trim())
      .filter(Boolean)
  );
  const hasActivePaths = activePathSet.size > 0;
  if (!hasActivePaths) {
    return {
      standaloneEntries: args.tree.standaloneEntries,
      buckets: args.tree.buckets,
      totalVisibleCount: args.tree.totalCount,
    };
  }

  const standaloneEntries = args.tree.standaloneEntries.filter((entry) => (
    activePathSet.has(entry.path) || (entry.oldPath ? activePathSet.has(entry.oldPath) : false)
  ));
  const buckets = args.tree.buckets
    .map((bucket) => ({
      ...bucket,
      entries: bucket.entries.filter((entry) => (
        activePathSet.has(entry.path) || (entry.oldPath ? activePathSet.has(entry.oldPath) : false)
      )),
    }))
    .filter((bucket) => bucket.entries.length > 0);

  const totalVisibleCount = standaloneEntries.length + buckets.reduce((sum, bucket) => sum + bucket.entries.length, 0);
  return { standaloneEntries, buckets, totalVisibleCount };
}

export function flattenReviewFileTreeEntriesByFolder(entries: ReviewFileTreeEntry[]): ReviewFileTreeEntry[] {
  type FolderOrderNode = {
    children: Map<string, FolderOrderNode>;
    files: ReviewFileTreeEntry[];
  };

  const root: FolderOrderNode = { children: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    parts.pop();
    let current = root;
    for (const part of parts) {
      let child = current.children.get(part);
      if (!child) {
        child = { children: new Map(), files: [] };
        current.children.set(part, child);
      }
      current = child;
    }
    current.files.push(entry);
  }

  const ordered: ReviewFileTreeEntry[] = [];
  const visit = (node: FolderOrderNode) => {
    for (const child of node.children.values()) {
      visit(child);
    }
    ordered.push(...node.files);
  };
  visit(root);
  return ordered;
}

export function normalizeReviewTier(review: ReviewResult | null | undefined): ReviewTier {
  if (!review || typeof review !== 'object') return 'failed';
  const rawTier = String(review.stats?.reviewTier || '').trim().toLowerCase();
  if (rawTier === 'full' || rawTier === 'partial' || rawTier === 'files_only' || rawTier === 'failed') {
    return rawTier;
  }
  const partialFlag = review.stats?.isPartial === true;
  const failedFileCount = Math.max(0, Number(review.stats?.perFileFailedFiles || 0));
  const hasGroups = Array.isArray(review.changeGroups) && review.changeGroups.length > 0;
  const hasRecs = Array.isArray(review.recommendations) && review.recommendations.length > 0;
  if (partialFlag || failedFileCount > 0) return 'partial';
  if (hasRecs && !hasGroups) return 'files_only';
  return 'full';
}

export function isActiveReviewProgressPhase(phase?: string): boolean {
  const normalized = String(phase || '').toLowerCase();
  return normalized === 'reviewing'
    || normalized === 'running'
    || normalized === 'retrying'
    || normalized === 'preparing_files'
    || normalized === 'file_triage'
    || normalized === 'file_review_start'
    || normalized === 'file_review_inflight'
    || normalized === 'file_review_failed'
    || normalized === 'file_partial'
    || normalized === 'single_start'
    || normalized === 'single_inflight'
    || normalized === 'chunk_start'
    || normalized === 'chunk_inflight'
    || normalized === 'chunk_split'
    || normalized === 'provider_retry'
    || normalized === 'synthesizing'
    || normalized === 'agentic_exploration'
    || normalized === 'agentic_tool_use';
}

export function computeProgressPercent({
  phase,
  filesCompleted,
  totalFiles,
  currentChunk,
  totalChunks,
  activeChunkFiles,
  isRunActive,
  isLifecycleTerminal,
}: {
  phase?: string;
  filesCompleted?: number;
  totalFiles?: number;
  currentChunk?: number;
  totalChunks?: number;
  activeChunkFiles?: number;
  isRunActive?: boolean;
  isLifecycleTerminal?: boolean;
}): number {
  const safeTotalFiles = Math.max(0, Number(totalFiles) || 0);
  const safeFilesCompleted = Math.max(0, Math.min(safeTotalFiles, Number(filesCompleted) || 0));
  const safeActiveChunkFiles = Math.max(0, Number(activeChunkFiles) || 0);
  // Progress events can arrive out-of-order and briefly report impossible states
  // (e.g., completed + in-flight > total). Clamp to a coherent completed count.
  const overlap = safeTotalFiles > 0
    ? Math.max(0, (safeFilesCompleted + safeActiveChunkFiles) - safeTotalFiles)
    : 0;
  const effectiveCompleted = Math.max(0, safeFilesCompleted - overlap);
  const rawPercent = safeTotalFiles > 0
    ? Math.round((effectiveCompleted / safeTotalFiles) * 100)
    : 0;
  if (rawPercent < 100) return rawPercent;

  // When lifecycle is terminal, the review is done — never cap at 99%.
  if (isLifecycleTerminal) return 100;

  const normalizedPhase = String(phase || '').trim().toLowerCase();
  const hasActivePhase = normalizedPhase === 'queued' || isActiveReviewProgressPhase(normalizedPhase);
  const hasInflightFiles = safeActiveChunkFiles > 0;
  const hasPendingChunks = Math.max(0, Number(totalChunks) || 0) > Math.max(0, Number(currentChunk) || 0);
  const shouldCapAtNinetyNine = Boolean(
    safeTotalFiles > 0
    && (isRunActive || hasActivePhase)
    && (hasInflightFiles || hasPendingChunks || (hasActivePhase && !normalizedPhase.includes('complete')))
  );

  return shouldCapAtNinetyNine ? 99 : rawPercent;
}

export function normalizeLegacyReviewStatusValue(
  value: unknown,
  fallback: 'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed' = 'none'
): 'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed' {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'none'
    || normalized === 'queued'
    || normalized === 'reviewing'
    || normalized === 'reviewed'
    || normalized === 'failed'
  ) {
    return normalized;
  }
  return fallback;
}

export function normalizeLifecycleStatusValue(
  value: unknown,
  fallback: ReviewLifecycleStatus = 'queued'
): ReviewLifecycleStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'queued'
    || normalized === 'running'
    || normalized === 'retrying'
    || normalized === 'partial'
    || normalized === 'failed'
    || normalized === 'completed'
  ) {
    return normalized;
  }
  if (
    normalized === 'none'
    || normalized === 'reviewing'
    || normalized === 'reviewed'
  ) {
    return LEGACY_REVIEW_STATUS_TO_LIFECYCLE[normalized];
  }
  return fallback;
}

export function isActiveLifecycleStatus(status: unknown): boolean {
  return ACTIVE_LIFECYCLE_STATUSES.has(normalizeLifecycleStatusValue(status, 'completed'));
}

export function buildOptimisticQueuedLifecycle(updatedAt: string, reviewedAt?: string | null) {
  return {
    status: 'queued' as ReviewLifecycleStatus,
    phase: 'queued',
    isActive: true,
    isTerminal: false,
    canRetry: false,
    error: null,
    updatedAt,
    reviewedAt: reviewedAt || null,
    sourceStatus: 'queued',
  };
}

export function buildGitHubCompareUrl(owner: string, repo: string, baseBranch: string, branchName: string): string {
  const safeOwner = String(owner || '').trim();
  const safeRepo = String(repo || '').trim();
  const safeBase = String(baseBranch || '').trim();
  const safeBranch = String(branchName || '').trim();
  if (!safeOwner || !safeRepo || !safeBase || !safeBranch) return '';
  return `https://github.com/${safeOwner}/${safeRepo}/compare/${encodeURIComponent(safeBase)}...${encodeURIComponent(safeBranch)}`;
}

export function parseScopePatterns(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function buildScopeStatusLabel(args: {
  includeCount: number;
  excludeCount: number;
  applyGlobalIgnorePatterns: boolean;
  globalIgnorePatternCount: number;
}): string {
  return [
    args.includeCount > 0 || args.excludeCount > 0
      ? `${args.includeCount} include • ${args.excludeCount} scoped exclude`
      : 'all files',
    args.applyGlobalIgnorePatterns
      ? `global ignore ${args.globalIgnorePatternCount}`
      : 'global ignore off',
  ].join(' • ');
}

export function getReviewCoverageStats(review: ReviewResult, contextFileCount?: number): ReviewCoverageStats {
  const stats: Partial<ReviewResult['stats']> = (review?.stats && typeof review.stats === 'object')
    ? review.stats
    : {};
  const analyzedFiles = Math.max(
    0,
    Number(
      stats.deepReviewedFiles
      ?? stats.filesDeepReviewed
      ?? stats.filesAnalyzed
      ?? 0
    )
  );
  const totalFiles = Math.max(
    0,
    Number(
      stats.fileCount
      ?? stats.totalChangedFiles
      ?? contextFileCount
      ?? stats.filesTotal
      ?? stats.filesAnalyzed
      ?? 0
    )
  );
  const omittedFiles = Math.max(
    Number(stats.omittedFiles || 0),
    totalFiles > 0 ? Math.max(0, totalFiles - Math.min(analyzedFiles, totalFiles)) : 0
  );
  const cacheHits = Math.max(0, Number(stats.perFileCacheHits || 0));
  const cacheMisses = Math.max(0, Number(stats.perFileCacheMisses || 0));
  const cacheLabel = (cacheHits + cacheMisses) > 0
    ? `${cacheHits}/${cacheHits + cacheMisses} cached reuse`
    : null;
  const coverageLabel = totalFiles > 0
    ? `${Math.min(analyzedFiles, totalFiles)}/${totalFiles} files • ${omittedFiles} omitted`
    : `${stats.filesAnalyzed || 0} files analyzed`;
  const chunkLabel = (stats.chunkCount || 0) > 1
    ? `${stats.chunkCount} chunks`
    : null;
  const focusedLabel = stats.reviewMode === 'focused' || omittedFiles > 0
    ? 'Focused deep analysis'
    : 'Full deep analysis';

  return {
    analyzedFiles: totalFiles > 0 ? Math.min(analyzedFiles, totalFiles) : analyzedFiles,
    totalFiles,
    omittedFiles,
    cacheHits,
    cacheMisses,
    coverageLabel,
    cacheLabel,
    focusedLabel,
    chunkLabel,
  };
}

function shortenSha(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return null;
  return normalized.slice(0, 7);
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function getDiffScopeSummaryFromStats(
  stats: Partial<ReviewResult['stats']> | null | undefined,
  fallbackTotalFiles?: number
): ReviewDiffScopeSummary | null {
  const safeStats: Partial<ReviewResult['stats']> = (stats && typeof stats === 'object')
    ? stats
    : {};
  const mode = safeStats.diffScopeMode === 'delta' ? 'delta' : safeStats.diffScopeMode === 'full' ? 'full' : null;
  if (!mode) return null;

  const parts: string[] = [mode === 'delta' ? 'Incremental review' : 'Full review'];
  const commitCount = Math.max(0, Number(safeStats.diffScopeCommitCount || 0));
  if (commitCount > 0) {
    parts.push(pluralize(commitCount, 'commit'));
  }

  const totalFiles = Math.max(
    0,
    Number(
      safeStats.fileCount
      ?? safeStats.totalChangedFiles
      ?? fallbackTotalFiles
      ?? safeStats.filesTotal
      ?? 0
    )
  );
  if (totalFiles > 0) {
    parts.push(pluralize(totalFiles, 'file'));
  }

  const baseSha = shortenSha(safeStats.diffBaseSha);
  const headSha = shortenSha(safeStats.diffHeadSha);
  if (baseSha && headSha) {
    parts.push(`${baseSha}..${headSha}`);
  } else if (headSha) {
    parts.push(headSha);
  }

  const longLabel = parts.join(' · ');
  return {
    mode,
    shortLabel: mode === 'delta' ? 'Incremental review' : 'Full review',
    longLabel,
  };
}

export function getReviewDiffScopeSummary(
  review: Pick<ReviewResult, 'stats'> | null | undefined,
  fallbackTotalFiles?: number
): ReviewDiffScopeSummary | null {
  const stats: Partial<ReviewResult['stats']> = (review?.stats && typeof review.stats === 'object')
    ? review.stats
    : {};
  return getDiffScopeSummaryFromStats(stats, fallbackTotalFiles);
}

export function getReviewPrecisionStats(review: ReviewResult): ReviewPrecisionStats {
  const stats: Partial<ReviewResult['stats']> = (review?.stats && typeof review.stats === 'object')
    ? review.stats
    : {};
  const grounded = Math.max(0, Number(stats.issuesGrounded || 0));
  const demoted = Math.max(0, Number(stats.issuesDemoted || 0));
  const suppressed = Math.max(0, Number(stats.issuesSuppressed || 0));
  const declaredTotal = Math.max(0, Number(stats.issuesTotal || 0));
  const verifierSupported = Math.max(0, Number(stats.verifierSupported || 0));
  const verifierUnsupported = Math.max(0, Number(stats.verifierUnsupported || 0));
  const verifierNeedsMoreContext = Math.max(0, Number(
    stats.verifierNeedsMoreContext ?? stats.verifierNeedsContext ?? 0
  ));
  const verifierSkippedBudget = Math.max(0, Number(stats.verifierSkippedBudget || 0));
  const corroborationChecked = Math.max(0, Number(
    stats.corroborationChecked
    ?? stats.corroboration?.checked
    ?? 0
  ));
  const corroborationSupported = Math.max(0, Number(
    stats.corroborationSupported
    ?? stats.corroboration?.supported
    ?? 0
  ));
  const corroborationUnsupported = Math.max(0, Number(
    stats.corroborationUnsupported
    ?? stats.corroboration?.unsupported
    ?? 0
  ));
  const corroborationDowngraded = Math.max(0, Number(
    stats.corroborationDowngraded
    ?? stats.corroboration?.downgraded
    ?? 0
  ));
  const outcomeSuppressionChecked = Math.max(0, Number(
    stats.outcomeSuppressionChecked
    ?? stats.outcomeSuppression?.checked
    ?? 0
  ));
  const outcomeSuppressionSuppressed = Math.max(0, Number(
    stats.outcomeSuppressionSuppressed
    ?? stats.outcomeSuppression?.suppressed
    ?? 0
  ));
  const issuesTotal = Math.max(declaredTotal, grounded + demoted + suppressed);
  const normalizedGrounded = Math.min(grounded, issuesTotal);
  const normalizedDemoted = Math.min(demoted, issuesTotal);
  const normalizedSuppressed = Math.min(suppressed, issuesTotal);
  const normalizedVerifierSupported = Math.max(0, Math.trunc(verifierSupported));
  const normalizedVerifierUnsupported = Math.max(0, Math.trunc(verifierUnsupported));
  const normalizedVerifierNeedsMoreContext = Math.max(0, Math.trunc(verifierNeedsMoreContext));
  const normalizedVerifierSkippedBudget = Math.max(0, Math.trunc(verifierSkippedBudget));
  const normalizedCorroborationChecked = Math.max(0, Math.trunc(corroborationChecked));
  const normalizedCorroborationSupported = Math.max(0, Math.trunc(corroborationSupported));
  const normalizedCorroborationUnsupported = Math.max(0, Math.trunc(corroborationUnsupported));
  const normalizedCorroborationDowngraded = Math.max(0, Math.trunc(corroborationDowngraded));
  const normalizedOutcomeSuppressionChecked = Math.max(0, Math.trunc(outcomeSuppressionChecked));
  const normalizedOutcomeSuppressionSuppressed = Math.max(0, Math.trunc(outcomeSuppressionSuppressed));

  if (issuesTotal === 0) {
    const hasVerifierCounters =
      normalizedVerifierSupported > 0
      || normalizedVerifierUnsupported > 0
      || normalizedVerifierNeedsMoreContext > 0
      || normalizedVerifierSkippedBudget > 0;
    const hasCorroborationCounters =
      normalizedCorroborationChecked > 0
      || normalizedCorroborationSupported > 0
      || normalizedCorroborationUnsupported > 0
      || normalizedCorroborationDowngraded > 0;
    const hasSuppressionCounters =
      normalizedOutcomeSuppressionChecked > 0
      || normalizedOutcomeSuppressionSuppressed > 0;
    const verifierDetailParts = [];
    if (normalizedVerifierSupported > 0) {
      verifierDetailParts.push(`${normalizedVerifierSupported} supported`);
    }
    if (normalizedVerifierUnsupported > 0) {
      verifierDetailParts.push(`${normalizedVerifierUnsupported} unsupported`);
    }
    if (normalizedVerifierNeedsMoreContext > 0) {
      verifierDetailParts.push(`${normalizedVerifierNeedsMoreContext} needs context`);
    }
    if (normalizedVerifierSkippedBudget > 0) {
      verifierDetailParts.push(`${normalizedVerifierSkippedBudget} skipped budget`);
    }
    if (normalizedCorroborationChecked > 0) {
      verifierDetailParts.push(`${normalizedCorroborationChecked} corroboration checks`);
    }
    if (normalizedCorroborationDowngraded > 0) {
      verifierDetailParts.push(`${normalizedCorroborationDowngraded} downgraded`);
    }
    if (normalizedOutcomeSuppressionChecked > 0) {
      verifierDetailParts.push(`${normalizedOutcomeSuppressionChecked} suppression checks`);
    }
    if (normalizedOutcomeSuppressionSuppressed > 0) {
      verifierDetailParts.push(`${normalizedOutcomeSuppressionSuppressed} suppression-filtered`);
    }
    return {
      issuesTotal,
      issuesGrounded: normalizedGrounded,
      issuesDemoted: normalizedDemoted,
      issuesSuppressed: normalizedSuppressed,
      verifierSupported: normalizedVerifierSupported,
      verifierUnsupported: normalizedVerifierUnsupported,
      verifierNeedsMoreContext: normalizedVerifierNeedsMoreContext,
      verifierSkippedBudget: normalizedVerifierSkippedBudget,
      corroborationChecked: normalizedCorroborationChecked,
      corroborationSupported: normalizedCorroborationSupported,
      corroborationUnsupported: normalizedCorroborationUnsupported,
      corroborationDowngraded: normalizedCorroborationDowngraded,
      outcomeSuppressionChecked: normalizedOutcomeSuppressionChecked,
      outcomeSuppressionSuppressed: normalizedOutcomeSuppressionSuppressed,
      label: hasVerifierCounters || hasCorroborationCounters || hasSuppressionCounters
        ? 'Verifier/corroboration/suppression outcomes recorded'
        : null,
      details: verifierDetailParts.length > 0 ? verifierDetailParts.join(' • ') : null,
    };
  }

  const detailParts = [];
  if (normalizedDemoted > 0) {
    detailParts.push(`${normalizedDemoted} demoted`);
  }
  if (normalizedSuppressed > 0) {
    detailParts.push(`${normalizedSuppressed} suppressed`);
  }
  if (normalizedVerifierSupported > 0) {
    detailParts.push(`${normalizedVerifierSupported} verifier-supported`);
  }
  if (normalizedVerifierUnsupported > 0) {
    detailParts.push(`${normalizedVerifierUnsupported} verifier-unsupported`);
  }
  if (normalizedVerifierNeedsMoreContext > 0) {
    detailParts.push(`${normalizedVerifierNeedsMoreContext} verifier-needs-context`);
  }
  if (normalizedVerifierSkippedBudget > 0) {
    detailParts.push(`${normalizedVerifierSkippedBudget} verifier-skipped`);
  }
  if (normalizedCorroborationSupported > 0) {
    detailParts.push(`${normalizedCorroborationSupported} corroborated`);
  }
  if (normalizedCorroborationUnsupported > 0) {
    detailParts.push(`${normalizedCorroborationUnsupported} uncorroborated`);
  }
  if (normalizedCorroborationDowngraded > 0) {
    detailParts.push(`${normalizedCorroborationDowngraded} corroboration-downgraded`);
  }
  if (normalizedOutcomeSuppressionChecked > 0) {
    detailParts.push(`${normalizedOutcomeSuppressionChecked} suppression checks`);
  }
  if (normalizedOutcomeSuppressionSuppressed > 0) {
    detailParts.push(`${normalizedOutcomeSuppressionSuppressed} suppression-filtered`);
  }

  return {
    issuesTotal,
    issuesGrounded: normalizedGrounded,
    issuesDemoted: normalizedDemoted,
    issuesSuppressed: normalizedSuppressed,
    verifierSupported: normalizedVerifierSupported,
    verifierUnsupported: normalizedVerifierUnsupported,
    verifierNeedsMoreContext: normalizedVerifierNeedsMoreContext,
    verifierSkippedBudget: normalizedVerifierSkippedBudget,
    corroborationChecked: normalizedCorroborationChecked,
    corroborationSupported: normalizedCorroborationSupported,
    corroborationUnsupported: normalizedCorroborationUnsupported,
    corroborationDowngraded: normalizedCorroborationDowngraded,
    outcomeSuppressionChecked: normalizedOutcomeSuppressionChecked,
    outcomeSuppressionSuppressed: normalizedOutcomeSuppressionSuppressed,
    label: `${normalizedGrounded}/${issuesTotal} grounded issues`,
    details: detailParts.length > 0 ? detailParts.join(' • ') : null,
  };
}

export function normalizeReviewModelStrategyValue(value: unknown): 'smart' | 'latency_first' | 'max_quality' | 'custom' | 'adaptive' | 'performance' | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'smart'
    || normalized === 'latency_first'
    || normalized === 'max_quality'
    || normalized === 'custom'
    || normalized === 'adaptive'
    || normalized === 'performance'
  ) {
    return normalized;
  }
  return null;
}

export function getReviewStrategySuffix(review: ReviewResult): string {
  const strategy = normalizeReviewModelStrategyValue(review.stats?.reviewModelStrategy);
  if (strategy === 'smart') return ' (smart mode)';
  if (strategy === 'latency_first') return ' (latency-first)';
  if (strategy === 'adaptive') return ' (cost-aware)';
  if (strategy === 'performance') return ' (performance)';
  if (strategy === 'custom') return ' (custom)';
  return '';
}

export function buildReviewedByLabel(review: ReviewResult): string {
  const type = review?.provider?.type || 'unknown';
  const model = review?.provider?.model || 'unknown';
  return `${type}/${model}${getReviewStrategySuffix(review)}`;
}

export function buildReviewModelBreakdown(review: ReviewResult): string | null {
  const models = review?.stats?.modelsUsed;
  if (!models || typeof models !== 'object') return null;
  const parts: string[] = [];
  if (models.triage && models.triage !== review.provider?.model) {
    parts.push(`triage: ${models.triage}`);
  }
  if (models.review && models.review !== review.provider?.model) {
    parts.push(`review: ${models.review}`);
  }
  if (models.synthesis && models.synthesis !== review.provider?.model) {
    parts.push(`synthesis: ${models.synthesis}`);
  }
  if (parts.length === 0) return null;
  return parts.join(' • ');
}

export function humanizeReasonCode(reason: string | null | undefined): string | null {
  const raw = String(reason || '').trim();
  if (!raw) return null;
  if (raw === 'rollout_canary_selected') return 'canary selected';
  if (raw === 'rollout_canary_skipped') return 'canary skipped (smart fallback)';
  if (raw === 'rollout_shadow') return 'shadow mode (smart fallback)';
  if (raw === 'rollout_off') return 'rollout off (smart fallback)';
  if (raw === 'rollout_allowlist_excluded') return 'allowlist excluded (smart fallback)';
  if (raw === 'rollout_gate_failed') return 'rollout gate failed (smart fallback)';
  if (raw === 'rollout_gate_warn') return 'rollout gate warn (smart fallback)';
  if (raw === 'gate_partial_review') return 'partial review';
  if (raw === 'gate_duration_exceeded') return 'duration exceeded';
  if (raw === 'gate_deep_coverage_below_floor') return 'deep coverage below floor';
  if (raw === 'gate_first_signal_slow') return 'first signal slow';
  if (raw === 'gate_omitted_rate_high') return 'omitted rate high';
  if (raw === 'gate_telemetry_missing_duration') return 'missing duration telemetry';
  if (raw === 'gate_telemetry_missing_deep_coverage') return 'missing deep-coverage telemetry';
  if (raw === 'gate_telemetry_missing_first_signal') return 'missing first-signal telemetry';
  if (raw === 'gate_telemetry_missing_chunk_cadence') return 'missing chunk-cadence telemetry';
  return raw.replace(/_/g, ' ');
}

export function humanizeReasonCodeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = humanizeReasonCode(typeof value === 'string' ? value : null);
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= 5) break;
  }
  return Array.from(deduped);
}

export function formatPartialReasonForDisplay(reason: string): string {
  const trimmed = String(reason || '').trim();
  if (!trimmed) return '';
  const normalized = trimmed.toLowerCase();
  if (
    normalized.includes('failed to parse review response as json')
    || normalized.includes('unknown parse error')
    || normalized.includes('json parse')
  ) {
    return 'Some chunk responses could not be parsed. Results shown are from successfully parsed chunks.';
  }
  return trimmed;
}

export function extractPersistedFailureClass(rawMessage: string): string | null {
  const match = rawMessage.match(/\[class=([a-z0-9_]+)\]/i);
  if (!match?.[1]) return null;
  return match[1].trim().toLowerCase();
}

export function stripPersistedFailureMetadata(rawMessage: string): string {
  return rawMessage
    .replace(/\s*\[class=[^\]]+\]/gi, '')
    .replace(/\s*Attempts:\s*.*/i, '')
    .trim();
}

export function buildRuntimeFailureHint(failureClass: string | null): string | null {
  if (!failureClass) return null;
  if (failureClass === 'auth') {
    return 'Check AI provider credentials in Settings and run connection test.';
  }
  if (failureClass === 'quota') {
    return 'Provider credits or quota are exhausted. Add credits or update billing, then retry.';
  }
  if (failureClass === 'deadline' || failureClass === 'timeout') {
    return 'Retry with narrower scope or fewer files to complete within runtime limits.';
  }
  if (failureClass === 'context_window') {
    return 'Diff exceeded provider context window. Narrow scope or split review.';
  }
  if (failureClass === 'rate_limit' || failureClass === 'network') {
    return 'Transient provider/network issue. Retry in a moment.';
  }
  if (failureClass === 'max_turns_exceeded') {
    return 'The AI spent all agentic turns exploring files without producing the review. Retry with a narrower diff scope or increase max turns.';
  }
  if (failureClass === 'invalid_request' || failureClass === 'model_unavailable') {
    return 'Provider request was rejected. Verify selected model/provider settings.';
  }
  return null;
}

function formatKnownProviderFailure(rawMessage: string): string | null {
  const normalized = rawMessage.toLowerCase();
  if (
    normalized.includes('credit balance')
    || normalized.includes('insufficient credits')
    || normalized.includes('credits exhausted')
    || normalized.includes('out of credits')
    || normalized.includes('creditserror')
    || normalized.includes('quota exceeded')
    || normalized.includes('insufficient quota')
    || normalized.includes('billing')
    || normalized.includes('payment required')
    || normalized.includes('no payment method')
  ) {
    if (normalized.includes('claude')) {
      return 'Claude credits or quota are exhausted. Check Claude credits or Anthropic Console billing, then retry.';
    }
    return 'Provider credits or quota are exhausted. Add credits or update billing, then retry.';
  }

  if (
    normalized.includes('claude cli-agentic error')
    && normalized.includes('service_tier')
    && normalized.includes('terminal_reason')
    && normalized.includes('request_id')
  ) {
    return 'Claude CLI failed before returning a readable error. Check Claude credits/billing or run `claude doctor`, then retry.';
  }

  if (
    normalized.includes('claude cli-agent')
    && normalized.includes('"type":"system"')
    && normalized.includes('"subtype":"init"')
  ) {
    return 'Claude CLI started but exited before returning a review. Check Claude credits/billing or run `claude doctor`, then retry.';
  }

  return null;
}

export function formatPersistedFailureMessage(rawMessage: string): string {
  const trimmed = String(rawMessage || '').trim();
  if (!trimmed) return '';
  const knownProviderFailure = formatKnownProviderFailure(trimmed);
  if (knownProviderFailure) return knownProviderFailure;
  const failureClass = extractPersistedFailureClass(trimmed);
  const baseMessage = stripPersistedFailureMetadata(trimmed) || trimmed;
  const hint = buildRuntimeFailureHint(failureClass);
  if (!hint) return baseMessage;
  return `${baseMessage} ${hint}`;
}

export function parseStoredPatternSetting(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    }
    if (typeof parsed === 'string') {
      return parseScopePatterns(parsed);
    }
  } catch {
    // Fall back to plain text parsing
  }
  return parseScopePatterns(value);
}

export function getRecommendationOutcomeKey(rec: ReviewRecommendation): string {
  return buildReviewRecommendationKey(rec);
}

export const getRecommendationFingerprint = getRecommendationOutcomeKey;

export function getReviewDiffRecommendations(
  reviewData?: Pick<ReviewResult, 'recommendations' | 'candidateFindings'> | null
): ReviewRecommendation[] {
  const recommendations = Array.isArray(reviewData?.recommendations) ? reviewData.recommendations : [];
  const candidateFindings = Array.isArray(reviewData?.candidateFindings) ? reviewData.candidateFindings : [];
  if (candidateFindings.length === 0) return recommendations;

  const seen = new Set<string>();
  const result: ReviewRecommendation[] = [];
  for (const rec of [...recommendations, ...candidateFindings]) {
    const fingerprint = getRecommendationFingerprint(rec);
    if (fingerprint && seen.has(fingerprint)) continue;
    if (fingerprint) seen.add(fingerprint);
    result.push(rec);
  }
  return result;
}

export function buildReviewFixRequest(args: {
  projectId: string;
  scope: RecommendationOutcomeScope;
  recommendations: ReviewRecommendation[];
}): ReviewFixRequest {
  const recommendationKeys = Array.from(new Set(
    (Array.isArray(args.recommendations) ? args.recommendations : [])
      .map((recommendation) => getRecommendationFingerprint(recommendation))
      .filter(Boolean)
  ));

  return {
    projectId: args.projectId,
    reviewType: args.scope.reviewType,
    reviewId: args.scope.reviewId,
    recommendationKeys,
    contextLabels: {
      nonGoals: 'non-goals',
    },
  };
}

export function buildRecommendationOutcomeScope(args: {
  changesetId?: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
}): RecommendationOutcomeScope | null {
  if (args.branchReviewId) {
    return {
      reviewType: 'branch_review',
      reviewId: args.branchReviewId,
    };
  }
  if (args.workspaceReviewId) {
    return {
      reviewType: 'workspace_review',
      reviewId: args.workspaceReviewId,
    };
  }
  if (args.prReviewId) {
    return {
      reviewType: 'pr_review',
      reviewId: args.prReviewId,
    };
  }
  if (args.changesetId) {
    return {
      reviewType: 'changeset',
      reviewId: args.changesetId,
    };
  }
  return null;
}

export function buildRecommendationResolutionStorageKey(args: {
  projectId: string;
  changesetId?: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
}): string | null {
  const scope = args.branchReviewId
    ? `br:${args.projectId}:${args.branchReviewId}`
    : args.workspaceReviewId
      ? `ws:${args.projectId}:${args.workspaceReviewId}`
    : args.prReviewId
      ? `pr:${args.projectId}:${args.prReviewId}`
    : args.changesetId
      ? `cs:${args.projectId}:${args.changesetId}`
      : null;
  if (!scope) return null;
  return `atlas_review_resolution:${scope}`;
}

export function buildRecommendationCommentStorageKey(args: {
  projectId: string;
  changesetId?: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
}): string | null {
  const scope = args.branchReviewId
    ? `br:${args.projectId}:${args.branchReviewId}`
    : args.workspaceReviewId
      ? `ws:${args.projectId}:${args.workspaceReviewId}`
    : args.prReviewId
      ? `pr:${args.projectId}:${args.prReviewId}`
      : args.changesetId
        ? `cs:${args.projectId}:${args.changesetId}`
        : null;
  if (!scope) return null;
  return `atlas_review_comment:${scope}`;
}

export function buildManualLineCommentStorageKey(args: {
  projectId: string;
  changesetId?: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
}): string | null {
  const scope = args.branchReviewId
    ? `br:${args.projectId}:${args.branchReviewId}`
    : args.workspaceReviewId
      ? `ws:${args.projectId}:${args.workspaceReviewId}`
    : args.prReviewId
      ? `pr:${args.projectId}:${args.prReviewId}`
      : args.changesetId
        ? `cs:${args.projectId}:${args.changesetId}`
        : null;
  if (!scope) return null;
  return `atlas_review_line_comment:${scope}`;
}

export function buildRecommendationNoteStorageKey(args: {
  projectId: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  branchName?: string | null;
  prReviewId?: string;
}): string | null {
  const normalizedBranchName = String(args.branchName || '').trim();
  const scope = args.workspaceReviewId
    ? `ws:${args.projectId}:${args.workspaceReviewId}`
    : normalizedBranchName
      ? `br:${args.projectId}:${normalizedBranchName}`
      : args.branchReviewId
        ? `br:${args.projectId}:${args.branchReviewId}`
        : args.prReviewId
          ? `pr:${args.projectId}:${args.prReviewId}`
          : null;
  if (!scope) return null;
  return `atlas_review_finding_note:${scope}`;
}

export function buildRecommendationNoteId(args: {
  recommendationKey: string;
}): string {
  return normalizeRecommendationKeyPart(args.recommendationKey);
}

export function buildRecommendationNoteDraft(args: {
  rec: ReviewRecommendation;
  body: string;
  recommendationKey?: string;
  reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
  branchReviewId?: string | null;
  workspaceReviewId?: string | null;
  branchName?: string | null;
  prReviewId?: string | null;
  githubPrNumber?: number | null;
  prHtmlUrl?: string | null;
  reviewDisplayId?: string | null;
  reviewTitle?: string | null;
  updatedAt?: string;
}): RecommendationNoteDraft | null {
  const recommendationKey = buildRecommendationNoteId({
    recommendationKey: args.recommendationKey || getRecommendationFingerprint(args.rec),
  });
  const body = String(args.body || '').trim();
  if (!recommendationKey || !body) return null;
  const description = sanitizeRecommendationDescription(args.rec.description);
  const evidenceSnippet = String(
    args.rec.sourceAnchor?.snippet
    || args.rec.evidence?.snippet
    || args.rec.evidenceSnippet
    || args.rec.targetSnippet
    || ''
  ).trim();

  return {
    id: recommendationKey,
    recommendationKey,
    body,
    updatedAt: typeof args.updatedAt === 'string' && args.updatedAt.trim()
      ? args.updatedAt.trim()
      : new Date().toISOString(),
    reviewType: args.reviewType,
    ...(typeof args.branchReviewId === 'string' && args.branchReviewId.trim()
      ? { branchReviewId: args.branchReviewId.trim() }
      : {}),
    ...(typeof args.workspaceReviewId === 'string' && args.workspaceReviewId.trim()
      ? { workspaceReviewId: args.workspaceReviewId.trim() }
      : {}),
    ...(typeof args.branchName === 'string' && args.branchName.trim()
      ? { branchName: args.branchName.trim() }
      : {}),
    ...(typeof args.prReviewId === 'string' && args.prReviewId.trim()
      ? { prReviewId: args.prReviewId.trim() }
      : {}),
    ...(args.githubPrNumber != null && Number.isFinite(Number(args.githubPrNumber))
      ? { githubPrNumber: Math.trunc(Number(args.githubPrNumber)) }
      : {}),
    ...(typeof args.prHtmlUrl === 'string' && args.prHtmlUrl.trim()
      ? { prHtmlUrl: args.prHtmlUrl.trim() }
      : {}),
    ...(typeof args.reviewDisplayId === 'string' && args.reviewDisplayId.trim()
      ? { reviewDisplayId: args.reviewDisplayId.trim() }
      : {}),
    ...(typeof args.reviewTitle === 'string' && args.reviewTitle.trim()
      ? { reviewTitle: args.reviewTitle.trim() }
      : {}),
    findingTitle: String(args.rec.title || 'Atlas finding').trim() || 'Atlas finding',
    findingType: String(args.rec.type || 'issue').trim().toLowerCase() || 'issue',
    findingSeverity: normalizeRecommendationSeverity(args.rec),
    findingLocation: formatRecommendationDisplayLocation(args.rec),
    findingSourceLocation: formatRecommendationSourceLocation(args.rec),
    ...(description ? { findingDescription: description } : {}),
    ...(evidenceSnippet ? { evidenceSnippet } : {}),
  };
}

export function buildPrivateReviewNoteStorageKey(args: {
  projectId: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  branchName?: string | null;
  prReviewId?: string;
}): string | null {
  const normalizedBranchName = String(args.branchName || '').trim();
  const scope = args.workspaceReviewId
    ? `ws:${args.projectId}:${args.workspaceReviewId}`
    : normalizedBranchName
    ? `br:${args.projectId}:${normalizedBranchName}`
    : args.branchReviewId
      ? `br:${args.projectId}:${args.branchReviewId}`
    : args.prReviewId
      ? `pr:${args.projectId}:${args.prReviewId}`
      : null;
  if (!scope) return null;
  return `atlas_review_private_note:${scope}`;
}

export function buildPrivateReviewNoteId(args: {
  path: string;
  line?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
}): string {
  const path = String(args.path || '').trim();
  const side = String(args.side || 'RIGHT').trim().toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
  const line = Number.isFinite(Number(args.line)) && Number(args.line) > 0
    ? Math.floor(Number(args.line))
    : null;
  if (!path) return '';
  return line ? `line:${path}:${side}:${line}` : `file:${path}`;
}

function parsePrivateReviewNoteStorageKey(storageKey: string): {
  projectId: string;
  reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
  scopeId: string;
} | null {
  const parts = String(storageKey || '').split(':');
  if (parts.length < 4) return null;
  if (parts[0] !== 'atlas_review_private_note') return null;
  const scopeType = parts[1];
  const projectId = String(parts[2] || '').trim();
  const scopeId = parts.slice(3).join(':').trim();
  if (!projectId || !scopeId) return null;
  if (scopeType === 'br') {
    return { projectId, reviewType: 'branch_review', scopeId };
  }
  if (scopeType === 'ws') {
    return { projectId, reviewType: 'workspace_review', scopeId };
  }
  if (scopeType === 'pr') {
    return { projectId, reviewType: 'pr_review', scopeId };
  }
  return null;
}

function parseRecommendationNoteStorageKey(storageKey: string): {
  projectId: string;
  reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
  scopeId: string;
} | null {
  const prefix = 'atlas_review_finding_note:';
  if (!storageKey.startsWith(prefix)) return null;
  const rawScope = storageKey.slice(prefix.length);
  const [scopeType, projectId, ...scopeParts] = rawScope.split(':');
  const scopeId = scopeParts.join(':').trim();
  if (!projectId || !scopeId) return null;
  if (scopeType === 'br') {
    return { projectId, reviewType: 'branch_review', scopeId };
  }
  if (scopeType === 'ws') {
    return { projectId, reviewType: 'workspace_review', scopeId };
  }
  if (scopeType === 'pr') {
    return { projectId, reviewType: 'pr_review', scopeId };
  }
  return null;
}

function parseStoredRecommendationLocation(locationLabel: string | null | undefined): {
  filePath: string | null;
  line: number | null;
} {
  const normalized = String(locationLabel || '').trim();
  if (!normalized) {
    return { filePath: null, line: null };
  }
  const match = normalized.match(/^(.*?):(\d+)(?:-\d+)?$/);
  if (match) {
    return {
      filePath: match[1]?.trim() || null,
      line: Number.isFinite(Number(match[2])) ? Math.trunc(Number(match[2])) : null,
    };
  }
  return {
    filePath: normalized,
    line: null,
  };
}

export function collectProjectRecommendationNoteStorageEntries(args: {
  projectId: string;
  storage?: Pick<Storage, 'length' | 'key' | 'getItem'> | null;
}): RecommendationNoteStorageEntry[] {
  const projectId = String(args.projectId || '').trim();
  if (!projectId) return [];
  const storage = args.storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  if (!storage) return [];

  const entries: RecommendationNoteStorageEntry[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const storageKey = storage.key(index);
    if (!storageKey) continue;
    const parsed = parseRecommendationNoteStorageKey(storageKey);
    if (!parsed || parsed.projectId !== projectId) continue;
    const raw = storage.getItem(storageKey);
    if (!raw) continue;
    try {
      const notes = normalizeRecommendationNoteMap(JSON.parse(raw));
      if (Object.keys(notes).length === 0) continue;
      entries.push({ storageKey, notes });
    } catch {
      // Ignore malformed local-only note payloads.
    }
  }

  return entries;
}

export function buildProjectRecommendationNoteHistory(args: {
  projectId: string;
  storageEntries?: RecommendationNoteStorageEntry[];
  branchReviews?: BranchReview[];
  workspaceReviews?: WorkspaceReview[];
  prReviews?: PrReview[];
  localBranchNames?: Iterable<string> | null;
}): RecommendationNoteHistoryEntry[] {
  const projectId = String(args.projectId || '').trim();
  if (!projectId) return [];

  const storageEntries = Array.isArray(args.storageEntries)
    ? args.storageEntries
    : collectProjectRecommendationNoteStorageEntries({ projectId });
  const branchReviews = Array.isArray(args.branchReviews) ? args.branchReviews : [];
  const workspaceReviews = Array.isArray(args.workspaceReviews) ? args.workspaceReviews : [];
  const prReviews = Array.isArray(args.prReviews) ? args.prReviews : [];
  const localBranchNames = new Set(
    Array.from(args.localBranchNames || [], (value) => String(value || '').trim()).filter(Boolean)
  );
  const history: RecommendationNoteHistoryEntry[] = [];

  for (const entry of storageEntries) {
    const parsed = parseRecommendationNoteStorageKey(entry.storageKey);
    if (!parsed || parsed.projectId !== projectId) continue;
    for (const note of Object.values(entry.notes || {})) {
      const reviewType = note.reviewType === 'pr_review' || parsed.reviewType === 'pr_review'
        ? 'pr_review'
        : note.reviewType === 'workspace_review' || parsed.reviewType === 'workspace_review'
          ? 'workspace_review'
          : 'branch_review';
      const locationLabel = note.findingLocation || note.findingSourceLocation || 'Saved finding context';
      const navigationTarget = parseStoredRecommendationLocation(note.findingLocation || note.findingSourceLocation);

      if (reviewType === 'branch_review') {
        const branchName = String(note.branchName || '').trim() || parsed.scopeId;
        const matchedBranchReview = branchReviews.find((review) => (
          (note.branchReviewId && review.id === note.branchReviewId)
          || (branchName && review.branchName === branchName)
          || review.id === parsed.scopeId
        )) || null;
        const branchStillExists = branchName ? localBranchNames.has(branchName) : false;
        const reviewAvailable = Boolean(matchedBranchReview) && branchStillExists;
        history.push({
          ...note,
          reviewType,
          branchName: branchName || null,
          reviewId: reviewAvailable ? matchedBranchReview?.id || null : null,
          reviewAvailable,
          sourceLabel: branchName || note.reviewDisplayId || 'Branch review',
          sourceMeta: matchedBranchReview
            ? `${matchedBranchReview.baseBranch} · ${matchedBranchReview.displayId}`
            : (note.reviewDisplayId || null),
          locationLabel,
          stale: !reviewAvailable,
          staleReason: reviewAvailable
            ? undefined
            : (matchedBranchReview ? 'Branch no longer exists locally' : 'Review no longer available'),
          storageKey: entry.storageKey,
          navigationFilePath: navigationTarget.filePath,
          navigationLine: navigationTarget.line,
        });
        continue;
      }

      if (reviewType === 'workspace_review') {
        const matchedWorkspaceReview = workspaceReviews.find((review) => (
          (note.workspaceReviewId && review.id === note.workspaceReviewId)
          || review.id === parsed.scopeId
        )) || null;
        const sourceLabel = note.reviewDisplayId || matchedWorkspaceReview?.displayId || 'Workspace review';
        history.push({
          ...note,
          reviewType,
          workspaceReviewId: note.workspaceReviewId || matchedWorkspaceReview?.id || null,
          reviewId: matchedWorkspaceReview?.id || null,
          reviewAvailable: Boolean(matchedWorkspaceReview),
          sourceLabel,
          sourceMeta: matchedWorkspaceReview?.branchName
            ? `${matchedWorkspaceReview.branchName}${matchedWorkspaceReview.baseBranch ? ` · ${matchedWorkspaceReview.baseBranch}` : ''}`
            : (note.branchName || null),
          locationLabel,
          stale: !matchedWorkspaceReview,
          staleReason: matchedWorkspaceReview ? undefined : 'Workspace review no longer available',
          storageKey: entry.storageKey,
          navigationFilePath: navigationTarget.filePath,
          navigationLine: navigationTarget.line,
        });
        continue;
      }

      const matchedPrReview = prReviews.find((review) => (
        (note.prReviewId && review.id === note.prReviewId)
        || (note.githubPrNumber != null && review.githubPrNumber === note.githubPrNumber)
        || review.id === parsed.scopeId
      )) || null;
      const prNumber = note.githubPrNumber ?? matchedPrReview?.githubPrNumber ?? null;
      history.push({
        ...note,
        reviewType,
        prReviewId: note.prReviewId || matchedPrReview?.id || null,
        githubPrNumber: prNumber,
        prHtmlUrl: note.prHtmlUrl || matchedPrReview?.htmlUrl || null,
        reviewId: matchedPrReview?.id || null,
        reviewAvailable: Boolean(matchedPrReview),
        sourceLabel: prNumber != null ? `PR #${prNumber}` : (note.reviewDisplayId || 'PR review'),
        sourceMeta: note.reviewTitle || matchedPrReview?.title || null,
        locationLabel,
        stale: !matchedPrReview,
        staleReason: matchedPrReview ? undefined : 'Review no longer available',
        storageKey: entry.storageKey,
        navigationFilePath: navigationTarget.filePath,
        navigationLine: navigationTarget.line,
      });
    }
  }

  return history.sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt || '') || 0;
    const leftTime = Date.parse(left.updatedAt || '') || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    const severityDiff = (RISK_ORDER[right.findingSeverity || 'low'] ?? 0) - (RISK_ORDER[left.findingSeverity || 'low'] ?? 0);
    if (severityDiff !== 0) return severityDiff;
    return left.locationLabel.localeCompare(right.locationLabel);
  });
}

export function collectProjectPrivateNoteStorageEntries(args: {
  projectId: string;
  storage?: Pick<Storage, 'length' | 'key' | 'getItem'> | null;
}): PrivateReviewNoteStorageEntry[] {
  const projectId = String(args.projectId || '').trim();
  if (!projectId) return [];
  const storage = args.storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  if (!storage) return [];

  const entries: PrivateReviewNoteStorageEntry[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const storageKey = storage.key(index);
    if (!storageKey) continue;
    const parsed = parsePrivateReviewNoteStorageKey(storageKey);
    if (!parsed || parsed.projectId !== projectId) continue;
    const raw = storage.getItem(storageKey);
    if (!raw) continue;
    try {
      const notes = normalizePrivateReviewNoteMap(JSON.parse(raw));
      if (Object.keys(notes).length === 0) continue;
      entries.push({ storageKey, notes });
    } catch {
      // Ignore malformed local-only note payloads.
    }
  }

  return entries;
}

export function buildProjectPrivateNoteHistory(args: {
  projectId: string;
  storageEntries?: PrivateReviewNoteStorageEntry[];
  branchReviews?: BranchReview[];
  workspaceReviews?: WorkspaceReview[];
  prReviews?: PrReview[];
  localBranchNames?: Iterable<string> | null;
}): PrivateReviewNoteHistoryEntry[] {
  const projectId = String(args.projectId || '').trim();
  if (!projectId) return [];

  const storageEntries = Array.isArray(args.storageEntries)
    ? args.storageEntries
    : collectProjectPrivateNoteStorageEntries({ projectId });
  const branchReviews = Array.isArray(args.branchReviews) ? args.branchReviews : [];
  const workspaceReviews = Array.isArray(args.workspaceReviews) ? args.workspaceReviews : [];
  const prReviews = Array.isArray(args.prReviews) ? args.prReviews : [];
  const localBranchNames = new Set(
    Array.from(args.localBranchNames || [], (value) => String(value || '').trim()).filter(Boolean)
  );
  const history: PrivateReviewNoteHistoryEntry[] = [];

  for (const entry of storageEntries) {
    const parsed = parsePrivateReviewNoteStorageKey(entry.storageKey);
    if (!parsed || parsed.projectId !== projectId) continue;
    for (const note of Object.values(entry.notes || {})) {
      const reviewType = note.reviewType === 'pr_review' || parsed.reviewType === 'pr_review'
        ? 'pr_review'
        : note.reviewType === 'workspace_review' || parsed.reviewType === 'workspace_review'
          ? 'workspace_review'
        : 'branch_review';
      const anchorKind = note.line ? 'line' : 'file';
      const locationLabel = note.line ? `${note.path}:${note.line}` : note.path;

      if (reviewType === 'branch_review') {
        const branchName = String(note.branchName || '').trim() || parsed.scopeId;
        const matchedBranchReview = branchReviews.find((review) => (
          (note.branchReviewId && review.id === note.branchReviewId)
          || (branchName && review.branchName === branchName)
          || review.id === parsed.scopeId
        )) || null;
        const branchStillExists = branchName ? localBranchNames.has(branchName) : false;
        const reviewAvailable = Boolean(matchedBranchReview) && branchStillExists;
        history.push({
          ...note,
          reviewType,
          branchName: branchName || null,
          reviewId: reviewAvailable ? matchedBranchReview?.id || null : null,
          reviewAvailable,
          sourceLabel: branchName || note.reviewDisplayId || 'Branch review',
          sourceMeta: matchedBranchReview
            ? `${matchedBranchReview.baseBranch} · ${matchedBranchReview.displayId}`
            : (note.reviewDisplayId || null),
          anchorKind,
          locationLabel,
          stale: !reviewAvailable,
          staleReason: reviewAvailable
            ? undefined
            : (matchedBranchReview ? 'Branch no longer exists locally' : 'Review no longer available'),
          storageKey: entry.storageKey,
        });
        continue;
      }

      if (reviewType === 'workspace_review') {
        const matchedWorkspaceReview = workspaceReviews.find((review) => (
          (note.workspaceReviewId && review.id === note.workspaceReviewId)
          || review.id === parsed.scopeId
        )) || null;
        const sourceLabel = note.reviewDisplayId || matchedWorkspaceReview?.displayId || 'Workspace review';
        history.push({
          ...note,
          reviewType,
          workspaceReviewId: note.workspaceReviewId || matchedWorkspaceReview?.id || null,
          reviewId: matchedWorkspaceReview?.id || null,
          reviewAvailable: Boolean(matchedWorkspaceReview),
          sourceLabel,
          sourceMeta: matchedWorkspaceReview?.branchName
            ? `${matchedWorkspaceReview.branchName}${matchedWorkspaceReview.baseBranch ? ` · ${matchedWorkspaceReview.baseBranch}` : ''}`
            : (note.branchName || null),
          anchorKind,
          locationLabel,
          stale: !matchedWorkspaceReview,
          staleReason: matchedWorkspaceReview ? undefined : 'Workspace review no longer available',
          storageKey: entry.storageKey,
        });
        continue;
      }

      const matchedPrReview = prReviews.find((review) => (
        (note.prReviewId && review.id === note.prReviewId)
        || (note.githubPrNumber != null && review.githubPrNumber === note.githubPrNumber)
        || review.id === parsed.scopeId
      )) || null;
      const prNumber = note.githubPrNumber ?? matchedPrReview?.githubPrNumber ?? null;
      history.push({
        ...note,
        reviewType,
        prReviewId: note.prReviewId || matchedPrReview?.id || null,
        githubPrNumber: prNumber,
        prHtmlUrl: note.prHtmlUrl || matchedPrReview?.htmlUrl || null,
        reviewId: matchedPrReview?.id || null,
        reviewAvailable: Boolean(matchedPrReview),
        sourceLabel: prNumber != null ? `PR #${prNumber}` : (note.reviewDisplayId || 'PR review'),
        sourceMeta: note.reviewTitle || matchedPrReview?.title || null,
        anchorKind,
        locationLabel,
        stale: !matchedPrReview,
        staleReason: matchedPrReview ? undefined : 'Review no longer available',
        storageKey: entry.storageKey,
      });
    }
  }

  return history.sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt || '') || 0;
    const leftTime = Date.parse(left.updatedAt || '') || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.locationLabel.localeCompare(right.locationLabel);
  });
}

export function buildLegacyRecommendationResolutionStorageKey(args: {
  projectId: string;
  changesetId?: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
  reviewedAt?: string | null;
}): string | null {
  const scope = args.branchReviewId
    ? `br:${args.projectId}:${args.branchReviewId}`
    : args.workspaceReviewId
      ? `ws:${args.projectId}:${args.workspaceReviewId}`
    : args.prReviewId
      ? `pr:${args.projectId}:${args.prReviewId}`
    : args.changesetId
      ? `cs:${args.projectId}:${args.changesetId}`
      : null;
  const reviewedAt = String(args.reviewedAt || '').trim();
  if (!scope || !reviewedAt) return null;
  return `atlas_review_resolution:${scope}:${reviewedAt}`;
}

export function normalizeRecommendationResolutionMap(rawMap: unknown): RecommendationResolutionMap {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const normalized: RecommendationResolutionMap = {};
  for (const [key, value] of Object.entries(rawMap as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<RecommendationResolutionEntry & { status?: RecommendationResolutionState }>;
    const state = entry.state ?? entry.status;
    if (state !== 'addressed' && state !== 'dismissed') continue;
    const noteRaw = typeof entry.note === 'string'
      ? entry.note.trim()
      : '';
    const updatedAtRaw = typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
      ? entry.updatedAt.trim()
      : new Date().toISOString();
    normalized[normalizeRecommendationKeyPart(key)] = {
      state,
      note: noteRaw || undefined,
      updatedAt: updatedAtRaw,
    };
  }
  return normalized;
}

export function getRecommendationVerificationState(args: {
  resolution: RecommendationResolutionEntry | null;
  fixStatus?: ReviewFixRecommendationStatus | null;
}): RecommendationVerificationState | null {
  if (args.resolution?.state === 'addressed') return 'addressed';
  const status = String(args.fixStatus || '').trim().toLowerCase() as ReviewFixRecommendationStatus;
  if (
    status === 'patch_applied'
    || status === 'verification_pending'
    || status === 're_reviewing'
    || status === 'still_open'
  ) {
    return status;
  }
  return null;
}

export function isRecommendationAwaitingVerification(
  state: RecommendationVerificationState | null | undefined
): boolean {
  return state === 'patch_applied'
    || state === 'verification_pending'
    || state === 're_reviewing';
}

export function getVerificationPendingRecommendationKeys(
  recommendations: ReviewRecommendation[],
  recommendationResolutions: RecommendationResolutionMap,
  recommendationFixStatuses: RecommendationFixStatusMap,
): string[] {
  return recommendations.flatMap((rec) => {
    const fingerprint = getRecommendationFingerprint(rec);
    const state = getRecommendationVerificationState({
      resolution: getRecommendationResolutionFor(rec, recommendationResolutions),
      fixStatus: recommendationFixStatuses[fingerprint]?.status || null,
    });
    return state && isRecommendationAwaitingVerification(state) ? [fingerprint] : [];
  });
}

export function buildPersistedFixRunStatusLabel(run: Pick<ReviewFixRunArtifact, 'status' | 'selectedRecommendationKeys' | 'buildSummary'>): string {
  if (run.status === 'running') return 'Fixing selected findings…';
  if (run.status === 'stopped') return 'Fix run stopped';
  if (run.status === 'failed') return 'Fix run failed';
  if ((run.buildSummary?.filesChanged || 0) <= 0) return 'Fix run complete. No patch applied.';
  return (run.selectedRecommendationKeys || []).length === 1
    ? 'Fix run complete. Inspect the patch and resolve the finding manually.'
    : 'Fix run complete. Review selected findings.';
}

export function getVisibleRecommendationFixStatusLabel(
  status: ReviewFixRecommendationStatus | null | undefined
): string {
  const normalized = String(status || '').trim().toLowerCase() as ReviewFixRecommendationStatus;
  if (!normalized) return '';
  if (normalized === 'patch_applied' || normalized === 'verification_pending' || normalized === 're_reviewing') {
    return 'patch ready';
  }
  return normalized.replace(/_/g, ' ');
}

export function buildRecommendationFixStatusesFromRun(run: ReviewFixRunArtifact | null | undefined): RecommendationFixStatusMap {
  if (!run || !run.recommendationStatuses || typeof run.recommendationStatuses !== 'object') {
    return {};
  }
  return Object.entries(run.recommendationStatuses).reduce((acc, [recommendationKey, entry]) => {
    if (!entry?.status) return acc;
    if (entry.status === 'queued') return acc;
    acc[recommendationKey] = {
      status: entry.status as ReviewFixRecommendationStatus,
      updatedAt: entry.updatedAt,
      filePaths: Array.isArray(entry.filePaths) ? entry.filePaths : undefined,
      error: entry.error || null,
    };
    return acc;
  }, {} as RecommendationFixStatusMap);
}

function getReviewFixRunSortTimestamp(run: ReviewFixRunArtifact): number {
  const value = run.updatedAt || run.completedAt || run.failedAt || run.stoppedAt || run.startedAt;
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildRecommendationFixStatusesFromRuns(
  runs: ReviewFixRunArtifact[] | null | undefined
): RecommendationFixStatusMap {
  const normalizedRuns = Array.isArray(runs) ? [...runs] : [];
  normalizedRuns.sort((a, b) => {
    const diff = getReviewFixRunSortTimestamp(b) - getReviewFixRunSortTimestamp(a);
    if (diff !== 0) return diff;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });

  return normalizedRuns.reduce((acc, run) => {
    const statuses = buildRecommendationFixStatusesFromRun(run);
    for (const [recommendationKey, entry] of Object.entries(statuses)) {
      if (!acc[recommendationKey]) {
        acc[recommendationKey] = entry;
      }
    }
    return acc;
  }, {} as RecommendationFixStatusMap);
}

function formatReviewFixRunTimestamp(value: string | null | undefined, nowMs = Date.now()): string {
  const iso = String(value || '').trim();
  if (!iso) return 'Unknown time';
  const parsedMs = Date.parse(iso);
  if (!Number.isFinite(parsedMs)) return 'Unknown time';
  const diffMs = Math.max(0, nowMs - parsedMs);
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return 'just now';
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

export function buildReviewFixRunSummaryLabel(run: Pick<ReviewFixRunArtifact, 'status' | 'buildSummary'>): string | null {
  if ((run.buildSummary?.filesChanged || 0) > 0) {
    const fileCount = run.buildSummary?.filesChanged || 0;
    return `${fileCount} file${fileCount === 1 ? '' : 's'} changed`;
  }
  if (run.status === 'failed') return 'No patch applied';
  if (run.status === 'stopped') return 'Stopped before patch applied';
  if (run.status === 'skipped') return 'No patch applied';
  return null;
}

type ReviewFixRunPatchSummary = {
  changesetId: string | null;
  changesetTitle: string | null;
  fileSummaryLabel: string | null;
  filePreviewLabel: string | null;
  coverageLabel: string | null;
  patchActionLabel: string | null;
  filePaths: string[];
};

export function buildReviewFixRunPatchSummary(run: ReviewFixRunArtifact | null | undefined): ReviewFixRunPatchSummary {
  const buildSummary = run?.buildSummary || null;
  const filePaths = Array.from(new Set(
    Array.isArray(buildSummary?.filePaths)
      ? buildSummary.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
      : []
  ));
  const newFiles = Array.from(new Set(
    Array.isArray(buildSummary?.newFiles)
      ? buildSummary.newFiles.map((value) => String(value || '').trim()).filter(Boolean)
      : []
  ));
  const modifiedFiles = Array.from(new Set(
    Array.isArray(buildSummary?.modifiedFiles)
      ? buildSummary.modifiedFiles.map((value) => String(value || '').trim()).filter(Boolean)
      : []
  ));
  const changesetId = String(buildSummary?.changesetId || '').trim() || null;
  const changesetTitle = String(buildSummary?.changesetTitle || '').trim() || null;
  const previewPaths = filePaths.slice(0, 2).map((path) => {
    const segments = String(path || '').split('/').filter(Boolean);
    return segments[segments.length - 1] || String(path || '').trim();
  }).filter(Boolean);
  const previewSuffix = filePaths.length > previewPaths.length
    ? ` +${filePaths.length - previewPaths.length}`
    : '';
  const fileSummaryLabel = filePaths.length > 0
    ? `${filePaths.length} file${filePaths.length === 1 ? '' : 's'} changed`
    : null;
  const filePreviewLabel = previewPaths.length > 0
    ? `${previewPaths.join(', ')}${previewSuffix}`
    : null;
  const changeParts = [
    newFiles.length > 0 ? `${newFiles.length} new` : null,
    modifiedFiles.length > 0 ? `${modifiedFiles.length} modified` : null,
  ].filter(Boolean);
  const coverageCount = Object.values(run?.recommendationStatuses || {}).reduce((count, entry) => (
    Array.isArray(entry?.filePaths) && entry.filePaths.length > 0 ? count + 1 : count
  ), 0);
  const selectedCount = Array.isArray(run?.selectedRecommendationKeys) ? run.selectedRecommendationKeys.length : 0;
  const coverageLabel = selectedCount > 0
    ? `${coverageCount}/${selectedCount} selected finding${selectedCount === 1 ? '' : 's'} touched files`
    : null;

  return {
    changesetId,
    changesetTitle,
    fileSummaryLabel: fileSummaryLabel
      ? [fileSummaryLabel, changeParts.length > 0 ? changeParts.join(', ') : null].filter(Boolean).join(' · ')
      : (changeParts.length > 0 ? changeParts.join(', ') : null),
    filePreviewLabel,
    coverageLabel,
    patchActionLabel: filePaths.length > 0
      ? 'Inspect patch'
      : null,
    filePaths,
  };
}

export function buildReviewFixRunHistoryItems(args: {
  runs: ReviewFixRunArtifact[];
  latestRunId?: string | null;
  retryableRecommendationKeys?: string[];
  verificationPendingRecommendationKeys?: string[];
  nowMs?: number;
}): ReviewFixRunHistoryEntry[] {
  const {
    runs,
    latestRunId = null,
    retryableRecommendationKeys = [],
    verificationPendingRecommendationKeys: _verificationPendingRecommendationKeys = [],
    nowMs = Date.now(),
  } = args;
  const retryableKeySet = new Set(
    retryableRecommendationKeys
      .map((value) => normalizeRecommendationKeyPart(value))
      .filter(Boolean)
  );

  return (Array.isArray(runs) ? runs : []).map((run, index) => {
    const selectedKeys = (run.selectedRecommendationKeys || [])
      .map((value) => normalizeRecommendationKeyPart(value))
      .filter(Boolean);
    const normalizedRecommendationStatuses = Object.entries(run.recommendationStatuses || {}).reduce((acc, [key, entry]) => {
      const normalizedKey = normalizeRecommendationKeyPart(key);
      if (!normalizedKey || !entry || typeof entry !== 'object') {
        return acc;
      }
      acc[normalizedKey] = entry;
      return acc;
    }, {} as Record<string, ReviewFixRunArtifact['recommendationStatuses'][string]>);
    const retryKeys = selectedKeys.filter((key) => {
      if (!retryableKeySet.has(key)) {
        return false;
      }
      const entry = normalizedRecommendationStatuses[key];
      const hasObservedCoverage = Array.isArray(entry?.filePaths) && entry.filePaths.length > 0;
      if (entry?.status === 'failed' || entry?.status === 'stopped' || entry?.status === 'skipped') {
        return true;
      }
      return !hasObservedCoverage
        && (run.status === 'patch_applied' || run.status === 'verification_pending');
    });
    let action: ReviewFixRunHistoryAction | null = null;
    let actionLabel: string | null = null;
    let actionRecommendationKeys: string[] = [];

    // Keep verification history support dormant for now. The persisted artifact
    // state still tracks verification-pending findings, but the UI stays on a
    // manual inspect-and-mark flow until we re-enable the verification loop.
    if (retryKeys.length > 0) {
      action = 'retry';
      actionLabel = 'Retry';
      actionRecommendationKeys = retryKeys;
    }

    const patchSummary = buildReviewFixRunPatchSummary(run);

    return {
      id: run.id,
      isLatest: latestRunId ? run.id === latestRunId : index === 0,
      status: run.status,
      statusLabel: buildPersistedFixRunStatusLabel(run),
      timestampLabel: formatReviewFixRunTimestamp(
        run.updatedAt || run.completedAt || run.failedAt || run.stoppedAt || run.startedAt,
        nowMs
      ),
      summaryLabel: buildReviewFixRunSummaryLabel(run),
      patchActionLabel: patchSummary.patchActionLabel,
      changesetId: patchSummary.changesetId,
      changesetTitle: patchSummary.changesetTitle,
      fileSummaryLabel: patchSummary.fileSummaryLabel,
      filePreviewLabel: patchSummary.filePreviewLabel,
      coverageLabel: patchSummary.coverageLabel,
      selectedCount: selectedKeys.length,
      selectedKeys,
      filePaths: patchSummary.filePaths,
      error: run.error || null,
      action,
      actionLabel,
      actionRecommendationKeys,
      patchAction: patchSummary.patchActionLabel ? 'inspect_patch' : null,
    };
  });
}

export function normalizeRecommendationCommentMap(rawMap: unknown): RecommendationCommentMap {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const normalized: RecommendationCommentMap = {};
  for (const [key, value] of Object.entries(rawMap as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<RecommendationCommentEntry>;
    const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
    if (!comment) continue;
    const normalizedKey = normalizeRecommendationKeyPart(key);
    if (!normalizedKey) continue;
    normalized[normalizedKey] = {
      comment,
      updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
        ? entry.updatedAt.trim()
        : new Date().toISOString(),
    };
  }
  return normalized;
}

export function normalizeManualLineCommentMap(rawMap: unknown): ManualLineCommentMap {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const normalized: ManualLineCommentMap = {};
  for (const [rawKey, value] of Object.entries(rawMap as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<ManualLineCommentDraft>;
    const id = String(entry.id || rawKey || '').trim();
    const path = String(entry.path || '').trim();
    const line = Number.isFinite(Number(entry.line)) && Number(entry.line) > 0
      ? Math.floor(Number(entry.line))
      : null;
    const side = String(entry.side || 'RIGHT').trim().toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
    const body = typeof entry.body === 'string' ? entry.body.trim() : '';
    if (!id || !path || !line || !body) continue;
    normalized[id] = {
      id,
      path,
      line,
      side,
      body,
      updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
        ? entry.updatedAt.trim()
        : new Date().toISOString(),
    };
  }
  return normalized;
}

export function normalizeRecommendationNoteMap(rawMap: unknown): RecommendationNoteMap {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const normalized: RecommendationNoteMap = {};
  for (const [rawKey, value] of Object.entries(rawMap as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<RecommendationNoteDraft>;
    const recommendationKey = buildRecommendationNoteId({
      recommendationKey: entry.recommendationKey || entry.id || rawKey,
    });
    const body = typeof entry.body === 'string' ? entry.body.trim() : '';
    if (!recommendationKey || !body) continue;
    const findingSeverity = entry.findingSeverity && RISK_ORDER[entry.findingSeverity] != null
      ? entry.findingSeverity
      : undefined;
    normalized[recommendationKey] = {
      id: recommendationKey,
      recommendationKey,
      body,
      updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
        ? entry.updatedAt.trim()
        : new Date().toISOString(),
      ...(entry.reviewType === 'branch_review' || entry.reviewType === 'pr_review'
        || entry.reviewType === 'workspace_review'
        ? { reviewType: entry.reviewType }
        : {}),
      ...(typeof entry.branchReviewId === 'string' && entry.branchReviewId.trim()
        ? { branchReviewId: entry.branchReviewId.trim() }
        : {}),
      ...(typeof entry.workspaceReviewId === 'string' && entry.workspaceReviewId.trim()
        ? { workspaceReviewId: entry.workspaceReviewId.trim() }
        : {}),
      ...(typeof entry.branchName === 'string' && entry.branchName.trim()
        ? { branchName: entry.branchName.trim() }
        : {}),
      ...(typeof entry.prReviewId === 'string' && entry.prReviewId.trim()
        ? { prReviewId: entry.prReviewId.trim() }
        : {}),
      ...(entry.githubPrNumber != null && Number.isFinite(Number(entry.githubPrNumber))
        ? { githubPrNumber: Math.trunc(Number(entry.githubPrNumber)) }
        : {}),
      ...(typeof entry.prHtmlUrl === 'string' && entry.prHtmlUrl.trim()
        ? { prHtmlUrl: entry.prHtmlUrl.trim() }
        : {}),
      ...(typeof entry.reviewDisplayId === 'string' && entry.reviewDisplayId.trim()
        ? { reviewDisplayId: entry.reviewDisplayId.trim() }
        : {}),
      ...(typeof entry.reviewTitle === 'string' && entry.reviewTitle.trim()
        ? { reviewTitle: entry.reviewTitle.trim() }
        : {}),
      ...(typeof entry.findingTitle === 'string' && entry.findingTitle.trim()
        ? { findingTitle: entry.findingTitle.trim() }
        : {}),
      ...(typeof entry.findingType === 'string' && entry.findingType.trim()
        ? { findingType: entry.findingType.trim().toLowerCase() }
        : {}),
      ...(findingSeverity ? { findingSeverity } : {}),
      ...(typeof entry.findingLocation === 'string' && entry.findingLocation.trim()
        ? { findingLocation: entry.findingLocation.trim() }
        : {}),
      ...(typeof entry.findingSourceLocation === 'string' && entry.findingSourceLocation.trim()
        ? { findingSourceLocation: entry.findingSourceLocation.trim() }
        : {}),
      ...(typeof entry.findingDescription === 'string' && entry.findingDescription.trim()
        ? { findingDescription: entry.findingDescription.trim() }
        : {}),
      ...(typeof entry.evidenceSnippet === 'string' && entry.evidenceSnippet.trim()
        ? { evidenceSnippet: entry.evidenceSnippet.trimEnd() }
        : {}),
    };
  }
  return normalized;
}

export function normalizePrivateReviewNoteMap(rawMap: unknown): PrivateReviewNoteMap {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const normalized: PrivateReviewNoteMap = {};
  for (const [rawKey, value] of Object.entries(rawMap as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<PrivateReviewNoteDraft>;
    const path = String(entry.path || '').trim();
    const line = Number.isFinite(Number(entry.line)) && Number(entry.line) > 0
      ? Math.floor(Number(entry.line))
      : undefined;
    const side = line
      ? (String(entry.side || 'RIGHT').trim().toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT')
      : undefined;
    const body = typeof entry.body === 'string' ? entry.body.trim() : '';
    const id = String(entry.id || rawKey || '').trim() || buildPrivateReviewNoteId({ path, line, side });
    if (!id || !path || !body) continue;
    normalized[id] = {
      id,
      path,
      line,
      side,
      body,
      updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
        ? entry.updatedAt.trim()
        : new Date().toISOString(),
      ...(entry.reviewType === 'branch_review' || entry.reviewType === 'pr_review'
        || entry.reviewType === 'workspace_review'
        ? { reviewType: entry.reviewType }
        : {}),
      ...(typeof entry.branchReviewId === 'string' && entry.branchReviewId.trim()
        ? { branchReviewId: entry.branchReviewId.trim() }
        : {}),
      ...(typeof entry.workspaceReviewId === 'string' && entry.workspaceReviewId.trim()
        ? { workspaceReviewId: entry.workspaceReviewId.trim() }
        : {}),
      ...(typeof entry.branchName === 'string' && entry.branchName.trim()
        ? { branchName: entry.branchName.trim() }
        : {}),
      ...(typeof entry.prReviewId === 'string' && entry.prReviewId.trim()
        ? { prReviewId: entry.prReviewId.trim() }
        : {}),
      ...(entry.githubPrNumber != null && Number.isFinite(Number(entry.githubPrNumber))
        ? { githubPrNumber: Math.trunc(Number(entry.githubPrNumber)) }
        : {}),
      ...(typeof entry.prHtmlUrl === 'string' && entry.prHtmlUrl.trim()
        ? { prHtmlUrl: entry.prHtmlUrl.trim() }
        : {}),
      ...(typeof entry.reviewDisplayId === 'string' && entry.reviewDisplayId.trim()
        ? { reviewDisplayId: entry.reviewDisplayId.trim() }
        : {}),
      ...(typeof entry.reviewTitle === 'string' && entry.reviewTitle.trim()
        ? { reviewTitle: entry.reviewTitle.trim() }
        : {}),
      ...(typeof entry.snapshotLabel === 'string' && entry.snapshotLabel.trim()
        ? { snapshotLabel: entry.snapshotLabel.trim() }
        : {}),
      ...(typeof entry.snapshotExcerpt === 'string' && entry.snapshotExcerpt.trim()
        ? { snapshotExcerpt: entry.snapshotExcerpt.trimEnd() }
        : {}),
      ...(typeof entry.snapshotLanguage === 'string' && entry.snapshotLanguage.trim()
        ? { snapshotLanguage: entry.snapshotLanguage.trim() }
        : {}),
    };
  }
  return normalized;
}

export function buildRecommendationNoteList(args: {
  notes: RecommendationNoteMap;
  activeRecommendationKeys?: Iterable<string> | null;
}): RecommendationNoteListEntry[] {
  const activeRecommendationKeySet = args.activeRecommendationKeys
    ? new Set(Array.from(args.activeRecommendationKeys, (key) => buildRecommendationNoteId({ recommendationKey: String(key || '') })).filter(Boolean))
    : null;
  return Object.values(args.notes)
    .map((note) => {
      const active = activeRecommendationKeySet ? activeRecommendationKeySet.has(note.recommendationKey) : true;
      return {
        ...note,
        active,
        staleReason: active ? undefined : 'Finding is not present in the current review snapshot.',
      };
    })
    .sort((left, right) => {
      const activeDiff = Number(right.active) - Number(left.active);
      if (activeDiff !== 0) return activeDiff;
      const severityDiff = (RISK_ORDER[right.findingSeverity || 'low'] ?? 0) - (RISK_ORDER[left.findingSeverity || 'low'] ?? 0);
      if (severityDiff !== 0) return severityDiff;
      const updatedDiff = (Date.parse(right.updatedAt || '') || 0) - (Date.parse(left.updatedAt || '') || 0);
      if (updatedDiff !== 0) return updatedDiff;
      return String(left.findingTitle || '').localeCompare(String(right.findingTitle || ''));
    });
}

export function buildPrivateReviewNoteList(args: {
  notes: PrivateReviewNoteMap;
  activePaths?: Iterable<string> | null;
}): PrivateReviewNoteListEntry[] {
  const activePathSet = args.activePaths
    ? new Set(Array.from(args.activePaths, (path) => String(path || '').trim()).filter(Boolean))
    : null;
  return Object.values(args.notes)
    .map((note) => {
      const anchorKind: 'file' | 'line' = note.line ? 'line' : 'file';
      const fileMissing = activePathSet ? !activePathSet.has(note.path) : false;
      const locationLabel = anchorKind === 'line'
        ? `${note.path}:${note.line}${note.side === 'LEFT' ? ' (deleted)' : ''}`
        : note.path;
      return {
        ...note,
        anchorKind,
        stale: fileMissing,
        staleReason: fileMissing ? 'File no longer exists in this review snapshot.' : undefined,
        locationLabel,
      };
    })
    .sort((left, right) => {
      const staleDiff = Number(left.stale) - Number(right.stale);
      if (staleDiff !== 0) return staleDiff;
      const pathDiff = left.path.localeCompare(right.path);
      if (pathDiff !== 0) return pathDiff;
      const leftLine = left.line ?? -1;
      const rightLine = right.line ?? -1;
      if (leftLine !== rightLine) return leftLine - rightLine;
      return (right.updatedAt || '').localeCompare(left.updatedAt || '');
    });
}

export function mergeRecommendationResolutionMaps(
  localMap: RecommendationResolutionMap,
  serverMap: RecommendationResolutionMap
): RecommendationResolutionMap {
  const merged: RecommendationResolutionMap = { ...localMap };
  for (const [key, serverEntry] of Object.entries(serverMap)) {
    const localEntry = merged[key];
    if (!localEntry) {
      merged[key] = serverEntry;
      continue;
    }
    const localUpdatedAt = Date.parse(localEntry.updatedAt || '');
    const serverUpdatedAt = Date.parse(serverEntry.updatedAt || '');
    const serverIsNewer = Number.isFinite(serverUpdatedAt)
      ? (!Number.isFinite(localUpdatedAt) || serverUpdatedAt >= localUpdatedAt)
      : true;
    if (serverIsNewer) {
      merged[key] = serverEntry;
    }
  }
  return merged;
}

export function reconcileRecommendationResolutionMaps(
  localMap: RecommendationResolutionMap,
  serverMap: RecommendationResolutionMap,
  nowMs = Date.now()
): RecommendationResolutionMap {
  const reconciled = mergeRecommendationResolutionMaps(localMap, serverMap);
  const hasServerOutcomeEntries = Object.keys(serverMap).length > 0;
  if (!hasServerOutcomeEntries) {
    return reconciled;
  }
  const serverKeys = new Set(Object.keys(serverMap));
  for (const [key, localEntry] of Object.entries(localMap)) {
    if (serverKeys.has(key)) continue;
    const localUpdatedAt = Date.parse(localEntry.updatedAt || '');
    const keepLocal = Number.isFinite(localUpdatedAt) && (nowMs - localUpdatedAt) <= OUTCOME_SYNC_GRACE_MS;
    if (!keepLocal) {
      delete reconciled[key];
    }
  }
  return reconciled;
}

export function getRecommendationResolutionFor(
  rec: ReviewRecommendation,
  resolutions: RecommendationResolutionMap
): RecommendationResolutionEntry | null {
  const canonicalKey = getRecommendationOutcomeKey(rec);
  const canonicalResolution = resolutions[canonicalKey];
  if (canonicalResolution) return canonicalResolution;
  const legacyKey = buildLegacyReviewRecommendationKey(rec);
  if (legacyKey !== canonicalKey) {
    return resolutions[legacyKey] || null;
  }
  return null;
}

export function getSelectedRecommendations(args: {
  review: ReviewResult;
  includeResolved: boolean;
  recommendationResolutions: RecommendationResolutionMap;
}): ReviewRecommendation[] {
  const { review, includeResolved, recommendationResolutions } = args;
  const allRecs = Array.isArray(review.recommendations) ? review.recommendations : [];
  if (includeResolved) return allRecs;
  return allRecs.filter((rec) => !getRecommendationResolutionFor(rec, recommendationResolutions));
}

export function buildReviewMarkdown(args: {
  review: ReviewResult;
  contextLabel: string;
  includeResolved: boolean;
  recommendationResolutions: RecommendationResolutionMap;
}): string {
  const lines: string[] = [];
  const { review, contextLabel, includeResolved, recommendationResolutions } = args;
  const allRecs = Array.isArray(review.recommendations) ? review.recommendations : [];
  const selectedRecs = getSelectedRecommendations({
    review,
    includeResolved,
    recommendationResolutions,
  });
  const actionableRecs = selectedRecs.filter((r) => r.type !== 'praise');
  const praiseRecs = selectedRecs.filter((r) => r.type === 'praise');
  const grouped = new Map<string, ReviewRecommendation[]>();
  const effectiveRiskLevel = getEffectiveReviewRiskLevel(review);
  for (const rec of actionableRecs) {
    const severity = normalizeRecommendationSeverity(rec);
    const list = grouped.get(severity) || [];
    list.push(rec);
    grouped.set(severity, list);
  }

  lines.push(`## AI Review Summary — ${contextLabel}`);
  lines.push('');
  lines.push(`- Risk: ${String(effectiveRiskLevel).toUpperCase()}`);
  lines.push(`- Findings included: ${actionableRecs.length}/${allRecs.length}${includeResolved ? ' (including resolved)' : ' (unresolved only)'}`);
  lines.push(`- Reviewed at: ${review.reviewedAt}`);
  lines.push('');
  lines.push(review.summary || 'No summary provided.');
  lines.push('');
  lines.push('### Findings');

  const order = ['critical', 'high', 'medium', 'low'];
  let emittedAny = false;
  for (const severity of order) {
    const recs = grouped.get(severity) || [];
    if (recs.length === 0) continue;
    emittedAny = true;
    lines.push('');
    lines.push(`#### ${severity.toUpperCase()} (${recs.length})`);
    for (const rec of recs) {
      const locationValue = formatRecommendationLocation(rec);
      const location = locationValue ? ` (${locationValue})` : '';
      const prefix = rec.type === 'issue' ? 'Issue' : 'Suggestion';
      lines.push(`- **${prefix}:** ${rec.title}${location}`);
      if (rec.description) {
        lines.push(`  - ${rec.description}`);
      }
      const resolution = getRecommendationResolutionFor(rec, recommendationResolutions);
      if (resolution) {
        const noteSuffix = resolution.note ? ` — ${resolution.note}` : '';
        lines.push(`  - Resolution: ${resolution.state}${noteSuffix}`);
      }
    }
  }

  if (!emittedAny) {
    lines.push('');
    lines.push('- No findings in selected scope.');
  }

  if (praiseRecs.length > 0) {
    lines.push('');
    lines.push('### Praises');
    for (const rec of praiseRecs) {
      const locationValue = formatRecommendationLocation(rec);
      const location = locationValue ? ` (${locationValue})` : '';
      lines.push(`- ${rec.title}${location}`);
      if (rec.description) {
        lines.push(`  - ${rec.description}`);
      }
    }
  }

  lines.push('');
  lines.push('### Suggested next steps');
  lines.push('- Address unresolved issues in priority order.');
  lines.push('- Re-run AI review after fixes.');
  lines.push('- Request follow-up review if risk remains high.');

  return lines.join('\n');
}

export function formatRecommendationLocation(rec: ReviewRecommendation): string {
  return formatRecommendationDisplayLocation(rec);
}

export function summarizeRecommendationLine(rec: ReviewRecommendation): string {
  const location = formatRecommendationLocation(rec);
  const severity = normalizeRecommendationSeverity(rec).toUpperCase();
  const title = String(rec.title || '').trim() || 'Untitled finding';
  return location
    ? `- [${severity}] ${title} (${location})`
    : `- [${severity}] ${title}`;
}

export function buildGitHubReviewCommentMarkdown(args: {
  review: ReviewResult;
  contextLabel: string;
  includeResolved: boolean;
  recommendationResolutions: RecommendationResolutionMap;
}): string {
  const base = buildReviewMarkdown(args);
  return `${base}\n\n### Reviewer Checklist\n- [ ] Validate high-severity findings\n- [ ] Verify suggested fixes and tests\n- [ ] Re-run review after updates`;
}

export function buildFixPrompt(args: {
  review: ReviewResult;
  contextLabel: string;
  includeResolved: boolean;
  recommendationResolutions: RecommendationResolutionMap;
  selectedRecommendationKeys?: string[];
}): string {
  const {
    review,
    contextLabel,
    includeResolved,
    recommendationResolutions,
    selectedRecommendationKeys = [],
  } = args;
  const selectedKeySet = new Set(
    (Array.isArray(selectedRecommendationKeys) ? selectedRecommendationKeys : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  const selected = getSelectedRecommendations({ review, includeResolved, recommendationResolutions })
    .filter((rec) => selectedKeySet.size === 0 || selectedKeySet.has(getRecommendationFingerprint(rec)));
  const actionable = selected.filter((r) => r.type !== 'praise');
  const praises = selected.filter((r) => r.type === 'praise');
  const lines: string[] = [];
  lines.push('You are helping fix review findings in a code review.');
  lines.push(`Context: ${contextLabel}`);
  lines.push(`Risk level: ${getEffectiveReviewRiskLevel(review)}`);
  const reviewStats: Partial<ReviewResult['stats']> = (
    review?.stats && typeof review.stats === 'object'
  ) ? review.stats : {};
  const diffAdditions = Math.max(0, Number(reviewStats.totalAdditions || 0));
  const diffDeletions = Math.max(0, Number(reviewStats.totalDeletions || 0));
  const diffFileCount = Math.max(0, Number(
    reviewStats.totalChangedFiles
    ?? reviewStats.filesTotal
    ?? reviewStats.filesAnalyzed
    ?? 0
  ));
  lines.push(`Diff stats: +${diffAdditions} / -${diffDeletions} across ${diffFileCount} files`);
  lines.push(`Findings to address: ${actionable.length}`);
  const reviewSummary = String(review?.summary || '').trim();
  if (reviewSummary) {
    lines.push('');
    lines.push(`Review summary: ${reviewSummary}`);
  }
  lines.push('');
  lines.push('Execution rules:');
  lines.push('- Read each target file before editing — understand the surrounding code context first.');
  lines.push('- Apply the smallest patch that resolves the selected findings.');
  lines.push('- Preserve behavior unless a safety fix requires a minimal guard.');
  lines.push('- Avoid unrelated refactors.');
  lines.push('- Leave the repo in a verification-ready state.');
  lines.push('');
  if (actionable.length === 0) {
    lines.push('No open findings were selected.');
  } else {
    lines.push('Selected findings:');
    actionable.forEach((rec, index) => {
      lines.push(``);
      lines.push(`### Finding ${index + 1}`);
      lines.push(buildFixIssueContext(rec));
    });
  }
  if (praises.length > 0) {
    lines.push('');
    lines.push('Praises:');
    praises.forEach((rec) => lines.push(summarizeRecommendationLine(rec)));
  }
  return lines.join('\n');
}

export function inferOmittedReason(
  path: string,
  file?: BranchReviewFileSummary | BranchReviewFileContent | null
): string {
  const normalizedPath = String(path || '').trim().toLowerCase();
  const status = String(file?.status || '').toUpperCase();
  const totalDelta = Number(file?.additions || 0) + Number(file?.deletions || 0);

  if (status === 'R' && totalDelta === 0) return 'Rename-only change';
  if (totalDelta > 1400) return 'Large diff (focused budget)';

  if (
    normalizedPath.endsWith('.png')
    || normalizedPath.endsWith('.jpg')
    || normalizedPath.endsWith('.jpeg')
    || normalizedPath.endsWith('.gif')
    || normalizedPath.endsWith('.ico')
    || normalizedPath.endsWith('.pdf')
    || normalizedPath.endsWith('.zip')
    || normalizedPath.endsWith('.mp4')
    || normalizedPath.endsWith('.mov')
  ) {
    return 'Binary/non-code asset';
  }

  if (
    normalizedPath.startsWith('docs/')
    || normalizedPath.includes('/docs/')
    || normalizedPath.endsWith('.md')
    || normalizedPath.endsWith('.mdx')
    || normalizedPath.includes('readme')
    || normalizedPath.includes('changelog')
  ) {
    return 'Low-risk docs/content';
  }

  if (
    normalizedPath.includes('/node_modules/')
    || normalizedPath.startsWith('node_modules/')
    || normalizedPath.includes('/dist/')
    || normalizedPath.includes('/build/')
    || normalizedPath.includes('/vendor/')
    || normalizedPath.includes('/third_party/')
    || normalizedPath.endsWith('.lock')
    || normalizedPath.endsWith('.min.js')
  ) {
    return 'Generated/vendor artifact';
  }

  if (
    normalizedPath.endsWith('.test.ts')
    || normalizedPath.endsWith('.test.tsx')
    || normalizedPath.endsWith('.spec.ts')
    || normalizedPath.endsWith('.spec.tsx')
    || normalizedPath.includes('__tests__/')
  ) {
    return 'Lower risk test-only change';
  }

  return 'Focused risk-priority budget';
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function sanitizeFileNamePart(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function downloadMarkdownFile(filename: string, content: string): boolean {
  if (!filename || !content) return false;
  try {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename.endsWith('.md') ? filename : `${filename}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

export type TrustAnalyticsCardTone = 'default' | 'good' | 'warn' | 'critical' | 'info';

export type TrustAnalyticsCardModel = {
  label: string;
  value: string;
  detail: string;
  tone: TrustAnalyticsCardTone;
};

export function formatTrustAnalyticsDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return 'n/a';
  const ms = Math.max(0, Number(value));
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) {
    const seconds = ms / 1000;
    return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatTrustAnalyticsRate(metric: Pick<TrustAnalyticsRateMetric, 'value'> | null | undefined): string {
  if (!metric || metric.value == null || !Number.isFinite(Number(metric.value))) {
    return 'n/a';
  }
  return `${Math.round(Number(metric.value) * 100)}%`;
}

function describeTrustAnalyticsSample(metric: TrustAnalyticsRateMetric): string {
  if (metric.denominator <= 0) return 'n/a';
  if (metric.isInsufficientSample) return `n=${metric.sampleSize}`;
  return `${metric.numerator}/${metric.denominator}`;
}

function getRateTone(metric: TrustAnalyticsRateMetric, thresholds: { good: number; warn: number }): TrustAnalyticsCardTone {
  if (metric.value == null) return 'default';
  if (metric.value >= thresholds.good) return 'good';
  if (metric.value >= thresholds.warn) return 'warn';
  return 'critical';
}

export function buildTrustAnalyticsInstantReturnCards(analytics: TrustReviewAnalytics): TrustAnalyticsCardModel[] {
  const reliabilityTone: Record<TrustReviewAnalytics['reliability']['reviewReliability'], TrustAnalyticsCardTone> = {
    full: 'good',
    partial: 'warn',
    files_only: 'warn',
    failed: 'critical',
  };
  return [
    {
      label: 'TTFS',
      value: formatTrustAnalyticsDuration(analytics.immediateValue.ttfsMs),
      detail: analytics.immediateValue.reviewDurationMs != null
        ? `Completed in ${formatTrustAnalyticsDuration(analytics.immediateValue.reviewDurationMs)}`
        : 'No duration telemetry',
      tone: analytics.immediateValue.ttfsMs != null && analytics.immediateValue.ttfsMs <= 10000 ? 'good' : 'info',
    },
    {
      label: 'Deep coverage',
      value: formatTrustAnalyticsRate(analytics.immediateValue.deepCoverage),
      detail: analytics.immediateValue.deepCoverage.denominator > 0
        ? `${analytics.immediateValue.deepCoverage.numerator}/${analytics.immediateValue.deepCoverage.denominator} files`
        : 'No changed-file denominator',
      tone: getRateTone(analytics.immediateValue.deepCoverage, { good: 0.85, warn: 0.6 }),
    },
    {
      label: 'Issues found',
      value: String(analytics.immediateValue.issuesFound),
      detail: analytics.immediateValue.highRiskFindings > 0
        ? `${analytics.immediateValue.highRiskFindings} high risk`
        : 'No high-risk findings',
      tone: analytics.immediateValue.highRiskFindings > 0 ? 'warn' : 'info',
    },
    {
      label: 'Trust quality',
      value: formatTrustAnalyticsRate(analytics.trustQuality.groundedIssueRate),
      detail: describeTrustAnalyticsSample(analytics.trustQuality.groundedIssueRate),
      tone: getRateTone(analytics.trustQuality.groundedIssueRate, { good: 0.8, warn: 0.5 }),
    },
    {
      label: 'Reliability',
      value: analytics.reliability.reviewReliability.replace('_', ' '),
      detail: analytics.reliability.gateStatus
        ? `Gate ${analytics.reliability.gateStatus}`
        : 'No gate decision',
      tone: reliabilityTone[analytics.reliability.reviewReliability],
    },
  ];
}

export function buildTrustAnalyticsFollowThroughCards(analytics: TrustReviewAnalytics): TrustAnalyticsCardModel[] {
  return [
    {
      label: 'Addressed rate',
      value: formatTrustAnalyticsRate(analytics.followThrough.issueAddressedRate),
      detail: analytics.followThrough.issueAddressedRate.denominator > 0
        ? `${analytics.followThrough.addressedCount} addressed • ${describeTrustAnalyticsSample(analytics.followThrough.issueAddressedRate)}`
        : 'No issue outcomes yet',
      tone: getRateTone(analytics.followThrough.issueAddressedRate, { good: 0.6, warn: 0.3 }),
    },
    {
      label: 'Dismissed rate',
      value: formatTrustAnalyticsRate(analytics.followThrough.issueDismissedRate),
      detail: analytics.followThrough.issueDismissedRate.denominator > 0
        ? `${analytics.followThrough.dismissedCount} dismissed • ${describeTrustAnalyticsSample(analytics.followThrough.issueDismissedRate)}`
        : 'No issue outcomes yet',
      tone: analytics.followThrough.issueDismissedRate.value != null && analytics.followThrough.issueDismissedRate.value >= 0.5 ? 'warn' : 'info',
    },
    {
      label: 'Outcome coverage',
      value: formatTrustAnalyticsRate(analytics.followThrough.issueOutcomeCoverage),
      detail: analytics.followThrough.issueOutcomeCoverage.denominator > 0
        ? describeTrustAnalyticsSample(analytics.followThrough.issueOutcomeCoverage)
        : 'Waiting for reviewer actions',
      tone: getRateTone(analytics.followThrough.issueOutcomeCoverage, { good: 0.7, warn: 0.4 }),
    },
  ];
}
