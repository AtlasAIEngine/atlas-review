// Project types
export interface ProjectGitHubMetadata {
  repoId?: number | null;
  repoFullName?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  installationId?: number | null;
  cloneUrl?: string | null;
  defaultBranch?: string | null;
  lastSyncSha?: string | null;
  lastSyncAt?: string | null;
  webhookId?: number | null;
  syncEnabled?: boolean;
  syncStatus?: string | null;
}

export interface Project {
  id: string;
  sessionId: string;
  name: string;
  description?: string;
  path?: string | null;
  framework?: string;
  language?: string;
  hasMemory: boolean;
  memorySize?: number;
  status: 'active' | 'archived' | 'deleted';
  source?: 'builder' | 'local' | 'github';
  baseBranchDisplay?: string | null;
  baseBranchRef?: string | null;
  github?: ProjectGitHubMetadata | null;
  hasGitHubIntegration?: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessed?: string;
  // Card metadata for HomePage
  lastModified?: string;
  deploymentUrl?: string | null;
  deploymentStatus?: 'deployed' | 'never';
}

// Build types
export interface Build {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  buildLogs?: string;
  errorMessage?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
}

// Preview types
export interface Preview {
  id: string;
  projectId: string;
  containerId: string;
  containerName: string;
  host: string;
  port: number;
  status: 'starting' | 'healthy' | 'unhealthy' | 'stopped' | 'failed';
  url: string;
  createdAt: string;
}

// Memory types
export interface MemoryStats {
  currentSize: number;
  totalSnapshots: number;
  checkpoints: number;
  autoSnapshots: number;
  lastUpdate?: string;
}

export interface MemoryHealth {
  healthy: boolean;
  fileSize?: number;
  totalSnapshots?: number;
  lastUpdate?: string;
  recommendations?: string[];
}

// UI Selection types
export interface UiSelectionLocator {
  selector?: string;
  path?: string;
  id?: string;
  dataTestId?: string;
  ariaLabel?: string;
  name?: string;
  role?: string;
  type?: string;
  text?: string;
  placeholder?: string;
}

export interface UiSelection {
  tagName: string;
  elementType?: 'text' | 'input' | 'textarea' | 'image' | 'other';
  selector?: string;
  locator?: UiSelectionLocator;
  text?: string;
  editableText?: string;
  placeholder?: string;
  value?: string;
  computedStyles?: Record<string, string>;
  outerHTML?: string;
  attributes?: Record<string, string>;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
    top?: number;
    left?: number;
  } | null;
  pageUrl?: string;
  timestamp?: string;
}

export interface UiEditPayload {
  text?: string | null;
  placeholder?: string | null;
  value?: string | null;
  styles?: Record<string, string | null>;
}

// File types
export interface FileItem {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

// Test types
export type TestAction = 'click' | 'type' | 'navigate' | 'assert' | 'screenshot';

export interface TestStep {
  action: TestAction;
  selector?: string;
  value?: string;
  expected?: string;
  // Screenshot-specific fields
  screenshotName?: string;
  threshold?: number; // 0-100, percentage diff tolerance (default 0.1)
}

export interface TestCase {
  id: string;
  name: string;
  steps: TestStep[];
  projectId: string;
  createdAt: string;
  updatedAt?: string;
}

export interface StepResult {
  stepIndex: number;
  status: 'pass' | 'fail' | 'skipped';
  actual?: string;
  error?: string;
  screenshot?: string;
  // Screenshot comparison data
  screenshotData?: {
    imageData: string; // base64 PNG
    hasBaseline: boolean;
    matchPercentage?: number;
    diffImageData?: string; // base64 PNG of diff
    baselineImageData?: string; // base64 PNG of baseline
  };
}

export interface TestResult {
  testId: string;
  status: 'pass' | 'fail';
  steps: StepResult[];
  duration: number;
  timestamp: string;
}

// Recorded action from test recording
export interface RecordedAction {
  action: TestAction;
  selector?: string;
  value?: string;
  elementInfo?: {
    tagName: string;
    text?: string;
    type?: string;
    placeholder?: string;
    name?: string;
    id?: string;
    role?: string;
  };
  timestamp: number;
}

// Branch Review types
export type BranchReviewStatus = 'active' | 'merged' | 'closed' | 'stale';
export type BranchReviewDiffScope = 'base_branch' | 'last_commit';

export interface BranchReviewScope {
  includePatterns?: string[];
  excludePatterns?: string[];
  applyGlobalIgnorePatterns?: boolean;
}

export interface BranchReviewFileSummary {
  path: string;
  additions: number;
  deletions: number;
  status: string;
  oldPath: string | null;
}

export interface BranchReviewFileContent extends BranchReviewFileSummary {
  before: string | null;
  after: string | null;
  patch?: string | null;
}

export interface ReviewDiffManifestSummary {
  visibleCount: number;
  totalCount: number;
  hiddenCount: number;
  maxVisible: number;
  isCapped: boolean;
}

export interface BranchReview {
  id: string;
  projectId: string;
  displayId: string;
  branchName: string;
  isWorktree?: boolean;
  worktreePath?: string | null;
  worktreeName?: string | null;
  worktreeHead?: string | null;
  baseBranch: string;
  /**
   * How this review's base_branch was set:
   *  - `'inferred'` (default) — chosen by inferBaseBranch or inherited
   *    from the project-wide base; reconcile may heal/rewrite it.
   *  - `'pinned'` — user explicitly set this review's base via
   *    Change Base; reconcile and the project-wide cascade skip it.
   *  - `'last_commit'` — synthetic review scope for the latest commit.
   */
  baseBranchSource?: 'inferred' | 'pinned' | 'last_commit';
  mergeBaseSha?: string;
  forkPointSha?: string | null;
  headSha?: string;
  status: BranchReviewStatus;
  /**
   * Backend-derived classification of this review's fork-point state.
   * - `'ok'`           — normal review with distinct fork point.
   * - `'preserved'`    — branch fully merged into base but fork_point_sha
   *                     still anchors the historical work.
   * - `'unrecoverable'` — branch is merged and fork point couldn't be
   *                     recovered from reflog; UI should surface a hint
   *                     explaining empty counts.
   */
  forkPointRecovery?: 'ok' | 'preserved' | 'unrecoverable' | null;
  /**
   * Files and commits touched between `review_head_sha` and the current
   * head — i.e. what the next incremental review would actually scope.
   * Populated only for active reviews with a completed baseline. When
   * both are zero and `reviewHeadSha === headSha`, nothing is unreviewed.
   */
  unreviewedFileCount?: number;
  unreviewedCommitCount?: number;
  isCurrent: boolean;
  fileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  commitCount: number;
  firstCommitAt?: string | null;
  lastCommitAt?: string | null;
  reviewStatus: ReviewStatus;
  reviewRiskLevel?: RiskLevel | null;
  reviewSummary?: string | null;
  reviewError?: string | null;
  reviewLifecycle?: ReviewLifecycle | null;
  reviewActionEligibility?: ReviewActionEligibility | null;
  reviewBaseBranch?: string | null;
  reviewMergeBaseSha?: string | null;
  reviewHeadSha?: string | null;
  reviewedAt?: string | null;
  reviewJson?: ReviewResult | null;
  trustAnalytics?: TrustReviewAnalytics | null;
  diffManifestSummary?: ReviewDiffManifestSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceReview {
  id: string;
  projectId: string;
  displayId: string;
  branchName: string;
  baseBranch: string | null;
  status: 'active';
  isCurrent: boolean;
  fileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  commitCount: number;
  headSha?: string | null;
  snapshotKey?: string | null;
  reviewSnapshotKey?: string | null;
  reviewStatus: ReviewStatus;
  reviewRiskLevel?: RiskLevel | null;
  reviewSummary?: string | null;
  reviewError?: string | null;
  reviewLifecycle?: ReviewLifecycle | null;
  reviewActionEligibility?: ReviewActionEligibility | null;
  reviewedAt?: string | null;
  reviewHeadSha?: string | null;
  reviewJson?: ReviewResult | null;
  trustAnalytics?: TrustReviewAnalytics | null;
  files?: Array<BranchReviewFileSummary | BranchReviewFileContent>;
  diffManifestSummary?: ReviewDiffManifestSummary | null;
  createdAt: string;
  updatedAt: string;
}

export type PrReviewState = 'open' | 'closed' | 'merged' | 'draft';

export interface PrReview {
  id: string;
  projectId: string;
  displayId: string;
  githubPrNumber: number;
  title: string;
  body?: string | null;
  authorLogin: string;
  authorAvatarUrl?: string | null;
  state: PrReviewState;
  headBranch: string;
  baseBranch: string;
  headSha?: string | null;
  baseSha?: string | null;
  fileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  commitCount: number;
  githubCommentCount?: number;
  githubReviewCommentCount?: number;
  githubReviewDecision?: string | null;
  githubMergeStateStatus?: string | null;
  githubLatestReviewState?: string | null;
  githubLatestReviewAuthor?: string | null;
  githubLatestReviewSubmittedAt?: string | null;
  githubReviewStateCounts?: Record<string, number>;
  githubReviewStatusSyncedAt?: string | null;
  githubUpdatedAt?: string | null;
  labels?: string[];
  assignees?: string[];
  requestedReviewers?: string[];
  reviewerParticipants?: string[];
  htmlUrl?: string | null;
  reviewStatus: ReviewStatus;
  reviewRiskLevel?: RiskLevel | null;
  reviewSummary?: string | null;
  reviewError?: string | null;
  reviewJson?: ReviewResult | null;
  reviewLifecycle?: ReviewLifecycle | null;
  isSelfAuthored?: boolean;
  reviewActionEligibility?: ReviewActionEligibility | null;
  reviewCommentEligibility?: ReviewCommentEligibility | null;
  reviewParityGate?: ReviewParityGate | null;
  latestPublicationAction?: GitHubReviewAction | null;
  latestPublicationHeadSha?: string | null;
  latestPublicationAt?: string | null;
  diffManifestSummary?: ReviewDiffManifestSummary | null;
  latestApprovedPublicationHeadSha?: string | null;
  latestApprovedPublicationAt?: string | null;
  reviewHeadSha?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Union type for review items displayed in the Trust Pipeline */
export type ReviewItem = ChangeSetIndex | BranchReview | WorkspaceReview;

// ChangeSet types
export type ChangeSetSource = 'agent' | 'visual_edit' | 'workflow' | 'git_watcher' | 'manual' | 'baseline';
export type ChangeSetStatus = 'applied' | 'verified' | 'committed' | 'published' | 'reverted';
export type VerificationStatus = 'not_run' | 'pass' | 'fail';
export type LegacyReviewStatus = 'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed';
export type ReviewLifecycleStatus = 'queued' | 'running' | 'retrying' | 'partial' | 'failed' | 'completed';
export type ReviewStatus = LegacyReviewStatus | ReviewLifecycleStatus;
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ReviewLifecycle {
  status: ReviewLifecycleStatus;
  phase: string;
  isActive: boolean;
  isTerminal: boolean;
  canRetry: boolean;
  error?: string | null;
  updatedAt?: string | null;
  reviewedAt?: string | null;
  hasProgress?: boolean;
  sourceStatus?: ReviewStatus | string | null;
}

export interface ReviewActionEligibility {
  canApprove: boolean;
  canRequestChanges: boolean;
  approveBlockedReason?: string | null;
  blockedReason?: string | null;
  requestChangesBlockedReason?: string | null;
  staleReason?: 'head_mismatch' | 'base_mismatch' | 'merge_base_mismatch' | string | null;
}

export type ReviewFileFilterKind = 'change_group' | 'risky' | 'code_only' | 'finding' | 'github_conversation';

export interface ReviewFileFilter {
  label: string;
  paths: string[];
  kind?: ReviewFileFilterKind;
  focusLine?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
  finding?: ReviewRecommendation | null;
  findingDisplayMode?: 'diff' | 'details';
  findingDetailsReason?: string | null;
}

// AI Provider types
export type ProviderType = 'anthropic' | 'openai' | 'google' | 'opencode';
export type ProviderSource = 'cli_detected' | 'byok';

export interface AIProvider {
  id: string;
  type: ProviderType;
  source: ProviderSource;
  label: string;
  model: string;
  isActive: boolean;
  status: 'connected' | 'error' | 'expired' | 'unchecked' | 'needs_key';
  lastCheckedAt: string | null;
  error?: string;
}

export interface ProviderScanResult {
  providers: AIProvider[];
  activeProvider: AIProvider | null;
}

// Review types
export interface ReviewChangeGroup {
  label: string;
  description: string;
  risk: RiskLevel;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    description: string;
  }>;
}

export interface ReviewRecommendation {
  findingId?: string;
  recommendationKey?: string;
  type: 'issue' | 'suggestion' | 'praise';
  severity: RiskLevel;
  title: string;
  description: string;
  file?: string;
  line?: number;
  sourceAnchor?: {
    file?: string | null;
    line?: number | null;
    snippet?: string | null;
    reasoning?: string | null;
  };
  patchAnchor?: {
    file?: string | null;
    line?: number | null;
    startLine?: number | null;
    endLine?: number | null;
    status?: 'exact' | 'exact_block' | 'partial_block' | 'nearby_unique_line' | 'outside_patch' | 'file_not_in_diff' | 'diff_unavailable' | 'unanchored';
  };
  targetSnippet?: string;
  suggestedFix?: string;
  confidence?: 'low' | 'medium' | 'high';
  evidenceSnippet?: string;
  evidence?: {
    file?: string | null;
    line?: number | null;
    snippet?: string | null;
    reasoning?: string | null;
  };
  corroboration?: {
    status?: 'supported' | 'unsupported' | 'inconclusive' | 'not_applicable';
    reason?: string;
    confidence?: 'low' | 'medium' | 'high' | null;
    sourceClass?: 'deterministic_tool' | 'verifier' | 'grounding' | 'none';
    sourceName?: string | null;
    downgradedFrom?: RiskLevel;
    downgradedTo?: RiskLevel;
    isSecuritySensitive?: boolean;
  };
  commentEligible?: boolean;
  commentEligibility?: {
    eligible?: boolean;
    confidence?: 'low' | 'medium' | 'high' | null;
    reasonCodes?: string[];
  };
}

export type ReviewFixRecommendationStatus =
  | 'pending'
  | 'running'
  | 'touched'
  | 'patch_applied'
  | 'verification_pending'
  | 're_reviewing'
  | 'still_open'
  | 'failed'
  | 'stopped'
  | 'skipped';

export interface ReviewFixBuildSummary {
  filesChanged: number;
  filePaths: string[];
  newFiles: string[];
  modifiedFiles: string[];
  changesetId: string | null;
  changesetTitle: string | null;
}

export interface ReviewCommentEligibility {
  totalFindings: number;
  eligibleFindings: number;
  withheldFindings: number;
  reasonCounts?: Record<string, number>;
}

export interface ReviewParityGate {
  status: 'ready' | 'warn' | 'blocked';
  reasonCodes?: string[];
  reviewTier?: 'full' | 'partial' | 'files_only' | 'failed' | string | null;
  totalFiles?: number;
  deepReviewedFiles?: number;
  deepCoverageRate?: number;
  totalFindings?: number;
  eligibleFindings?: number;
  withheldFindings?: number;
  commentReadyRate?: number;
  verificationSummary?: string | null;
}

export interface ReviewVerificationStatus {
  overallStatus?: 'pass' | 'fail' | 'warn' | 'pending' | string;
  summary?: string | null;
  lines?: string[];
  failingChecks?: string[];
  passingChecks?: string[];
  pendingChecks?: string[];
}

export type ReviewOutcomeState = 'addressed' | 'dismissed';
export type ReviewOutcomeScopeType = 'changeset' | 'branch_review' | 'pr_review' | 'workspace_review';

export interface ReviewOutcomeScope {
  projectId: string;
  reviewType: ReviewOutcomeScopeType;
  reviewId: string;
}

export interface ReviewRecommendationOutcome {
  recommendationKey: string;
  status: ReviewOutcomeState;
  note?: string;
  dimensions?: {
    providerType?: string;
    providerModel?: string;
    language?: string;
    pathPattern?: string;
  };
  updatedAt: string;
}

export type ReviewFixStatus =
  | 'queued'
  | 'running'
  | 'touched'
  | 'patch_applied'
  | 'verification_pending'
  | 're_reviewing'
  | 'still_open'
  | 'failed'
  | 'stopped'
  | 'skipped';

export interface ReviewFixRunRequest {
  projectId: string;
  reviewType: ReviewOutcomeScopeType;
  reviewId: string;
  recommendationKeys: string[];
}

export interface ReviewFixFindingState {
  recommendationKey: string;
  status: ReviewFixStatus;
  updatedAt: string;
  filePaths?: string[];
  error?: string | null;
}

export interface ReviewFixStatusEvent {
  projectId: string;
  reviewType: ReviewOutcomeScopeType;
  reviewId: string;
  recommendationKey: string;
  status: ReviewFixStatus;
  updatedAt?: string;
  filePaths?: string[];
  error?: string | null;
}

export type ReviewFixRunArtifactStatus =
  | 'running'
  | 'patch_applied'
  | 'verification_pending'
  | 'failed'
  | 'stopped'
  | 'skipped';

export type ReviewFixRunHistoryAction = 'retry' | 'verify' | 'inspect_patch';

export interface ReviewFixRunArtifact {
  id: string;
  projectId: string;
  reviewType: ReviewOutcomeScopeType;
  reviewId: string;
  status: ReviewFixRunArtifactStatus;
  transcriptVisibility: 'hidden';
  providerType?: string | null;
  providerModel?: string | null;
  selectedRecommendationKeys: string[];
  recommendationStatuses: Record<string, ReviewFixFindingState>;
  buildSummary?: ReviewFixBuildSummary | null;
  error?: string | null;
  startedAt: string;
  completedAt?: string | null;
  stoppedAt?: string | null;
  failedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ReviewFixRunHistoryEntry {
  id: string;
  isLatest: boolean;
  status: ReviewFixRunArtifactStatus;
  statusLabel: string;
  timestampLabel: string;
  summaryLabel?: string | null;
  patchActionLabel?: string | null;
  changesetId?: string | null;
  changesetTitle?: string | null;
  fileSummaryLabel?: string | null;
  filePreviewLabel?: string | null;
  coverageLabel?: string | null;
  selectedCount: number;
  selectedKeys: string[];
  filePaths?: string[];
  error?: string | null;
  action?: ReviewFixRunHistoryAction | null;
  actionLabel?: string | null;
  actionRecommendationKeys?: string[];
  patchAction?: Extract<ReviewFixRunHistoryAction, 'inspect_patch'> | null;
}

export interface ReviewOutcomeTelemetry {
  total: number;
  addressed: number;
  dismissed: number;
  addressedRate: number;
  dismissedRate: number;
  issueTotal: number;
  issueAddressed: number;
  issueDismissed: number;
  issueAddressedRate: number;
  issueDismissedRate: number;
}

export type GitHubReviewAction = 'comment' | 'approve' | 'request_changes';

export interface ReviewPublicationRecord {
  recommendationKey: string;
  channel: 'github_pr_review' | string;
  action: GitHubReviewAction;
  githubReviewId?: string | null;
  githubPrNumber?: number | null;
  headSha?: string | null;
  path?: string | null;
  line?: number | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
}

export interface ReviewPublicationState {
  scope: {
    projectId: string;
    reviewType: ReviewOutcomeScopeType;
    reviewId: string;
  };
  publications: ReviewPublicationRecord[];
  byRecommendationKey: Record<string, ReviewPublicationRecord>;
  totalPublished: number;
  latestAction?: GitHubReviewAction | null;
  latestPublishedAt?: string | null;
}

export interface ReviewSubmissionState {
  event: string;
  githubReviewId?: string | null;
  htmlUrl?: string | null;
  state?: string | null;
  commentCount?: number;
  headSha?: string | null;
  submittedAt?: string | null;
}

export interface GitHubPrThreadComment {
  id: string;
  nodeId: string;
  databaseId?: number | null;
  threadNodeId?: string | null;
  replyToNodeId?: string | null;
  githubReviewNodeId?: string | null;
  githubReviewDatabaseId?: number | null;
  body: string;
  bodyText?: string | null;
  authorLogin?: string | null;
  authorAvatarUrl?: string | null;
  authorUrl?: string | null;
  htmlUrl?: string | null;
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  side?: string | null;
  diffHunk?: string | null;
  isMinimized?: boolean;
  minimizedReason?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  syncedAt?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface GitHubPrReviewThread {
  id: string;
  nodeId: string;
  githubPrNumber?: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedByLogin?: string | null;
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  side?: string | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
  firstCommentAt?: string | null;
  lastCommentAt?: string | null;
  commentCount: number;
  syncedAt?: string | null;
  comments: GitHubPrThreadComment[];
}

export interface GitHubPrIssueComment {
  id: string;
  nodeId: string;
  databaseId?: number | null;
  githubPrNumber?: number | null;
  body: string;
  bodyText?: string | null;
  authorLogin?: string | null;
  authorAvatarUrl?: string | null;
  authorUrl?: string | null;
  htmlUrl?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  syncedAt?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface GitHubPrConversationSummary {
  totalThreads: number;
  openThreads: number;
  resolvedThreads: number;
  outdatedThreads: number;
  threadComments: number;
  issueComments: number;
  syncedAt?: string | null;
}

export interface GitHubPrConversations {
  threads: GitHubPrReviewThread[];
  issueComments: GitHubPrIssueComment[];
  summary: GitHubPrConversationSummary;
  sync?: {
    githubPrNumber?: number | null;
    pullRequestNodeId?: string | null;
    reviewDecision?: string | null;
    mergeStateStatus?: string | null;
    latestReviewState?: string | null;
    latestReviewAuthor?: string | null;
    latestReviewSubmittedAt?: string | null;
    reviewStateCounts?: Record<string, number>;
    threadCount: number;
    issueCommentCount: number;
    syncedAt?: string | null;
  } | null;
}

export interface PrivateReviewNote {
  id: string;
  path: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
  updatedAt: string;
  reviewType?: 'branch_review' | 'pr_review' | 'workspace_review';
  branchReviewId?: string | null;
  branchName?: string | null;
  prReviewId?: string | null;
  githubPrNumber?: number | null;
  prHtmlUrl?: string | null;
  reviewDisplayId?: string | null;
  reviewTitle?: string | null;
  snapshotLabel?: string | null;
  snapshotExcerpt?: string | null;
  snapshotLanguage?: string | null;
}

export interface TrustAnalyticsRateMetric {
  value: number | null;
  numerator: number;
  denominator: number;
  sampleSize: number;
  minimumSampleSize: number;
  isInsufficientSample: boolean;
}

export interface TrustAnalyticsValueMetric {
  value: number | null;
  sampleSize: number;
}

export interface TrustReviewAnalytics {
  meta: {
    projectId: string | null;
    reviewType: 'changeset' | 'branch_review' | 'pr_review' | 'workspace_review';
    reviewId: string | null;
    displayId: string | null;
    branchName: string | null;
    completedAt: string | null;
    providerType: string | null;
    providerModel: string | null;
  };
  immediateValue: {
    ttfsMs: number | null;
    reviewDurationMs: number | null;
    deepCoverage: TrustAnalyticsRateMetric;
    issuesFound: number;
    highRiskFindings: number;
  };
  trustQuality: {
    groundedIssueRate: TrustAnalyticsRateMetric;
    unsupportedIssueRate: TrustAnalyticsRateMetric;
    lowEvidenceIssueRate: TrustAnalyticsRateMetric;
    uncorroboratedHighRiskRate: TrustAnalyticsRateMetric;
    outcomeSuppressionRate: TrustAnalyticsRateMetric;
  };
  followThrough: {
    issueAddressedRate: TrustAnalyticsRateMetric;
    issueDismissedRate: TrustAnalyticsRateMetric;
    issueOutcomeCoverage: TrustAnalyticsRateMetric;
    addressedCount: number;
    dismissedCount: number;
  };
  reliability: {
    reviewReliability: 'full' | 'partial' | 'files_only' | 'failed';
    gateStatus: 'pass' | 'warn' | 'fail' | null;
    gateReasonCodes: string[];
    gateEvaluatedAt: string | null;
    omittedFiles: number;
    failedFiles: number;
    reviewStatus: ReviewStatus;
  };
}

export type TrustAnalyticsReviewType = 'changeset' | 'branch_review' | 'pr_review' | 'workspace_review';
export type TrustAnalyticsScope = 'all' | 'branches' | 'prs';

export interface TrustAnalyticsScopeBreakdown {
  branchScopedCount: number;
  branchReviewCount: number;
  changesetCount: number;
  workspaceReviewCount: number;
  prReviewCount: number;
}

export interface TrustAnalyticsScopeComparison {
  dominantScope: 'branches' | 'prs' | 'balanced';
  branchScopedCount: number;
  prReviewCount: number;
  branchShare: number;
  prShare: number;
}

export interface TrustAnalyticsHeroCardMeta {
  key: string;
  label: string;
  description: string;
}

export interface TrustAnalyticsSummary {
  projectId: string | null;
  reviewType: TrustAnalyticsReviewType | null;
  scope: TrustAnalyticsScope;
  window: {
    key: '24h' | '7d' | '30d' | 'custom';
    from: string;
    to: string;
  };
  reviewCount: number;
  scopeBreakdown: TrustAnalyticsScopeBreakdown;
  comparison: TrustAnalyticsScopeComparison;
  heroCards: TrustAnalyticsHeroCardMeta[];
  hero: {
    medianTtfsMs: TrustAnalyticsValueMetric;
    medianReviewDurationMs: TrustAnalyticsValueMetric;
    deepCoverageRate: TrustAnalyticsRateMetric;
    findingsFoundPerReview: {
      value: number | null;
      numerator: number;
      denominator: number;
      sampleSize: number;
    };
    issuesFoundPerReview: {
      value: number | null;
      numerator: number;
      denominator: number;
      sampleSize: number;
    };
    commentReadyFindingsPerReview: {
      value: number | null;
      numerator: number;
      denominator: number;
      sampleSize: number;
    };
    medianChangedFiles: TrustAnalyticsValueMetric;
    verificationContextRate: TrustAnalyticsRateMetric;
    groundedIssueRate: TrustAnalyticsRateMetric;
  };
  quality: {
    groundedIssueRate: TrustAnalyticsRateMetric;
    unsupportedIssueRate: TrustAnalyticsRateMetric;
    lowEvidenceIssueRate: TrustAnalyticsRateMetric;
    uncorroboratedHighRiskRate: TrustAnalyticsRateMetric;
    outcomeSuppressionRate: TrustAnalyticsRateMetric;
  };
  outcome: {
    issueAddressedRate: TrustAnalyticsRateMetric;
    issueDismissedRate: TrustAnalyticsRateMetric;
    issueOutcomeCoverage: TrustAnalyticsRateMetric;
    addressedCount: number;
    dismissedCount: number;
  };
  reliability: {
    fullCount: number;
    partialCount: number;
    filesOnlyCount: number;
    failedCount: number;
    partialRate: TrustAnalyticsRateMetric;
    filesOnlyRate: TrustAnalyticsRateMetric;
    failedRate: TrustAnalyticsRateMetric;
    gateWarnRate: TrustAnalyticsRateMetric;
    gateFailRate: TrustAnalyticsRateMetric;
  };
}

export interface TrustAnalyticsTimeseriesPoint {
  bucketStart: string;
  bucketEnd: string;
  reviewCount: number;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  sampleSize: number;
  aggregation: 'median' | 'rate' | 'count' | 'sum';
}

export interface TrustAnalyticsTimeseries {
  projectId: string | null;
  reviewType: TrustAnalyticsReviewType | null;
  scope: TrustAnalyticsScope;
  window: {
    key: '24h' | '7d' | '30d' | 'custom';
    from: string;
    to: string;
  };
  metric: 'ttfs_ms' | 'review_duration_ms' | 'deep_coverage_rate' | 'grounded_issue_rate' | 'issue_addressed_rate' | 'issue_dismissed_rate' | 'partial_rate' | 'review_count' | 'issues_found' | 'findings_found';
  metricLabel: string;
  metricDescription: string;
  interval: 'hour' | 'day' | 'week';
  points: TrustAnalyticsTimeseriesPoint[];
}

export type TrustAnalyticsBreakdownMetric =
  | 'grounded_issue_rate'
  | 'deep_coverage_rate'
  | 'issue_addressed_rate'
  | 'issue_dismissed_rate'
  | 'issue_outcome_coverage'
  | 'partial_rate'
  | 'review_count'
  | 'issues_found'
  | 'findings_found'
  | 'high_risk_findings';

export type TrustAnalyticsBreakdownDimension = 'provider_model' | 'language' | 'path_pattern';

export interface TrustAnalyticsBreakdownMetricValue {
  value: number | null;
  numerator: number;
  denominator: number | null;
  sampleSize: number;
  minimumSampleSize: number;
  isInsufficientSample: boolean;
}

export interface TrustAnalyticsBreakdownGroup {
  key: string;
  label: string;
  reviewCount: number;
  metric: TrustAnalyticsBreakdownMetricValue;
}

export interface TrustAnalyticsBreakdown {
  projectId: string | null;
  reviewType: TrustAnalyticsReviewType | null;
  scope: TrustAnalyticsScope;
  window: {
    key: '24h' | '7d' | '30d' | 'custom';
    from: string;
    to: string;
  };
  by: TrustAnalyticsBreakdownDimension;
  metric: TrustAnalyticsBreakdownMetric;
  groups: TrustAnalyticsBreakdownGroup[];
}

export interface ReviewResult {
  summary: string;
  riskLevel: RiskLevel;
  changeGroups: ReviewChangeGroup[];
  recommendations: ReviewRecommendation[];
  /**
   * Lower-confidence findings the model surfaced but did not fully verify.
   * Section R Phase B-6 (Performance soft-enforcement bullets) directs the
   * agent to keep plausible-but-incomplete concerns here instead of
   * dropping them. Backend persists these alongside `recommendations`;
   * the UI must surface them or the contract breaks.
   *
   * Optional because reviews from older runs predate the Phase B contract.
   */
  candidateFindings?: ReviewRecommendation[];
  previousFindings?: ReviewRecommendation[];
  verificationStatus?: ReviewVerificationStatus | null;
  stats: {
    filesAnalyzed: number;
    totalAdditions: number;
    totalDeletions: number;
    estimatedComplexity: 'trivial' | 'simple' | 'moderate' | 'complex';
    issuesTotal: number;
    issuesGrounded: number;
    issuesDemoted: number;
    issuesSuppressed: number;
    verifierEnabled?: boolean;
    verifierMaxFindings?: number;
    verifierUnsupportedPolicy?: 'demote' | 'hide';
    verifierChecked?: number;
    verifierSupported?: number;
    verifierUnsupported?: number;
    verifierNeedsMoreContext?: number;
    verifierNeedsContext?: number;
    verifierSkippedBudget?: number;
    verifierMediumEnabled?: boolean;
    verifierMediumMaxFindings?: number;
    verifierMediumConsidered?: number;
    verifierMediumChecked?: number;
    verifierMediumSkippedBudget?: number;
    verifierMediumGateStatus?: 'pass' | 'blocked' | 'disabled';
    verifierMediumGateReasonCodes?: string[];
    corroborationEnabled?: boolean;
    corroborationChecked?: number;
    corroborationSupported?: number;
    corroborationUnsupported?: number;
    corroborationInconclusive?: number;
    corroborationNotApplicable?: number;
    corroborationDowngraded?: number;
    corroborationSecuritySensitiveChecked?: number;
    corroborationReasonCounts?: Record<string, number>;
    corroborationSourceClassCounts?: Record<string, number>;
    corroborationSourceNameCounts?: Record<string, number>;
    corroboration?: {
      enabled?: boolean;
      checked?: number;
      supported?: number;
      unsupported?: number;
      inconclusive?: number;
      notApplicable?: number;
      downgraded?: number;
      securitySensitiveChecked?: number;
      reasonCounts?: Record<string, number>;
      sourceClassCounts?: Record<string, number>;
      sourceNameCounts?: Record<string, number>;
    };
    reviewOutcomeTelemetry?: {
      issueTotal?: number;
      issueDismissed?: number;
      issueAddressed?: number;
    };
    outcomeSuppressionEnabled?: boolean;
    outcomeSuppressionCandidates?: number;
    outcomeSuppressionChecked?: number;
    outcomeSuppressionSuppressed?: number;
    outcomeSuppressionMinSamples?: number;
    outcomeSuppressionMinDismissedRate?: number;
    outcomeSuppressionMaxPerRun?: number;
    outcomeSuppressionReasonCounts?: Record<string, number>;
    outcomeSuppression?: {
      enabled?: boolean;
      candidates?: number;
      checked?: number;
      suppressed?: number;
      minSamples?: number;
      minDismissedRate?: number;
      maxPerRun?: number;
      reasonCounts?: Record<string, number>;
    };
    reviewMode?: 'full' | 'focused';
    diffScopeRequestedMode?: 'auto' | 'full';
    diffScopeMode?: 'full' | 'delta';
    diffScopeCommitCount?: number;
    diffBaseSha?: string | null;
    diffHeadSha?: string | null;
    diffMergeBaseSha?: string | null;
    deltaEligible?: boolean;
    deltaFallbackReason?: string | null;
    reviewTier?: 'full' | 'partial' | 'files_only' | 'failed';
    fileCount?: number;
    filesDeepReviewed?: number;
    deepReviewedFiles?: number;
    filesTotal?: number;
    totalChangedFiles?: number;
    omittedFiles?: number;
    omissionReasons?: Record<string, string>;
    perFileFailedFiles?: number;
    perFileFailedPaths?: string[];
    perFileTriageOmittedPaths?: string[];
    perFileCacheHits?: number;
    perFileCacheMisses?: number;
    coveragePlanner?: {
      totalFiles?: number;
      estimatedTotalChars?: number;
      highRiskCount?: number;
      highRiskRatio?: number;
      budgetClass?: string;
      multiplier?: number;
      deadlineRemainingMs?: number;
      deadlineRatio?: number;
      providerCoverageMultiplier?: number;
    };
    reviewProfile?: {
      id?: string;
      label?: string;
      source?: string;
      presetId?: string | null;
      detectionSignals?: string[];
    };
    shapedScope?: {
      rawFileCount?: number;
      reviewUnitCount?: number;
      pairedFiles?: number;
      classCounts?: {
        deep?: number;
        structural?: number;
        shallow?: number;
        collapsed?: number;
        skip?: number;
      };
    };
    chunkCount?: number;
    isPartial?: boolean;
    partialReason?: string;
    partialChunksCompleted?: number;
    partialChunksTotal?: number;
    partialDeferredFileCount?: number;
    partialDeferredFiles?: string[];
    // CLI-agentic execution telemetry — present only when the review ran via
    // cli-agentic mode. Surfaced in the VerdictCard Execution section.
    executionMode?: string | null;
    agenticReview?: boolean | null;
    agenticActualTurns?: number | null;
    agenticMaxTurns?: number | null;
    agenticToolUseCount?: number | null;
    agenticDurationMs?: number | null;
    agenticCompletionReason?: string | null;
    agenticTier?: 'small' | 'medium' | 'large';
    commentEligibility?: ReviewCommentEligibility;
    reviewModelStrategy?: 'smart' | 'latency_first' | 'max_quality' | 'custom' | 'adaptive' | 'performance';
    reviewModelEffectiveStrategy?: 'smart' | 'latency_first' | 'max_quality' | 'custom' | 'adaptive' | 'performance';
    reviewModelPolicyVersion?: string;
    reviewModelDecisionReason?: string | null;
    reviewModelFallbackReason?: string | null;
    reviewModelBudgetClass?: 'latency' | 'balanced' | 'quality' | 'custom';
    reviewModelThresholdProfile?: {
      adaptive?: {
        fastPathMaxFiles?: number;
        fastPathMaxDiffChars?: number;
        preferQualityOnHighRisk?: boolean;
      };
      latencyFirst?: {
        reviewMaxFiles?: number;
        reviewMaxDiffChars?: number;
        synthesisMaxFiles?: number;
        synthesisMaxDiffChars?: number;
        guardHighRisk?: boolean;
      };
    };
    reviewModelDecisionInputs?: {
      fileCount?: number;
      diffChars?: number;
      riskLevel?: 'low' | 'medium' | 'high' | 'critical' | null;
      highRiskHints?: boolean;
      focusedReview?: boolean;
    };
    reviewModelRollout?: {
      mode?: 'off' | 'shadow' | 'canary' | 'on';
      enabled?: boolean;
      reason?: string | null;
      canaryPercent?: number;
      canaryBucket?: number;
      allowlistEnabled?: boolean;
      allowlistMatched?: boolean;
      gate?: {
        status?: 'pass' | 'warn' | 'fail';
        reasonCodes?: string[];
        source?: string | null;
        evaluatedAt?: string | null;
      };
    };
    reviewModelGate?: {
      status?: 'pass' | 'warn' | 'fail';
      reasonCodes?: string[];
      criticalReasonCodes?: string[];
      warningReasonCodes?: string[];
      source?: string | null;
      evaluatedAt?: string | null;
      thresholds?: {
        minCoverageFileCount?: number;
        minDeepCoverageRate?: number;
        warnOmittedRate?: number;
        maxDurationMs?: number;
        maxFirstSignalMs?: number;
        maxUnsupportedIssueRate?: number;
        maxLowEvidenceIssueRate?: number;
        maxDismissedIssueRate?: number;
        maxUncorroboratedHighRiskRate?: number;
        maxOutcomeSuppressionRate?: number;
      };
      metrics?: {
        totalFiles?: number;
        deepReviewedFiles?: number;
        omittedFiles?: number;
        deepCoverageRate?: number;
        omittedRate?: number;
        durationMs?: number;
        firstSignalMs?: number | null;
        isPartial?: boolean;
        unsupportedIssueRate?: number | null;
        lowEvidenceIssueRate?: number | null;
        dismissedIssueRate?: number | null;
        uncorroboratedHighRiskRate?: number | null;
        outcomeSuppressionRate?: number | null;
        precisionIssueSampleCount?: number;
        verifierSampleCount?: number;
        dismissalSampleCount?: number;
        corroborationSampleCount?: number;
        suppressionSampleCount?: number;
      };
    };
    modelsUsed?: {
      triage?: string;
      review?: string;
      synthesis?: string;
      verifier?: string;
    };
    modelsChosenByPhase?: {
      triage?: string | null;
      review?: string | null;
      synthesis?: string | null;
      verifier?: string | null;
    };
    phaseTimingsMs?: {
      triage?: number;
      review?: number;
      synthesis?: number;
      verifier?: number;
    };
    reviewTotalDurationMs?: number | null;
    estimatedCostUsd?: number | null;
    costSource?: 'provider_native' | 'pricing_table' | 'fallback_pricing' | null;
    costIsApproximate?: boolean;
    providerNativeCostUsd?: number | null;
    costPricingKey?: string | null;
  };
  provider: {
    type: ProviderType;
    model: string;
  };
  tokensUsed: {
    input: number;
    output: number;
  };
  estimatedCost?: number | null;
  costSource?: 'provider_native' | 'pricing_table' | 'fallback_pricing' | null;
  costIsApproximate?: boolean;
  reviewedAt: string;
}

export interface ChangeSetVerification {
  lint: VerificationStatus;
  unit: VerificationStatus;
  e2e: VerificationStatus;
  lastRunAt: string | null;
  logs?: Record<string, string>;
  checks?: Record<string, {
    id: string;
    label?: string;
    kind?: string;
    command?: string;
    status: VerificationStatus;
    lastRunAt?: string | null;
    duration?: number;
    exitCode?: number;
  }>;
}

export interface ChangeSetRiskFlags {
  dependencyChanges: boolean;
  envChanges: boolean;
  buildConfigChanges: boolean;
  largeBlastRadius: boolean;
  fileCount: number;
  totalAdditions: number;
  totalDeletions: number;
}

export interface ChangeSetFileChange {
  path: string;
  before: string | null;
  after: string | null;
  language: string;
}

export interface ChangeSetDeployment {
  url: string;
  status: 'succeeded' | 'failed' | 'running' | 'queued';
  deployedAt: string | null;
  errorMessage?: string | null;
}

export interface ChangeSetIndex {
  id: string;
  displayId?: string;
  title: string;
  summary?: string | null;
  source: ChangeSetSource;
  status: ChangeSetStatus;
  createdAt: string;
  fileCount: number;
  filePaths: string[];
  projectId?: string;
  commitSha?: string;
  commitMessage?: string;
  publishedUrl?: string | null;
  riskFlags?: ChangeSetRiskFlags;
  verification?: Omit<ChangeSetVerification, 'logs'>;
  deployment?: ChangeSetDeployment | null;
  isProduction?: boolean;
  // Trust Pipeline review fields
  reviewStatus?: ReviewStatus;
  reviewRiskLevel?: RiskLevel;
  reviewSummary?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewError?: string | null;
  reviewLifecycle?: ReviewLifecycle | null;
}

export interface ChangeSetAlsoIn {
  id: string;
  displayId?: string;
}

export interface ChangeSet extends Omit<ChangeSetIndex, 'fileCount' | 'filePaths' | 'verification'> {
  files: ChangeSetFileChange[];
  summary?: string | null;
  commitSha?: string;
  commitMessage?: string;
  publishedUrl?: string | null;
  riskFlags?: ChangeSetRiskFlags;
  verification?: ChangeSetVerification;
  alsoInChangesets?: ChangeSetAlsoIn[];
  // Trust Pipeline review data (full detail)
  reviewData?: ReviewResult | null;
  trustAnalytics?: TrustReviewAnalytics | null;
  reviewError?: string | null;
  reviewLifecycle?: ReviewLifecycle | null;
}

// Project Secrets types
export interface ProjectSecret {
  id: string;
  projectId: string;
  key: string;
  value: string; // Masked for display, full value not returned from list endpoint
  isSecret: boolean;
  environment: string;
  createdAt: string;
  updatedAt: string;
}

// Integration detection types
export interface IntegrationVarCheck {
  key: string;
  configured: boolean;
}

export interface IntegrationCheck {
  id: string;
  name: string;
  docsUrl: string;
  requiredVars: IntegrationVarCheck[];
  missingCount: number;
}

export interface MissingVar {
  key: string;
  integrationId: string;
  integrationName: string;
  docsUrl: string;
}

export interface IntegrationsResponse {
  success: boolean;
  integrations: IntegrationCheck[];
  missingVars: MissingVar[];
}

// Quota types
export interface QuotaSummary {
  tokens: {
    used: number;
    limit: number;
    percentage: string;
    remaining: number;
  };
  cost: {
    used: number;
    limit: number;
    percentage: string;
    remaining: string;
  };
  requests: {
    thisHour: number;
    limit: number;
  };
  containers: {
    limit: number;
  };
  status: {
    exceeded: boolean;
    reason?: string;
  };
}

// Deployment types
export interface ProductionPointer {
  deploymentId: string | null;
  changesetId: string | null;
  changesetDisplayId: string | null;
  changesetTitle: string | null;
  commitHash: string | null;
  url: string | null;
  updatedAt: string | null;
}

export interface DeploymentRow {
  id: string;
  changesetId: string | null;
  changesetDisplayId: string | null;
  changesetTitle: string | null;
  commitHash: string | null;
  url: string | null;
  vercelUrl: string | null;
  deploymentId: string | null;
  inspectUrl: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  errorMessage: string | null;
  durationSeconds: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  isProduction: boolean;
}

export interface DeploymentsResponse {
  production: ProductionPointer;
  deployments: DeploymentRow[];
}

// Chat Mode types
export type ChatMode = 'agent' | 'plan' | 'build';

// Chat Message types
export type {
  MessageCategory,
  ToolEventType,
  FileDiff,
  MessageAttachment,
  Message,
  ChatMessage,
  ToolSummary,
} from './chat';

export {
  categorizeMessage,
  getToolEventType,
  createChatMessage,
  createEmptyToolSummary,
} from './chat';
