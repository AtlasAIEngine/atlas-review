export interface ProjectSummary {
  id: string;
  name: string;
  path: string | null;
  source?: string;
  baseBranchDisplay?: string | null;
  updatedAt?: string | null;
}

export interface CompactProjectSummary {
  id: string;
  name: string;
  path: string | null;
}

export interface ReviewRecommendation {
  findingId?: string;
  recommendationKey?: string;
  type?: string;
  severity?: string;
  title?: string;
  description?: string;
  file?: string;
  line?: number;
  suggestedFix?: string;
  [key: string]: unknown;
}

export interface ReviewResult {
  summary?: string;
  riskLevel?: string;
  recommendations?: ReviewRecommendation[];
  previousFindings?: ReviewRecommendation[];
  stats?: Record<string, unknown>;
}

export interface BranchReviewSummary {
  id: string;
  projectId: string;
  displayId?: string;
  branchName?: string;
  baseBranch?: string;
  status?: string;
  isCurrent?: boolean;
  reviewStatus?: string;
  reviewSummary?: string | null;
  reviewRiskLevel?: string | null;
  reviewJson?: ReviewResult | null;
  reviewLifecycle?: ReviewLifecycleSnapshot | null;
  reviewedAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface PrReviewSummary {
  id: string;
  projectId: string;
  displayId?: string;
  githubPrNumber?: number;
  title?: string;
  headBranch?: string;
  baseBranch?: string;
  status?: string;
  reviewStatus?: string;
  reviewSummary?: string | null;
  reviewRiskLevel?: string | null;
  reviewJson?: ReviewResult | null;
  reviewLifecycle?: ReviewLifecycleSnapshot | null;
  reviewedAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface WorkspaceReviewSummary {
  id: string;
  projectId: string;
  displayId?: string;
  branchName?: string;
  baseBranch?: string;
  status?: string;
  isCurrent?: boolean;
  reviewStatus?: string;
  reviewSummary?: string | null;
  reviewRiskLevel?: string | null;
  reviewJson?: ReviewResult | null;
  reviewLifecycle?: ReviewLifecycleSnapshot | null;
  reviewedAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface ChangesetSummary {
  id: string;
  projectId: string;
  displayId?: string;
  title?: string;
  status?: string;
  reviewStatus?: string;
  reviewSummary?: string | null;
  reviewRiskLevel?: string | null;
  reviewJson?: ReviewResult | null;
  reviewLifecycle?: ReviewLifecycleSnapshot | null;
  reviewedAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface BranchReviewScope {
  includePatterns?: string[];
  excludePatterns?: string[];
  applyGlobalIgnorePatterns?: boolean;
}

export interface BranchReviewDetailsResponse {
  success?: boolean;
  branchReview?: BranchReviewSummary;
}

export interface PrReviewDetailsResponse {
  success?: boolean;
  prReview?: PrReviewSummary;
}

export interface PrReviewsResponse {
  success?: boolean;
  prReviews?: PrReviewSummary[];
}

export interface ChangesetDetailsResponse {
  success?: boolean;
  changeset?: ChangesetSummary;
}

export interface BranchReviewsResponse {
  success?: boolean;
  branchReviews?: BranchReviewSummary[];
}

export interface WorkspaceReviewDetailsResponse {
  success?: boolean;
  workspaceReview?: WorkspaceReviewSummary;
}

export interface WorkspaceReviewsResponse {
  success?: boolean;
  workspaceReviews?: WorkspaceReviewSummary[];
}

export interface ProjectsResponse {
  success?: boolean;
  projects?: ProjectSummary[];
}

export interface OpenLocalResponse {
  success?: boolean;
  project?: ProjectSummary;
}

export type ReviewModelStrategy = 'smart' | 'latency_first' | 'max_quality' | 'custom' | 'adaptive';

export interface SettingValueResponse {
  success?: boolean;
  key?: string;
  value?: unknown;
  exists?: boolean;
  updatedAt?: string | null;
}

export interface ProviderMetadata {
  id: string;
  type: string;
  source?: string;
  label?: string;
  model?: string | null;
  isActive?: boolean;
  status?: string;
  lastCheckedAt?: string | null;
  error?: string;
  [key: string]: unknown;
}

export interface ProvidersResponse {
  success?: boolean;
  providers?: ProviderMetadata[];
  activeProvider?: ProviderMetadata | null;
}

export type ProviderContext = 'review' | 'build';

export interface ProviderContextActive {
  providerId: string;
  model?: string | null;
}

export interface ProviderContextActiveResponse {
  success?: boolean;
  data?: ProviderContextActive | null;
}

export interface ReviewProgressSnapshot {
  phase?: string | null;
  currentChunk?: number | null;
  totalChunks?: number | null;
  filesCompleted?: number | null;
  totalFiles?: number | null;
  activeChunkFiles?: number | null;
  elapsedSeconds?: number | null;
  splitDepth?: number | null;
  splitParts?: number | null;
  retryAttempt?: number | null;
  retryMaxAttempts?: number | null;
  retryDelayMs?: number | null;
  error?: string | null;
  agenticToolSummary?: string | null;
  agentName?: string | null;
  updatedAt?: string | null;
}

export interface ReviewLifecycleSnapshot {
  status?: string | null;
  phase?: string | null;
  isActive?: boolean;
  isTerminal?: boolean;
  canRetry?: boolean;
  error?: string | null;
  updatedAt?: string | null;
  reviewedAt?: string | null;
  hasProgress?: boolean;
  sourceStatus?: string | null;
}

export interface ReviewQueueEntry {
  id?: string;
  type?: string;
  status?: string;
  projectId?: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
  changesetId?: string;
  queuedAt?: string;
  updatedAt?: string;
  reviewedAt?: string;
  reviewError?: string | null;
  progress?: ReviewProgressSnapshot | null;
  lifecycle?: ReviewLifecycleSnapshot | null;
}

export interface ReviewQueueResponse {
  success?: boolean;
  queue?: ReviewQueueEntry[];
}

export interface ReviewQueueMutationResponse {
  success?: boolean;
  id?: string;
  position?: number;
  alreadyRunning?: boolean;
  branchReview?: BranchReviewSummary;
  workspaceReview?: WorkspaceReviewSummary;
  prReview?: PrReviewSummary;
}

export type BranchReviewQueueResponse = ReviewQueueMutationResponse;
export type WorkspaceReviewQueueResponse = ReviewQueueMutationResponse;
export type PrReviewQueueResponse = ReviewQueueMutationResponse;

export interface BranchReviewRunResponse {
  success?: boolean;
  review?: unknown;
  alreadyRunning?: boolean;
  id?: string | null;
  position?: number | null;
  branchReview?: BranchReviewSummary;
}

export interface ReviewCancelResponse {
  success?: boolean;
  stopped?: boolean;
  was?: string | null;
}

export type BranchReviewCancelResponse = ReviewCancelResponse;
export type WorkspaceReviewCancelResponse = ReviewCancelResponse;
export type PrReviewCancelResponse = ReviewCancelResponse;

export interface ReviewFileContent {
  path: string;
  oldPath?: string | null;
  status?: string;
  additions?: number;
  deletions?: number;
  beforeHash?: string | null;
  afterHash?: string | null;
  before?: string | null;
  after?: string | null;
  patch?: string | null;
  [key: string]: unknown;
}

export type BranchReviewFileContent = ReviewFileContent;

export interface ReviewFileContentResponse {
  success?: boolean;
  files?: ReviewFileContent[];
  missingPaths?: string[];
}

export type BranchReviewFileContentResponse = ReviewFileContentResponse;
export type WorkspaceReviewFileContentResponse = ReviewFileContentResponse;
export type PrReviewFileContentResponse = ReviewFileContentResponse;

export type ReviewOutcomeStatus = 'addressed' | 'dismissed';

export interface ReviewOutcomeDimensions {
  providerType: string;
  providerModel: string;
  language: string;
  pathPattern: string;
}

export interface ReviewOutcomeScope {
  projectId: string;
  reviewType: ReviewType;
  reviewId: string;
}

export type ReviewType = 'branch_review' | 'workspace_review' | 'pr_review' | 'changeset';

export interface ReviewTargetRef {
  type: ReviewType;
  id: string;
  displayId: string | null;
  label: string;
}

export interface ResolvedReviewTarget {
  review: ReviewTargetRef | null;
  branchReview: BranchReviewSummary | WorkspaceReviewSummary | null;
  prReview: PrReviewSummary | null;
}

export interface ReviewOutcomeRecord {
  projectId: string;
  reviewType: string;
  reviewId: string;
  recommendationKey: string;
  status: ReviewOutcomeStatus;
  note: string | null;
  dimensions: ReviewOutcomeDimensions;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type GitHubReviewAction = 'comment' | 'approve' | 'request_changes';

export interface ReviewPublicationRecord {
  recommendationKey: string;
  channel: string;
  action: GitHubReviewAction;
  githubReviewId?: string | null;
  githubPrNumber?: number | null;
  headSha?: string | null;
  path?: string | null;
  line?: number | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
}

export interface ReviewPublicationsResponse {
  success?: boolean;
  publication?: {
    scope?: {
      projectId?: string;
      reviewType?: ReviewType;
      reviewId?: string;
    };
    publications?: ReviewPublicationRecord[];
    byRecommendationKey?: Record<string, ReviewPublicationRecord>;
    totalPublished?: number;
    latestAction?: GitHubReviewAction | null;
    latestPublishedAt?: string | null;
  };
}

export interface PrReviewGitHubPublishResponse extends ReviewPublicationsResponse {
  reviewSubmission?: {
    event?: string;
    githubReviewId?: string | null;
    htmlUrl?: string | null;
    state?: string | null;
    commentCount?: number;
    submittedAt?: string | null;
  } | null;
  results?: Array<{
    recommendationKey?: string;
    status?: 'published' | 'already_published' | 'skipped' | 'failed';
    reason?: string | null;
    path?: string | null;
    line?: number | null;
    githubReviewId?: string | null;
  }>;
}

export interface ReviewOutcomeByRecommendationKey {
  recommendationKey: string;
  status: ReviewOutcomeStatus;
  note: string | null;
  dimensions: ReviewOutcomeDimensions;
  updatedAt?: string | null;
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

export interface ReviewOutcomesResponse {
  success?: boolean;
  scope?: ReviewOutcomeScope;
  outcomes?: ReviewOutcomeRecord[];
  byRecommendationKey?: Record<string, ReviewOutcomeByRecommendationKey>;
  telemetry?: ReviewOutcomeTelemetry;
}

export interface ReviewOutcomeMutationPayload {
  status: ReviewOutcomeStatus;
  note?: string | null;
  recommendationKey?: string;
  recommendation?: ReviewRecommendation;
  filePath?: string;
}

export interface ReviewOutcomeUpsertResponse extends ReviewOutcomesResponse {
  outcome?: ReviewOutcomeRecord;
}

export interface ReviewOutcomeDeleteResponse extends ReviewOutcomesResponse {
  deletedOutcome?: ReviewOutcomeRecord | null;
}

export interface HealthResponse {
  status?: string;
  timestamp?: string;
  database?: string;
  docker?: string;
  [key: string]: unknown;
}

export interface StatusToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef | null;
  branchReview: CompactReviewRecord | null;
  prReview: CompactReviewRecord | null;
  queueCount: number;
  queueForCurrentReview: CompactQueueEntry[];
  queueForCurrentReviewCount: number;
  lifecycleStatus: string;
  queueState: 'queued_or_running' | 'no_active_queue';
  activeExecution: ReviewActiveExecutionStatus | null;
}

export interface CompactReviewRecord {
  id: string;
  displayId: string | null;
  reviewStatus: string | null;
  lifecycleStatus: string | null;
  branchName?: string | null;
  baseBranch?: string | null;
  headBranch?: string | null;
  githubPrNumber?: number | null;
  updatedAt?: string | null;
}

export interface CompactQueueEntry {
  id: string | null;
  type: ReviewQueueEntry['type'];
  status: string | null;
  branchReviewId?: string | null;
  workspaceReviewId?: string | null;
  prReviewId?: string | null;
  queuedAt?: string | null;
  updatedAt?: string | null;
}

export interface LatestToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  branchReview: CompactReviewRecord | null;
  prReview: CompactReviewRecord | null;
  summary: string;
  riskLevel: string;
  findings: Array<{
    findingId: string;
    recommendationKey: string;
    severity: string;
    title: string;
    previousFinding?: boolean;
    file?: string;
    line?: number;
    outcome?: ReviewOutcomeByRecommendationKey | null;
  }>;
}

export interface RunCurrentToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  branchReview: CompactReviewRecord | null;
  prReview: CompactReviewRecord | null;
  mode: 'queue' | 'immediate';
  queueId: string | null;
  queuePosition: number | null;
  reviewStatus: string;
  lifecycleStatus: string;
  alreadyRunning?: boolean;
  requestTimedOut?: boolean;
}

export interface QueueCancelToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  branchReview: CompactReviewRecord | null;
  prReview: CompactReviewRecord | null;
  stopped: boolean;
  was: string | null;
}

export interface ReviewActiveExecutionStatus {
  queueEntryId: string | null;
  queuePosition: number | null;
  lifecycleStatus: string;
  phase: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  elapsedSeconds: number | null;
  secondsSinceLastActivity: number | null;
  filesCompleted: number | null;
  totalFiles: number | null;
  currentChunk: number | null;
  totalChunks: number | null;
  retryAttempt: number | null;
  retryMaxAttempts: number | null;
  isActive: boolean;
  isTerminal: boolean;
  isStale: boolean;
  staleAfterSeconds: number;
  executionNote: string | null;
  queueStatus: string | null;
  error: string | null;
  progress: ReviewProgressSnapshot | null;
  lifecycle: ReviewLifecycleSnapshot | null;
}

export interface WaitForTerminalToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef | null;
  branchReview: CompactReviewRecord | null;
  prReview: CompactReviewRecord | null;
  status: StatusToolData;
  terminal: boolean;
  timedOut: boolean;
  continuationRecommended: boolean;
  hostWindowLimited: boolean;
  latest: LatestToolData | null;
  timeoutMs: number;
  pollIntervalMs: number;
  hostToolTimeoutMs: number;
  effectiveWaitWindowMs: number;
}

export interface ConfigGetToolData {
  project: CompactProjectSummary;
  strategySettingKey: 'review_model_strategy';
  reviewStrategy: ReviewModelStrategy;
  strategySource: 'persisted' | 'default';
  activeReviewProvider: {
    providerId: string | null;
    model: string | null;
    provider: ProviderMetadata | null;
  };
  providers: ProviderMetadata[];
}

export interface ConfigSetStrategyToolData {
  project: CompactProjectSummary;
  strategySettingKey: 'review_model_strategy';
  reviewStrategy: ReviewModelStrategy;
  previousReviewStrategy: ReviewModelStrategy | null;
}

export interface FileToolFinding {
  findingId: string;
  recommendationKey: string;
  type: string;
  severity: string;
  title: string;
  description: string;
  previousFinding?: boolean;
  file?: string;
  line?: number;
  outcome?: ReviewOutcomeByRecommendationKey | null;
}

export interface FileToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  branchReview: CompactReviewRecord | null;
  prReview: CompactReviewRecord | null;
  path: string;
  file: ReviewFileContent | null;
  fileInScope: boolean;
  missingPaths: string[];
  findings: FileToolFinding[];
}

export interface OutcomeSetToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  status: ReviewOutcomeStatus;
  recommendationKey: string | null;
  outcome: ReviewOutcomeRecord | null;
  outcomes: ReviewOutcomeRecord[];
  telemetry: ReviewOutcomeTelemetry | null;
}

export interface OutcomeGetToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  outcomes: ReviewOutcomeRecord[];
  byRecommendationKey: Record<string, ReviewOutcomeByRecommendationKey>;
  telemetry: ReviewOutcomeTelemetry | null;
}

export interface OutcomeClearToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  recommendationKey: string;
  deletedOutcome: ReviewOutcomeRecord | null;
  outcomes: ReviewOutcomeRecord[];
  telemetry: ReviewOutcomeTelemetry | null;
}

export interface GitHubPublicationsToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  publication: NonNullable<ReviewPublicationsResponse['publication']>;
}

export interface GitHubPublishToolData {
  project: CompactProjectSummary;
  review: ReviewTargetRef;
  action: GitHubReviewAction;
  publication: NonNullable<ReviewPublicationsResponse['publication']>;
  reviewSubmission: PrReviewGitHubPublishResponse['reviewSubmission'] | null;
  results: NonNullable<PrReviewGitHubPublishResponse['results']>;
}

export interface ToolExecutionResult<TData = unknown> {
  summary: string;
  data: TData;
  nextActions?: string[];
}

export interface PromptArgumentDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface PromptExecutionResult {
  description?: string;
  messages: PromptMessage[];
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: PromptArgumentDefinition[];
  handler: (args: Record<string, string>) => Promise<PromptExecutionResult>;
}

export interface ResourceExecutionResult<TData = unknown> {
  summary: string;
  data: TData;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  handler: () => Promise<ResourceExecutionResult>;
}
