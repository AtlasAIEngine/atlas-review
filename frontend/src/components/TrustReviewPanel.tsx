/**
 * TrustReviewPanel — Right panel AI review with progressive disclosure.
 * Replaces TrustReviewPlaceholder with progressive disclosure layers:
 *   1. Verdict Card (always visible)
 *   2. Risks & Recommendations (collapsible)
 *   3. Summary (collapsed by default)
 * Change groups have moved to the dedicated Walkthrough mode.
 * Plus Verification section and Ship-It action bar.
 */

import { useState, useEffect, useCallback, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
import { changesetApi, reviewApi, actionApi, branchReviewApi, workspaceReviewApi, prReviewApi, settingsApi } from '@/services/api';
import type { VerifyConfig } from '@/services/api';
import { emitProjectSocketEvent, emitProjectSocketEventWithAck, subscribeProjectSocket } from '@/services/projectSocket';
import { openExternal } from '@/utils/openExternal';
import { isTauriEnvironment } from '@/utils/tauri';
import type { DiffNavigationTarget } from '@/utils/reviewNavigation';
import { getRecommendationDiffNavigationTarget, getRecommendationPatchLine, getRecommendationSourceFile, getRecommendationSourceLine } from '@/utils/reviewNavigation';
import {
  buildReviewPathLookup,
  resolveCanonicalReviewPath,
} from '@/utils/reviewPathMatching';
import type {
  ChangeSet,
  BranchReview,
  PrReview,
  BranchReviewFileSummary,
  BranchReviewFileContent,
  BranchReviewScope,
  ReviewResult,
  ReviewRecommendation,
  ChangeSetVerification,
  ReviewPublicationState,
  ReviewSubmissionState,
  ReviewFileFilter,
  ReviewFixBuildSummary,
  ReviewFixRunArtifact,
  ReviewFixRecommendationStatus,
  GitHubPrConversations,
  GitHubPrIssueComment,
  GitHubPrReviewThread,
  GitHubPrThreadComment,
} from '@/types';
import type { ReviewAgentAttachment, ReviewAgentOpenOptions, ReviewAgentScope } from '@/services/reviewAgentApi';

// ── Extracted subcomponents ─────────────────────────────────────────────
import { VerdictCard } from './review/VerdictCard';
import {
  GITHUB_CONVERSATION_RETRY_DELAY_MS,
  PR_REVIEW_CONVERSATIONS_UPDATED_EVENT,
  describeGitHubConversationLoadError,
  describeGitHubConversationRetry,
  getGitHubConversationDiffTarget,
  isRetryableGitHubConversationLoadError,
  shouldAutoSyncGitHubConversations,
  type PrReviewConversationsUpdatedDetail,
} from './review/GitHubConversation';
import { GitHubConversationsSection } from './review/GitHubConversationsSection';
import {
  ReviewTierNotice,
  CollapsibleSection,
  ProgressPill,
  NoReviewSection,
} from './review/ReviewWidgets';
import { QueuedReviewPill, RunningReviewStrip, type RunningStepSpec } from './review/RunningView';
import { RisksSection } from './review/RisksSection';
import { RecommendationItem } from './review/RecommendationItem';
import { PrCommentSelectionDialog } from './review/PrCommentSelectionDialog';
import { FixIssueSelectionDialog } from './review/FixIssueSelectionDialog';
import { ReviewAgentDrawer } from './review/ReviewAgentDrawer';
import { VerificationSection } from './review/VerificationSection';
import { isPrReviewStale, getPrStaleReviewSummary } from '@/lib/reviewPublishActions';
import { usePopup } from './shared/PopupProvider';
import {
  LARGE_DIFF_PARTIAL_POPUP_THRESHOLD,
  PARTIAL_MODE_MAX_FILES_HINT,
} from '@/constants/reviewPartialMode';
import { askPartialOrFull } from '@/lib/askPartialOrFull';
import type {
  ManualLineCommentDraft,
  RecommendationNoteMap,
  RecommendationFixStatusMap,
  RecommendationResolutionState,
  RecommendationResolutionMap,
} from './review/reviewPanelUtils';
import {
  TERMINAL_LIFECYCLE_STATUSES,
  normalizeReviewTier,
  isActiveReviewProgressPhase,
  computeProgressPercent,
  normalizeLifecycleStatusValue,
  isActiveLifecycleStatus,
  buildOptimisticQueuedLifecycle,
  buildPrCommentSelectionItems,
  buildFixSelectionItems,
  buildGitHubCompareUrl,
  parseScopePatterns,
  buildScopeStatusLabel,
  getReviewCoverageStats,
  formatPersistedFailureMessage,
  parseStoredPatternSetting,
  getRecommendationFingerprint,
  buildRecommendationOutcomeScope,
  buildRecommendationResolutionStorageKey,
  buildRecommendationCommentStorageKey,
  buildManualLineCommentStorageKey,
  buildRecommendationNoteStorageKey,
  REVIEW_COMMENT_DRAFTS_UPDATED_EVENT,
  buildLegacyRecommendationResolutionStorageKey,
  normalizeRecommendationResolutionMap,
  normalizeRecommendationCommentMap,
  normalizeManualLineCommentMap,
  normalizeRecommendationNoteMap,
  getVerificationPendingRecommendationKeys,
  buildPersistedFixRunStatusLabel,
  buildRecommendationFixStatusesFromRun,
  buildRecommendationFixStatusesFromRuns,
  buildRecommendationNoteDraft,
  reconcileRecommendationResolutionMaps,
  getRecommendationResolutionFor,
  buildReviewMarkdown,
  buildGitHubReviewCommentMarkdown,
  buildFixIssueContext,
  buildFixIssueFilePaths,
  buildFixPrompt,
  copyTextToClipboard,
  sanitizeFileNamePart,
  downloadMarkdownFile,
  isLastCommitFallbackBaseBranch,
  formatBaseBranchLabel,
} from './review/reviewPanelUtils';
import { normalizeHeadSha } from '@/utils/sha';

// ── Props & Ref ─────────────────────────────────────────────────────────

interface TrustReviewPanelProps {
  projectId: string;
  changesetId?: string;       // For change sets
  branchReviewId?: string;    // For branch reviews
  workspaceReviewId?: string; // For workspace reviews
  prReviewId?: string;        // For PR reviews
  activeProviderLabel?: string | null;
  refreshToken?: number;
  hasTopBannerReviewAction?: boolean;
  branchSnapshotStaleMessage?: string | null;
  suppressBranchReviewProgress?: boolean;
  branchReviewProgress?: {
    phase?: string;
    currentChunk: number;
    totalChunks: number;
    filesCompleted: number;
    totalFiles: number;
    activeChunkFiles?: number;
    elapsedSeconds?: number;
    splitDepth?: number;
    splitParts?: number;
    agenticToolSummary?: string | null;
    agentName?: string | null;
    reviewModel?: string | null;
    reviewModelStrategy?: string | null;
    reviewModelEffectiveStrategy?: string | null;
    diffScopeMode?: 'full' | 'delta' | null;
    diffScopeCommitCount?: number;
    diffBaseSha?: string | null;
    diffHeadSha?: string | null;
    prRequestedMode?: 'auto' | 'full' | 'agentic_discovery' | null;
    prEffectiveMode?: 'auto' | 'full' | 'agentic_discovery' | null;
    prPipelineMode?: 'standard' | 'agentic_discovery' | null;
    totalPrFiles?: number;
    effectiveReviewFiles?: number;
  } | null;
  queuedBranchReviewRun?: {
    queueId?: string | null;
    position?: number | null;
  } | null;
  onCancelQueuedBranchReview?: (queueId: string) => void;
  queuedBranchReviewCancelDisabled?: boolean;
  activeFileFilter?: ReviewFileFilter | null;
  interactionLockReason?: string | null;
  currentBranchName?: string | null;
  onSelectFileFilter?: (filter: ReviewFileFilter | null) => void;
  onScrollToFile?: (target: DiffNavigationTarget) => void;
  onBranchReviewDeleted?: (branchReviewId: string) => void;
  onBannerReviewStateChange?: ((state: { isFixRunActive: boolean; hasVerificationPending: boolean }) => void) | null;
  onPrReviewPublished?: ((action: 'comment' | 'approve' | 'request_changes') => void) | null;
  onOpenReviewAgent?: ((attachments?: ReviewAgentAttachment[], options?: ReviewAgentOpenOptions) => void) | null;
}

type BranchReviewProgressState = NonNullable<TrustReviewPanelProps['branchReviewProgress']>;

export interface TrustReviewPanelRef {
  triggerPush: () => void;
  triggerReview: () => Promise<boolean>;
  triggerFullReview: () => Promise<boolean>;
  triggerPartialReview: () => Promise<boolean>;
  stopFixRun: () => void;
  openFixDialog: () => void;
  startFixRunForKeys: (recommendationKeys: string[]) => boolean;
  openPrFindingSelectionDialog: (
    action: 'comment' | 'request_changes',
    body?: string | null,
  ) => { ok: true } | { ok: false; error: string };
  openPrApproveDialog: () => { ok: true } | { ok: false; error: string };
  setRecommendationOutcomeByKey: (
    recommendationKey: string,
    status: RecommendationResolutionState,
    note?: string,
  ) => { ok: true } | { ok: false; error: string };
  clearReview: () => Promise<boolean>;
}

// ── Local constants (not extracted to reviewPanelUtils) ─────────────────

const STALE_BACKGROUND_REVIEW_MS = 5 * 60 * 1000;
const MAX_REVIEW_POLL_MS = 10 * 60 * 1000;
const OUTCOME_REFRESH_POLL_MS = 5000;
const VERIFICATION_SNAPSHOT_COMMIT_MESSAGE = 'chore(review): verification snapshot for issue fixer';
const FINDINGS_INCLUDE_RESOLVED_STORAGE_KEY = 'atlas.trust-review.findings.includeResolved';

function normalizeBranchNameForFix(value: unknown): string {
  return String(value || '').trim().replace(/^refs\/heads\//, '');
}

function formatReviewDurationMs(value: unknown): string | null {
  const ms = Math.max(0, Math.trunc(Number(value) || 0));
  if (ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function readPersistedIncludeResolvedInActions(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(FINDINGS_INCLUDE_RESOLVED_STORAGE_KEY);
    if (raw === 'false') return false;
    if (raw === 'true') return true;
  } catch {
    // localStorage may throw in private modes or when quota is exceeded.
  }
  return true;
}

function isCompletedReviewStatusValue(reviewStatus: string | null | undefined): boolean {
  const normalized = String(reviewStatus || '').trim().toLowerCase();
  return normalized === 'reviewed' || normalized === 'completed';
}

type BranchReviewWithDiffFiles = BranchReview & {
  files?: Array<BranchReviewFileSummary | BranchReviewFileContent>;
};

type ReviewOutcomeSocketEvent = {
  projectId?: string;
  reviewType?: string;
  reviewId?: string;
  action?: 'upsert' | 'delete';
  recommendationKey?: string | null;
};

type FixSocketEventPayload = {
  projectId?: string;
  runId?: string | null;
  reviewType?: string | null;
  reviewId?: string | null;
  recommendationKey?: string | null;
  recommendationKeys?: string[];
  status?: ReviewFixRecommendationStatus | string | null;
  filePaths?: string[];
  error?: string | null;
  buildSummary?: ReviewFixBuildSummary | null;
  startedAt?: string | null;
  taskId?: string | null;
  kind?: string | null;
  text?: string | null;
  payload?: unknown;
  tool?: unknown;
};

type ActiveFixRunState = {
  runId: string | null;
  isRunning: boolean;
  startedAt: string | null;
  selectedKeys: string[];
  statusLabel: string;
  activityLabel: string | null;
  error: string | null;
  buildSummary: ReviewFixBuildSummary | null;
};

function normalizeFixActivityText(value: unknown): string | null {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function buildFixToolActivityLabel(tool: unknown): string | null {
  if (!tool || typeof tool !== 'object') return null;
  const record = tool as Record<string, any>;
  const name = String(record.name || record.tool || record.type || '').trim();
  const input = record.input && typeof record.input === 'object'
    ? record.input as Record<string, any>
    : {};
  const filePath = String(
    input.file_path
    || input.path
    || input.filePath
    || record.file_path
    || record.path
    || ''
  ).trim();
  if (name && filePath) return `Atlas is using ${name} on ${filePath}`;
  if (name) return `Atlas is using ${name}`;
  if (filePath) return `Atlas is updating ${filePath}`;
  return null;
}

function buildPostFixStatusLabel(selectedCount: number, filesChanged: number): string {
  if (filesChanged <= 0) return 'Fix run complete. No patch applied.';
  return selectedCount === 1
    ? 'Fix run complete. Inspect the patch and resolve the finding manually.'
    : 'Fix run complete. Review selected findings.';
}

function buildDefaultPrApprovalBody(prReview: PrReview | null | undefined): string {
  const prLabel = Number.isFinite(Number(prReview?.githubPrNumber))
    ? `PR #${Math.trunc(Number(prReview?.githubPrNumber))}`
    : (prReview?.displayId || 'this PR');
  const summary = typeof prReview?.reviewSummary === 'string' && prReview.reviewSummary.trim()
    ? prReview.reviewSummary.trim()
    : (typeof prReview?.reviewJson?.summary === 'string' && prReview.reviewJson.summary.trim()
        ? prReview.reviewJson.summary.trim()
        : '');
  const lines = [`Atlas approve review for ${prLabel}`];
  if (summary) {
    lines.push('', summary);
  }
  return lines.join('\n').trim();
}

// ── Main Component ──────────────────────────────────────────────────────

const TrustReviewPanel = forwardRef<TrustReviewPanelRef, TrustReviewPanelProps>(
function TrustReviewPanel({
    projectId,
    changesetId,
    branchReviewId,
    workspaceReviewId,
    prReviewId,
    activeProviderLabel = null,
    refreshToken = 0,
    hasTopBannerReviewAction = false,
    branchSnapshotStaleMessage = null,
    suppressBranchReviewProgress = false,
    branchReviewProgress,
    queuedBranchReviewRun = null,
    onCancelQueuedBranchReview,
    queuedBranchReviewCancelDisabled = false,
    activeFileFilter = null,
    interactionLockReason = null,
    currentBranchName = null,
    onSelectFileFilter,
    onScrollToFile,
    onBranchReviewDeleted,
    onBannerReviewStateChange = null,
    onPrReviewPublished = null,
    onOpenReviewAgent = null,
  }, ref) {
    const showBranchReviewDeleteAction = import.meta.env.DEV || isTauriEnvironment();
    const showPrReviewDeleteAction = import.meta.env.DEV || isTauriEnvironment();
    const resolveCurrentPrHeadSha = useCallback((review: any) => (
      normalizeHeadSha(review?.headSha || review?.reviewHeadSha || null)
    ), []);
    const retainSubmissionForHead = useCallback((
      nextHeadSha: string | null,
      previousSubmission: ReviewSubmissionState | null,
    ) => {
      if (!nextHeadSha || !previousSubmission) return null;
      return normalizeHeadSha(previousSubmission.headSha || null) === nextHeadSha
        ? previousSubmission
        : null;
    }, []);

    const [changeset, setChangeset] = useState<ChangeSet | null>(null);
    const [branchReview, setBranchReview] = useState<BranchReview | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [isReviewing, setIsReviewing] = useState(false);
    const [reviewError, setReviewError] = useState<string | null>(null);
    const [scopeIncludeText, setScopeIncludeText] = useState('');
    const [scopeExcludeText, setScopeExcludeText] = useState('');
    const [scopeApplyGlobalIgnorePatterns, setScopeApplyGlobalIgnorePatterns] = useState(true);
    const [globalIgnorePatternCount, setGlobalIgnorePatternCount] = useState(0);
    const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);
    const [reviewDetailsOpen, setReviewDetailsOpen] = useState(false);
    const [queueHasActiveBranchReview, setQueueHasActiveBranchReview] = useState<boolean | null>(null);
    const [queueStatusCheckedAt, setQueueStatusCheckedAt] = useState(0);
    const [queueProgressFallback, setQueueProgressFallback] = useState<BranchReviewProgressState | null>(null);
    const [csPollingTimedOut, setCsPollingTimedOut] = useState(false);
    const [isDismissingFailedReview, setIsDismissingFailedReview] = useState(false);
    const [githubCompareUrl, setGithubCompareUrl] = useState<string | null>(null);
    const [prBodyText, setPrBodyText] = useState<string | null>(null);
    const [prPublicationState, setPrPublicationState] = useState<ReviewPublicationState | null>(null);
    const [prReviewSubmission, setPrReviewSubmission] = useState<ReviewSubmissionState | null>(null);
    const [prConversations, setPrConversations] = useState<GitHubPrConversations | null>(null);
    const [isPrConversationsLoading, setIsPrConversationsLoading] = useState(false);
    const [isPrConversationsSyncing, setIsPrConversationsSyncing] = useState(false);
    const [prConversationsError, setPrConversationsError] = useState<string | null>(null);
    const [prConversationActionThreadId, setPrConversationActionThreadId] = useState<string | null>(null);
    const [prConversationActionCommentId, setPrConversationActionCommentId] = useState<string | null>(null);
    const [prConversationActionIssueCommentId, setPrConversationActionIssueCommentId] = useState<string | null>(null);
    const popup = usePopup();

    /** Whether we are displaying a branch review or PR review (vs a changeset) */
    const isBrMode = !!branchReviewId || !!workspaceReviewId || !!prReviewId;
    const isPrMode = !!prReviewId;
    const lifecycleProgressFallback = useMemo<BranchReviewProgressState | null>(() => {
      if (suppressBranchReviewProgress || !isBrMode || branchReviewProgress || queueProgressFallback || !branchReview) {
        return null;
      }
      const lifecycleStatus = normalizeLifecycleStatusValue(
        branchReview.reviewLifecycle?.status
          || branchReview.reviewLifecycle?.sourceStatus
          || branchReview.reviewStatus
          || 'none',
        'completed'
      );
      const lifecyclePhase = String(branchReview.reviewLifecycle?.phase || '').trim().toLowerCase();
      const isLifecycleActive = branchReview.reviewLifecycle?.isActive === true
        || isActiveLifecycleStatus(lifecycleStatus)
        || isActiveReviewProgressPhase(lifecyclePhase);
      if (!isLifecycleActive) {
        return null;
      }
      const fallbackPhase = lifecyclePhase || (
        lifecycleStatus === 'queued'
          ? 'queued'
          : lifecycleStatus === 'retrying'
            ? 'provider_retry'
            : 'reviewing'
      );
      return {
        phase: fallbackPhase,
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 0,
        activeChunkFiles: 0,
        elapsedSeconds: 0,
        splitDepth: 0,
        splitParts: 0,
        agenticToolSummary: null,
        agentName: null,
        diffScopeMode: null,
        diffScopeCommitCount: 0,
        diffBaseSha: null,
        diffHeadSha: null,
      };
    }, [
      isBrMode,
      suppressBranchReviewProgress,
      branchReviewProgress,
      queueProgressFallback,
      branchReview?.reviewStatus,
      branchReview?.reviewLifecycle?.status,
      branchReview?.reviewLifecycle?.sourceStatus,
      branchReview?.reviewLifecycle?.phase,
      branchReview?.reviewLifecycle?.isActive,
    ]);
    const effectiveBranchReviewProgress = suppressBranchReviewProgress
      ? null
      : (branchReviewProgress || queueProgressFallback || lifecycleProgressFallback);
    const branchReviewCoversCurrentHead = useMemo(() => {
      if (!isBrMode || isPrMode || !branchReview) return false;
      if (branchReview.reviewStatus !== 'reviewed') return false;
      const currentHeadSha = normalizeHeadSha(branchReview.headSha || null);
      const reviewedHeadSha = normalizeHeadSha(branchReview.reviewHeadSha || null);
      return Boolean(currentHeadSha && reviewedHeadSha && currentHeadSha === reviewedHeadSha);
    }, [isBrMode, isPrMode, branchReview]);
    const branchFixUnavailableReason = useMemo(() => {
      if (!branchReviewId || isPrMode) return null;
      const reviewBranchName = normalizeBranchNameForFix(branchReview?.branchName);
      const activeBranchName = normalizeBranchNameForFix(currentBranchName);
      const hasMatchingWorktree = Boolean(branchReview?.worktreePath || branchReview?.isWorktree);
      if (reviewBranchName && activeBranchName && reviewBranchName !== activeBranchName && !hasMatchingWorktree) {
        return `Switch to branch ${reviewBranchName} to run Fix Issues. Current worktree branch is ${activeBranchName}.`;
      }
      return null;
    }, [branchReviewId, isPrMode, branchReview?.branchName, branchReview?.isWorktree, branchReview?.worktreePath, currentBranchName]);
    const prReviewCoversCurrentHead = useMemo(() => {
      if (!isPrMode || !branchReview) return false;
      if (branchReview.reviewStatus !== 'reviewed') return false;
      const currentHeadSha = normalizeHeadSha(branchReview.headSha || null);
      const reviewedHeadSha = normalizeHeadSha(branchReview.reviewHeadSha || null);
      return Boolean(currentHeadSha && reviewedHeadSha && currentHeadSha === reviewedHeadSha);
    }, [isPrMode, branchReview]);
    const progressDisplayAgentName = effectiveBranchReviewProgress?.agentName
      || (typeof activeProviderLabel === 'string' && activeProviderLabel.trim() ? activeProviderLabel.trim() : null);
    const idleSectionProgress: BranchReviewProgressState | null = effectiveBranchReviewProgress
      ? {
          ...effectiveBranchReviewProgress,
          agentName: progressDisplayAgentName,
        }
      : null;
    const scopeStorageKey = branchReviewId ? `atlas_br_scope_${projectId}_${branchReviewId}` : null;
    const recommendationNoteStorageKey = useMemo(() => buildRecommendationNoteStorageKey({
      projectId,
      branchReviewId,
      workspaceReviewId,
      branchName: branchReview?.branchName || null,
      prReviewId,
    }), [projectId, branchReviewId, workspaceReviewId, branchReview?.branchName, prReviewId]);

    // Collapsible section states
    const [risksOpen, setRisksOpen] = useState(true);
    const [previousFindingsOpen, setPreviousFindingsOpen] = useState(false);
    const [praisesOpen, setPraisesOpen] = useState(false);
    // Candidate findings: open by default. The Performance soft-enforcement
    // bullet block (Section R Phase B-6) directs the agent to keep
    // unverified-but-plausible concerns as candidates rather than dropping
    // them. That contract only delivers user value if the candidates are
    // visible without an extra click.
    const [candidateFindingsOpen, setCandidateFindingsOpen] = useState(true);

    // Expanded recommendations (for description expansion)
    const [expandedRecs, setExpandedRecs] = useState<Set<number>>(new Set());
    const [expandedPreviousRecs, setExpandedPreviousRecs] = useState<Set<string>>(new Set());
    const [expandedCandidateRecs, setExpandedCandidateRecs] = useState<Set<string>>(new Set());
    // Section R Phase B-6 candidate findings need a selectable state of
    // their own. RecommendationItem gates its action row (Addressed,
    // Dismiss, Ask Atlas, Copy) behind isSelected, so without a tracked
    // selection candidates can be read but not acted on — defeating the
    // verification workflow that justifies surfacing them. Tracked by
    // recommendation fingerprint (string), not the array index, because
    // candidate keys in the rendered list don't share storage with
    // recommendation indices and we want them independently selectable.
    const [selectedCandidateRecommendationKey, setSelectedCandidateRecommendationKey] = useState<string | null>(null);
    const [recommendationResolutions, setRecommendationResolutions] = useState<RecommendationResolutionMap>({});
    const [recommendationNotes, setRecommendationNotes] = useState<RecommendationNoteMap>({});
    const [includeResolvedInActions, setIncludeResolvedInActions] = useState<boolean>(
      readPersistedIncludeResolvedInActions,
    );

    useEffect(() => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(
          FINDINGS_INCLUDE_RESOLVED_STORAGE_KEY,
          includeResolvedInActions ? 'true' : 'false',
        );
      } catch {
        // Ignore persistence failures (private mode, quota exceeded).
      }
    }, [includeResolvedInActions]);
    const [selectedRecommendationIndex, setSelectedRecommendationIndex] = useState<number>(0);
    const panelRootRef = useRef<HTMLDivElement | null>(null);
    const onSelectFileFilterRef = useRef<typeof onSelectFileFilter>(onSelectFileFilter);
    const progressPercentRef = useRef(0);
    const progressWasActiveRef = useRef(false);
    const [isPanelHovered, setIsPanelHovered] = useState(false);

    // Verification state
    const [verifyConfig, setVerifyConfig] = useState<VerifyConfig | null>(null);
    const [verificationState, setVerificationState] = useState<ChangeSetVerification | null>(null);
    const [isRunningChecks, setIsRunningChecks] = useState(false);
    const [verifyError, setVerifyError] = useState<string | null>(null);
    const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

    // Ship-It action state
    const [activeAction, setActiveAction] = useState<'push' | 'deploy' | 'rollback' | 'comment' | 'approve' | 'request_changes' | 'delete' | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionSuccess, setActionSuccess] = useState<{ type: string; message: string } | null>(null);
    const [confirmingRollback, setConfirmingRollback] = useState(false);
    const [isPrCommentDialogOpen, setIsPrCommentDialogOpen] = useState(false);
    const [prCommentDialogAction, setPrCommentDialogAction] = useState<'comment' | 'request_changes'>('comment');
    const [prCommentDialogBody, setPrCommentDialogBody] = useState<string | null>(null);
    const [prCommentDialogItems, setPrCommentDialogItems] = useState<Array<{
      key: string;
      title: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      location: string | null;
      defaultSelected: boolean;
      kind: 'recommendation' | 'manual_line_comment';
      kindLabel?: string;
      manualLineComment?: ManualLineCommentDraft;
    }>>([]);
    const [selectedPrCommentKeys, setSelectedPrCommentKeys] = useState<Set<string>>(new Set());
    const [isFixDialogOpen, setIsFixDialogOpen] = useState(false);
    const [isReviewAgentOpen, setIsReviewAgentOpen] = useState(false);
    const [reviewAgentExtraAttachments, setReviewAgentExtraAttachments] = useState<ReviewAgentAttachment[]>([]);
    const [fixDialogItems, setFixDialogItems] = useState<Array<{
      key: string;
      title: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      location: string | null;
      defaultSelected: boolean;
    }>>([]);
    const [selectedFixKeys, setSelectedFixKeys] = useState<Set<string>>(new Set());
    const [isStartingFixRun, setIsStartingFixRun] = useState(false);
    const [activeFixRun, setActiveFixRun] = useState<ActiveFixRunState | null>(null);
    const activeFixRunRef = useRef<ActiveFixRunState | null>(null);
    const [recommendationFixStatuses, setRecommendationFixStatuses] = useState<RecommendationFixStatusMap>({});
    const [recentFixRuns, setRecentFixRuns] = useState<ReviewFixRunArtifact[]>([]);
    const [, setFixElapsedTick] = useState(0);
    const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => {
      activeFixRunRef.current = activeFixRun;
    }, [activeFixRun]);
    const updateRecommendationFixStatuses = useCallback((
      recommendationKeys: string[],
      status: ReviewFixRecommendationStatus,
    ) => {
      const normalizedKeys = recommendationKeys.filter(Boolean);
      if (normalizedKeys.length === 0) return;
      setRecommendationFixStatuses((prev) => {
        const next: RecommendationFixStatusMap = { ...prev };
        const updatedAt = new Date().toISOString();
        for (const recommendationKey of normalizedKeys) {
          next[recommendationKey] = {
            ...(next[recommendationKey] || {}),
            status,
            updatedAt,
          };
        }
        return next;
      });
    }, []);
    const recommendationOutcomeScope = useMemo(() => buildRecommendationOutcomeScope({
      changesetId,
      branchReviewId,
      workspaceReviewId,
      prReviewId,
    }), [changesetId, branchReviewId, workspaceReviewId, prReviewId]);
    const reviewAgentScope = useMemo<ReviewAgentScope | null>(() => {
      if (!recommendationOutcomeScope) return null;
      return {
        projectId,
        reviewType: recommendationOutcomeScope.reviewType as ReviewAgentScope['reviewType'],
        reviewId: recommendationOutcomeScope.reviewId,
      };
    }, [projectId, recommendationOutcomeScope]);
    const [reviewAgentDraftRequest, setReviewAgentDraftRequest] = useState<{ id: string; text: string } | null>(null);
    const openReviewAgent = useCallback((extraAttachments: ReviewAgentAttachment[] = [], options: ReviewAgentOpenOptions = {}) => {
      if (onOpenReviewAgent) {
        onOpenReviewAgent(extraAttachments, options);
        return;
      }
      setReviewAgentExtraAttachments(extraAttachments);
      setReviewAgentDraftRequest(options.prompt ? { id: `${Date.now()}-${options.prompt}`, text: options.prompt } : null);
      setIsReviewAgentOpen(true);
    }, [onOpenReviewAgent]);

    // ── Data loading ──────────────────────────────────────────────────

    const refreshData = useCallback(async () => {
      try {
        if (prReviewId) {
          const [response, publicationResponse] = await Promise.all([
            prReviewApi.get(projectId, prReviewId),
            prReviewApi.getPublications(projectId, prReviewId),
          ]);
          const nextPrReview = response.prReview as any;
          const nextHeadSha = resolveCurrentPrHeadSha(nextPrReview);
          setBranchReview(nextPrReview);
          setPrBodyText(nextPrReview?.body || null);
          setPrPublicationState(publicationResponse.publication);
          setPrReviewSubmission((prev) => retainSubmissionForHead(nextHeadSha, prev));
        } else if (workspaceReviewId) {
          const response = await workspaceReviewApi.get(projectId, workspaceReviewId);
          setBranchReview(response.workspaceReview as any);
        } else if (branchReviewId) {
          const response = await branchReviewApi.get(projectId, branchReviewId, { forceRefresh: true });
          setBranchReview(response.branchReview);
        } else if (changesetId) {
          const response = await changesetApi.get(projectId, changesetId);
          setChangeset(response.changeset);
          if (response.changeset.verification) {
            setVerificationState(response.changeset.verification);
          }
        }
      } catch (error) {
        console.error('Failed to refresh data:', error);
      }
    }, [projectId, changesetId, branchReviewId, workspaceReviewId, prReviewId, resolveCurrentPrHeadSha, retainSubmissionForHead]);

    const loadData = useCallback(async () => {
      setIsLoading(true);
      setLoadError(null);
      setReviewError(null);
      setActionError(null);
      setActionSuccess(null);
      setCsPollingTimedOut(false);
      setConfirmingRollback(false);
      setExpandedRecs(new Set());
      setExpandedLogs(new Set());
      setReviewDetailsOpen(false);
      setChangeset(null);
      setBranchReview(null);
      setPrPublicationState(null);
      setPrReviewSubmission(null);
      setPrConversations(null);
      setPrConversationsError(null);
      setActiveFixRun(null);
      setRecommendationFixStatuses({});
      setRecentFixRuns([]);
      try {
        if (prReviewId) {
          const [response, publicationResponse] = await Promise.all([
            prReviewApi.get(projectId, prReviewId),
            prReviewApi.getPublications(projectId, prReviewId),
          ]);
          const nextPrReview = response.prReview as any;
          setBranchReview(nextPrReview);
          setPrBodyText(nextPrReview?.body || null);
          setPrPublicationState(publicationResponse.publication);
          setPrReviewSubmission(null);
        } else if (workspaceReviewId) {
          const response = await workspaceReviewApi.get(projectId, workspaceReviewId);
          setBranchReview(response.workspaceReview as any);
        } else if (branchReviewId) {
          const response = await branchReviewApi.get(projectId, branchReviewId, { forceRefresh: true });
          setBranchReview(response.branchReview);
        } else if (changesetId) {
          const [csResponse, configResponse] = await Promise.allSettled([
            changesetApi.get(projectId, changesetId),
            changesetApi.getVerifyConfig(projectId),
          ]);
          if (csResponse.status === 'fulfilled') {
            setChangeset(csResponse.value.changeset);
            if (csResponse.value.changeset.verification) {
              setVerificationState(csResponse.value.changeset.verification);
            } else {
              setVerificationState(null);
            }
          } else {
            setLoadError('Failed to load review data');
          }
          if (configResponse.status === 'fulfilled') {
            setVerifyConfig(configResponse.value);
          }
        }
      } catch (error) {
        console.error('Failed to load data:', error);
        setLoadError('Failed to load review data');
      } finally {
        setIsLoading(false);
      }
    }, [projectId, changesetId, branchReviewId, workspaceReviewId, prReviewId, resolveCurrentPrHeadSha, retainSubmissionForHead]);

    useEffect(() => {
      loadData();
    }, [loadData]);

    const publishPrConversations = useCallback((conversations: GitHubPrConversations | null) => {
      setPrConversations(conversations);
      window.dispatchEvent(new CustomEvent<PrReviewConversationsUpdatedDetail>(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, {
        detail: { projectId, prReviewId: prReviewId || '', conversations },
      }));
    }, [projectId, prReviewId]);

    const loadPrConversations = useCallback(async (options?: { sync?: boolean }) => {
      if (!prReviewId) {
        publishPrConversations(null);
        setPrConversationsError(null);
        setIsPrConversationsLoading(false);
        setIsPrConversationsSyncing(false);
        return;
      }
      const shouldSync = options?.sync === true;
      if (shouldSync) {
        setIsPrConversationsSyncing(true);
      } else {
        setIsPrConversationsLoading(true);
      }
      setPrConversationsError(null);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const response = shouldSync
              ? await prReviewApi.syncConversations(projectId, prReviewId)
              : await prReviewApi.getConversations(projectId, prReviewId);
            setPrConversationsError(null);
            publishPrConversations(response.conversations);
            if (!shouldSync && shouldAutoSyncGitHubConversations(response.conversations)) {
              void loadPrConversations({ sync: true });
            }
            return;
          } catch (error) {
            if (attempt === 0 && isRetryableGitHubConversationLoadError(error)) {
              setPrConversationsError(describeGitHubConversationRetry(error));
              await new Promise((resolve) => window.setTimeout(resolve, GITHUB_CONVERSATION_RETRY_DELAY_MS));
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        setPrConversationsError(describeGitHubConversationLoadError(error));
      } finally {
        if (shouldSync) {
          setIsPrConversationsSyncing(false);
        } else {
          setIsPrConversationsLoading(false);
        }
      }
    }, [projectId, prReviewId, publishPrConversations]);

    useEffect(() => {
      if (!prReviewId) return undefined;
      const handleConversationsUpdated = (event: Event) => {
        const detail = (event as CustomEvent<PrReviewConversationsUpdatedDetail>).detail;
        if (!detail || detail.projectId !== projectId || detail.prReviewId !== prReviewId) return;
        setPrConversations(detail.conversations || null);
      };
      window.addEventListener(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, handleConversationsUpdated as EventListener);
      return () => {
        window.removeEventListener(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, handleConversationsUpdated as EventListener);
      };
    }, [projectId, prReviewId]);

    useEffect(() => {
      if (!prReviewId) {
        setPrConversations(null);
        return;
      }
      void loadPrConversations();
    }, [prReviewId, loadPrConversations]);

    const refreshFixRunArtifacts = useCallback(async () => {
      if (!projectId || !recommendationOutcomeScope) {
        setActiveFixRun(null);
        setIsStartingFixRun(false);
        setRecommendationFixStatuses({});
        setRecentFixRuns([]);
        return;
      }

      const [latestResult, listResult] = await Promise.allSettled([
        reviewApi.getLatestFixRun(projectId, recommendationOutcomeScope),
        reviewApi.listFixRuns(projectId, recommendationOutcomeScope, { limit: 10 }),
      ]);

      if (listResult.status === 'fulfilled') {
        const persistedRuns = listResult.value.runs || [];
        setRecentFixRuns(persistedRuns);
        setRecommendationFixStatuses(buildRecommendationFixStatusesFromRuns(persistedRuns));
      } else {
        console.error('Failed to load review fix run history:', listResult.reason);
        setRecentFixRuns([]);
      }

      if (latestResult.status !== 'fulfilled') {
        console.error('Failed to load latest review fix run:', latestResult.reason);
        setActiveFixRun(null);
        setIsStartingFixRun(false);
        return;
      }

      const latestRun = latestResult.value.run;
      if (!latestRun) {
        setActiveFixRun(null);
        setIsStartingFixRun(false);
        if (listResult.status !== 'fulfilled') {
          setRecommendationFixStatuses({});
        }
        return;
      }

      if (listResult.status !== 'fulfilled') {
        setRecommendationFixStatuses(buildRecommendationFixStatusesFromRun(latestRun));
      }

      if (latestRun.status === 'running') {
        setActiveFixRun({
          runId: latestRun.id,
          isRunning: true,
          startedAt: latestRun.startedAt,
          selectedKeys: latestRun.selectedRecommendationKeys || [],
          statusLabel: buildPersistedFixRunStatusLabel(latestRun),
          activityLabel: 'Atlas is resuming the active fix run…',
          error: latestRun.error || null,
          buildSummary: latestRun.buildSummary || null,
        });
      } else {
        // Keep persisted run artifacts available for compact history and
        // per-finding hints, but do not reopen the live fix banner after reload.
        setActiveFixRun(null);
        setIsStartingFixRun(false);
      }
    }, [projectId, recommendationOutcomeScope?.reviewType, recommendationOutcomeScope?.reviewId]);

    useEffect(() => {
      setActiveFixRun(null);
      setIsStartingFixRun(false);
    }, [recommendationOutcomeScope?.reviewType, recommendationOutcomeScope?.reviewId]);

    useEffect(() => {
      void refreshFixRunArtifacts();
    }, [refreshFixRunArtifacts, refreshToken]);

    useEffect(() => {
      if (!activeFixRun?.isRunning) return undefined;

      const refreshIfVisible = () => {
        if (typeof document !== 'undefined' && document.hidden) return;
        void refreshFixRunArtifacts();
      };

      const intervalId = window.setInterval(refreshIfVisible, 10000);
      window.addEventListener('focus', refreshIfVisible);
      document.addEventListener('visibilitychange', refreshIfVisible);

      return () => {
        window.clearInterval(intervalId);
        window.removeEventListener('focus', refreshIfVisible);
        document.removeEventListener('visibilitychange', refreshIfVisible);
      };
    }, [activeFixRun?.isRunning, refreshFixRunArtifacts]);

    useEffect(() => {
      if ((!branchReviewId && !workspaceReviewId && !prReviewId) || refreshToken <= 0) return;
      let cancelled = false;
      (async () => {
        try {
          if (prReviewId) {
            const [response, publicationResponse] = await Promise.all([
              prReviewApi.get(projectId, prReviewId),
              prReviewApi.getPublications(projectId, prReviewId),
            ]);
            if (!cancelled) {
              const nextPrReview = response.prReview as any;
              setBranchReview(nextPrReview);
              setPrBodyText(nextPrReview?.body || null);
              setPrPublicationState(publicationResponse.publication);
              setPrReviewSubmission(null);
            }
          } else if (workspaceReviewId) {
            const response = await workspaceReviewApi.get(projectId, workspaceReviewId);
            if (!cancelled) {
              setBranchReview(response.workspaceReview as any);
            }
          } else if (branchReviewId) {
            const response = await branchReviewApi.get(projectId, branchReviewId, { forceRefresh: true });
            if (!cancelled) {
              setBranchReview(response.branchReview);
            }
          }
        } catch {
          // Keep existing UI state; user can retry from review controls.
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [projectId, branchReviewId, workspaceReviewId, prReviewId, refreshToken, resolveCurrentPrHeadSha, retainSubmissionForHead]);

    useEffect(() => {
      let cancelled = false;

      const loadGitHubCompareUrl = async () => {
        if (!isBrMode || !branchReview) {
          setGithubCompareUrl(null);
          return;
        }

        if (isPrMode) {
          const url = typeof (branchReview as any).htmlUrl === 'string'
            ? (branchReview as any).htmlUrl.trim()
            : '';
          setGithubCompareUrl(url || null);
          return;
        }

        if (!branchReview.baseBranch || !branchReview.branchName) {
          setGithubCompareUrl(null);
          return;
        }

        try {
          const gitStatus = await changesetApi.getGitStatus(projectId);
          if (cancelled) return;

          if (!gitStatus?.isGitRepo || !gitStatus?.isGitHub || !gitStatus.owner || !gitStatus.repo) {
            setGithubCompareUrl(null);
            return;
          }

          const url = buildGitHubCompareUrl(
            gitStatus.owner,
            gitStatus.repo,
            branchReview.baseBranch,
            branchReview.branchName
          );
          setGithubCompareUrl(url || null);
        } catch {
          if (!cancelled) setGithubCompareUrl(null);
        }
      };

      void loadGitHubCompareUrl();

      return () => {
        cancelled = true;
      };
    }, [isBrMode, isPrMode, projectId, branchReview]);

    // Clean up success timer
    useEffect(() => {
      return () => {
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
      };
    }, []);

    // Load persisted BR scope filters
    useEffect(() => {
      if (!scopeStorageKey) {
        setScopeIncludeText('');
        setScopeExcludeText('');
        setScopeApplyGlobalIgnorePatterns(true);
        return;
      }

      let include = '';
      let exclude = '';
      let applyGlobalIgnorePatterns = true;
      try {
        const raw = localStorage.getItem(scopeStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          include = typeof parsed.include === 'string' ? parsed.include : '';
          exclude = typeof parsed.exclude === 'string' ? parsed.exclude : '';
          if (typeof parsed.applyGlobalIgnorePatterns === 'boolean') {
            applyGlobalIgnorePatterns = parsed.applyGlobalIgnorePatterns;
          }
        }
      } catch {
        // Ignore malformed local storage entries
      }
      setScopeIncludeText(include);
      setScopeExcludeText(exclude);
      setScopeApplyGlobalIgnorePatterns(applyGlobalIgnorePatterns);
    }, [scopeStorageKey]);

    useEffect(() => {
      setQueueProgressFallback(null);
    }, [branchReviewId, workspaceReviewId, prReviewId]);

    // Clear stale queue fallback when primary progress is cleared (parent says done)
    useEffect(() => {
      if (isBrMode && !branchReviewProgress && queueProgressFallback) {
        setQueueProgressFallback(null);
      }
    }, [isBrMode, branchReviewProgress, queueProgressFallback]);

    useEffect(() => {
      if (!isBrMode) {
        setGlobalIgnorePatternCount(0);
        return;
      }
      let cancelled = false;
      (async () => {
        try {
          const setting = await settingsApi.get('review_ignore_patterns');
          if (cancelled) return;
          const patterns = setting.exists ? parseStoredPatternSetting(setting.value) : [];
          setGlobalIgnorePatternCount(patterns.length);
        } catch {
          if (!cancelled) setGlobalIgnorePatternCount(0);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [isBrMode]);

    // Clear stale local error messaging once a new review run starts.
    useEffect(() => {
      if (!isBrMode) return;
      const phase = String(effectiveBranchReviewProgress?.phase || '').toLowerCase();
      const lifecycleStatus = normalizeLifecycleStatusValue(
        branchReview?.reviewLifecycle?.status
          || branchReview?.reviewLifecycle?.sourceStatus
          || branchReview?.reviewStatus
          || 'none',
        'completed'
      );
      const hasActiveRun = isActiveLifecycleStatus(lifecycleStatus)
        || branchReview?.reviewLifecycle?.isActive === true
        || isActiveReviewProgressPhase(phase);
      if (!hasActiveRun) return;
      setReviewError((prev) => (prev ? null : prev));
    }, [
      isBrMode,
      branchReview?.reviewStatus,
      branchReview?.reviewLifecycle?.status,
      branchReview?.reviewLifecycle?.sourceStatus,
      branchReview?.reviewLifecycle?.isActive,
      effectiveBranchReviewProgress?.phase,
    ]);

    // Verify that queued/reviewing BR/PR state is backed by an active queue entry.
    // This catches stale states after backend/app restart where in-memory queue is lost.
    useEffect(() => {
      const reviewId = branchReviewId || workspaceReviewId || prReviewId;
      if (!isBrMode || !reviewId || !branchReview) {
        setQueueHasActiveBranchReview(null);
        setQueueStatusCheckedAt(0);
        setQueueProgressFallback(null);
        return;
      }

      const lifecycleStatus = normalizeLifecycleStatusValue(
        branchReview.reviewLifecycle?.status
          || branchReview.reviewLifecycle?.sourceStatus
          || branchReview.reviewStatus
          || 'none',
        'completed'
      );
      if (!isActiveLifecycleStatus(lifecycleStatus) && branchReview.reviewLifecycle?.isActive !== true) {
        setQueueHasActiveBranchReview(null);
        setQueueStatusCheckedAt(0);
        setQueueProgressFallback(null);
        return;
      }

      let cancelled = false;
      const checkQueue = async () => {
        try {
          const result = await reviewApi.getQueue();
          if (cancelled) return;
          const queue = result.queue || [];
          const isActiveQueueEntry = (entry: typeof queue[number]): boolean => {
            const lifecycleActive = entry.lifecycle?.isActive === true;
            const queueStatus = normalizeLifecycleStatusValue(
              entry.lifecycle?.status || entry.status,
              'queued'
            );
            return lifecycleActive || isActiveLifecycleStatus(queueStatus);
          };
          const matchesReview = (entry: typeof queue[number]): boolean => {
            if (prReviewId) {
              return (entry as any).type === 'pr_review' && (entry as any).prReviewId === prReviewId;
            }
            if (workspaceReviewId) {
              return (entry as any).type === 'workspace_review' && (entry as any).workspaceReviewId === workspaceReviewId;
            }
            const isBranchEntry = entry.type === 'branch_review' || (!!entry.branchReviewId && !entry.changesetId);
            return isBranchEntry && entry.branchReviewId === branchReviewId;
          };
          const hasActiveEntry = queue.some((entry) => matchesReview(entry) && isActiveQueueEntry(entry));
          const activeEntry = queue.find((entry) => matchesReview(entry) && isActiveQueueEntry(entry));
          setQueueHasActiveBranchReview(hasActiveEntry);
          if (activeEntry?.progress) {
            setQueueProgressFallback({
              phase: activeEntry.progress.phase || activeEntry.lifecycle?.phase || activeEntry.status || 'reviewing',
              currentChunk: Number(activeEntry.progress.currentChunk || 0),
              totalChunks: Number(activeEntry.progress.totalChunks || 0),
              filesCompleted: Number(activeEntry.progress.filesCompleted || 0),
              totalFiles: Number(activeEntry.progress.totalFiles || 0),
              activeChunkFiles: Number(activeEntry.progress.activeChunkFiles || 0),
              elapsedSeconds: Number(activeEntry.progress.elapsedSeconds || 0),
              splitDepth: Number(activeEntry.progress.splitDepth || 0),
              splitParts: Number(activeEntry.progress.splitParts || 0),
              reviewModel: typeof activeEntry.progress.reviewModel === 'string'
                ? activeEntry.progress.reviewModel
                : null,
              reviewModelStrategy: typeof activeEntry.progress.reviewModelStrategy === 'string'
                ? activeEntry.progress.reviewModelStrategy
                : null,
              reviewModelEffectiveStrategy: typeof activeEntry.progress.reviewModelEffectiveStrategy === 'string'
                ? activeEntry.progress.reviewModelEffectiveStrategy
                : null,
              diffScopeMode: activeEntry.progress.diffScopeMode === 'delta'
                ? 'delta'
                : activeEntry.progress.diffScopeMode === 'full'
                  ? 'full'
                  : null,
              diffScopeCommitCount: Number(activeEntry.progress.diffScopeCommitCount || 0),
              diffBaseSha: typeof activeEntry.progress.diffBaseSha === 'string'
                ? activeEntry.progress.diffBaseSha
                : null,
              diffHeadSha: typeof activeEntry.progress.diffHeadSha === 'string'
                ? activeEntry.progress.diffHeadSha
                : null,
            });
          } else if (hasActiveEntry) {
            const activeStatus = normalizeLifecycleStatusValue(
              activeEntry?.lifecycle?.status || activeEntry?.status,
              lifecycleStatus
            );
            setQueueProgressFallback({
              phase: activeStatus === 'queued'
                ? 'queued'
                : activeStatus === 'retrying'
                  ? 'provider_retry'
                  : 'reviewing',
              currentChunk: 0,
              totalChunks: 0,
              filesCompleted: 0,
              totalFiles: 0,
              diffScopeMode: null,
              diffScopeCommitCount: 0,
              diffBaseSha: null,
              diffHeadSha: null,
            });
          } else {
            setQueueProgressFallback(null);
          }
          setQueueStatusCheckedAt(Date.now());

          // If queue is no longer tracking this review, force-sync from backend.
          // This avoids false "stale worker" UI when socket lifecycle events are missed.
          if (!hasActiveEntry && isActiveLifecycleStatus(lifecycleStatus)) {
            try {
              if (prReviewId) {
                const latest = await prReviewApi.get(projectId, prReviewId);
                if (!cancelled && latest?.prReview) {
                  setBranchReview(latest.prReview as any);
                  setPrBodyText((latest.prReview as any)?.body || null);
                }
              } else if (workspaceReviewId) {
                const latest = await workspaceReviewApi.get(projectId, workspaceReviewId);
                if (!cancelled && latest?.workspaceReview) {
                  setBranchReview(latest.workspaceReview as any);
                }
              } else if (branchReviewId) {
                const latest = await branchReviewApi.get(projectId, branchReviewId, { forceRefresh: true });
                if (!cancelled && latest?.branchReview) {
                  setBranchReview(latest.branchReview);
                }
              }
            } catch {
              // Keep existing optimistic state; stale detection still acts as fallback.
            }
          }
        } catch {
          if (!cancelled) {
            setQueueHasActiveBranchReview(null);
            setQueueStatusCheckedAt(Date.now());
            setQueueProgressFallback(null);
          }
        }
      };

      checkQueue();
      const intervalId = window.setInterval(checkQueue, 10000);
      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
      };
    }, [
      isBrMode,
      branchReviewId,
      workspaceReviewId,
      prReviewId,
      branchReview?.id,
      branchReview?.reviewStatus,
      branchReview?.reviewLifecycle?.status,
      branchReview?.reviewLifecycle?.sourceStatus,
      branchReview?.reviewLifecycle?.isActive,
    ]);

    // Poll CS status while lifecycle remains active so queued/running/retrying reviews resolve without manual refresh.
    useEffect(() => {
      if (isBrMode || !changesetId || !changeset) return;
      const lifecycleStatus = normalizeLifecycleStatusValue(
        (changeset as any)?.reviewLifecycle?.status
          || (changeset as any)?.reviewLifecycle?.sourceStatus
          || changeset.reviewStatus
          || 'none',
        'completed'
      );
      if (!isActiveLifecycleStatus(lifecycleStatus) && (changeset as any)?.reviewLifecycle?.isActive !== true) {
        setCsPollingTimedOut(false);
        return;
      }

      let cancelled = false;
      const pollStartedAt = Date.now();
      let intervalId: number | null = null;
      const poll = async () => {
        if (cancelled) return;
        if ((Date.now() - pollStartedAt) > MAX_REVIEW_POLL_MS) {
          setCsPollingTimedOut(true);
          cancelled = true;
          if (intervalId != null) {
            window.clearInterval(intervalId);
            intervalId = null;
          }
          return;
        }
        await refreshData();
      };

      void poll();
      intervalId = window.setInterval(() => {
        void poll();
      }, 5000);

      return () => {
        cancelled = true;
        if (intervalId != null) {
          window.clearInterval(intervalId);
        }
      };
    }, [
      isBrMode,
      changesetId,
      changeset?.id,
      changeset?.reviewStatus,
      (changeset as any)?.reviewLifecycle?.status,
      (changeset as any)?.reviewLifecycle?.sourceStatus,
      (changeset as any)?.reviewLifecycle?.isActive,
      refreshData,
    ]);

    // Persist BR scope filters
    useEffect(() => {
      if (!scopeStorageKey) return;
      try {
        localStorage.setItem(scopeStorageKey, JSON.stringify({
          include: scopeIncludeText,
          exclude: scopeExcludeText,
          applyGlobalIgnorePatterns: scopeApplyGlobalIgnorePatterns,
        }));
      } catch {
        // Ignore local storage write failures
      }
    }, [scopeStorageKey, scopeIncludeText, scopeExcludeText, scopeApplyGlobalIgnorePatterns]);

    // ── Review actions ────────────────────────────────────────────────

    const handleReviewNow = useCallback(async (
      force = false,
      options?: {
        skipAlreadyReviewedPrompt?: boolean;
        forceFullPopup?: boolean;
        partial?: boolean;
      },
    ): Promise<boolean> => {
      if (interactionLockReason) {
        setActionError(interactionLockReason);
        return false;
      }
      try {
        const skipAlreadyReviewedPrompt = options?.skipAlreadyReviewedPrompt === true;
        const forceFullPopup = options?.forceFullPopup === true;
        const explicitPartial = options?.partial === true;
        let queuedBranchOrPrReview = false;
        if (prReviewId) {
          let reviewMode: 'auto' | 'full' | undefined;
          let forceFullScope = false;
          let refreshed = null as Awaited<ReturnType<typeof prReviewApi.refresh>> | null;
          if (!force && !skipAlreadyReviewedPrompt) {
            const fresh = await prReviewApi.refresh(projectId, prReviewId);
            refreshed = fresh;
            setBranchReview(prev => prev ? {
              ...prev,
              ...fresh.prReview,
            } : fresh.prReview as any);
            const refreshedPrReview = fresh.prReview;
            const refreshedCurrentHeadSha = normalizeHeadSha(refreshedPrReview?.headSha || null);
            const refreshedReviewedHeadSha = normalizeHeadSha(refreshedPrReview?.reviewHeadSha || null);
            const refreshedCoversCurrentHead = (
              isCompletedReviewStatusValue(refreshedPrReview?.reviewStatus)
              && Boolean(
                refreshedCurrentHeadSha
                && refreshedReviewedHeadSha
                && refreshedCurrentHeadSha === refreshedReviewedHeadSha
              )
            );
            if (refreshedCoversCurrentHead || forceFullPopup) {
              const confirmed = await popup.confirm({
                title: refreshedCoversCurrentHead ? 'Pull request already reviewed' : 'Run full PR review?',
                message: refreshedCoversCurrentHead
                  ? 'This pull request is already reviewed through the latest commit. Re-review the full PR again? Atlas will run a fresh full-PR review on the current diff.'
                  : 'Atlas will run a fresh full-PR review on the current diff. This re-examines every changed file instead of the incremental delta.',
                confirmLabel: refreshedCoversCurrentHead ? 'Re-review full PR' : 'Run full review',
                cancelLabel: 'Cancel',
              });
              if (!confirmed) return false;
              reviewMode = 'auto';
              forceFullScope = true;
            }
          }

          setIsReviewing(true);
          setReviewError(null);
          if (!refreshed) {
            refreshed = await prReviewApi.refresh(projectId, prReviewId);
          }
          const refreshedPrReview = refreshed.prReview;
          setBranchReview(prev => prev ? {
            ...prev,
            ...refreshedPrReview,
          } : refreshedPrReview as any);
          await prReviewApi.queueReview(projectId, prReviewId, {
            ...(reviewMode ? { reviewMode } : {}),
            ...(forceFullScope ? { forceFullScope: true } : {}),
            policySource: 'working_tree',
          });
          const nowIso = new Date().toISOString();
          setBranchReview(prev => prev ? {
            ...prev,
            reviewStatus: 'queued',
            reviewError: null,
            reviewLifecycle: buildOptimisticQueuedLifecycle(nowIso, (prev as any).reviewedAt || null),
            updatedAt: nowIso,
          } : prev);
          queuedBranchOrPrReview = true;
        } else if (workspaceReviewId) {
          let reviewMode: 'auto' | 'full' | undefined;

          if (!force && !skipAlreadyReviewedPrompt && (branchReviewCoversCurrentHead || forceFullPopup)) {
            const confirmed = await popup.confirm({
              title: branchReviewCoversCurrentHead ? 'Workspace review already current' : 'Run full workspace review?',
              message: branchReviewCoversCurrentHead
                ? 'This workspace snapshot is already reviewed through the latest head. Re-run a fresh workspace review anyway?'
                : 'Atlas will run a fresh full workspace review on the current snapshot.',
              confirmLabel: branchReviewCoversCurrentHead ? 'Re-run workspace review' : 'Run full review',
              cancelLabel: 'Cancel',
            });
            if (!confirmed) return false;
            reviewMode = 'full';
          }

          setIsReviewing(true);
          setReviewError(null);
          await workspaceReviewApi.queueReview(projectId, workspaceReviewId, {
            ...(reviewMode ? { reviewMode } : {}),
            policySource: 'working_tree' as const,
          });
          const nowIso = new Date().toISOString();
          setQueueHasActiveBranchReview(true);
          setQueueStatusCheckedAt(Date.now());
          setBranchReview(prev => prev ? {
            ...prev,
            reviewStatus: 'queued',
            reviewError: null,
            reviewLifecycle: buildOptimisticQueuedLifecycle(
              nowIso,
              prev.reviewLifecycle?.reviewedAt || prev.reviewedAt || null
            ),
            updatedAt: nowIso,
          } : prev);
          queuedBranchOrPrReview = true;
        } else if (branchReviewId) {
          let refreshedBranchReview = branchReview;
          if (!force && !skipAlreadyReviewedPrompt && !forceFullPopup) {
            try {
              const fresh = await branchReviewApi.refresh(projectId, branchReviewId);
              refreshedBranchReview = fresh.branchReview as any;
              setBranchReview(prev => prev ? {
                ...prev,
                ...fresh.branchReview,
              } : fresh.branchReview as any);
            } catch {
              // Best-effort freshness check; fall back to the current snapshot.
            }
          }
          const refreshedBranchReviewCoversCurrentHead = (() => {
            if (!refreshedBranchReview || refreshedBranchReview.reviewStatus !== 'reviewed') return false;
            const currentHeadSha = normalizeHeadSha(refreshedBranchReview.headSha || null);
            const reviewedHeadSha = normalizeHeadSha(refreshedBranchReview.reviewHeadSha || null);
            return Boolean(currentHeadSha && reviewedHeadSha && currentHeadSha === reviewedHeadSha);
          })();
          const scopePayload: BranchReviewScope | undefined = (() => {
            const includePatterns = parseScopePatterns(scopeIncludeText);
            const excludePatterns = parseScopePatterns(scopeExcludeText);
            if (includePatterns.length === 0 && excludePatterns.length === 0 && scopeApplyGlobalIgnorePatterns) {
              return undefined;
            }
            return { includePatterns, excludePatterns, applyGlobalIgnorePatterns: scopeApplyGlobalIgnorePatterns };
          })();
          const hasExplicitScope = Boolean(scopePayload);
          let reviewMode: 'auto' | 'full' | undefined;
          let usePartial = explicitPartial;

          // Pre-flight large-diff popup: when not forced, not pinned to full,
          // and not already explicitly partial, ask the user whether to run
          // a partial (top-N highest-risk) review or commit to a full one.
          const branchFileCount = Number(refreshedBranchReview?.fileCount) || 0;
          const shouldOfferPartial = (
            !force
            && !skipAlreadyReviewedPrompt
            && !forceFullPopup
            && !explicitPartial
            && !hasExplicitScope
            && !refreshedBranchReviewCoversCurrentHead
            && branchFileCount >= LARGE_DIFF_PARTIAL_POPUP_THRESHOLD
          );
          if (shouldOfferPartial) {
            const choice = await askPartialOrFull(popup, branchFileCount);
            if (choice === null) {
              // User dismissed — abort entirely.
              return false;
            }
            usePartial = choice === 'partial';
          }

          if (!force && !skipAlreadyReviewedPrompt && !hasExplicitScope && (refreshedBranchReviewCoversCurrentHead || forceFullPopup)) {
            const confirmed = await popup.confirm({
              title: refreshedBranchReviewCoversCurrentHead ? 'Branch already reviewed' : 'Run full branch review?',
              message: refreshedBranchReviewCoversCurrentHead
                ? 'This branch is already reviewed through the latest commit. Re-review the full branch again? Atlas will keep the current review visible while the fresh full-branch review runs.'
                : 'Atlas will keep the current review visible while it runs a fresh full-branch review against the base branch.',
              confirmLabel: refreshedBranchReviewCoversCurrentHead ? 'Re-review full branch' : 'Run full review',
              cancelLabel: 'Cancel',
            });
            if (!confirmed) return false;
            reviewMode = 'full';
          }

          setIsReviewing(true);
          setReviewError(null);
          // Queue BR review instead of blocking on a long synchronous request.
          await branchReviewApi.queueReview(projectId, branchReviewId, {
            ...(scopePayload || {}),
            ...(reviewMode ? { reviewMode } : {}),
            ...(usePartial ? { partial: true } : {}),
            policySource: 'working_tree' as const,
          });
          const nowIso = new Date().toISOString();
          // Optimistically clear stale-state detection until queue poll confirms state.
          setQueueHasActiveBranchReview(true);
          setQueueStatusCheckedAt(Date.now());
          setBranchReview(prev => prev ? {
            ...prev,
            reviewStatus: 'queued',
            reviewError: null,
            reviewLifecycle: buildOptimisticQueuedLifecycle(
              nowIso,
              prev.reviewLifecycle?.reviewedAt || prev.reviewedAt || null
            ),
            updatedAt: nowIso,
          } : prev);
          queuedBranchOrPrReview = true;
        } else if (changesetId) {
          setIsReviewing(true);
          setReviewError(null);
          // Queue CS review to avoid long-running synchronous HTTP timeouts.
          await reviewApi.enqueue(projectId, changesetId, force);
          const nowIso = new Date().toISOString();
          setChangeset(prev => prev ? {
            ...prev,
            reviewStatus: 'queued',
            reviewError: null,
            reviewLifecycle: buildOptimisticQueuedLifecycle(nowIso, prev.reviewLifecycle?.reviewedAt || prev.reviewedAt || null),
          } : prev);
        }

        if (!queuedBranchOrPrReview) {
          await refreshData();
        }
        return true;
      } catch (error: any) {
        const msg = error?.response?.data?.error || error?.message || 'Review failed';
        setReviewError(msg);
        return false;
      } finally {
        setIsReviewing(false);
      }
    }, [
      projectId,
      changesetId,
      branchReviewId,
      workspaceReviewId,
      prReviewId,
      interactionLockReason,
      refreshData,
      scopeIncludeText,
      scopeExcludeText,
      scopeApplyGlobalIgnorePatterns,
      branchReviewCoversCurrentHead,
      prReviewCoversCurrentHead,
      branchReview?.fileCount,
      popup,
    ]);

    const handleStopReview = useCallback(async () => {
      try {
        if (isPrMode && prReviewId) {
          await prReviewApi.stopReview(projectId, prReviewId);
          setBranchReview(prev => prev ? {
            ...prev,
            reviewStatus: 'none' as const,
            reviewError: null,
          } : prev);
        } else if (workspaceReviewId) {
          await workspaceReviewApi.stopReview(projectId, workspaceReviewId);
          setBranchReview(prev => prev ? {
            ...prev,
            reviewStatus: 'none' as const,
            reviewError: null,
          } : prev);
          setQueueHasActiveBranchReview(false);
        } else if (isBrMode && branchReviewId) {
          await branchReviewApi.stopReview(projectId, branchReviewId);
          setBranchReview(prev => prev ? {
            ...prev,
            reviewStatus: 'none' as const,
            reviewError: null,
          } : prev);
          setQueueHasActiveBranchReview(false);
        } else if (changesetId) {
          await reviewApi.cancelQueue(projectId, changesetId);
          setChangeset(prev => prev ? {
            ...prev,
            reviewStatus: 'none' as const,
            reviewError: null,
          } : prev);
        }
        await refreshData();
      } catch (err) {
        console.error('Failed to stop review:', err);
      }
    }, [isBrMode, isPrMode, branchReviewId, workspaceReviewId, prReviewId, changesetId, projectId, refreshData]);

    const handleDeleteBranchReview = useCallback(async () => {
      if (!isBrMode || !branchReviewId || activeAction) return;

      const confirmed = await popup.confirm({
        title: 'Clear AI review?',
        message: 'This clears the current AI review result while keeping the branch details and file tree intact. You can run the review again afterward.',
        confirmLabel: 'Clear review',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      setActiveAction('delete');
      setActionError(null);
      setActionSuccess(null);
      try {
        const response = await branchReviewApi.delete(projectId, branchReviewId);
        if (response.branchReview) {
          setBranchReview(response.branchReview);
        }
        setExpandedRecs(new Set());
        setSelectedRecommendationIndex(0);
        setRecommendationResolutions({});
        setActionSuccess({ type: 'delete', message: 'AI review cleared' });
        onBranchReviewDeleted?.(branchReviewId);
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to delete branch review';
        setActionError(message);
      } finally {
        setActiveAction(null);
      }
    }, [isBrMode, branchReviewId, activeAction, popup, projectId, onBranchReviewDeleted]);

    const handleDeletePrReview = useCallback(async () => {
      if (!isPrMode || !prReviewId || activeAction) return;

      const confirmed = await popup.confirm({
        title: 'Clear AI review?',
        message: 'This clears the current AI review result while keeping the pull request details and file tree intact. You can run the review again afterward.',
        confirmLabel: 'Clear review',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      setActiveAction('delete');
      setActionError(null);
      setActionSuccess(null);
      try {
        const response = await prReviewApi.delete(projectId, prReviewId);
        if (response.prReview) {
          setBranchReview(response.prReview as any);
          setPrBodyText(response.prReview.body || null);
        }
        setExpandedRecs(new Set());
        setSelectedRecommendationIndex(0);
        setRecommendationResolutions({});
        setActionSuccess({ type: 'delete', message: 'AI review cleared' });
        try {
          await refreshData();
        } catch (refreshError) {
          console.warn('Failed to refresh PR review after delete', refreshError);
        }
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to delete PR review';
        setActionError(message);
      } finally {
        setActiveAction(null);
      }
    }, [isPrMode, prReviewId, activeAction, popup, projectId, refreshData]);

    const handleDismissFailedReview = useCallback(async () => {
      if (isBrMode || !changesetId || isDismissingFailedReview) return;
      setIsDismissingFailedReview(true);
      setReviewError(null);
      try {
        await reviewApi.dismissFailure(projectId, changesetId);
        await refreshData();
      } catch (error: any) {
        const msg = error?.response?.data?.error || error?.message || 'Failed to dismiss error state';
        setReviewError(msg);
      } finally {
        setIsDismissingFailedReview(false);
      }
    }, [isBrMode, changesetId, isDismissingFailedReview, projectId, refreshData]);

    const reviewForActions: ReviewResult | null = isBrMode
      ? (branchReview?.reviewJson ?? null)
      : (changeset?.reviewData ?? null);
    const allRecommendationsForActions = useMemo(
      () => reviewForActions?.recommendations || [],
      [reviewForActions]
    );
    const unresolvedRecommendationsForActions = useMemo(
      () => allRecommendationsForActions.filter((rec) => !getRecommendationResolutionFor(rec, recommendationResolutions)),
      [allRecommendationsForActions, recommendationResolutions]
    );
    const unresolvedActionableRecommendationsForApproval = useMemo(
      () => unresolvedRecommendationsForActions.filter((rec) => rec.type !== 'praise'),
      [unresolvedRecommendationsForActions]
    );
    const approvalUnresolvedHighSeverityCount = useMemo(
      () => unresolvedActionableRecommendationsForApproval
        .filter((rec) => rec.severity === 'high' || rec.severity === 'critical')
        .length,
      [unresolvedActionableRecommendationsForApproval]
    );
    const approvalUnresolvedSoftCount = Math.max(
      0,
      unresolvedActionableRecommendationsForApproval.length - approvalUnresolvedHighSeverityCount,
    );
    const recommendationsForActions = useMemo(
      () => (includeResolvedInActions ? allRecommendationsForActions : unresolvedRecommendationsForActions),
      [includeResolvedInActions, allRecommendationsForActions, unresolvedRecommendationsForActions]
    );
    const fixableRecommendations = useMemo(
      () => unresolvedRecommendationsForActions.filter((rec) => rec.type !== 'praise'),
      [unresolvedRecommendationsForActions]
    );
    const fixSelectionItems = useMemo(
      () => buildFixSelectionItems(fixableRecommendations),
      [fixableRecommendations]
    );
    const reviewExportContextLabel = useMemo(
      () => (
        isBrMode
          ? `${branchReview?.branchName || 'branch'} vs ${formatBaseBranchLabel(branchReview?.baseBranch)}`
          : `${changeset?.displayId || changesetId || 'changeset'}`
      ),
      [isBrMode, branchReview?.branchName, branchReview?.baseBranch, changeset?.displayId, changesetId]
    );
    const {
      reviewExportMarkdown,
      reviewExportGitHubComment,
      reviewExportPrompt,
    } = useMemo(() => {
      if (!reviewForActions) {
        return {
          reviewExportMarkdown: '',
          reviewExportGitHubComment: '',
          reviewExportPrompt: '',
        };
      }

      const common = {
        review: reviewForActions,
        contextLabel: reviewExportContextLabel,
        includeResolved: includeResolvedInActions,
        recommendationResolutions,
      };

      return {
        reviewExportMarkdown: buildReviewMarkdown(common),
        reviewExportGitHubComment: buildGitHubReviewCommentMarkdown(common),
        reviewExportPrompt: buildFixPrompt(common),
      };
    }, [reviewForActions, reviewExportContextLabel, includeResolvedInActions, recommendationResolutions]);
    const markdownFileLabel = useMemo(
      () => sanitizeFileNamePart(
        isBrMode
          ? `${branchReview?.branchName || 'branch'}-vs-${formatBaseBranchLabel(branchReview?.baseBranch)}`
          : `${changeset?.displayId || changesetId || 'changeset'}`
      ) || 'review-summary',
      [isBrMode, branchReview?.branchName, branchReview?.baseBranch, changeset?.displayId, changesetId]
    );
    const markdownFilename = `${markdownFileLabel}.md`;
    const {
      branchReviewDiffPaths,
      omittedFileCount,
      omittedOnlyCount,
      failedFileCount,
      failedFileCountUnlisted,
    } = useMemo(() => {
      const branchReviewDiffFiles = ((branchReview as BranchReviewWithDiffFiles | null)?.files || []).filter((file) => (
        file && typeof file.path === 'string' && file.path.trim().length > 0
      ));
      const canonicalPathLookup = buildReviewPathLookup(
        branchReviewDiffFiles.map((file) => String(file.path || '').trim())
      );
      const nextBranchReviewDiffPaths = Array.from(new Set(branchReviewDiffFiles.map((file) => file.path.trim())));
      const resolveCanonicalDiffPath = (pathValue: unknown) => (
        resolveCanonicalReviewPath(pathValue, canonicalPathLookup)
      );
      const deeplyReviewedPathSet = new Set<string>();

      if (reviewForActions) {
        for (const group of reviewForActions.changeGroups || []) {
          for (const file of group.files || []) {
            const normalizedPath = resolveCanonicalDiffPath(file?.path);
            if (normalizedPath) deeplyReviewedPathSet.add(normalizedPath);
          }
        }
        for (const rec of reviewForActions.recommendations || []) {
          const parsed = getRecommendationDiffNavigationTarget(rec);
          if (!parsed) continue;
          if (typeof parsed === 'string') {
            const normalizedPath = resolveCanonicalDiffPath(parsed);
            if (normalizedPath) deeplyReviewedPathSet.add(normalizedPath);
            continue;
          }
          if (typeof parsed.filePath === 'string' && parsed.filePath.trim()) {
            const normalizedPath = resolveCanonicalDiffPath(parsed.filePath);
            if (normalizedPath) deeplyReviewedPathSet.add(normalizedPath);
          }
        }
      }

      const rawFailedPaths = Array.isArray(reviewForActions?.stats?.perFileFailedPaths)
        ? reviewForActions.stats.perFileFailedPaths
        : [];
      const rawOmissionReasons = (
        reviewForActions?.stats?.omissionReasons
        && typeof reviewForActions.stats.omissionReasons === 'object'
        && !Array.isArray(reviewForActions.stats.omissionReasons)
      )
        ? reviewForActions.stats.omissionReasons
        : {};
      const normalizedFailedPaths = rawFailedPaths
        .map((value) => resolveCanonicalDiffPath(value))
        .filter((value): value is string => Boolean(value));
      const nextFailedFilePaths = Array.from(new Set(normalizedFailedPaths));
      const declaredFailedFileCount = Math.max(
        nextFailedFilePaths.length,
        Number(reviewForActions?.stats?.perFileFailedFiles || 0)
      );
      const failedPathSet = new Set(nextFailedFilePaths);
      const branchDiffPathSet = new Set(nextBranchReviewDiffPaths);
      const telemetryReasonPaths = Array.from(new Set(Object.keys(rawOmissionReasons).map((path) => {
        const normalizedPath = resolveCanonicalDiffPath(path);
        return normalizedPath && branchDiffPathSet.has(normalizedPath) ? normalizedPath : null;
      }).filter((path): path is string => Boolean(path))));
      const stats = reviewForActions?.stats;
      const reportedAnalyzedFiles = Math.max(
        0,
        Number(
          stats?.deepReviewedFiles
          ?? stats?.filesDeepReviewed
          ?? stats?.filesAnalyzed
          ?? 0
        )
      );
      const reportedTotalFiles = Math.max(
        0,
        Number(
          stats?.fileCount
          ?? stats?.totalChangedFiles
          ?? nextBranchReviewDiffPaths.length
          ?? 0
        )
      );
      const reportedOmittedFiles = Math.max(0, Number(stats?.omittedFiles || 0));
      const reportedFullCoverage = reportedTotalFiles > 0
        && reportedAnalyzedFiles >= reportedTotalFiles
        && reportedOmittedFiles === 0;
      const coverageOmittedPaths = reportedFullCoverage
        ? []
        : nextBranchReviewDiffPaths.filter((path) => !deeplyReviewedPathSet.has(path));
      const nextFollowUpPaths = Array.from(new Set([
        ...nextFailedFilePaths,
        ...coverageOmittedPaths,
        ...telemetryReasonPaths,
      ]));
      const nextOmittedOnlyCount = nextFollowUpPaths.filter((path) => !failedPathSet.has(path)).length;

      return {
        branchReviewDiffPaths: nextBranchReviewDiffPaths,
        omittedFileCount: nextFollowUpPaths.length,
        omittedOnlyCount: nextOmittedOnlyCount,
        failedFileCount: nextFailedFilePaths.length,
        failedFileCountUnlisted: Math.max(0, declaredFailedFileCount - nextFailedFilePaths.length),
      };
    }, [branchReview, reviewForActions]);
    const reviewTier = reviewForActions ? normalizeReviewTier(reviewForActions) : null;
    // ── Verification actions ──────────────────────────────────────────

    const handleRunChecks = useCallback(async () => {
      setIsRunningChecks(true);
      setVerifyError(null);
      try {
        const result = await changesetApi.runVerification(projectId, changesetId!);
        setVerificationState(result.verification);
        await refreshData();
      } catch (error: any) {
        const msg = error?.response?.data?.error || error?.message || 'Verification failed';
        setVerifyError(msg);
      } finally {
        setIsRunningChecks(false);
      }
    }, [projectId, changesetId, refreshData]);

    // ── Ship-It actions ───────────────────────────────────────────────

    const showSuccess = useCallback((type: string, message: string) => {
      setActionSuccess({ type, message });
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setActionSuccess(null), 3000);
    }, []);

    const handleReplyToGitHubConversation = useCallback(async (thread: GitHubPrReviewThread, body: string) => {
      if (!prReviewId) return;
      const threadNodeId = thread.nodeId || thread.id;
      setPrConversationActionThreadId(thread.id);
      setPrConversationsError(null);
      setActionError(null);
      try {
        const response = await prReviewApi.replyToConversationThread(projectId, prReviewId, threadNodeId, body);
        publishPrConversations(response.conversations);
        showSuccess('github-conversation', 'Replied to GitHub conversation');
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to reply to GitHub conversation';
        setPrConversationsError(message);
        setActionError(message);
        throw new Error(message);
      } finally {
        setPrConversationActionThreadId(null);
      }
    }, [projectId, prReviewId, publishPrConversations, showSuccess]);

    const handleSetGitHubConversationResolved = useCallback(async (
      thread: GitHubPrReviewThread,
      resolved: boolean,
    ) => {
      if (!prReviewId) return;
      const threadNodeId = thread.nodeId || thread.id;
      setPrConversationActionThreadId(thread.id);
      setPrConversationsError(null);
      setActionError(null);
      try {
        const response = await prReviewApi.setConversationThreadResolution(projectId, prReviewId, threadNodeId, resolved);
        publishPrConversations(response.conversations);
        showSuccess('github-conversation', resolved ? 'Resolved GitHub conversation' : 'Reopened GitHub conversation');
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to update GitHub conversation';
        setPrConversationsError(message);
        setActionError(message);
        throw new Error(message);
      } finally {
        setPrConversationActionThreadId(null);
      }
    }, [projectId, prReviewId, publishPrConversations, showSuccess]);

    const handleUpdateGitHubConversationComment = useCallback(async (
      comment: GitHubPrThreadComment,
      body: string,
    ) => {
      if (!prReviewId) return;
      const commentNodeId = comment.nodeId || comment.id;
      setPrConversationActionCommentId(comment.id);
      setPrConversationsError(null);
      setActionError(null);
      try {
        const response = await prReviewApi.updateConversationComment(projectId, prReviewId, commentNodeId, body);
        publishPrConversations(response.conversations);
        showSuccess('github-conversation', 'Updated GitHub comment');
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to update GitHub comment';
        setPrConversationsError(message);
        setActionError(message);
        throw new Error(message);
      } finally {
        setPrConversationActionCommentId(null);
      }
    }, [projectId, prReviewId, publishPrConversations, showSuccess]);

    const handleDeleteGitHubConversationComment = useCallback(async (comment: GitHubPrThreadComment) => {
      if (!prReviewId) return;
      const commentNodeId = comment.nodeId || comment.id;
      setPrConversationActionCommentId(comment.id);
      setPrConversationsError(null);
      setActionError(null);
      try {
        const response = await prReviewApi.deleteConversationComment(projectId, prReviewId, commentNodeId);
        publishPrConversations(response.conversations);
        showSuccess('github-conversation', 'Deleted GitHub comment');
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to delete GitHub comment';
        setPrConversationsError(message);
        setActionError(message);
        throw new Error(message);
      } finally {
        setPrConversationActionCommentId(null);
      }
    }, [projectId, prReviewId, publishPrConversations, showSuccess]);

    const handleConfirmDeleteGitHubConversationComment = useCallback(async (comment: GitHubPrThreadComment) => {
      const author = comment.authorLogin ? ` from ${comment.authorLogin}` : '';
      const isReply = Boolean(comment.replyToNodeId);
      return popup.confirm({
        title: isReply ? 'Delete GitHub reply?' : 'Delete GitHub comment?',
        message: `This will delete the ${isReply ? 'reply' : 'comment'}${author} from the GitHub pull request conversation.`,
        confirmLabel: isReply ? 'Delete reply' : 'Delete comment',
        cancelLabel: 'Cancel',
        danger: true,
      });
    }, [popup]);

    const handleReplyToGitHubIssueComment = useCallback(async (body: string) => {
      if (!prReviewId) return;
      setPrConversationActionIssueCommentId('__new__');
      setPrConversationsError(null);
      setActionError(null);
      try {
        const response = await prReviewApi.addIssueComment(projectId, prReviewId, body);
        publishPrConversations(response.conversations);
        showSuccess('github-conversation', 'Replied to PR comment');
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to reply to PR comment';
        setPrConversationsError(message);
        setActionError(message);
        throw new Error(message);
      } finally {
        setPrConversationActionIssueCommentId(null);
      }
    }, [projectId, prReviewId, publishPrConversations, showSuccess]);

    const handleUpdateGitHubIssueComment = useCallback(async (
      comment: GitHubPrIssueComment,
      body: string,
    ) => {
      if (!prReviewId) return;
      const commentNodeId = comment.nodeId || comment.id;
      setPrConversationActionIssueCommentId(comment.id);
      setPrConversationsError(null);
      setActionError(null);
      try {
        const response = await prReviewApi.updateIssueComment(projectId, prReviewId, commentNodeId, body);
        publishPrConversations(response.conversations);
        showSuccess('github-conversation', 'Updated PR comment');
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to update PR comment';
        setPrConversationsError(message);
        setActionError(message);
        throw new Error(message);
      } finally {
        setPrConversationActionIssueCommentId(null);
      }
    }, [projectId, prReviewId, publishPrConversations, showSuccess]);

    const handleDeleteGitHubIssueComment = useCallback(async (comment: GitHubPrIssueComment) => {
      if (!prReviewId) return;
      const commentNodeId = comment.nodeId || comment.id;
      setPrConversationActionIssueCommentId(comment.id);
      setPrConversationsError(null);
      setActionError(null);
      try {
        const response = await prReviewApi.deleteIssueComment(projectId, prReviewId, commentNodeId);
        publishPrConversations(response.conversations);
        showSuccess('github-conversation', 'Deleted PR comment');
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || 'Failed to delete PR comment';
        setPrConversationsError(message);
        setActionError(message);
        throw new Error(message);
      } finally {
        setPrConversationActionIssueCommentId(null);
      }
    }, [projectId, prReviewId, publishPrConversations, showSuccess]);

    const handleConfirmDeleteGitHubIssueComment = useCallback(async (comment: GitHubPrIssueComment) => {
      const author = comment.authorLogin ? ` from ${comment.authorLogin}` : '';
      return popup.confirm({
        title: 'Delete PR comment?',
        message: `This will delete the PR comment${author} from GitHub.`,
        confirmLabel: 'Delete comment',
        cancelLabel: 'Cancel',
        danger: true,
      });
    }, [popup]);

    // ── BR-specific actions ─────────────────────────────────────────────

    // ── CS-specific actions ───────────────────────────────────────────

    const handlePush = useCallback(async () => {
      if (activeAction || !changesetId) return;
      setActiveAction('push');
      setActionError(null);
      try {
        if (changeset && changeset.status !== 'committed' && changeset.status !== 'published') {
          await changesetApi.commit(projectId, changesetId);
        }
        await actionApi.push(projectId, changesetId);
        showSuccess('push', 'Pushed successfully');
        await refreshData();
      } catch (error: any) {
        const msg = error?.response?.data?.error || error?.message || 'Push failed';
        setActionError(msg);
      } finally {
        setActiveAction(null);
      }
    }, [projectId, changesetId, changeset, activeAction, showSuccess, refreshData]);

    const handleDeploy = useCallback(async () => {
      if (activeAction || !changesetId) return;
      setActiveAction('deploy');
      setActionError(null);
      try {
        const result = await actionApi.deploy(projectId, changesetId);
        const url = (result.data as any)?.url;
        showSuccess('deploy', url ? `Deployed: ${url}` : 'Deploy started');
        await refreshData();
      } catch (error: any) {
        const msg = error?.response?.data?.error || error?.message || 'Deploy failed';
        setActionError(msg);
      } finally {
        setActiveAction(null);
      }
    }, [projectId, changesetId, activeAction, showSuccess, refreshData]);

    const handleRollback = useCallback(async () => {
      if (activeAction || !changesetId) return;
      setActiveAction('rollback');
      setActionError(null);
      setConfirmingRollback(false);
      try {
        await actionApi.rollback(projectId, changesetId);
        showSuccess('rollback', 'Rolled back successfully');
        await refreshData();
      } catch (error: any) {
        const msg = error?.response?.data?.error || error?.message || 'Rollback failed';
        setActionError(msg);
      } finally {
        setActiveAction(null);
      }
    }, [projectId, changesetId, activeAction, showSuccess, refreshData]);

    const handleCopyMarkdown = useCallback(async () => {
      setActionError(null);
      if (!reviewExportMarkdown) {
        setActionError('No review summary available to copy yet.');
        return;
      }
      const copied = await copyTextToClipboard(reviewExportMarkdown);
      if (!copied) {
        setActionError('Unable to copy review summary to clipboard.');
        return;
      }
      showSuccess(
        'copy',
        `Copied \u2713 ${recommendationsForActions.length} finding${recommendationsForActions.length !== 1 ? 's' : ''} to clipboard`
      );
    }, [reviewExportMarkdown, recommendationsForActions.length, showSuccess]);

    const handleCopyGitHubComment = useCallback(async () => {
      setActionError(null);
      if (!reviewExportGitHubComment) {
        setActionError('No GitHub comment summary available to copy yet.');
        return;
      }
      const copied = await copyTextToClipboard(reviewExportGitHubComment);
      if (!copied) {
        setActionError('Unable to copy GitHub comment summary.');
        return;
      }
      showSuccess('copy', 'Copied \u2713 GitHub review comment');
    }, [reviewExportGitHubComment, showSuccess]);

    const handleCopyPrompt = useCallback(async () => {
      setActionError(null);
      if (!reviewExportPrompt) {
        setActionError('No prompt available to copy yet.');
        return;
      }
      const copied = await copyTextToClipboard(reviewExportPrompt);
      if (!copied) {
        setActionError('Unable to copy prompt.');
        return;
      }
      showSuccess('copy', 'Copied \u2713 fix prompt');
    }, [reviewExportPrompt, showSuccess]);

    const handleDownloadMarkdown = useCallback(() => {
      setActionError(null);
      if (!reviewExportMarkdown) {
        setActionError('No review summary available to download yet.');
        return;
      }
      const downloaded = downloadMarkdownFile(markdownFilename, reviewExportMarkdown);
      if (!downloaded) {
        setActionError('Unable to download markdown summary.');
        return;
      }
      showSuccess('export', `Downloaded ${markdownFilename}`);
    }, [reviewExportMarkdown, markdownFilename, showSuccess]);

    const openFixDialogWithKeys = useCallback((preferredKeys?: string[], options?: {
      fallbackToDefaults?: boolean;
    }) => {
      setActionError(null);
      if (branchFixUnavailableReason) {
        setActionError(branchFixUnavailableReason);
        return false;
      }
      if (fixSelectionItems.length === 0) {
        setActionError('No unresolved findings are available to fix.');
        return false;
      }
      setFixDialogItems(fixSelectionItems);
      const preferredKeySet = new Set((preferredKeys || []).filter(Boolean));
      const preferredSelection = fixSelectionItems
        .filter((item) => preferredKeySet.has(item.key))
        .map((item) => item.key);
      const defaultSelection = fixSelectionItems
        .filter((item) => item.defaultSelected)
        .map((item) => item.key);
      const nextSelection = preferredSelection.length > 0
        ? preferredSelection
        : options?.fallbackToDefaults === false
          ? []
          : defaultSelection;
      if (nextSelection.length === 0) {
        setActionError('None of the selected findings are currently available for this action.');
        return false;
      }
      setSelectedFixKeys(new Set(nextSelection));
      setIsFixDialogOpen(true);
      return true;
    }, [branchFixUnavailableReason, fixSelectionItems]);

    const handleOpenFixDialog = useCallback(() => {
      if (isPrMode) {
        setActionError('Fix Issues is currently available only for branch reviews.');
        return;
      }
      if (branchFixUnavailableReason) {
        setActionError(branchFixUnavailableReason);
        return;
      }
      void openFixDialogWithKeys([], {
        fallbackToDefaults: true,
      });
    }, [isPrMode, branchFixUnavailableReason, openFixDialogWithKeys]);

    const handleToggleFixSelection = useCallback((key: string) => {
      setSelectedFixKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
    }, []);

    const handleToggleAllFixSelections = useCallback(() => {
      setSelectedFixKeys((prev) => {
        if (fixDialogItems.length === 0) {
          return prev;
        }
        const selectedVisibleCount = fixDialogItems.filter((item) => prev.has(item.key)).length;
        if (selectedVisibleCount === fixDialogItems.length) {
          return new Set();
        }
        return new Set(fixDialogItems.map((item) => item.key));
      });
    }, [fixDialogItems]);

    const handleStopFixRun = useCallback(async () => {
      if (!activeFixRun?.isRunning) return;
      setActionError(null);
      const stoppedAt = new Date().toISOString();
      setActiveFixRun((prev) => prev ? {
        ...prev,
        isRunning: false,
        statusLabel: 'Fix run stopped',
        activityLabel: null,
        error: null,
      } : prev);
      setRecommendationFixStatuses((prev) => {
        const next: RecommendationFixStatusMap = { ...prev };
        for (const key of activeFixRun.selectedKeys) {
          next[key] = {
            ...(next[key] || {}),
            status: 'stopped',
            updatedAt: stoppedAt,
            error: null,
          };
        }
        return next;
      });
      try {
        const response = await emitProjectSocketEventWithAck<{ success?: boolean; error?: string }>(
          projectId,
          'fix-stop',
          {
            projectId,
            runId: activeFixRun?.runId || undefined,
          },
        );
        if (response?.success) {
          setActiveFixRun((prev) => prev ? {
            ...prev,
            isRunning: false,
            statusLabel: 'Fix run stopped',
            activityLabel: null,
            error: null,
          } : prev);
          return;
        }

        const errorMessage = String(response?.error || '').trim();
        if (errorMessage.toLowerCase().includes('no active fix run')) {
          setActiveFixRun((prev) => prev ? {
            ...prev,
            isRunning: false,
            statusLabel: 'Fix run stopped',
            activityLabel: null,
            error: null,
          } : prev);
          void refreshFixRunArtifacts();
          return;
        }

        setActiveFixRun((prev) => prev ? {
          ...prev,
          statusLabel: 'Fix run stop requested',
          activityLabel: null,
          error: errorMessage || prev.error,
        } : prev);
        if (errorMessage) {
          setActionError(errorMessage);
        }
      } catch (error: any) {
        const message = String(error?.message || 'Failed to stop fix run.').trim();
        setActiveFixRun((prev) => prev ? {
          ...prev,
          statusLabel: 'Fix run stop requested',
          activityLabel: null,
          error: message,
        } : prev);
        setActionError(message);
      }
    }, [activeFixRun, projectId, refreshFixRunArtifacts]);

    const startFixRunForKeys = useCallback((requestedRecommendationKeys?: string[]) => {
      if (!recommendationOutcomeScope) {
        setActionError('Fix Issues is only available for a persisted review scope.');
        return false;
      }
      if (isPrMode) {
        setActionError('Fix Issues is currently available only for branch reviews.');
        return false;
      }
      if (branchFixUnavailableReason) {
        setActionError(branchFixUnavailableReason);
        return false;
      }
      if (activeFixRun?.isRunning || isStartingFixRun) {
        setActionError('A Fix Issues run is already active for this review.');
        return false;
      }

      const requestedKeySet = new Set(
        (Array.isArray(requestedRecommendationKeys) ? requestedRecommendationKeys : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      );
      const recommendationKeys = fixableRecommendations
        .map((rec) => getRecommendationFingerprint(rec))
        .filter((key) => requestedKeySet.size > 0 ? requestedKeySet.has(key) : selectedFixKeys.has(key));

      if (recommendationKeys.length === 0) {
        setActionError(requestedKeySet.size > 0
          ? 'None of the requested findings are currently available for Fix Issues.'
          : 'Select at least one finding to fix.');
        return false;
      }

      const selectedRecommendations = fixableRecommendations.filter((rec) => (
        recommendationKeys.includes(getRecommendationFingerprint(rec))
      ));
      const prompt = buildFixPrompt({
        review: reviewForActions!,
        contextLabel: reviewExportContextLabel,
        includeResolved: false,
        recommendationResolutions,
        selectedRecommendationKeys: recommendationKeys,
      });

      setIsStartingFixRun(true);
      setIsFixDialogOpen(false);
      setActiveFixRun({
        runId: null,
        isRunning: true,
        startedAt: new Date().toISOString(),
        selectedKeys: recommendationKeys,
        statusLabel: 'Starting fix run…',
        activityLabel: 'Atlas is preparing a patch for the selected finding set…',
        error: null,
        buildSummary: null,
      });
      setRecommendationFixStatuses((prev) => {
        const next: RecommendationFixStatusMap = { ...prev };
        for (const recommendationKey of recommendationKeys) {
          next[recommendationKey] = {
            status: 'running',
            updatedAt: new Date().toISOString(),
            filePaths: [],
            error: null,
          };
        }
        return next;
      });

      emitProjectSocketEvent(projectId, 'fix-issues', {
        projectId,
        reviewType: recommendationOutcomeScope.reviewType,
        reviewId: recommendationOutcomeScope.reviewId,
        prompt,
        recommendationKeys,
        findings: selectedRecommendations.map((rec) => ({
          recommendationKey: getRecommendationFingerprint(rec),
          context: buildFixIssueContext(rec),
          filePaths: buildFixIssueFilePaths(rec),
        })),
      });
      return true;
    }, [
      activeFixRun?.isRunning,
      isStartingFixRun,
      isPrMode,
      branchFixUnavailableReason,
      fixableRecommendations,
      selectedFixKeys,
      reviewForActions,
      reviewExportContextLabel,
      recommendationResolutions,
      projectId,
      recommendationOutcomeScope,
    ]);

    const handleStartFixRun = useCallback(() => {
      startFixRunForKeys();
    }, [startFixRunForKeys]);

    const handleOpenOnGitHub = useCallback(async () => {
      if (!githubCompareUrl) return;
      try {
        await openExternal(githubCompareUrl);
      } catch (error: any) {
        const msg = error?.message || 'Failed to open GitHub compare view';
        setActionError(msg);
      }
    }, [githubCompareUrl]);

    const loadManualLineCommentDrafts = useCallback(() => {
      const storageKey = buildManualLineCommentStorageKey({
        projectId,
        prReviewId,
      });
      if (!storageKey) return {};
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return {};
        return normalizeManualLineCommentMap(JSON.parse(raw));
      } catch {
        return {};
      }
    }, [projectId, prReviewId]);

    const clearManualLineCommentDrafts = useCallback((ids: string[]) => {
      const storageKey = buildManualLineCommentStorageKey({
        projectId,
        prReviewId,
      });
      if (!storageKey) return;
      const idsToClear = new Set(ids.map((id) => String(id || '').trim()).filter(Boolean));
      if (idsToClear.size === 0) return;
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return;
        const current = normalizeManualLineCommentMap(JSON.parse(raw));
        let changed = false;
        for (const id of idsToClear) {
          if (current[id]) {
            delete current[id];
            changed = true;
          }
        }
        if (!changed) return;
        if (Object.keys(current).length === 0) {
          localStorage.removeItem(storageKey);
        } else {
          localStorage.setItem(storageKey, JSON.stringify(current));
        }
        window.dispatchEvent(new CustomEvent(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, {
          detail: {
            kind: 'manual_line',
            storageKey,
          },
        }));
      } catch {
        // Ignore storage failures; the next conversation sync still shows the posted GitHub thread.
      }
    }, [projectId, prReviewId]);

    const loadRecommendationNotes = useCallback(() => {
      if (!recommendationNoteStorageKey) return {};
      try {
        const raw = localStorage.getItem(recommendationNoteStorageKey);
        if (!raw) return {};
        return normalizeRecommendationNoteMap(JSON.parse(raw));
      } catch {
        return {};
      }
    }, [recommendationNoteStorageKey]);

    useEffect(() => {
      const loaded = loadRecommendationNotes();
      setRecommendationNotes(loaded);
    }, [loadRecommendationNotes]);

    useEffect(() => {
      if (!recommendationNoteStorageKey) return undefined;
      const handleNotesUpdated = (event: Event) => {
        const detail = (event as CustomEvent<{ storageKey?: string }>).detail;
        if (!detail || detail.storageKey !== recommendationNoteStorageKey) return;
        setRecommendationNotes(loadRecommendationNotes());
      };
      window.addEventListener('atlas-review-finding-notes-updated', handleNotesUpdated as EventListener);
      return () => {
        window.removeEventListener('atlas-review-finding-notes-updated', handleNotesUpdated as EventListener);
      };
    }, [recommendationNoteStorageKey, loadRecommendationNotes]);

    const persistRecommendationNotes = useCallback((nextNotes: RecommendationNoteMap) => {
      if (!recommendationNoteStorageKey) return;
      try {
        if (Object.keys(nextNotes).length === 0) {
          localStorage.removeItem(recommendationNoteStorageKey);
        } else {
          localStorage.setItem(recommendationNoteStorageKey, JSON.stringify(nextNotes));
        }
        window.dispatchEvent(new CustomEvent('atlas-review-finding-notes-updated', {
          detail: { storageKey: recommendationNoteStorageKey },
        }));
      } catch {
        // Ignore storage write failures (quota/private mode).
      }
    }, [recommendationNoteStorageKey]);

    const buildCurrentPrCommentDialogItems = useCallback(() => {
      const recommendationItems = buildPrCommentSelectionItems(recommendationsForActions, {
        publishedByRecommendationKey: prPublicationState?.byRecommendationKey || {},
        currentHeadSha: resolveCurrentPrHeadSha(branchReview),
        recommendationResolutions,
      }).map((item) => ({
        ...item,
        kind: 'recommendation' as const,
        kindLabel: 'AI finding',
      }));
      const publishedByRecommendationKey = prPublicationState?.byRecommendationKey || {};
      const manualItems = Object.values(loadManualLineCommentDrafts())
        .filter((draft) => {
          const publication = publishedByRecommendationKey[draft.id]
            || publishedByRecommendationKey[String(draft.id || '').trim().toLowerCase()];
          if (publication) {
            return false;
          }
          return true;
        })
        .sort((left, right) => {
          const pathDiff = left.path.localeCompare(right.path);
          if (pathDiff !== 0) return pathDiff;
          return left.line - right.line;
        })
        .map((draft) => {
          const firstLine = draft.body.split('\n')[0]?.trim() || 'Line comment';
          const title = firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
          return {
            key: `manual:${draft.id}`,
            title,
            severity: 'low' as const,
            location: `${draft.path}:${draft.line}${draft.side === 'LEFT' ? ' (deleted)' : ''}`,
            defaultSelected: true,
            kind: 'manual_line_comment' as const,
            kindLabel: 'Line comment',
            manualLineComment: draft,
          };
        });
      return [...manualItems, ...recommendationItems];
    }, [recommendationsForActions, prPublicationState?.byRecommendationKey, branchReview, resolveCurrentPrHeadSha, recommendationResolutions, loadManualLineCommentDrafts]);

    const handlePublishPrReview = useCallback(async (
      action: 'comment' | 'approve' | 'request_changes',
      body?: string | null,
      recommendationKeysOverride?: string[],
      options?: {
        useExplicitRecommendationSelection?: boolean;
        commentOverridesByRecommendationKey?: Record<string, string>;
        skipExistingPublicationCheck?: boolean;
        manualLineComments?: ManualLineCommentDraft[];
      },
    ) => {
      if (!prReviewId || !isPrMode || activeAction) return;
      setActiveAction(action);
      setActionError(null);
      try {
        const recommendationKeys = Array.isArray(recommendationKeysOverride)
          ? recommendationKeysOverride
          : recommendationsForActions
            .filter((rec) => rec.type !== 'praise')
            .map((rec) => getRecommendationFingerprint(rec));
        const storedRecommendationComments = (() => {
          const storageKey = buildRecommendationCommentStorageKey({
            projectId,
            prReviewId,
          });
          if (!storageKey) return {};
          try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return {};
            return normalizeRecommendationCommentMap(JSON.parse(raw));
          } catch {
            return {};
          }
        })();
        const commentOverridesByRecommendationKey = recommendationKeys.reduce<Record<string, string>>((acc, key) => {
          const storedComment = storedRecommendationComments[key]?.comment;
          if (typeof storedComment === 'string' && storedComment.trim()) {
            acc[key] = storedComment.trim();
          }
          return acc;
        }, {});
        const result = await prReviewApi.publishToGitHub(projectId, prReviewId, {
          action,
          recommendationKeys,
          ...(options?.useExplicitRecommendationSelection === true
            ? { useExplicitRecommendationSelection: true }
            : {}),
          ...(body !== undefined ? { body } : {}),
          ...(Array.isArray(options?.manualLineComments) && options.manualLineComments.length > 0
            ? { manualLineComments: options.manualLineComments }
            : {}),
          ...(
            Object.keys({
              ...commentOverridesByRecommendationKey,
              ...(options?.commentOverridesByRecommendationKey || {}),
            }).length > 0
              ? {
                  commentOverridesByRecommendationKey: {
                    ...commentOverridesByRecommendationKey,
                    ...(options?.commentOverridesByRecommendationKey || {}),
                  },
                }
              : {}
          ),
          ...(options?.skipExistingPublicationCheck === true
            ? { skipExistingPublicationCheck: true }
            : {}),
        });
        setPrPublicationState(result.publication);
        const currentHeadSha = resolveCurrentPrHeadSha(branchReview);
        setPrReviewSubmission(result.reviewSubmission
          ? {
              ...result.reviewSubmission,
              headSha: currentHeadSha,
            }
          : null);
        const publishedCount = Array.isArray(result.results)
          ? result.results.filter((entry) => entry?.status === 'published').length
          : 0;
        const alreadyPublishedCount = Array.isArray(result.results)
          ? result.results.filter((entry) => entry?.status === 'already_published').length
          : 0;
        const skippedCount = Array.isArray(result.results)
          ? result.results.filter((entry) => entry?.status === 'skipped').length
          : 0;
        const clearedManualLineCommentIds = Array.isArray(result.results)
          ? result.results
              .filter((entry) => (
                entry?.manualLineCommentId
                && (entry.status === 'published' || entry.status === 'already_published')
              ))
              .map((entry) => String(entry.manualLineCommentId))
          : [];
        clearManualLineCommentDrafts(clearedManualLineCommentIds);
        const actionLabel = action === 'request_changes'
          ? 'request changes'
          : action === 'approve'
            ? 'approve'
            : 'comment';
        const detailParts = [`Submitted ${actionLabel} review to GitHub`];
        if (publishedCount > 0) detailParts.push(`${publishedCount} published`);
        if (alreadyPublishedCount > 0) detailParts.push(`${alreadyPublishedCount} already posted`);
        if (skippedCount > 0) detailParts.push(`${skippedCount} skipped`);
        showSuccess('github-review', detailParts.join(' • '));
        onPrReviewPublished?.(action);
        void loadPrConversations({ sync: true });
        if (action === 'comment' || action === 'request_changes') {
          setIsPrCommentDialogOpen(false);
          setPrCommentDialogAction('comment');
          setPrCommentDialogBody(null);
          setPrCommentDialogItems([]);
          setSelectedPrCommentKeys(new Set());
        }
      } catch (error: any) {
        const msg = error?.response?.data?.blockedReason
          || error?.response?.data?.error
          || error?.message
          || 'Failed to publish PR review to GitHub';
        setActionError(msg);
      } finally {
        setActiveAction(null);
      }
    }, [prReviewId, isPrMode, activeAction, recommendationsForActions, projectId, showSuccess, branchReview, resolveCurrentPrHeadSha, onPrReviewPublished, loadPrConversations, clearManualLineCommentDrafts]);

    const openPrFindingSelectionDialog = useCallback((
      action: 'comment' | 'request_changes',
      body?: string | null,
    ): { ok: true } | { ok: false; error: string } => {
      if (!isPrMode) {
        return { ok: false, error: 'Select a PR review to publish GitHub comments.' };
      }
      if (activeAction) {
        return { ok: false, error: 'Another PR review action is already in progress.' };
      }
      const items = buildCurrentPrCommentDialogItems();
      if (items.length === 0) {
        return { ok: false, error: 'No actionable findings are available to publish.' };
      }
      setActionError(null);
      setPrCommentDialogItems(items);
      setSelectedPrCommentKeys(new Set(
        items
          .filter((item) => item.defaultSelected)
          .map((item) => item.key)
      ));
      setPrCommentDialogAction(action);
      setPrCommentDialogBody(typeof body === 'string' && body.trim() ? body : null);
      setIsPrCommentDialogOpen(true);
      return { ok: true };
    }, [isPrMode, activeAction, buildCurrentPrCommentDialogItems]);

    const handleOpenPrCommentDialog = useCallback(() => {
      const result = openPrFindingSelectionDialog('comment');
      if (!result.ok) setActionError(result.error);
    }, [openPrFindingSelectionDialog]);

    const handleOpenPrRequestChangesDialog = useCallback(() => {
      const result = openPrFindingSelectionDialog('request_changes');
      if (!result.ok) setActionError(result.error);
    }, [openPrFindingSelectionDialog]);

    const handleTogglePrCommentKey = useCallback((key: string) => {
      setSelectedPrCommentKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    }, []);

    const handleConfirmPrCommentDialog = useCallback(() => {
      const selectedItems = prCommentDialogItems.filter((item) => selectedPrCommentKeys.has(item.key));
      const recommendationKeys = selectedItems
        .filter((item) => item.kind === 'recommendation')
        .map((item) => item.key);
      const manualLineComments = selectedItems
        .filter((item) => item.kind === 'manual_line_comment' && item.manualLineComment)
        .map((item) => item.manualLineComment as ManualLineCommentDraft);
      if (recommendationKeys.length === 0 && manualLineComments.length === 0) {
        setActionError('Select at least one comment to publish.');
        return;
      }
      void handlePublishPrReview(prCommentDialogAction, prCommentDialogBody || undefined, recommendationKeys, {
        useExplicitRecommendationSelection: true,
        manualLineComments,
      });
    }, [prCommentDialogItems, selectedPrCommentKeys, handlePublishPrReview, prCommentDialogAction, prCommentDialogBody]);

    const handleOpenApproveDialog = useCallback(async () => {
      if (!isPrMode || activeAction) return;
      if (approvalUnresolvedHighSeverityCount > 0) {
        setActionError(`${approvalUnresolvedHighSeverityCount} unresolved high-severity finding${approvalUnresolvedHighSeverityCount !== 1 ? 's block' : ' blocks'} approval.`);
        return;
      }
      const prReview = branchReview as unknown as PrReview | null;
      const staleApproval = isPrReviewStale(prReview?.reviewActionEligibility || null);
      if (staleApproval) {
        const staleSummary = getPrStaleReviewSummary(prReview?.reviewActionEligibility || null);
        const detailSuffix = approvalUnresolvedSoftCount > 0
          ? ` ${approvalUnresolvedSoftCount} medium/low finding${approvalUnresolvedSoftCount !== 1 ? 's are' : ' is'} still open.`
          : '';
        const confirmed = await popup.confirm({
          title: 'Approve stale review?',
          message: `${staleSummary}${detailSuffix} Approve this PR without re-running the review?`,
          confirmLabel: 'Approve stale PR',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;
        setActionError(null);
        void handlePublishPrReview('approve', undefined, [], {
          useExplicitRecommendationSelection: true,
        });
        return;
      }
      if (approvalUnresolvedSoftCount > 0) {
        const confirmed = await popup.confirm({
          title: 'Approve with unresolved findings?',
          message: `${approvalUnresolvedSoftCount} medium/low finding${approvalUnresolvedSoftCount !== 1 ? 's remain' : ' remains'} unresolved. Approve anyway?`,
          confirmLabel: 'Continue',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;
      }
      setActionError(null);
      const value = await popup.prompt({
        title: 'Approve PR',
        message: 'Edit the GitHub approval message before submitting. Leave it blank to approve without posting any summary comment.',
        initialValue: buildDefaultPrApprovalBody(prReview),
        placeholder: 'Optional approval message',
        confirmLabel: 'Approve',
        cancelLabel: 'Cancel',
        multiline: true,
      });
      if (value === null) return;
      void handlePublishPrReview('approve', value, [], {
        useExplicitRecommendationSelection: true,
      });
    }, [
      isPrMode,
      activeAction,
      approvalUnresolvedHighSeverityCount,
      approvalUnresolvedSoftCount,
      branchReview,
      popup,
      handlePublishPrReview,
    ]);

    const currentReview: ReviewResult | null | undefined = reviewForActions;
    // Include candidate findings (Section R Phase B-6) alongside
    // recommendations so the cleanup effects below don't prune persisted
    // outcomes for candidates after a reload or review hydration.
    // RecommendationItem keys candidate resolutions on the fingerprint of
    // the candidate finding itself; if those keys aren't in the active set,
    // setRecommendationResolutions strips them and the card reverts to
    // unresolved despite localStorage having the entry.
    // Build fingerprint Sets directly from the keyed array. A previous
    // implementation joined keys with `||` and split back; that's lossy because
    // individual keys can end in `|` (or contain `||`) when trailing parts like
    // file/line/suggestedFix are empty, which fragments the round-trip — e.g.
    // a candidate's `…|27|` + `…|||` pair became three malformed slices, and
    // candidateFindingFingerprintSet.has(key) silently missed real candidates.
    const recommendationFingerprints = useMemo(() => (
      [
        ...(currentReview?.recommendations || []),
        ...(currentReview?.candidateFindings || []),
      ]
        .map((rec) => getRecommendationFingerprint(rec))
        .filter(Boolean)
    ), [currentReview?.recommendations, currentReview?.candidateFindings]);
    const recommendationFingerprintToken = useMemo(
      () => recommendationFingerprints.join(''),
      [recommendationFingerprints]
    );
    const previousFindingFingerprints = useMemo(() => (
      (currentReview?.previousFindings || [])
        .filter((rec) => rec?.type === 'issue' || rec?.type === 'suggestion')
        .map((rec) => getRecommendationFingerprint(rec))
        .filter(Boolean)
    ), [currentReview?.previousFindings]);
    const previousFindingFingerprintSet = useMemo(
      () => new Set(previousFindingFingerprints),
      [previousFindingFingerprints]
    );
    const candidateFindingFingerprints = useMemo(() => (
      (currentReview?.candidateFindings || [])
        .filter((rec) => rec?.type === 'issue' || rec?.type === 'suggestion')
        .map((rec) => getRecommendationFingerprint(rec))
        .filter(Boolean)
    ), [currentReview?.candidateFindings]);
    const candidateFindingFingerprintSet = useMemo(
      () => new Set(candidateFindingFingerprints),
      [candidateFindingFingerprints]
    );
    useEffect(() => {
      onSelectFileFilterRef.current = onSelectFileFilter;
    }, [onSelectFileFilter]);

    useEffect(() => {
      if (currentReview) return;
      setIsStartingFixRun(false);
      setActiveFixRun(null);
    }, [currentReview]);

    // Auto-filter the diff viewer to the selected finding's file. With
    // findings present, the right pane shows the file with that finding;
    // when no findings exist, the filter is cleared so the full file
    // tree is visible. On unmount (mode switch out of Findings), the
    // filter is cleared so Files / Walkthrough modes see everything.
    useEffect(() => {
      if (!onSelectFileFilter) return;
      // This effect owns the "auto-focus the diff to the selected finding"
      // filter only. Non-finding filters (e.g. github_conversation set when
      // the user clicks a PR comment) belong to other flows and must not be
      // touched here — overwriting them causes the right pane to flicker
      // back to the summary or the auto-selected finding.
      if (activeFileFilter && activeFileFilter.kind !== 'finding') return;
      const recs = currentReview?.recommendations || [];
      const actionable = recs.filter((r) => r?.type === 'issue' || r?.type === 'suggestion');
      const activeFindingKey = activeFileFilter?.kind === 'finding' && activeFileFilter.finding
        ? getRecommendationFingerprint(activeFileFilter.finding as ReviewRecommendation)
        : '';
      const activeFindingIsSupplemental = Boolean(
        activeFindingKey
        && (
          previousFindingFingerprintSet.has(activeFindingKey)
          || candidateFindingFingerprintSet.has(activeFindingKey)
        )
      );
      if (activeFindingIsSupplemental) {
        return;
      }
      if (actionable.length === 0) {
        if (!activeFileFilter) return;
        onSelectFileFilter(null);
        return;
      }
      const selected = recs[selectedRecommendationIndex];
      const target = (selected && (selected.type === 'issue' || selected.type === 'suggestion'))
        ? selected
        : actionable[0];
      const targetKey = getRecommendationFingerprint(target);
      const file = getRecommendationSourceFile(target);
      if (file) {
        const focusLine = getRecommendationPatchLine(target) ?? getRecommendationSourceLine(target);
        const activePath = Array.isArray(activeFileFilter?.paths) ? activeFileFilter.paths[0] || '' : '';
        if (
          activeFileFilter?.kind === 'finding'
          && activeFileFilter.findingDisplayMode === 'diff'
          && activeFindingKey === targetKey
          && activePath === file
          && activeFileFilter.focusLine === focusLine
        ) {
          return;
        }
        onSelectFileFilter({
          paths: [file],
          label: target.title || file,
          kind: 'finding',
          focusLine,
          finding: target,
          findingDisplayMode: 'diff',
          findingDetailsReason: null,
        });
      } else {
        if (
          activeFileFilter?.kind === 'finding'
          && activeFileFilter.findingDisplayMode === 'details'
          && activeFindingKey === targetKey
        ) {
          return;
        }
        onSelectFileFilter({
          paths: [],
          label: target.title || 'Finding details',
          kind: 'finding',
          focusLine: null,
          finding: target,
          findingDisplayMode: 'details',
          findingDetailsReason: 'This finding does not include a source file anchor, so there is no diff context to render.',
        });
      }
    }, [
      recommendationFingerprintToken,
      previousFindingFingerprintSet,
      candidateFindingFingerprintSet,
      selectedRecommendationIndex,
      onSelectFileFilter,
      activeFileFilter,
    ]);

    useEffect(() => {
      return () => {
        if (onSelectFileFilterRef.current) onSelectFileFilterRef.current(null);
      };
    }, []);
    const verificationPendingRecommendationKeys = useMemo(() => (
      currentReview
        ? getVerificationPendingRecommendationKeys(
            currentReview.recommendations || [],
            recommendationResolutions,
            recommendationFixStatuses
          )
        : []
    ), [currentReview, recommendationResolutions, recommendationFixStatuses]);
    // Keep the verification workflow reachable in code only. The current UX
    // stays on a manual inspect-and-mark flow until we intentionally re-enable it.
    const handleRunVerificationReview = useCallback(async (targetRecommendationKeys?: string[], options?: {
      runId?: string | null;
    }): Promise<boolean> => {
      if (activeFixRun?.isRunning) {
        setActionError('Stop the active fix run before starting verification review.');
        return false;
      }

      const scopedRecommendationKeys = Array.isArray(targetRecommendationKeys) && targetRecommendationKeys.length > 0
        ? verificationPendingRecommendationKeys.filter((key) => targetRecommendationKeys.includes(key))
        : verificationPendingRecommendationKeys;

      if (Array.isArray(targetRecommendationKeys) && targetRecommendationKeys.length > 0 && scopedRecommendationKeys.length === 0) {
        setActionError('No verification-pending findings remain for this run.');
        return false;
      }

      if (scopedRecommendationKeys.length === 0) {
        return handleReviewNow(false);
      }

      const verificationRun = (() => {
        const preferredRunId = String(options?.runId || '').trim();
        if (preferredRunId) {
          return recentFixRuns.find((run) => run.id === preferredRunId) || null;
        }
        const targetKeySet = new Set(scopedRecommendationKeys);
        return recentFixRuns.find((run) => {
          if (run.status !== 'patch_applied' && run.status !== 'verification_pending') {
            return false;
          }
          const selectedKeys = Array.isArray(run.selectedRecommendationKeys) ? run.selectedRecommendationKeys : [];
          return selectedKeys.some((key) => targetKeySet.has(key));
        }) || null;
      })();

      if (isBrMode && recommendationOutcomeScope?.reviewType === 'branch_review' && verificationRun) {
        const targetFilePaths = Array.isArray(verificationRun.buildSummary?.filePaths)
          ? verificationRun.buildSummary.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
          : [];
        if (targetFilePaths.length === 0) {
          setActionError('Atlas cannot create a verification snapshot because this fix run has no persisted file list.');
          return false;
        }

        const fileCount = targetFilePaths.length;
        const selectedCount = scopedRecommendationKeys.length;
        const previewPaths = targetFilePaths.slice(0, 3);
        const previewSuffix = targetFilePaths.length > 3 ? `, +${targetFilePaths.length - 3} more` : '';
        const confirmed = await popup.confirm({
          title: 'Commit verification snapshot?',
          message: `Atlas will create a verification snapshot commit from the current contents of ${fileCount} fix-run file${fileCount === 1 ? '' : 's'} and rerun the branch review for ${selectedCount} finding${selectedCount === 1 ? '' : 's'}. Unrelated files stay out of the commit. Files: ${previewPaths.join(', ')}${previewSuffix}`,
          confirmLabel: 'Commit and verify',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return false;

        try {
          const snapshot = await reviewApi.createVerificationSnapshot(
            projectId,
            recommendationOutcomeScope,
            verificationRun.id,
            VERIFICATION_SNAPSHOT_COMMIT_MESSAGE,
          );
          setBranchReview((prev) => prev ? {
            ...prev,
            headSha: snapshot.commitSha,
          } : prev);
          showSuccess(
            'review',
            snapshot.commitCreated
              ? `Created verification snapshot ${snapshot.commitSha.slice(0, 7)} for ${snapshot.filesCommitted.length} file${snapshot.filesCommitted.length === 1 ? '' : 's'}.`
              : `Verification will reuse committed snapshot ${snapshot.commitSha.slice(0, 7)}.`
          );
        } catch (error: any) {
          const message = error?.response?.data?.error || error?.message || 'Failed to create verification snapshot commit.';
          setActionError(message);
          return false;
        }
      }

      setActionError(null);
      const previousStatuses = scopedRecommendationKeys.map((key) => ({
        key,
        status: recommendationFixStatuses[key]?.status || 'verification_pending',
      }));
      updateRecommendationFixStatuses(scopedRecommendationKeys, 're_reviewing');
      setActiveFixRun((prev) => prev ? {
        ...prev,
        statusLabel: 'Verification review running…',
        activityLabel: 'Atlas is verifying the patch against the review findings…',
        error: null,
      } : prev);

      const queued = await handleReviewNow(false, {
        skipAlreadyReviewedPrompt: true,
      });
      if (!queued) {
        setRecommendationFixStatuses((prev) => {
          const next: RecommendationFixStatusMap = { ...prev };
          const updatedAt = new Date().toISOString();
          for (const entry of previousStatuses) {
            next[entry.key] = {
              ...(next[entry.key] || {}),
              status: entry.status,
              updatedAt,
            };
          }
          return next;
        });
        setActiveFixRun((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            statusLabel: buildPostFixStatusLabel(
              prev.selectedKeys.length,
              prev.buildSummary?.filesChanged || 0
            ),
            activityLabel: null,
          };
        });
      }
      return queued;
    }, [
      activeFixRun?.isRunning,
      isBrMode,
      popup,
      projectId,
      recentFixRuns,
      recommendationOutcomeScope,
      verificationPendingRecommendationKeys,
      recommendationFixStatuses,
      updateRecommendationFixStatuses,
      handleReviewNow,
      showSuccess,
    ]);
    void handleRunVerificationReview;

    const recommendationResolutionStorageKey = useMemo(() => buildRecommendationResolutionStorageKey({
      projectId,
      changesetId,
      branchReviewId,
      workspaceReviewId,
      prReviewId,
    }), [projectId, changesetId, branchReviewId, workspaceReviewId, prReviewId]);
    const legacyRecommendationResolutionStorageKey = useMemo(() => buildLegacyRecommendationResolutionStorageKey({
      projectId,
      changesetId,
      branchReviewId,
      workspaceReviewId,
      prReviewId,
      reviewedAt: currentReview?.reviewedAt,
    }), [projectId, changesetId, branchReviewId, workspaceReviewId, prReviewId, currentReview?.reviewedAt]);

    useEffect(() => {
      if (!recommendationResolutionStorageKey) {
        setRecommendationResolutions({});
        return;
      }
      try {
        const raw = localStorage.getItem(recommendationResolutionStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          setRecommendationResolutions(normalizeRecommendationResolutionMap(parsed));
          return;
        }
        if (legacyRecommendationResolutionStorageKey) {
          const legacyRaw = localStorage.getItem(legacyRecommendationResolutionStorageKey);
          if (legacyRaw) {
            localStorage.setItem(recommendationResolutionStorageKey, legacyRaw);
            localStorage.removeItem(legacyRecommendationResolutionStorageKey);
            const parsed = JSON.parse(legacyRaw);
            setRecommendationResolutions(normalizeRecommendationResolutionMap(parsed));
            return;
          }
        }
        setRecommendationResolutions({});
      } catch {
        setRecommendationResolutions({});
      }
    }, [recommendationResolutionStorageKey, legacyRecommendationResolutionStorageKey]);

    const refreshRecommendationOutcomes = useCallback(async () => {
      if (!recommendationOutcomeScope) return;
      try {
        const response = await reviewApi.getOutcomes(projectId, recommendationOutcomeScope);
        const serverMap = normalizeRecommendationResolutionMap(response.byRecommendationKey);
        let didChange = false;
        setRecommendationResolutions((prev) => {
          const next = reconcileRecommendationResolutionMaps(prev, serverMap);
          const prevKeys = Object.keys(prev);
          const nextKeys = Object.keys(next);
          if (prevKeys.length !== nextKeys.length) {
            didChange = true;
            return next;
          }
          for (const key of nextKeys) {
            const prevEntry = prev[key];
            const nextEntry = next[key];
            if (
              !prevEntry
              || prevEntry.state !== nextEntry.state
              || (prevEntry.note || '') !== (nextEntry.note || '')
              || (prevEntry.updatedAt || '') !== (nextEntry.updatedAt || '')
            ) {
              didChange = true;
              return next;
            }
          }
          return prev;
        });
        if (didChange) {
          window.dispatchEvent(new CustomEvent('atlas-trust-analytics-refresh', {
            detail: { projectId },
          }));
        }
      } catch (error) {
        console.warn('Failed to hydrate recommendation outcomes from backend:', error);
      }
    }, [projectId, recommendationOutcomeScope?.reviewType, recommendationOutcomeScope?.reviewId]);

    useEffect(() => {
      if (!recommendationOutcomeScope) return;
      void refreshRecommendationOutcomes();
    }, [
      refreshRecommendationOutcomes,
      recommendationOutcomeScope?.reviewType,
      recommendationOutcomeScope?.reviewId,
    ]);

    useEffect(() => {
      if (!projectId || !recommendationOutcomeScope) return;
      return subscribeProjectSocket(projectId, {
        'review-outcomes-updated': (payload?: ReviewOutcomeSocketEvent) => {
          if (!payload) return;
          if (payload.projectId !== projectId) return;
          if (payload.reviewType !== recommendationOutcomeScope.reviewType) return;
          if (payload.reviewId !== recommendationOutcomeScope.reviewId) return;
          void refreshRecommendationOutcomes();
          window.dispatchEvent(new CustomEvent('atlas-trust-analytics-refresh', {
            detail: { projectId },
          }));
        },
      });
    }, [
      projectId,
      recommendationOutcomeScope?.reviewType,
      recommendationOutcomeScope?.reviewId,
      refreshRecommendationOutcomes,
    ]);

    useEffect(() => {
      if (!projectId) return;
      const matchesRecommendationScope = (payload?: FixSocketEventPayload) => {
        if (!payload || payload.projectId !== projectId) return false;
        const payloadRunId = String(payload.runId || '').trim();
        const activeRunId = String(activeFixRunRef.current?.runId || '').trim();
        if (payloadRunId && activeRunId && payloadRunId === activeRunId) return true;
        if (!recommendationOutcomeScope) return false;
        const payloadReviewType = String(payload.reviewType || '').trim().toLowerCase();
        const payloadReviewId = String(payload.reviewId || '').trim();
        return payloadReviewType === recommendationOutcomeScope.reviewType
          && payloadReviewId === recommendationOutcomeScope.reviewId;
      };
      return subscribeProjectSocket(projectId, {
        'fix-started': (payload?: FixSocketEventPayload) => {
          if (!matchesRecommendationScope(payload)) return;
          const p = payload as FixSocketEventPayload;
          setIsStartingFixRun(false);
          setActiveFixRun((prev) => ({
            runId: p.runId || prev?.runId || null,
            isRunning: true,
            startedAt: p.startedAt || prev?.startedAt || new Date().toISOString(),
            selectedKeys: Array.isArray(p.recommendationKeys) ? p.recommendationKeys : (prev?.selectedKeys || []),
            statusLabel: 'Fixing selected findings…',
            activityLabel: 'Atlas is preparing a patch for the selected finding set…',
            error: null,
            buildSummary: null,
          }));
        },
        'fix-stream': (payload?: FixSocketEventPayload) => {
          if (!matchesRecommendationScope(payload)) return;
          const p = payload as FixSocketEventPayload;
          const activity = normalizeFixActivityText(p.text || (p.payload as any)?.text || (p.payload as any)?.message);
          if (!activity) return;
          setActiveFixRun((prev) => prev && prev.isRunning ? {
            ...prev,
            activityLabel: activity,
          } : prev);
        },
        'fix-tool-use': (payload?: FixSocketEventPayload) => {
          if (!matchesRecommendationScope(payload)) return;
          const p = payload as FixSocketEventPayload;
          const activity = buildFixToolActivityLabel(p.tool || p.payload);
          if (!activity) return;
          setActiveFixRun((prev) => prev && prev.isRunning ? {
            ...prev,
            activityLabel: activity,
          } : prev);
        },
        'fix-status': (payload?: FixSocketEventPayload) => {
          if (!matchesRecommendationScope(payload)) return;
          const p = payload as FixSocketEventPayload;
          if (p.recommendationKey && p.status) {
            const isRunningStatus = p.status === 'running';
            setRecommendationFixStatuses((prev) => ({
              ...prev,
              [p.recommendationKey as string]: {
                status: p.status as ReviewFixRecommendationStatus,
                updatedAt: new Date().toISOString(),
                filePaths: isRunningStatus
                  ? []
                  : Array.isArray(p.filePaths)
                  ? p.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
                  : prev[p.recommendationKey as string]?.filePaths,
                error: isRunningStatus
                  ? null
                  : String(p.error || '').trim() || prev[p.recommendationKey as string]?.error || null,
              },
            }));
          }

          if (p.status === 'patch_applied' || p.status === 'verification_pending') {
            setActiveFixRun((prev) => prev ? {
              ...prev,
              statusLabel: Array.isArray(prev.selectedKeys) && prev.selectedKeys.length === 1
                ? 'Patch applied. Inspect and resolve manually.'
                : 'Patch applied. Review selected findings.',
              activityLabel: 'Patch applied. Inspect the diff before marking findings addressed.',
              buildSummary: p.buildSummary || prev.buildSummary,
            } : prev);
          }
        },
        'fix-complete': (payload?: FixSocketEventPayload) => {
          if (!matchesRecommendationScope(payload)) return;
          const p = payload as FixSocketEventPayload;
          setIsStartingFixRun(false);
          setActiveFixRun((prev) => prev ? {
            ...prev,
            runId: p.runId || prev.runId,
            isRunning: false,
            statusLabel: buildPostFixStatusLabel(
              prev.selectedKeys.length,
              p.buildSummary?.filesChanged || 0
            ),
            activityLabel: null,
            error: null,
            buildSummary: p.buildSummary || null,
          } : prev);
          void refreshFixRunArtifacts();
        },
        'fix-error': (payload?: FixSocketEventPayload) => {
          if (!matchesRecommendationScope(payload)) return;
          const p = payload as FixSocketEventPayload;
          setIsStartingFixRun(false);
          setActiveFixRun((prev) => prev ? {
            ...prev,
            isRunning: false,
            statusLabel: 'Fix run failed',
            activityLabel: null,
            error: p.error || 'Fix run failed',
            buildSummary: p.buildSummary || prev.buildSummary,
          } : prev);
          void refreshFixRunArtifacts();
        },
        'fix-stopped': (payload?: FixSocketEventPayload) => {
          if (!matchesRecommendationScope(payload)) return;
          const p = payload as FixSocketEventPayload;
          setIsStartingFixRun(false);
          setActiveFixRun((prev) => prev ? {
            ...prev,
            isRunning: false,
            statusLabel: 'Fix run stopped',
            activityLabel: null,
            error: null,
            buildSummary: p.buildSummary || prev.buildSummary,
          } : prev);
          void refreshFixRunArtifacts();
        },
      });
    }, [projectId, recommendationOutcomeScope?.reviewType, recommendationOutcomeScope?.reviewId, refreshFixRunArtifacts]);

    useEffect(() => {
      if (!recommendationOutcomeScope) return;

      const refreshIfVisible = () => {
        if (typeof document !== 'undefined' && document.hidden) return;
        void refreshRecommendationOutcomes();
      };

      const intervalId = window.setInterval(refreshIfVisible, OUTCOME_REFRESH_POLL_MS);
      window.addEventListener('focus', refreshIfVisible);
      document.addEventListener('visibilitychange', refreshIfVisible);

      return () => {
        window.clearInterval(intervalId);
        window.removeEventListener('focus', refreshIfVisible);
        document.removeEventListener('visibilitychange', refreshIfVisible);
      };
    }, [
      recommendationOutcomeScope?.reviewType,
      recommendationOutcomeScope?.reviewId,
      refreshRecommendationOutcomes,
    ]);

    useEffect(() => {
      if (!activeFixRun?.isRunning) return;
      const intervalId = window.setInterval(() => {
        setFixElapsedTick((value) => value + 1);
      }, 1000);
      return () => window.clearInterval(intervalId);
    }, [activeFixRun?.isRunning]);

    useEffect(() => {
      if (!recommendationResolutionStorageKey) return;
      try {
        localStorage.setItem(recommendationResolutionStorageKey, JSON.stringify(recommendationResolutions));
      } catch {
        // Ignore storage write failures (quota/private mode)
      }
    }, [recommendationResolutionStorageKey, recommendationResolutions]);

    useEffect(() => {
      if (!recommendationFingerprintToken) {
        setRecommendationResolutions({});
        return;
      }
      const activeFingerprintSet = new Set(recommendationFingerprints);
      setRecommendationResolutions((prev) => {
        let changed = false;
        const next: RecommendationResolutionMap = {};
        for (const [fingerprint, entry] of Object.entries(prev)) {
          if (activeFingerprintSet.has(fingerprint)) {
            next[fingerprint] = entry;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, [recommendationFingerprintToken]);

    useEffect(() => {
      if (!recommendationFingerprintToken) {
        setRecommendationFixStatuses({});
        return;
      }
      const activeFingerprintSet = new Set(recommendationFingerprints);
      setRecommendationFixStatuses((prev) => {
        let changed = false;
        const next: RecommendationFixStatusMap = {};
        for (const [fingerprint, entry] of Object.entries(prev)) {
          if (activeFingerprintSet.has(fingerprint)) {
            next[fingerprint] = entry;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, [recommendationFingerprintToken, recommendationFingerprints]);

    const setRecommendationResolution = useCallback(
      (rec: ReviewRecommendation, state: RecommendationResolutionState, note?: string) => {
        const fingerprint = getRecommendationFingerprint(rec);
        const normalizedNote = typeof note === 'string' && note.trim() ? note.trim() : undefined;
        setRecommendationFixStatuses((prev) => {
          if (!prev[fingerprint]) return prev;
          const next = { ...prev };
          delete next[fingerprint];
          return next;
        });
        setRecommendationResolutions((prev) => ({
          ...prev,
          [fingerprint]: {
            state,
            note: normalizedNote,
            updatedAt: new Date().toISOString(),
          },
        }));
        if (!recommendationOutcomeScope) return;
        void reviewApi.setOutcome(projectId, recommendationOutcomeScope, {
          recommendation: rec,
          recommendationKey: fingerprint,
          status: state,
          note: normalizedNote,
        }).then((response) => {
          const serverMap = normalizeRecommendationResolutionMap(response.byRecommendationKey);
          setRecommendationResolutions((prev) => reconcileRecommendationResolutionMaps(prev, serverMap));
          window.dispatchEvent(new CustomEvent('atlas-trust-analytics-refresh', {
            detail: { projectId },
          }));
        }).catch((error) => {
          console.warn('Failed to persist recommendation outcome:', error);
        });
      },
      [projectId, recommendationOutcomeScope]
    );

    const clearRecommendationResolution = useCallback((rec: ReviewRecommendation) => {
      const fingerprint = getRecommendationFingerprint(rec);
      setRecommendationResolutions((prev) => {
        if (!prev[fingerprint]) return prev;
        const next = { ...prev };
        delete next[fingerprint];
        return next;
      });
      if (!recommendationOutcomeScope) return;
      void reviewApi.clearOutcome(projectId, recommendationOutcomeScope, {
        recommendation: rec,
        recommendationKey: fingerprint,
      }).then((response) => {
        const serverMap = normalizeRecommendationResolutionMap(response.byRecommendationKey);
        setRecommendationResolutions((prev) => reconcileRecommendationResolutionMaps(prev, serverMap));
        window.dispatchEvent(new CustomEvent('atlas-trust-analytics-refresh', {
          detail: { projectId },
        }));
      }).catch((error) => {
        console.warn('Failed to clear recommendation outcome:', error);
      });
    }, [projectId, recommendationOutcomeScope]);

    const setRecommendationOutcomeByKey = useCallback((
      recommendationKey: string,
      status: RecommendationResolutionState,
      note?: string,
    ): { ok: true } | { ok: false; error: string } => {
      const normalizedKey = String(recommendationKey || '').trim().toLowerCase();
      if (!normalizedKey) {
        return { ok: false, error: 'No finding was selected for this outcome.' };
      }
      const recommendation = recommendationsForActions.find((rec) => (
        getRecommendationFingerprint(rec).toLowerCase() === normalizedKey
      ));
      if (!recommendation) {
        return { ok: false, error: 'The selected finding is not available in this review.' };
      }
      setRecommendationResolution(recommendation, status, note);
      return { ok: true };
    }, [recommendationsForActions, setRecommendationResolution]);

    const handleEditRecommendationNote = useCallback(async (rec: ReviewRecommendation) => {
      if (rec.type !== 'issue') return;
      const recommendationKey = getRecommendationFingerprint(rec);
      const existingNote = recommendationNotes[recommendationKey];
      const nextValue = await popup.prompt({
        title: existingNote ? 'Edit finding note' : 'Add finding note',
        message: 'This note stays local to Atlas and is never published to GitHub. Leave it blank to remove the note.',
        initialValue: existingNote?.body || '',
        placeholder: 'Capture context, follow-up, or a decision about this finding',
        confirmLabel: existingNote ? 'Save note' : 'Add note',
        cancelLabel: 'Cancel',
        multiline: true,
      });
      if (nextValue === null) return;

      const trimmed = nextValue.trim();
      if (!trimmed) {
        setRecommendationNotes((prev) => {
          if (!prev[recommendationKey]) return prev;
          const next = { ...prev };
          delete next[recommendationKey];
          persistRecommendationNotes(next);
          return next;
        });
        return;
      }

      const activePrReviewMeta = prReviewId ? (branchReview as unknown as Partial<PrReview> | null) : null;
      const draft = buildRecommendationNoteDraft({
        rec,
        body: trimmed,
        recommendationKey,
        reviewType: prReviewId ? 'pr_review' : workspaceReviewId ? 'workspace_review' : 'branch_review',
        branchReviewId: branchReviewId || null,
        workspaceReviewId: workspaceReviewId || null,
        branchName: branchReview?.branchName || null,
        prReviewId: prReviewId || null,
        githubPrNumber: activePrReviewMeta?.githubPrNumber ?? null,
        prHtmlUrl: activePrReviewMeta?.htmlUrl || null,
        reviewDisplayId: branchReview?.displayId || null,
        reviewTitle: activePrReviewMeta?.title || null,
      });
      if (!draft) return;

      setRecommendationNotes((prev) => {
        const next = {
          ...prev,
          [recommendationKey]: draft,
        };
        persistRecommendationNotes(next);
        return next;
      });
    }, [
      branchReview?.branchName,
      branchReview?.displayId,
      branchReviewId,
      popup,
      persistRecommendationNotes,
      prReviewId,
      recommendationNotes,
      workspaceReviewId,
    ]);

    const handleClearRecommendationNote = useCallback((rec: ReviewRecommendation) => {
      const recommendationKey = getRecommendationFingerprint(rec);
      setRecommendationNotes((prev) => {
        if (!prev[recommendationKey]) return prev;
        const next = { ...prev };
        delete next[recommendationKey];
        persistRecommendationNotes(next);
        return next;
      });
    }, [persistRecommendationNotes]);

    // ── Expose actions via ref ────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      triggerPush: () => {
        if (!activeAction) {
          if (!isBrMode && changeset) handlePush();
        }
      },
      triggerReview: () => {
        if (interactionLockReason) {
          setActionError(interactionLockReason);
          return Promise.resolve(false);
        }
        if (!isReviewing) {
          const force = Boolean(changeset?.reviewData) && !prReviewId && !branchReviewId && !workspaceReviewId;
          return handleReviewNow(force);
        }
        return Promise.resolve(false);
      },
      triggerFullReview: () => {
        if (interactionLockReason) {
          setActionError(interactionLockReason);
          return Promise.resolve(false);
        }
        // Only meaningful for scoped reviews (branch / PR / workspace); the
        // legacy changeset path uses the plain review flow.
        if (!prReviewId && !branchReviewId && !workspaceReviewId) {
          return Promise.resolve(false);
        }
        if (!isReviewing) {
          return handleReviewNow(false, { forceFullPopup: true });
        }
        return Promise.resolve(false);
      },
      triggerPartialReview: () => {
        if (interactionLockReason) {
          setActionError(interactionLockReason);
          return Promise.resolve(false);
        }
        // Partial mode only applies to branch reviews today.
        if (!branchReviewId) {
          return Promise.resolve(false);
        }
        if (!isReviewing) {
          return handleReviewNow(false, { partial: true });
        }
        return Promise.resolve(false);
      },
      stopFixRun: () => {
        handleStopFixRun();
      },
      openFixDialog: () => {
        if (isPrMode) {
          setActionError('Fix Issues is currently available only for branch reviews.');
          return;
        }
        handleOpenFixDialog();
      },
      startFixRunForKeys,
      openPrFindingSelectionDialog: (action, body) => openPrFindingSelectionDialog(action, body),
      openPrApproveDialog: () => {
        if (!isPrMode) {
          return { ok: false, error: 'Select a PR review to approve.' };
        }
        if (activeAction) {
          return { ok: false, error: 'Another PR review action is already in progress.' };
        }
        void handleOpenApproveDialog();
        return { ok: true };
      },
      setRecommendationOutcomeByKey,
      clearReview: async () => {
        if (isBrMode) {
          await handleDeleteBranchReview();
          return true;
        }
        if (isPrMode) {
          await handleDeletePrReview();
          return true;
        }
        return false;
      },
    }), [
      activeAction,
      changeset,
      handlePush,
      isReviewing,
      interactionLockReason,
      prReviewId,
      branchReviewId,
      workspaceReviewId,
      handleReviewNow,
      handleStopFixRun,
      isPrMode,
      isBrMode,
      handleOpenFixDialog,
      startFixRunForKeys,
      openPrFindingSelectionDialog,
      handleOpenApproveDialog,
      setRecommendationOutcomeByKey,
      handleDeleteBranchReview,
      handleDeletePrReview,
    ]);

    const hasData = isBrMode ? !!branchReview : !!changeset;

    const review = currentReview;
    const fixIssuesActionLabel = 'Fix Issues';
    const fixIssuesBusyLabel = 'Fixing…';
    const fixIssuesSupported = !isPrMode;
    const fixIssuesActionHandler = fixIssuesSupported ? handleOpenFixDialog : null;
    const fixIssuesActionEnabled = fixIssuesSupported && fixSelectionItems.length > 0;
    const fixIssuesActionActive = Boolean(activeFixRun?.isRunning || isStartingFixRun);
    const activeFixSelectionCount = activeFixRun?.selectedKeys.length || 0;
    const activeFixElapsedSeconds = activeFixRun?.startedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(activeFixRun.startedAt).getTime()) / 1000))
      : 0;
    const activeFixMetaLabel = activeFixRun?.isRunning
      ? [
          'Atlas fix run',
          `${activeFixSelectionCount} finding${activeFixSelectionCount === 1 ? '' : 's'}`,
          `${activeFixElapsedSeconds}s`,
        ].join(' · ')
      : null;
    const activeFixActivityLabel = activeFixRun?.isRunning
      ? (activeFixRun.activityLabel || 'Atlas is preparing a patch for the selected finding set…')
      : null;
    const activeFixRunningSteps = useMemo<RunningStepSpec[]>(() => ([
      { id: 'scope', label: 'Selecting findings', state: 'done' },
      { id: 'patch', label: 'Applying patch', state: 'active' },
      { id: 'inspect', label: 'Inspect changes', state: 'pending' },
      { id: 'verify', label: 'Verify review', state: 'pending' },
    ]), []);
    const activeFixLogTail = useMemo(() => {
      if (!activeFixRun?.isRunning) return [];
      return [
        `findings: ${activeFixSelectionCount || 0} selected`,
        activeFixActivityLabel || 'Atlas is preparing a patch for the selected finding set...',
      ].filter(Boolean);
    }, [activeFixActivityLabel, activeFixRun?.isRunning, activeFixSelectionCount]);
    const verification = isBrMode ? null : (verificationState || changeset?.verification);
    const branchReviewLifecycle = isBrMode ? (branchReview?.reviewLifecycle || null) : null;
    const changesetReviewLifecycle = !isBrMode ? ((changeset as any)?.reviewLifecycle || null) : null;
    const branchReviewStatus = isBrMode
      ? normalizeLifecycleStatusValue(
        branchReviewLifecycle?.status
          || branchReviewLifecycle?.sourceStatus
          || branchReview?.reviewStatus
          || 'none',
        'completed'
      )
      : 'completed';
    const changesetReviewStatus = !isBrMode
      ? normalizeLifecycleStatusValue(
        changesetReviewLifecycle?.status
          || changesetReviewLifecycle?.sourceStatus
          || changeset?.reviewStatus
          || 'none',
        'completed'
      )
      : 'completed';
    const branchLifecycleIsTerminal = branchReviewLifecycle?.isTerminal === true
      || TERMINAL_LIFECYCLE_STATUSES.has(branchReviewStatus);
    const branchLifecyclePhase = String(branchReviewLifecycle?.phase || '').toLowerCase();
    const branchProgressPhase = String(
      effectiveBranchReviewProgress?.phase
      || branchLifecyclePhase
      || ''
    ).toLowerCase();
    const branchLifecycleShowsQueued = branchLifecyclePhase === 'queued';
    const branchLifecycleShowsReviewing = isActiveReviewProgressPhase(branchLifecyclePhase) && !branchLifecycleShowsQueued;
    const branchLifecycleIsActive = branchReviewLifecycle?.isActive === true
      || isActiveLifecycleStatus(branchReviewStatus)
      || branchLifecycleShowsReviewing;
    const branchProgressShowsQueued = Boolean(
      isBrMode
      && effectiveBranchReviewProgress
      && branchProgressPhase === 'queued'
    );
    const branchProgressShowsReviewing = Boolean(
      isBrMode
      && effectiveBranchReviewProgress
      && isActiveReviewProgressPhase(branchProgressPhase)
    );
    const isQueuedRaw = branchReviewStatus === 'queued'
      || branchLifecycleShowsQueued
      || branchProgressShowsQueued;
    const isBackgroundReviewingRaw = branchReviewStatus === 'running'
      || branchReviewStatus === 'retrying'
      || (branchLifecycleIsActive && !branchLifecycleShowsQueued)
      || branchProgressShowsReviewing;
    const isChangesetQueued = !isBrMode && changesetReviewStatus === 'queued';
    const isChangesetReviewing = !isBrMode
      && (changesetReviewStatus === 'running' || changesetReviewStatus === 'retrying');
    const branchUpdatedAtCandidate = branchReviewLifecycle?.updatedAt || branchReview?.updatedAt || null;
    const branchUpdatedAtParsed = branchUpdatedAtCandidate ? Date.parse(branchUpdatedAtCandidate) : 0;
    const branchUpdatedAtMs = Number.isFinite(branchUpdatedAtParsed) ? branchUpdatedAtParsed : 0;
    const staleEvaluationTime = queueStatusCheckedAt || Date.now();
    const hasStaleAge = branchUpdatedAtMs > 0 && (staleEvaluationTime - branchUpdatedAtMs) > STALE_BACKGROUND_REVIEW_MS;
    const isBackgroundStateStale = isBrMode
      && (isQueuedRaw || isBackgroundReviewingRaw)
      && queueHasActiveBranchReview === false
      && hasStaleAge;
    const isQueued = isBrMode
      ? (isQueuedRaw && !isBackgroundStateStale)
      : isChangesetQueued;
    const isBackgroundReviewing = isBrMode
      ? (isBackgroundReviewingRaw && !isBackgroundStateStale)
      : isChangesetReviewing;
    const staleReviewError = isBackgroundStateStale
      ? (
        isBrMode && hasTopBannerReviewAction
          ? 'Review status looks stale (no active worker detected). Use "Run Review" in the top banner to retry.'
          : 'Review status looks stale (no active worker detected). Click "Run Review" to retry.'
      )
      : null;
    const csPollingTimeoutError = (!isBrMode && (isChangesetQueued || isChangesetReviewing) && csPollingTimedOut)
      ? 'Review is taking longer than expected (still waiting). Click "Run Review" to retry or wait a bit longer.'
      : null;
    const previousReviewSnapshotNote = (
      isBrMode
      && branchReviewStatus === 'failed'
      && review?.provider?.type
      && review?.provider?.model
    )
      ? ` Showing previous successful review from ${review.provider.type}/${review.provider.model}.`
      : '';
    const hasActiveBranchRun = isBrMode && (isQueued || isBackgroundReviewing);
    const showStickyProgressBanner = Boolean(
      activeFixRun?.isRunning
      || (hasActiveBranchRun && effectiveBranchReviewProgress)
      || queuedBranchReviewRun
    );
    const reviewWorkActive = Boolean(isReviewing || isQueued || isBackgroundReviewing);
    const previousReviewWorkActiveRef = useRef(reviewWorkActive);
    const previousBannerReviewStateRef = useRef<{
      isFixRunActive: boolean;
      hasVerificationPending: boolean;
    } | null>(null);
    const onBannerReviewStateChangeRef = useRef(onBannerReviewStateChange);

    useEffect(() => {
      onBannerReviewStateChangeRef.current = onBannerReviewStateChange;
    }, [onBannerReviewStateChange]);

    useEffect(() => {
      const nextState = {
        isFixRunActive: Boolean(activeFixRun?.isRunning),
        // Keep verification wiring dormant in the current UX.
        hasVerificationPending: false,
      };
      const previousState = previousBannerReviewStateRef.current;
      if (
        previousState
        && previousState.isFixRunActive === nextState.isFixRunActive
        && previousState.hasVerificationPending === nextState.hasVerificationPending
      ) {
        return;
      }
      previousBannerReviewStateRef.current = nextState;
      onBannerReviewStateChangeRef.current?.(nextState);
    }, [
      activeFixRun?.isRunning,
    ]);

    useEffect(() => () => {
      previousBannerReviewStateRef.current = null;
      onBannerReviewStateChangeRef.current?.({
        isFixRunActive: false,
        hasVerificationPending: false,
      });
    }, []);

    useEffect(() => {
      const previousReviewWorkActive = previousReviewWorkActiveRef.current;
      previousReviewWorkActiveRef.current = reviewWorkActive;
      if (!previousReviewWorkActive || reviewWorkActive) return;

      const reReviewingKeys = verificationPendingRecommendationKeys.filter((key) => (
        recommendationFixStatuses[key]?.status === 're_reviewing'
      ));
      if (reReviewingKeys.length === 0) return;

      updateRecommendationFixStatuses(reReviewingKeys, 'verification_pending');
      setActiveFixRun((prev) => {
        if (!prev || prev.isRunning) return prev;
        return {
          ...prev,
          statusLabel: 'Verification review complete. Resolve findings.',
          activityLabel: null,
          error: null,
        };
      });
    }, [
      reviewWorkActive,
      verificationPendingRecommendationKeys,
      recommendationFixStatuses,
      updateRecommendationFixStatuses,
    ]);
    const persistedBranchErrorMessage = (
      typeof (branchReviewLifecycle?.error || branchReview?.reviewError) === 'string'
      && String(branchReviewLifecycle?.error || branchReview?.reviewError).trim().length > 0
    )
      ? formatPersistedFailureMessage(String(branchReviewLifecycle?.error || branchReview?.reviewError).trim())
      : null;
    const persistedBranchReviewError = (
      isBrMode
      && !hasActiveBranchRun
      && branchReviewStatus === 'failed'
      && persistedBranchErrorMessage
    )
      ? `Review failed: ${persistedBranchErrorMessage}.${previousReviewSnapshotNote}`
      : null;
    const effectiveReviewError = reviewError
      || staleReviewError
      || csPollingTimeoutError
      || persistedBranchReviewError
      || (
        isBrMode
        && !hasActiveBranchRun
        && branchReviewStatus === 'failed'
        ? `Review timed out or failed. Try "Run Review" again.${previousReviewSnapshotNote}`
        : null
      )
      || null;
    const latestCommitSummary = (() => {
      if (!isBrMode || !branchReview || review) return null;
      const commits = Array.isArray((branchReview as any)?.commits) ? (branchReview as any).commits : [];
      const latestCommit = commits[0];
      const message = typeof latestCommit?.message === 'string' ? latestCommit.message.trim() : '';
      return message || null;
    })();
    const reviewSummaryText = typeof review?.summary === 'string' && review.summary.trim()
      ? review.summary.trim()
      : null;
    const reviewFallbackSummaryText = !reviewSummaryText
      ? (isBrMode
        ? (isPrMode
          ? (prBodyText || null)
          : (
            (branchReview?.fileCount || 0) === 0
              ? (isLastCommitFallbackBaseBranch(branchReview?.baseBranch)
                ? `No base branch detected. Atlas is reviewing the last commit on ${branchReview?.branchName || 'this branch'}. Create a separate branch for full branch-vs-base review.`
                : `No changed files on this branch yet. Atlas is tracking ${branchReview?.branchName || 'this branch'} against ${branchReview?.baseBranch || 'its base branch'} and will populate the diff automatically when commits land.`)
              : (latestCommitSummary || null)
          ))
        : (changeset ? [changeset.title, changeset.summary].filter(Boolean).join(' — ') : null))
      : null;
    const verdictSummaryText = reviewSummaryText || reviewFallbackSummaryText;
    useEffect(() => {
      setIsSummaryExpanded(false);
    }, [branchReviewId, workspaceReviewId, prReviewId]);
    const prParityGate = isPrMode
      ? (((branchReview as any)?.reviewParityGate && typeof (branchReview as any).reviewParityGate === 'object')
        ? (branchReview as any).reviewParityGate
        : null)
      : null;
    const prVerificationSummary = isPrMode
      ? (
        prParityGate?.verificationSummary
        || review?.verificationStatus?.summary
        || review?.verificationStatus?.lines?.find((line) => typeof line === 'string' && line.trim())
        || null
      )
      : null;
    const includeScopePatterns = parseScopePatterns(scopeIncludeText);
    const excludeScopePatterns = parseScopePatterns(scopeExcludeText);
    const includeScopeCount = includeScopePatterns.length;
    const excludeScopeCount = excludeScopePatterns.length;
    const scopeStatusLabel = buildScopeStatusLabel({
      includeCount: includeScopeCount,
      excludeCount: excludeScopeCount,
      applyGlobalIgnorePatterns: scopeApplyGlobalIgnorePatterns,
      globalIgnorePatternCount,
    });
    const baseCoverageStats = review
      ? getReviewCoverageStats(review, isBrMode ? branchReview?.fileCount : changeset?.riskFlags?.fileCount)
      : null;
    const totalFilesForProgress = effectiveBranchReviewProgress?.totalFiles || 0;
    const filesDoneForProgress = Math.min(effectiveBranchReviewProgress?.filesCompleted || 0, totalFilesForProgress || 0);
    const activeChunkFilesForProgress = effectiveBranchReviewProgress?.activeChunkFiles || 0;
    const computedProgressPercent = computeProgressPercent({
      phase: effectiveBranchReviewProgress?.phase,
      filesCompleted: filesDoneForProgress,
      totalFiles: totalFilesForProgress,
      currentChunk: effectiveBranchReviewProgress?.currentChunk,
      totalChunks: effectiveBranchReviewProgress?.totalChunks,
      activeChunkFiles: activeChunkFilesForProgress,
      isRunActive: isQueued || isBackgroundReviewing,
      isLifecycleTerminal: branchLifecycleIsTerminal,
    });
    const isRunActiveForProgress = Boolean(isQueued || isBackgroundReviewing);
    if (isRunActiveForProgress && !progressWasActiveRef.current) {
      progressPercentRef.current = 0;
    }
    progressWasActiveRef.current = isRunActiveForProgress;
    let progressPercent = computedProgressPercent;
    if (isRunActiveForProgress) {
      progressPercent = Math.max(progressPercentRef.current, computedProgressPercent);
    }
    progressPercentRef.current = progressPercent;
    const elapsedSecondsForProgress = effectiveBranchReviewProgress?.elapsedSeconds || 0;
    const splitDepthForProgress = effectiveBranchReviewProgress?.splitDepth || 0;
    const splitPartsForProgress = effectiveBranchReviewProgress?.splitParts || 0;
    const csReviewErrorMessage = !isBrMode
      ? (
        typeof (changesetReviewLifecycle?.error || (changeset as any)?.reviewError) === 'string'
          ? formatPersistedFailureMessage(String(changesetReviewLifecycle?.error || (changeset as any).reviewError))
          : null
      )
      : null;
    const isFailedChangesetReview = !isBrMode && changesetReviewStatus === 'failed';
    const failedChangesetDetail = csReviewErrorMessage || 'Review failed or timed out.';
    const actionableRecommendations = review
      ? review.recommendations.filter((rec) => rec.type !== 'praise')
      : [];
    const buildReviewAgentFindingAttachments = useCallback((rec: ReviewRecommendation): ReviewAgentAttachment[] => {
      const attachments: ReviewAgentAttachment[] = [];
      const recommendationKey = getRecommendationFingerprint(rec);
      if (recommendationKey) {
        attachments.push({
          type: 'finding',
          recommendationKey,
          findingId: rec.findingId,
        });
      }
      const sourceFile = getRecommendationSourceFile(rec);
      const sourceLine = getRecommendationPatchLine(rec) ?? getRecommendationSourceLine(rec);
      if (sourceFile && sourceLine) {
        attachments.push({
          type: 'line_range',
          path: sourceFile,
          startLine: sourceLine,
          endLine: sourceLine,
          side: 'RIGHT',
        });
      } else if (sourceFile) {
        attachments.push({ type: 'file', path: sourceFile });
      }
      return attachments;
    }, []);
    const askReviewAgentAboutFinding = useCallback((rec: ReviewRecommendation) => {
      openReviewAgent(buildReviewAgentFindingAttachments(rec), {
        prompt: 'Can you explain this finding and whether it is valid?',
      });
    }, [buildReviewAgentFindingAttachments, openReviewAgent]);
    const reviewAgentAttachments = useMemo<ReviewAgentAttachment[]>(() => {
      const next: ReviewAgentAttachment[] = [];
      const activePath = Array.isArray(activeFileFilter?.paths) && activeFileFilter.paths.length > 0
        ? activeFileFilter.paths[0]
        : null;
      if (activePath) {
        next.push({ type: 'file', path: activePath });
      }
      return next;
    }, [activeFileFilter?.paths]);
    const activeReviewAgentAttachments = useMemo<ReviewAgentAttachment[]>(() => {
      const seen = new Set<string>();
      return [...reviewAgentAttachments, ...reviewAgentExtraAttachments]
        .filter((attachment) => {
          const key = JSON.stringify(attachment);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 8);
    }, [reviewAgentAttachments, reviewAgentExtraAttachments]);
    const praiseRecommendations = review
      ? review.recommendations.filter((rec) => rec.type === 'praise')
      : [];
    const previousFindingRecommendations = review
      ? (review.previousFindings || []).filter((rec) => rec.type !== 'praise')
      : [];
    const visiblePreviousFindingRecommendations = previousFindingRecommendations.filter((rec) => {
      if (includeResolvedInActions) return true;
      return !getRecommendationResolutionFor(rec, recommendationResolutions);
    });
    const totalRecommendationCount = actionableRecommendations.length;
    const unresolvedRecommendationCount = actionableRecommendations
      .filter((rec) => !getRecommendationResolutionFor(rec, recommendationResolutions)).length;
    const unresolvedHighSeverityCount = actionableRecommendations
      .filter((rec) => !getRecommendationResolutionFor(rec, recommendationResolutions))
      .filter((rec) => rec.severity === 'high' || rec.severity === 'critical').length;
    const prReviewEligibility = isPrMode ? ((branchReview as unknown as PrReview | null)?.reviewActionEligibility || null) : null;
    const staleApproval = isPrMode ? isPrReviewStale(prReviewEligibility) : false;
    const branchReviewHeadMismatch = isBrMode
      && !isPrMode
      && isCompletedReviewStatusValue(branchReview?.reviewStatus)
      && !branchReviewCoversCurrentHead;
    const branchReviewMergeBaseMismatch = isBrMode
      && !isPrMode
      && isCompletedReviewStatusValue(branchReview?.reviewStatus)
      && Boolean(
        normalizeHeadSha(branchReview?.mergeBaseSha || null)
        && normalizeHeadSha(branchReview?.reviewMergeBaseSha || null)
        && normalizeHeadSha(branchReview?.mergeBaseSha || null) !== normalizeHeadSha(branchReview?.reviewMergeBaseSha || null)
      );
    const staleReviewSnapshot = staleApproval || branchReviewHeadMismatch || branchReviewMergeBaseMismatch;
    const addressedRecommendationCount = actionableRecommendations
      .filter((rec) => getRecommendationResolutionFor(rec, recommendationResolutions)?.state === 'addressed').length;
    const dismissedRecommendationCount = actionableRecommendations
      .filter((rec) => getRecommendationResolutionFor(rec, recommendationResolutions)?.state === 'dismissed').length;
    // Stale reviews show a dedicated "Review is stale" line with how
    // far the branch has drifted (new files / unreviewed commits since
    // the last completed review). Non-stale states stay null — the
    // verdict pill above already names the approval state, so we don't
    // repeat it.
    const approvalStateLabel = (() => {
      if (!staleReviewSnapshot) return null;
      const newFiles = Number((branchReview as { unreviewedFileCount?: number } | null)?.unreviewedFileCount) || 0;
      const newCommits = Number((branchReview as { unreviewedCommitCount?: number } | null)?.unreviewedCommitCount) || 0;
      const tail: string[] = [];
      if (newFiles > 0) tail.push(`${newFiles} new file${newFiles === 1 ? '' : 's'}`);
      if (newCommits > 0) tail.push(`${newCommits} unreviewed commit${newCommits === 1 ? '' : 's'} since last review`);
      if (tail.length > 0) return `Review is stale · ${tail.join(' · ')}`;
      if (branchSnapshotStaleMessage) return `Review is stale · ${branchSnapshotStaleMessage}`;
      return 'Review is stale';
    })();
    const approvalStateTone = staleReviewSnapshot
      ? 'warn'
      : unresolvedRecommendationCount === 0
        ? 'good'
        : unresolvedHighSeverityCount > 0
          ? 'warn'
          : 'info';
    const actionableOmittedCount = (isBrMode && !hasActiveBranchRun) ? omittedFileCount : 0;
    const actionableOmittedOnlyCount = (isBrMode && !hasActiveBranchRun) ? omittedOnlyCount : 0;
    const actionableFailedCount = (isBrMode && !hasActiveBranchRun) ? failedFileCount : 0;
    const actionableFailedCountUnlisted = (isBrMode && !hasActiveBranchRun) ? failedFileCountUnlisted : 0;
    const partialDeferredFiles = useMemo(() => {
      if (!isBrMode || hasActiveBranchRun) return [] as string[];
      const raw = reviewForActions?.stats?.partialDeferredFiles;
      if (!Array.isArray(raw)) return [];
      return raw.map((p) => String(p || '').trim()).filter(Boolean);
    }, [isBrMode, hasActiveBranchRun, reviewForActions]);
    const partialDeferredCount = partialDeferredFiles.length;
    const handleRunPartialOnDeferred = useCallback(async () => {
      if (!branchReviewId || partialDeferredFiles.length === 0) return;
      const nextChunkSize = Math.min(partialDeferredFiles.length, PARTIAL_MODE_MAX_FILES_HINT);
      const remainingAfter = Math.max(0, partialDeferredFiles.length - nextChunkSize);
      const message = remainingAfter > 0
        ? `${partialDeferredFiles.length} files were deferred. Atlas will review the top ${nextChunkSize} highest-risk now; ${remainingAfter} will remain for a follow-up partial run.`
        : `${partialDeferredFiles.length} file${partialDeferredFiles.length !== 1 ? 's were' : ' was'} deferred. Atlas will review ${partialDeferredFiles.length === 1 ? 'it' : 'them all'} in this run.`;
      const choice = await popup.choose<'partial' | 'cancel'>({
        title: 'Continue partial review',
        message,
        options: [
          { key: 'cancel', label: 'Cancel', tone: 'secondary' },
          { key: 'partial', label: 'Run next chunk', tone: 'primary' },
        ],
      });
      if (choice !== 'partial') return;
      setIsReviewing(true);
      setReviewError(null);
      try {
        await branchReviewApi.queueReview(projectId, branchReviewId, {
          partial: true,
          includePatterns: partialDeferredFiles,
          policySource: 'working_tree' as const,
        });
        const nowIso = new Date().toISOString();
        setQueueHasActiveBranchReview(true);
        setQueueStatusCheckedAt(Date.now());
        setBranchReview((prev) => prev ? {
          ...prev,
          reviewStatus: 'queued',
          reviewError: null,
          reviewLifecycle: buildOptimisticQueuedLifecycle(
            nowIso,
            prev.reviewLifecycle?.reviewedAt || prev.reviewedAt || null
          ),
          updatedAt: nowIso,
        } : prev);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : 'Failed to queue partial review';
        setReviewError(errMessage);
      } finally {
        setIsReviewing(false);
      }
    }, [branchReviewId, partialDeferredFiles, popup, projectId]);
    const coverageStats = useMemo(() => {
      if (!baseCoverageStats) return null;
      if (!isBrMode) return baseCoverageStats;
      if (hasActiveBranchRun) {
        const totalFiles = Math.max(
          0,
          Number(baseCoverageStats.totalFiles || branchReview?.fileCount || totalFilesForProgress || 0)
        );
        const analyzedFiles = Math.max(0, Math.min(totalFiles, filesDoneForProgress));
        const coverageLabel = totalFiles > 0
          ? `${analyzedFiles}/${totalFiles} files • re-review in progress`
          : 'Re-review in progress';
        return {
          ...baseCoverageStats,
          analyzedFiles,
          totalFiles,
          omittedFiles: 0,
          coverageLabel,
          focusedLabel: 'Re-review in progress',
        };
      }
      const totalFiles = Math.max(
        0,
        Number(baseCoverageStats.totalFiles || branchReview?.fileCount || branchReviewDiffPaths.length || 0)
      );
      const omittedFiles = Math.max(0, actionableOmittedCount);
      const analyzedFiles = totalFiles > 0
        ? Math.max(0, Math.min(totalFiles, totalFiles - omittedFiles))
        : baseCoverageStats.analyzedFiles;
      const coverageLabel = totalFiles > 0
        ? `${analyzedFiles}/${totalFiles} files • ${omittedFiles} omitted`
        : `${baseCoverageStats.analyzedFiles} files analyzed`;
      return {
        ...baseCoverageStats,
        analyzedFiles,
        totalFiles,
        omittedFiles,
        coverageLabel,
        focusedLabel: omittedFiles > 0 ? 'Focused deep analysis' : baseCoverageStats.focusedLabel,
      };
    }, [
      baseCoverageStats,
      isBrMode,
      hasActiveBranchRun,
      branchReview?.fileCount,
      branchReviewDiffPaths.length,
      totalFilesForProgress,
      filesDoneForProgress,
      actionableOmittedCount,
    ]);
    const prVerificationMetric = useMemo(() => {
      if (!isPrMode || !prVerificationSummary) return null;
      const overallStatus = String(review?.verificationStatus?.overallStatus || '').trim().toLowerCase();
      return {
        value: overallStatus === 'fail'
          ? 'Checks failing'
          : overallStatus === 'pass'
            ? 'Checks passing'
            : overallStatus === 'warn'
              ? 'Checks mixed'
              : 'Checks noted',
        detail: prVerificationSummary,
        tone: overallStatus === 'fail'
          ? 'critical'
          : overallStatus === 'warn'
            ? 'warn'
            : overallStatus === 'pass'
              ? 'good'
          : 'info',
      } as const;
    }, [isPrMode, prVerificationSummary, review?.verificationStatus?.overallStatus]);
    const reviewUsageDetails = useMemo(() => {
      if (!review) return null;
      const inputTokens = Math.max(0, Number(review.tokensUsed?.input || 0));
      const outputTokens = Math.max(0, Number(review.tokensUsed?.output || 0));
      const totalTokens = inputTokens + outputTokens;
      const providerLabel = review?.provider?.type && review?.provider?.model
        ? `${review.provider.type}/${review.provider.model}`
        : 'Unknown provider';
      const durationLabel = formatReviewDurationMs(review.stats?.reviewTotalDurationMs);
      return {
        tokensLabel: totalTokens.toLocaleString(),
        tokensDetail: `${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out`,
        costLabel: review.estimatedCost != null
          ? `$${review.estimatedCost.toFixed(4)}`
          : 'Unavailable',
        costDetail: providerLabel,
        durationLabel,
      };
    }, [review]);
    const focusRecommendationCard = useCallback((index: number) => {
      if (!Number.isFinite(index) || index < 0) return;

      setRisksOpen(true);
      setSelectedCandidateRecommendationKey(null);
      setSelectedRecommendationIndex(index);

      const scrollToCard = () => {
        const scope = panelRootRef.current || document;
        const el = scope.querySelector(`[data-review-rec-index="${index}"]`) as HTMLElement | null;
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return true;
      };

      if (scrollToCard()) return;
      window.requestAnimationFrame(() => {
        if (scrollToCard()) return;
        window.setTimeout(() => {
          scrollToCard();
        }, 60);
      });
    }, []);

    useEffect(() => {
      if (!review || totalRecommendationCount === 0) {
        setSelectedRecommendationIndex(0);
        return;
      }
      setSelectedRecommendationIndex((prev) => {
        if (!Number.isFinite(prev)) return 0;
        if (prev < 0) return 0;
        if (prev >= totalRecommendationCount) return totalRecommendationCount - 1;
        return prev;
      });
    }, [review?.reviewedAt, totalRecommendationCount]);

    const navigateToRecommendationTarget = useCallback((
      target: DiffNavigationTarget | null,
      rec?: ReviewRecommendation | null,
      options?: {
        detailsOnly?: boolean;
        detailsReason?: string;
        suppressNearestDiffToast?: boolean;
      },
    ) => {
      const targetPath = target
        ? (typeof target === 'string' ? target : target.filePath)
        : '';
      const focusLine = target && typeof target !== 'string' ? (target.line ?? null) : null;
      const nextFocusLine = Number.isFinite(Number(focusLine))
        ? Math.floor(Number(focusLine))
        : null;
      const shouldShowDetails = Boolean(options?.detailsOnly || !targetPath);
      // Ensure the filter points at the target file so the diff viewer
      // shows it (idempotent if already pointed there). The auto-filter
      // effect also sets this on selection change; setting it here avoids
      // a flicker between clicking the card and the effect running.
      if (onSelectFileFilter) {
        const filterPaths = activeFileFilter?.paths || [];
        const currentFocusLine = Number.isFinite(Number(activeFileFilter?.focusLine))
          ? Math.floor(Number(activeFileFilter?.focusLine))
          : null;
        const currentMode = activeFileFilter?.findingDisplayMode || 'diff';
        const nextMode = shouldShowDetails ? 'details' : 'diff';
        const currentFindingKey = activeFileFilter?.finding
          ? getRecommendationFingerprint(activeFileFilter.finding)
          : '';
        const nextFindingKey = rec ? getRecommendationFingerprint(rec) : currentFindingKey;
        if (
          filterPaths.length !== (targetPath ? 1 : 0)
          || (targetPath && filterPaths[0] !== targetPath)
          || currentFocusLine !== nextFocusLine
          || currentMode !== nextMode
          || currentFindingKey !== nextFindingKey
        ) {
          onSelectFileFilter({
            paths: targetPath ? [targetPath] : [],
            label: rec?.title || targetPath || 'Finding details',
            kind: 'finding',
            focusLine: nextFocusLine,
            finding: rec || activeFileFilter?.finding || null,
            findingDisplayMode: nextMode,
            findingDetailsReason: nextMode === 'details'
              ? (options?.detailsReason || 'This finding does not have a renderable diff anchor in the current file set.')
              : null,
          });
        }
      }
      if (shouldShowDetails || !target) return;
      // Defer scroll so the filter update has a chance to render the
      // target file before we try to scroll into it.
      window.requestAnimationFrame(() => {
        if (typeof target === 'string' || !options?.suppressNearestDiffToast) {
          onScrollToFile?.(target);
          return;
        }
        onScrollToFile?.({
          ...target,
          suppressNearestDiffToast: true,
        });
      });
    }, [activeFileFilter, onScrollToFile, onSelectFileFilter]);

    const navigateToGitHubConversationThread = useCallback((thread: GitHubPrReviewThread) => {
      const target = getGitHubConversationDiffTarget(thread);
      if (!target?.path) return;
      const nextFocusLine = Number.isFinite(Number(target.line))
        ? Math.floor(Number(target.line))
        : null;
      if (onSelectFileFilter) {
        onSelectFileFilter({
          paths: [target.path],
          label: nextFocusLine ? `${target.path}:${nextFocusLine}` : target.path,
          kind: 'github_conversation',
          focusLine: nextFocusLine,
          side: target.side,
        });
      }
    }, [onSelectFileFilter]);

    const jumpToRecommendationAtIndex = useCallback((
      index: number,
      options?: { suppressNearestDiffToast?: boolean },
    ) => {
      const targetReview = review;
      if (!targetReview || index < 0 || index >= targetReview.recommendations.length) return;
      const rec = targetReview.recommendations[index];
      const locationTarget = getRecommendationDiffNavigationTarget(rec)
        || getRecommendationSourceFile(rec)
        || null;
      navigateToRecommendationTarget(locationTarget, rec, options);
    }, [navigateToRecommendationTarget, review]);
    const jumpToRecommendationAtIndexRef = useRef(jumpToRecommendationAtIndex);
    const autoJumpReviewTokenRef = useRef<string | null>(null);
    useEffect(() => {
      jumpToRecommendationAtIndexRef.current = jumpToRecommendationAtIndex;
    }, [jumpToRecommendationAtIndex]);

    // On review load, auto-jump to the currently-selected finding's
    // location so the diff viewer focuses on the inline AI comment for
    // the selected finding (matching the design where the right pane
    // shows just one file at a time, scrolled to the relevant line).
    // RAF-deferred so TrustDiffViewer has a chance to register its
    // scroll-to-file ref. Subsequent selection changes via card click
    // are driven by RecommendationItem.onJump directly.
    const selectedIndexRef = useRef(selectedRecommendationIndex);
    useEffect(() => {
      selectedIndexRef.current = selectedRecommendationIndex;
    }, [selectedRecommendationIndex]);
    useEffect(() => {
      if (!review || totalRecommendationCount === 0) return;
      if (selectedCandidateRecommendationKey) return;
      if (activeFileFilter?.kind === 'finding' && activeFileFilter.findingDisplayMode === 'details') return;
      if (activeFileFilter?.kind === 'github_conversation') return;
      const token = [
        review.reviewedAt || '',
        recommendationFingerprintToken,
        selectedIndexRef.current,
      ].join('::');
      if (autoJumpReviewTokenRef.current === token) return;
      autoJumpReviewTokenRef.current = token;
      const handle = window.requestAnimationFrame(() => {
        jumpToRecommendationAtIndexRef.current(selectedIndexRef.current);
      });
      return () => window.cancelAnimationFrame(handle);
    }, [
      activeFileFilter?.findingDisplayMode,
      activeFileFilter?.kind,
      recommendationFingerprintToken,
      selectedCandidateRecommendationKey,
      totalRecommendationCount,
      review?.reviewedAt,
    ]);

    useEffect(() => {
      if (!review || totalRecommendationCount === 0) return;
      const handler = (event: KeyboardEvent) => {
        const activeElement = document.activeElement as HTMLElement | null;
        const tag = (activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (activeElement?.isContentEditable) return;
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;

        const navigateRecommendationByDelta = (delta: number) => {
          const currentIndex = selectedIndexRef.current;
          const nextIndex = Math.max(0, Math.min(totalRecommendationCount - 1, currentIndex + delta));
          if (nextIndex === currentIndex) return;
          selectedIndexRef.current = nextIndex;
          focusRecommendationCard(nextIndex);
          jumpToRecommendationAtIndex(nextIndex, { suppressNearestDiffToast: true });
        };

        if (event.key === 'j' || event.key === 'J' || event.key === 'k' || event.key === 'K') {
          event.preventDefault();
          const delta = event.key.toLowerCase() === 'j' ? -1 : 1;
          navigateRecommendationByDelta(delta);
          return;
        }

        const activeInsidePanel = panelRootRef.current?.contains(activeElement) || isPanelHovered;
        if (!activeInsidePanel) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          navigateRecommendationByDelta(event.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        const isInteractiveControl = Boolean(
          activeElement?.closest(
            'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="switch"]'
          )
        );
        if (isInteractiveControl) return;

        if (event.key === 'Enter') {
          event.preventDefault();
          jumpToRecommendationAtIndex(selectedRecommendationIndex);
          return;
        }
        if (event.key === 'a' || event.key === 'A') {
          event.preventDefault();
          const rec = review.recommendations[selectedIndexRef.current];
          if (!rec) return;
          const resolution = getRecommendationResolutionFor(rec, recommendationResolutions);
          if (resolution?.state === 'addressed') {
            clearRecommendationResolution(rec);
          } else {
            setRecommendationResolution(rec, 'addressed', resolution?.note);
          }
          return;
        }
        if (event.key === 'd' || event.key === 'D') {
          event.preventDefault();
          const rec = review.recommendations[selectedIndexRef.current];
          if (!rec) return;
          const resolution = getRecommendationResolutionFor(rec, recommendationResolutions);
          if (resolution?.state === 'dismissed') {
            clearRecommendationResolution(rec);
          } else {
            setRecommendationResolution(rec, 'dismissed', resolution?.note);
          }
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [
      review,
      totalRecommendationCount,
      selectedRecommendationIndex,
      isPanelHovered,
      focusRecommendationCard,
      jumpToRecommendationAtIndex,
      recommendationResolutions,
      clearRecommendationResolution,
      setRecommendationResolution,
    ]);

    // ── Loading / empty / error states ──────────────────────────────
    // NOTE: These must be placed AFTER all hook calls to avoid the
    // "Rendered more hooks than during the previous render" error.

    if (isLoading) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          fontFamily: 'var(--font-sans)',
          padding: 'var(--space-3)',
          gap: 'var(--space-3)',
        }}>
          {/* Skeleton verdict card */}
          <div style={{
            padding: 'var(--space-3)',
            background: 'var(--bg-overlay)',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
              <div style={{
                width: 60, height: 20, borderRadius: 'var(--radius-full)',
                background: 'var(--bg-hover)', animation: 'skeleton-pulse 1.5s ease-in-out infinite',
              }} />
              <div style={{
                width: 80, height: 12, borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-hover)', animation: 'skeleton-pulse 1.5s ease-in-out infinite',
              }} />
            </div>
            <div style={{
              width: '100%', height: 12, borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-hover)', animation: 'skeleton-pulse 1.5s ease-in-out infinite',
              marginBottom: 'var(--space-2)',
            }} />
            <div style={{
              width: '70%', height: 12, borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-hover)', animation: 'skeleton-pulse 1.5s ease-in-out infinite',
            }} />
          </div>
          {/* Skeleton blocks */}
          {[0, 1, 2].map((i) => (
            <div key={i} style={{
              padding: 'var(--space-3)',
              background: 'var(--bg-overlay)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{
                width: '50%', height: 12, borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-hover)', animation: 'skeleton-pulse 1.5s ease-in-out infinite',
                marginBottom: 'var(--space-2)',
              }} />
              <div style={{
                width: '90%', height: 10, borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-hover)', animation: 'skeleton-pulse 1.5s ease-in-out infinite',
              }} />
            </div>
          ))}
        </div>
      );
    }

    if (loadError || !hasData) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          fontFamily: 'var(--font-sans)',
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 'var(--space-2)' }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
            {loadError || 'No data available'}
          </p>
          <button
            type="button"
            onClick={loadData}
            style={{
              padding: 'var(--space-1) var(--space-3)',
              fontSize: 'var(--text-xs)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--accent-blue)',
              background: 'transparent',
              border: '1px solid var(--accent-blue)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    // Phase 07 / Task 1: the legacy action-bar handlers below are still
    // computed to keep the state effects around them intact, but their
    // consumer UIs (ShipItBar / BranchReviewActionBar / PrReviewActionBar)
    // were retired. The next task deletes this panel, so we only need to
    // keep TypeScript from flagging them as unused here.
    void handleDeploy; void handleRollback;
    void handleCopyPrompt; void handleCopyGitHubComment; void handleCopyMarkdown; void handleDownloadMarkdown;
    void handleOpenOnGitHub; void handleOpenApproveDialog;
    void handleOpenPrCommentDialog; void handleOpenPrRequestChangesDialog;
    void handleDeleteBranchReview; void handleDeletePrReview;
    void fixIssuesActionHandler; void fixIssuesActionEnabled; void fixIssuesActionActive;
    void fixIssuesActionLabel; void fixIssuesBusyLabel;
    void actionError; void actionSuccess; void confirmingRollback;
    void showBranchReviewDeleteAction; void showPrReviewDeleteAction;
    void prReviewSubmission;

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'var(--font-sans)',
        position: 'relative',
      }}
      ref={panelRootRef}
      onMouseEnter={() => setIsPanelHovered(true)}
      onMouseLeave={() => setIsPanelHovered(false)}
      >
        {/* Scrollable content */}
        <div style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: 'var(--space-3)',
          paddingBottom: 'calc(var(--space-3) + 40px)',
          scrollPaddingBottom: 40,
        }}>
          {/* Review section */}
          {review ? (
            <>
              {showStickyProgressBanner && (
                <div
                  style={{
                    position: 'sticky',
                    top: 'calc(var(--space-3) * -1)',
                    zIndex: 8,
                    margin: 'calc(var(--space-3) * -1) calc(var(--space-3) * -1) var(--space-2)',
                    padding: 'var(--space-3) var(--space-3) 0',
                    background: 'linear-gradient(180deg, var(--review-panel-bg) 0%, var(--review-panel-bg) 88%, rgba(10, 15, 28, 0) 100%)',
                    backdropFilter: 'blur(10px)',
                  }}
                >
                  {activeFixRun?.isRunning && (
                    <RunningReviewStrip
                      steps={activeFixRunningSteps}
                      currentStep={activeFixActivityLabel}
                      progress={{
                        phase: 'agentic_tool_use',
                        agentName: 'Atlas',
                        agenticToolSummary: activeFixActivityLabel,
                        filesCompleted: 0,
                        totalFiles: activeFixSelectionCount,
                        currentChunk: 1,
                        totalChunks: 1,
                        elapsedSeconds: activeFixElapsedSeconds,
                      }}
                      logTail={activeFixLogTail}
                      elapsedLabel={`${activeFixElapsedSeconds}s`}
                      metaLabel={activeFixMetaLabel}
                    />
                  )}

                  {/* Active run progress (show first, above previous snapshot content) */}
                  {(isQueued || isBackgroundReviewing) && effectiveBranchReviewProgress && (
                    <ProgressPill
                      currentChunk={effectiveBranchReviewProgress.currentChunk}
                      totalChunks={effectiveBranchReviewProgress.totalChunks}
                      filesCompleted={filesDoneForProgress}
                      totalFiles={totalFilesForProgress}
                      progressPercent={progressPercent}
                      phase={effectiveBranchReviewProgress.phase}
                      activeChunkFiles={activeChunkFilesForProgress}
                      elapsedSeconds={elapsedSecondsForProgress}
                      splitDepth={splitDepthForProgress}
                      splitParts={splitPartsForProgress}
                      agenticToolSummary={effectiveBranchReviewProgress?.agenticToolSummary || null}
                      agentName={progressDisplayAgentName}
                      diffScopeMode={effectiveBranchReviewProgress?.diffScopeMode ?? null}
                      diffScopeCommitCount={effectiveBranchReviewProgress?.diffScopeCommitCount || 0}
                      diffBaseSha={effectiveBranchReviewProgress?.diffBaseSha || null}
                      diffHeadSha={effectiveBranchReviewProgress?.diffHeadSha || null}
                      prRequestedMode={effectiveBranchReviewProgress?.prRequestedMode || null}
                      prEffectiveMode={effectiveBranchReviewProgress?.prEffectiveMode || null}
                      prPipelineMode={effectiveBranchReviewProgress?.prPipelineMode || null}
                      totalPrFiles={effectiveBranchReviewProgress?.totalPrFiles || 0}
                      effectiveReviewFiles={effectiveBranchReviewProgress?.effectiveReviewFiles || 0}
                      flushTop
                    />
                  )}
                  {queuedBranchReviewRun && (
                    <div style={{ marginTop: (isQueued || isBackgroundReviewing) && effectiveBranchReviewProgress ? 8 : 0 }}>
                      <QueuedReviewPill
                        position={queuedBranchReviewRun.position ?? null}
                        detail="Will start after the current review finishes"
                        onCancel={queuedBranchReviewRun.queueId
                          ? () => onCancelQueuedBranchReview?.(queuedBranchReviewRun.queueId!)
                          : undefined}
                        cancelDisabled={queuedBranchReviewCancelDisabled || !queuedBranchReviewRun.queueId}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Last-commit fallback notice */}
              {isBrMode && isLastCommitFallbackBaseBranch(branchReview?.baseBranch) && (
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--space-2)',
                  marginBottom: 'var(--space-2)',
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--chip-info-border)',
                  background: 'var(--chip-info-bg)',
                  fontSize: 10,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.45,
                }}>
                  <span style={{ color: 'var(--accent-blue)', fontWeight: 600, flexShrink: 0 }}>Last commit only</span>
                  <span>No base branch detected — reviewing the most recent commit. For full branch review, create a feature branch from main.</span>
                </div>
              )}

              {/* Layer 1: Verdict Card */}
              <VerdictCard
                review={review}
                verification={verification}
                contextFileCount={isBrMode ? branchReview?.fileCount : changeset?.riskFlags?.fileCount}
                coverageStats={coverageStats}
                summaryText={verdictSummaryText}
                summaryExpanded={isSummaryExpanded}
                onToggleSummary={verdictSummaryText ? () => setIsSummaryExpanded((prev) => !prev) : undefined}
                addressedFindingCount={addressedRecommendationCount}
                dismissedFindingCount={dismissedRecommendationCount}
                approvalStateLabel={approvalStateLabel}
                approvalStateTone={approvalStateTone}
                detailsOpen={reviewDetailsOpen}
                onToggleDetails={() => setReviewDetailsOpen((prev) => !prev)}
                detailsContent={(reviewUsageDetails || prVerificationMetric) ? (
                  <div style={{ display: 'grid', gap: 6, fontSize: 10 }}>
                    {reviewUsageDetails && (
                      <>
                        <div style={{ color: 'var(--text-secondary)' }}>
                          Tokens: {reviewUsageDetails.tokensLabel}{' '}
                          <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
                            ({reviewUsageDetails.tokensDetail})
                          </span>
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                          Estimated cost: {reviewUsageDetails.costLabel}{' '}
                          <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
                            ({reviewUsageDetails.costDetail})
                          </span>
                        </div>
                        {reviewUsageDetails.durationLabel && (
                          <div style={{ color: 'var(--text-secondary)' }}>
                            Duration: {reviewUsageDetails.durationLabel}
                          </div>
                        )}
                      </>
                    )}
                    {prVerificationMetric && (
                      <div style={{ color: 'var(--text-secondary)' }}>
                        Checks: {prVerificationMetric.value}{' '}
                        <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
                          ({prVerificationMetric.detail})
                        </span>
                      </div>
                    )}
                  </div>
                ) : null}
                scopeStatusLabel={isBrMode ? scopeStatusLabel : null}
                hideRoutingMetadata={isBrMode && hasActiveBranchRun}
              />
              {effectiveReviewError && (
                <div style={{
                  marginTop: 'calc(var(--space-2) * -1)',
                  marginBottom: 'var(--space-3)',
                  fontSize: 10,
                  color: 'var(--accent-red)',
                }}>
                  {effectiveReviewError}
                </div>
              )}
              {isBrMode && reviewTier && (
                !hasActiveBranchRun ? (
                <ReviewTierNotice
                  tier={reviewTier}
                  failedFileCount={actionableFailedCount}
                  failedFileCountUnlisted={actionableFailedCountUnlisted}
                  omittedOnlyCount={actionableOmittedOnlyCount}
                  totalFollowUpCount={actionableOmittedCount}
                  deferredFileCount={partialDeferredCount}
                  onRunPartialOnDeferred={partialDeferredCount > 0 ? handleRunPartialOnDeferred : undefined}
                />
                ) : null
              )}

              {!isBrMode && (isQueued || isBackgroundReviewing) && (
                <div style={{ marginBottom: 'var(--space-3)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <button
                    type="button"
                    onClick={handleStopReview}
                    style={{
                      padding: '2px var(--space-2)',
                      fontSize: 10,
                      fontFamily: 'var(--font-sans)',
                      fontWeight: 500,
                      color: 'var(--accent-red)',
                      background: 'transparent',
                      border: '1px solid var(--accent-red)',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                    }}
                  >
                    Stop Review
                  </button>
                </div>
              )}

              {/* Layer 3: Findings */}
              <CollapsibleSection
                title="Findings"
                isOpen={risksOpen}
                onToggle={() => setRisksOpen(!risksOpen)}
                badge={actionableRecommendations.length}
                headerActions={totalRecommendationCount > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      Open: {unresolvedRecommendationCount} · Addressed: {addressedRecommendationCount} · Dismissed: {dismissedRecommendationCount}
                    </span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', cursor: 'pointer', userSelect: 'none', fontSize: 10, color: 'var(--text-secondary)' }}>
                      <input
                        type="checkbox"
                        checked={!includeResolvedInActions}
                        onChange={() => setIncludeResolvedInActions((prev) => !prev)}
                        style={{ margin: 0 }}
                      />
                      <span>Open only</span>
                    </label>
                  </div>
                ) : null}
              >
                <RisksSection
                  review={review}
                  riskFlags={changeset?.riskFlags}
                  includeResolved={includeResolvedInActions}
                  expandedRecs={expandedRecs}
                  selectedRecommendationIndex={selectedRecommendationIndex}
                  recommendationResolutions={recommendationResolutions}
                  recommendationFixStatuses={recommendationFixStatuses}
                  recommendationNotes={recommendationNotes}
                  canManageNotes={Boolean(recommendationNoteStorageKey)}
                  onSetRecommendationResolution={setRecommendationResolution}
                  onClearRecommendationResolution={clearRecommendationResolution}
                  onEditRecommendationNote={handleEditRecommendationNote}
                  onClearRecommendationNote={handleClearRecommendationNote}
                  onAskAgent={askReviewAgentAboutFinding}
                  onSelectRecommendation={(index) => {
                    setSelectedCandidateRecommendationKey(null);
                    setSelectedRecommendationIndex(index);
                  }}
                  onJumpToRecommendation={(_index, target, rec) => {
                    navigateToRecommendationTarget(target, rec);
                  }}
                  onToggleRec={(i) => {
                    setExpandedRecs(prev => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    });
                  }}
                />
              </CollapsibleSection>

              {isPrMode && (
                <GitHubConversationsSection
                  conversations={prConversations}
                  isLoading={isPrConversationsLoading}
                  isSyncing={isPrConversationsSyncing}
                  error={prConversationsError}
                  prAuthorLogin={(branchReview as unknown as PrReview | null)?.authorLogin || null}
                  onRefresh={() => {
                    void loadPrConversations({ sync: true });
                  }}
                  onOpenThread={navigateToGitHubConversationThread}
                  onAskAgent={openReviewAgent}
                  onReplyThread={handleReplyToGitHubConversation}
                  onSetThreadResolved={handleSetGitHubConversationResolved}
                  onUpdateComment={handleUpdateGitHubConversationComment}
                  onDeleteComment={handleDeleteGitHubConversationComment}
                  onConfirmDeleteComment={handleConfirmDeleteGitHubConversationComment}
                  onReplyIssueComment={handleReplyToGitHubIssueComment}
                  onUpdateIssueComment={handleUpdateGitHubIssueComment}
                  onDeleteIssueComment={handleDeleteGitHubIssueComment}
                  onConfirmDeleteIssueComment={handleConfirmDeleteGitHubIssueComment}
                  busyThreadId={prConversationActionThreadId}
                  busyCommentId={prConversationActionCommentId}
                  busyIssueCommentId={prConversationActionIssueCommentId}
                />
              )}

              {previousFindingRecommendations.length > 0 && (
                <CollapsibleSection
                  title="Previous unresolved findings"
                  isOpen={previousFindingsOpen}
                  onToggle={() => setPreviousFindingsOpen(!previousFindingsOpen)}
                  badge={visiblePreviousFindingRecommendations.length}
                  headerActions={(
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      From earlier runs on this branch
                    </span>
                  )}
                >
                  <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                    <div style={{
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.45,
                    }}>
                      These findings were not repeated in the latest review and have no persisted outcome yet.
                    </div>
                    {visiblePreviousFindingRecommendations.map((rec, previousIndex) => {
                      const recommendationKey = getRecommendationFingerprint(rec);
                      const resolution = getRecommendationResolutionFor(rec, recommendationResolutions);
                      return (
                        <RecommendationItem
                          key={recommendationKey || previousIndex}
                          index={previousIndex}
                          rec={rec}
                          resolution={resolution}
                          fixStatus={null}
                          verificationState={null}
                          note={recommendationNotes[recommendationKey] || null}
                          canManageNote={Boolean(recommendationNoteStorageKey) && rec.type === 'issue'}
                          isExpanded={expandedPreviousRecs.has(recommendationKey)}
                          isSelected={
                            activeFileFilter?.kind === 'finding'
                            && activeFileFilter.findingDisplayMode === 'details'
                            && Boolean(activeFileFilter.finding)
                            && getRecommendationFingerprint(activeFileFilter.finding as ReviewRecommendation) === recommendationKey
                          }
                          onSetResolution={setRecommendationResolution}
                          onClearResolution={clearRecommendationResolution}
                          onEditNote={handleEditRecommendationNote}
                          onClearNote={handleClearRecommendationNote}
                          onAskAgent={askReviewAgentAboutFinding}
                          onSelect={() => navigateToRecommendationTarget(
                            getRecommendationDiffNavigationTarget(rec) || getRecommendationSourceFile(rec) || null,
                            rec,
                            {
                              detailsOnly: true,
                              detailsReason: 'This finding is from an earlier review snapshot, so its original diff context may no longer exist in the current file set.',
                            }
                          )}
                          onJump={(target) => navigateToRecommendationTarget(target, rec, {
                            detailsOnly: true,
                            detailsReason: 'This finding is from an earlier review snapshot, so its original diff context may no longer exist in the current file set.',
                          })}
                          onToggle={() => {
                            setExpandedPreviousRecs(prev => {
                              const next = new Set(prev);
                              if (next.has(recommendationKey)) next.delete(recommendationKey); else next.add(recommendationKey);
                              return next;
                            });
                          }}
                        />
                      );
                    })}
                  </div>
                </CollapsibleSection>
              )}

              {/* Section R Phase B-6: candidate findings (lower-confidence,
                  agent surfaced but didn't fully verify). Rendered before
                  praises because they're actionable concerns the user
                  should consider, just at a lower confidence than recs.
                  Open by default — burying them recreates the silent-drop
                  failure mode B-6 was designed to fix. */}
              {Array.isArray(review.candidateFindings) && review.candidateFindings.length > 0 && (() => {
                // Mirror the Open-only filter applied to the main Findings list:
                // hide candidates with a persisted addressed/dismissed outcome
                // when includeResolvedInActions is false. Without this, dismissed
                // candidates kept showing alongside the "No unresolved recommendations"
                // empty state in the Findings section above.
                const visibleCandidateFindings = includeResolvedInActions
                  ? review.candidateFindings
                  : review.candidateFindings.filter(
                      (rec) => !getRecommendationResolutionFor(rec, recommendationResolutions)
                    );
                return (
                <CollapsibleSection
                  title="Candidate findings"
                  isOpen={candidateFindingsOpen}
                  onToggle={() => setCandidateFindingsOpen(!candidateFindingsOpen)}
                  badge={review.candidateFindings.length}
                  headerActions={(
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      Need verification
                    </span>
                  )}
                >
                  <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                    <div style={{
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.45,
                    }}>
                      The reviewer flagged these as plausible concerns grounded in changed code, but did not fully verify them. Treat them as leads to investigate — they may be real bugs, or the reviewer may have misread the diff.
                    </div>
                    {visibleCandidateFindings.length === 0 && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', padding: 'var(--space-2) 0' }}>
                        No unresolved candidate findings
                      </div>
                    )}
                    {visibleCandidateFindings.map((rec, candidateIndex) => {
                      const recommendationKey = getRecommendationFingerprint(rec) || `candidate-${candidateIndex}`;
                      const candidateDiffTarget = getRecommendationPatchLine(rec) != null
                        ? getRecommendationDiffNavigationTarget(rec)
                        : null;
                      const candidateDetailsReason = 'This is a candidate finding the reviewer did not fully verify; no renderable patch anchor was found in the current diff.';
                      // Resolve from the same recommendationResolutions store
                      // recommendations and previous findings use, so a
                      // persisted outcome on a candidate flows back into
                      // isAddressed/isDismissed inside RecommendationItem
                      // instead of the card looking unresolved forever.
                      const resolution = getRecommendationResolutionFor(rec, recommendationResolutions);
                      return (
                        <RecommendationItem
                          key={recommendationKey}
                          index={candidateIndex}
                          rec={rec}
                          resolution={resolution}
                          fixStatus={null}
                          verificationState={null}
                          note={recommendationNotes[recommendationKey] || null}
                          canManageNote={false}
                          isExpanded={expandedCandidateRecs.has(recommendationKey)}
                          isSelected={selectedCandidateRecommendationKey === recommendationKey}
                          onSetResolution={setRecommendationResolution}
                          onClearResolution={clearRecommendationResolution}
                          onAskAgent={askReviewAgentAboutFinding}
                          onSelect={() => {
                            setSelectedCandidateRecommendationKey(recommendationKey);
                            // RecommendationItem only fires onJump when the rec has a
                            // resolvable source file or patch anchor. For ungrounded
                            // candidates (no file, no line) we still want the click to
                            // open the snapshot/details pane on the right.
                            if (!getRecommendationDiffNavigationTarget(rec)) {
                              navigateToRecommendationTarget(null, rec, {
                                detailsOnly: true,
                                detailsReason: candidateDetailsReason,
                              });
                            }
                          }}
                          onJump={() => navigateToRecommendationTarget(
                            candidateDiffTarget,
                            rec,
                            candidateDiffTarget
                              ? undefined
                              : {
                                  detailsOnly: true,
                                  detailsReason: candidateDetailsReason,
                                }
                          )}
                          onToggle={() => {
                            setExpandedCandidateRecs(prev => {
                              const next = new Set(prev);
                              if (next.has(recommendationKey)) next.delete(recommendationKey); else next.add(recommendationKey);
                              return next;
                            });
                          }}
                        />
                      );
                    })}
                  </div>
                </CollapsibleSection>
                );
              })()}

              {/* Praises (separate from actionable findings) */}
              {praiseRecommendations.length > 0 && (
                <CollapsibleSection
                  title="Praises"
                  isOpen={praisesOpen}
                  onToggle={() => setPraisesOpen(!praisesOpen)}
                  badge={praiseRecommendations.length}
                >
                  <div>
                    {praiseRecommendations.map((rec) => {
                      const originalIndex = review.recommendations.indexOf(rec);
                      return (
                        <RecommendationItem
                          key={originalIndex}
                          index={originalIndex}
                          rec={rec}
                          resolution={null}
                          isExpanded={expandedRecs.has(originalIndex)}
                          isSelected={selectedRecommendationIndex === originalIndex}
                          onSetResolution={setRecommendationResolution}
                          onClearResolution={clearRecommendationResolution}
                          note={null}
                          onAskAgent={askReviewAgentAboutFinding}
                          onSelect={() => setSelectedRecommendationIndex(originalIndex)}
                          onJump={(target) => navigateToRecommendationTarget(target, rec)}
                          onToggle={() => {
                            setExpandedRecs(prev => {
                              const next = new Set(prev);
                              if (next.has(originalIndex)) next.delete(originalIndex); else next.add(originalIndex);
                              return next;
                            });
                          }}
                        />
                      );
                    })}
                  </div>
                </CollapsibleSection>
              )}

            </>
          ) : (
            <>
              <NoReviewSection
                isReviewing={isReviewing || isBackgroundReviewing}
                isQueued={isQueued}
                onReviewNow={() => handleReviewNow(false)}
                onStopReview={handleStopReview}
                showReviewButton={!isBrMode || !hasTopBannerReviewAction}
                idleHint={isBrMode && hasTopBannerReviewAction ? 'Use Run Review in the top banner.' : null}
                error={effectiveReviewError}
                isFailedReview={isFailedChangesetReview}
                failedReviewDetail={failedChangesetDetail}
                isDismissingFailedReview={isDismissingFailedReview}
                onRetryFailedReview={() => handleReviewNow(true)}
                onDismissFailedReview={handleDismissFailedReview}
                progress={idleSectionProgress}
                runActionDisabled={Boolean(interactionLockReason)}
                runActionDisabledReason={interactionLockReason}
              />
              {isPrMode && (
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <GitHubConversationsSection
                    conversations={prConversations}
                    isLoading={isPrConversationsLoading}
                    isSyncing={isPrConversationsSyncing}
                    error={prConversationsError}
                    prAuthorLogin={(branchReview as unknown as PrReview | null)?.authorLogin || null}
                    onRefresh={() => {
                      void loadPrConversations({ sync: true });
                    }}
                    onOpenThread={navigateToGitHubConversationThread}
                    onAskAgent={openReviewAgent}
                    onReplyThread={handleReplyToGitHubConversation}
                    onSetThreadResolved={handleSetGitHubConversationResolved}
                    onUpdateComment={handleUpdateGitHubConversationComment}
                    onDeleteComment={handleDeleteGitHubConversationComment}
                    onConfirmDeleteComment={handleConfirmDeleteGitHubConversationComment}
                    onReplyIssueComment={handleReplyToGitHubIssueComment}
                    onUpdateIssueComment={handleUpdateGitHubIssueComment}
                    onDeleteIssueComment={handleDeleteGitHubIssueComment}
                    onConfirmDeleteIssueComment={handleConfirmDeleteGitHubIssueComment}
                    busyThreadId={prConversationActionThreadId}
                    busyCommentId={prConversationActionCommentId}
                    busyIssueCommentId={prConversationActionIssueCommentId}
                  />
                </div>
              )}
            </>
          )}

          {/* Verification section (CS only) */}
          {!isBrMode && (
            <VerificationSection
              verification={verification}
              verifyConfig={verifyConfig}
              isRunningChecks={isRunningChecks}
              verifyError={verifyError}
              expandedLogs={expandedLogs}
              onRunChecks={handleRunChecks}
              onToggleLog={(checkName) => {
                setExpandedLogs(prev => {
                  const next = new Set(prev);
                  if (next.has(checkName)) next.delete(checkName); else next.add(checkName);
                  return next;
                });
              }}
            />
          )}
        </div>

        {/*
          Phase 07 / Task 1: ShipItBar + BranchReviewActionBar +
          PrReviewActionBar were retired here. Submit / approve / request-
          changes now flow through `ReviewShellTopBar`'s SubmitPopover
          (wired in `TrustReviewView`). This panel itself is slated for
          deletion in Phase 07 / Task 2 (dispatcher rewrite). No bottom
          chrome is rendered here now; any residual fix-issues /
          fix-runs control surfaces will be relocated as part of task 2.
        */}

        {!onOpenReviewAgent && (
          <ReviewAgentDrawer
            isOpen={isReviewAgentOpen}
            scope={reviewAgentScope}
            attachments={activeReviewAgentAttachments}
            draftRequest={reviewAgentDraftRequest}
            onClose={() => {
              setIsReviewAgentOpen(false);
              setReviewAgentDraftRequest(null);
            }}
            onFixFindings={(recommendationKeys) => startFixRunForKeys(recommendationKeys)}
            onSetOutcome={(recommendationKey, status, note) => {
              const result = setRecommendationOutcomeByKey(recommendationKey, status, note);
              if (!result.ok) {
                setActionError(result.error);
                return false;
              }
              return true;
            }}
            onPublishPrReview={(action, body) => {
              if (action === 'approve') {
                if (!isPrMode) return { ok: false, error: 'Select a PR review to approve.' };
                if (activeAction) return { ok: false, error: 'Another PR review action is already in progress.' };
                void handleOpenApproveDialog();
                return { ok: true };
              }
              return openPrFindingSelectionDialog(action, body);
            }}
          />
        )}

        <FixIssueSelectionDialog
          isOpen={isFixDialogOpen}
          items={fixDialogItems}
          selectedKeys={selectedFixKeys}
          isSubmitting={isStartingFixRun}
          onToggle={handleToggleFixSelection}
          onToggleAll={handleToggleAllFixSelections}
          onCancel={() => {
            if (!isStartingFixRun) {
              setIsFixDialogOpen(false);
            }
          }}
          onConfirm={handleStartFixRun}
        />

        {isPrMode && (
          <PrCommentSelectionDialog
            isOpen={isPrCommentDialogOpen}
            action={prCommentDialogAction}
            items={prCommentDialogItems}
            selectedKeys={selectedPrCommentKeys}
            isSubmitting={activeAction === 'comment' || activeAction === 'request_changes'}
            onToggle={handleTogglePrCommentKey}
            onCancel={() => {
              if (activeAction === 'comment' || activeAction === 'request_changes') return;
              setIsPrCommentDialogOpen(false);
              setPrCommentDialogAction('comment');
              setPrCommentDialogBody(null);
              setPrCommentDialogItems([]);
            }}
            onConfirm={handleConfirmPrCommentDialog}
          />
        )}

      </div>
    );
  }
);

export default TrustReviewPanel;
