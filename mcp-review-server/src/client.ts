import { loadConfig, type AtlasConfig } from './config.js';
import { readDiscoveryEntry, type DiscoveryResult } from './desktopDiscovery.js';
import { AtlasMcpError } from './errors.js';
import type {
  BranchReviewCancelResponse,
  BranchReviewFileContentResponse,
  BranchReviewQueueResponse,
  BranchReviewRunResponse,
  BranchReviewScope,
  BranchReviewSummary,
  BranchReviewDetailsResponse,
  BranchReviewsResponse,
  WorkspaceReviewSummary,
  WorkspaceReviewDetailsResponse,
  WorkspaceReviewsResponse,
  WorkspaceReviewQueueResponse,
  WorkspaceReviewCancelResponse,
  WorkspaceReviewFileContentResponse,
  ChangesetDetailsResponse,
  HealthResponse,
  OpenLocalResponse,
  ProviderContext,
  ProviderContextActiveResponse,
  ProvidersResponse,
  PrReviewDetailsResponse,
  PrReviewSummary,
  PrReviewFileContentResponse,
  PrReviewGitHubPublishResponse,
  PrReviewQueueResponse,
  PrReviewCancelResponse,
  PrReviewsResponse,
  ProjectSummary,
  ProjectsResponse,
  ReviewPublicationsResponse,
  ReviewOutcomeDeleteResponse,
  ReviewOutcomeMutationPayload,
  ReviewOutcomeUpsertResponse,
  ReviewOutcomesResponse,
  ReviewType,
  ReviewQueueEntry,
  ReviewQueueResponse,
  SettingValueResponse,
} from './types.js';

interface RequestOptions {
  allowNotFound?: boolean;
  timeoutMs?: number;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

type BackendUrlSource = 'discovery' | 'configured';

const DISCOVERY_CACHE_TTL_MS = 30_000;

export class AtlasApiClient {
  private readonly config: AtlasConfig;
  private resolvedBackendUrl: string;
  private resolvedSource: BackendUrlSource;
  private resolvedAt: number;

  constructor(config: AtlasConfig = loadConfig()) {
    this.config = config;
    const initial = this.computeBackendUrl();
    this.resolvedBackendUrl = initial.url;
    this.resolvedSource = initial.source;
    this.resolvedAt = Date.now();
  }

  /**
   * Resolve a fresh backend URL. Prefers the desktop discovery file when it
   * exists and the app process is alive; otherwise falls back to the
   * configured `ATLAS_BACKEND_URL` (which may itself be stale, and that's
   * fine — it becomes the last-resort guess).
   */
  private computeBackendUrl(): { url: string; source: BackendUrlSource; discovery?: DiscoveryResult } {
    try {
      const discovered = readDiscoveryEntry();
      if (discovered) {
        return { url: stripTrailingSlash(discovered.url), source: 'discovery', discovery: discovered };
      }
    } catch {
      // Discovery is best-effort; any failure means we just fall back.
    }
    return { url: stripTrailingSlash(this.config.backendUrl), source: 'configured' };
  }

  private refreshResolvedUrlIfStale(): void {
    if (Date.now() - this.resolvedAt < DISCOVERY_CACHE_TTL_MS) return;
    const fresh = this.computeBackendUrl();
    this.resolvedBackendUrl = fresh.url;
    this.resolvedSource = fresh.source;
    this.resolvedAt = Date.now();
  }

  /**
   * Invalidate the cached URL after a connection failure so the next request
   * re-reads the discovery file and/or falls back to the configured URL.
   * Returns `true` if the URL actually changed, so callers can choose to retry.
   */
  private invalidateResolvedUrl(): boolean {
    const previousUrl = this.resolvedBackendUrl;
    const previousSource = this.resolvedSource;
    const fresh = this.computeBackendUrl();

    // If discovery still points to the same URL we just failed on, demote to
    // the configured fallback so we actually try something different.
    if (fresh.url === previousUrl) {
      const configuredUrl = stripTrailingSlash(this.config.backendUrl);
      if (previousSource === 'discovery' && configuredUrl && configuredUrl !== previousUrl) {
        this.resolvedBackendUrl = configuredUrl;
        this.resolvedSource = 'configured';
        this.resolvedAt = Date.now();
        return true;
      }
      // Both discovery and configured agree on the failing URL — nothing else
      // we can try. Keep cache fresh so we don't hammer the discovery read.
      this.resolvedAt = Date.now();
      return false;
    }

    this.resolvedBackendUrl = fresh.url;
    this.resolvedSource = fresh.source;
    this.resolvedAt = Date.now();
    return true;
  }

  getConfig(): AtlasConfig {
    return this.config;
  }

  async getProjects(): Promise<ProjectSummary[]> {
    const response = await this.request<ProjectsResponse>('GET', '/projects');
    return Array.isArray(response.projects) ? response.projects : [];
  }

  async openLocal(localPath: string): Promise<ProjectSummary | null> {
    const response = await this.request<OpenLocalResponse>('POST', '/projects/open-local', {
      body: { localPath },
    });
    return response.project || null;
  }

  async getSetting(key: string): Promise<SettingValueResponse> {
    return this.request<SettingValueResponse>('GET', `/settings/${encodeURIComponent(key)}`);
  }

  async setSetting(key: string, value: unknown): Promise<SettingValueResponse> {
    return this.request<SettingValueResponse>('PUT', `/settings/${encodeURIComponent(key)}`, {
      body: { value },
    });
  }

  async listProviders(): Promise<ProvidersResponse> {
    return this.request<ProvidersResponse>('GET', '/providers');
  }

  async getContextActiveProvider(context: ProviderContext): Promise<ProviderContextActiveResponse> {
    return this.request<ProviderContextActiveResponse>('GET', `/providers/context-active/${encodeURIComponent(context)}`);
  }

  async listBranchReviews(projectId: string): Promise<BranchReviewSummary[]> {
    const response = await this.request<BranchReviewsResponse>('GET', `/projects/${encodeURIComponent(projectId)}/branch-reviews`);
    return Array.isArray(response.branchReviews) ? response.branchReviews : [];
  }

  async getBranchReview(projectId: string, branchReviewId: string): Promise<BranchReviewSummary | null> {
    const response = await this.request<BranchReviewDetailsResponse>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/branch-reviews/${encodeURIComponent(branchReviewId)}`,
      { allowNotFound: true }
    );
    return response.branchReview || null;
  }

  async listWorkspaceReviews(projectId: string): Promise<WorkspaceReviewSummary[]> {
    const response = await this.request<WorkspaceReviewsResponse>('GET', `/projects/${encodeURIComponent(projectId)}/workspace-reviews`);
    return Array.isArray(response.workspaceReviews) ? response.workspaceReviews : [];
  }

  async getWorkspaceReview(projectId: string, workspaceReviewId: string): Promise<WorkspaceReviewSummary | null> {
    const response = await this.request<WorkspaceReviewDetailsResponse>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/workspace-reviews/${encodeURIComponent(workspaceReviewId)}`,
      { allowNotFound: true }
    );
    return response.workspaceReview || null;
  }

  async getPrReview(projectId: string, prReviewId: string) {
    const response = await this.request<PrReviewDetailsResponse>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/pr-reviews/${encodeURIComponent(prReviewId)}`,
      { allowNotFound: true }
    );
    return response.prReview || null;
  }

  async listPrReviews(projectId: string): Promise<PrReviewSummary[]> {
    const response = await this.request<PrReviewsResponse>('GET', `/projects/${encodeURIComponent(projectId)}/pr-reviews`);
    return Array.isArray(response.prReviews) ? response.prReviews : [];
  }

  async getPrReviewPublications(projectId: string, prReviewId: string): Promise<ReviewPublicationsResponse> {
    return this.request<ReviewPublicationsResponse>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/pr-reviews/${encodeURIComponent(prReviewId)}/github-review/publications`
    );
  }

  async publishPrReview(
    projectId: string,
    prReviewId: string,
    payload: {
      action: 'comment' | 'approve' | 'request_changes';
      recommendationKeys?: string[];
      body?: string | null;
    }
  ): Promise<PrReviewGitHubPublishResponse> {
    return this.request<PrReviewGitHubPublishResponse>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/pr-reviews/${encodeURIComponent(prReviewId)}/github-review`,
      { body: payload }
    );
  }

  async getChangeset(projectId: string, changesetId: string) {
    const response = await this.request<ChangesetDetailsResponse>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(changesetId)}`,
      { allowNotFound: true }
    );
    return response.changeset || null;
  }

  async getReviewQueue(): Promise<ReviewQueueEntry[]> {
    const response = await this.request<ReviewQueueResponse>('GET', '/review-queue');
    return Array.isArray(response.queue) ? response.queue : [];
  }

  async queueBranchReview(
    projectId: string,
    branchReviewId: string,
    options: { scope?: BranchReviewScope; reviewMode?: 'auto' | 'full' } = {}
  ): Promise<BranchReviewQueueResponse> {
    const body: Record<string, unknown> = {};
    if (options.scope) body.scope = options.scope;
    if (options.reviewMode) body.reviewMode = options.reviewMode;
    return this.request<BranchReviewQueueResponse>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/branch-reviews/${encodeURIComponent(branchReviewId)}/review/queue`,
      { body }
    );
  }

  async queueWorkspaceReview(
    projectId: string,
    workspaceReviewId: string,
    options: { reviewMode?: 'auto' | 'full' } = {}
  ): Promise<WorkspaceReviewQueueResponse> {
    const body: Record<string, unknown> = {};
    if (options.reviewMode) body.reviewMode = options.reviewMode;
    return this.request<WorkspaceReviewQueueResponse>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/workspace-reviews/${encodeURIComponent(workspaceReviewId)}/review/queue`,
      { body }
    );
  }

  async runBranchReview(
    projectId: string,
    branchReviewId: string,
    options: { scope?: BranchReviewScope; reviewMode?: 'auto' | 'full'; timeoutMs?: number } = {}
  ): Promise<BranchReviewRunResponse> {
    const body: Record<string, unknown> = {};
    if (options.scope) body.scope = options.scope;
    if (options.reviewMode) body.reviewMode = options.reviewMode;
    return this.request<BranchReviewRunResponse>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/branch-reviews/${encodeURIComponent(branchReviewId)}/review`,
      {
        body,
        timeoutMs: options.timeoutMs,
      }
    );
  }

  async cancelBranchReviewQueue(projectId: string, branchReviewId: string): Promise<BranchReviewCancelResponse> {
    return this.request<BranchReviewCancelResponse>(
      'DELETE',
      `/projects/${encodeURIComponent(projectId)}/branch-reviews/${encodeURIComponent(branchReviewId)}/review/queue`
    );
  }

  async cancelWorkspaceReviewQueue(projectId: string, workspaceReviewId: string): Promise<WorkspaceReviewCancelResponse> {
    return this.request<WorkspaceReviewCancelResponse>(
      'DELETE',
      `/projects/${encodeURIComponent(projectId)}/workspace-reviews/${encodeURIComponent(workspaceReviewId)}/review/queue`
    );
  }

  async queuePrReview(projectId: string, prReviewId: string): Promise<PrReviewQueueResponse> {
    return this.request<PrReviewQueueResponse>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/pr-reviews/${encodeURIComponent(prReviewId)}/review/queue`
    );
  }

  async cancelPrReviewQueue(projectId: string, prReviewId: string): Promise<PrReviewCancelResponse> {
    return this.request<PrReviewCancelResponse>(
      'DELETE',
      `/projects/${encodeURIComponent(projectId)}/pr-reviews/${encodeURIComponent(prReviewId)}/review/queue`
    );
  }

  async getBranchReviewFileContent(
    projectId: string,
    branchReviewId: string,
    paths: string[]
  ): Promise<BranchReviewFileContentResponse> {
    return this.request<BranchReviewFileContentResponse>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/branch-reviews/${encodeURIComponent(branchReviewId)}/files/content`,
      {
        body: { paths },
      }
    );
  }

  async getWorkspaceReviewFileContent(
    projectId: string,
    workspaceReviewId: string,
    paths: string[]
  ): Promise<WorkspaceReviewFileContentResponse> {
    return this.request<WorkspaceReviewFileContentResponse>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/workspace-reviews/${encodeURIComponent(workspaceReviewId)}/files/content`,
      {
        body: { paths },
      }
    );
  }

  async getPrReviewFileContent(
    projectId: string,
    prReviewId: string,
    paths: string[]
  ): Promise<PrReviewFileContentResponse> {
    return this.request<PrReviewFileContentResponse>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/pr-reviews/${encodeURIComponent(prReviewId)}/files/content`,
      {
        body: { paths },
      }
    );
  }

  async listReviewOutcomes(projectId: string, reviewType: ReviewType, reviewId: string): Promise<ReviewOutcomesResponse> {
    return this.request<ReviewOutcomesResponse>('GET', this.getReviewOutcomesPath(projectId, reviewType, reviewId));
  }

  async upsertReviewOutcome(
    projectId: string,
    reviewType: ReviewType,
    reviewId: string,
    payload: ReviewOutcomeMutationPayload
  ): Promise<ReviewOutcomeUpsertResponse> {
    return this.request<ReviewOutcomeUpsertResponse>('PUT', this.getReviewOutcomesPath(projectId, reviewType, reviewId), {
      body: payload,
    });
  }

  async deleteReviewOutcome(
    projectId: string,
    reviewType: ReviewType,
    reviewId: string,
    payload: Pick<ReviewOutcomeMutationPayload, 'recommendationKey' | 'recommendation'>
  ): Promise<ReviewOutcomeDeleteResponse> {
    return this.request<ReviewOutcomeDeleteResponse>(
      'DELETE',
      this.getReviewOutcomesPath(projectId, reviewType, reviewId),
      { body: payload }
    );
  }

  async getHealth(): Promise<HealthResponse> {
    this.refreshResolvedUrlIfStale();
    const apiBase = stripTrailingSlash(this.resolvedBackendUrl);
    const healthUrl = apiBase.endsWith('/api') ? `${apiBase.slice(0, -4)}/health` : `${apiBase}/health`;
    return this.requestAbsolute<HealthResponse>('GET', healthUrl);
  }

  private async requestAbsolute<T>(method: string, url: string, options?: { body?: unknown }): Promise<T> {
    try {
      return await this.requestInternal<T>(method, url, options);
    } catch (error) {
      if (this.shouldRetryAfterUnreachable(error) && this.invalidateResolvedUrl()) {
        return this.requestInternal<T>(method, url, options);
      }
      throw error;
    }
  }

  private async request<T>(method: string, path: string, options?: { body?: unknown } & RequestOptions): Promise<T> {
    this.refreshResolvedUrlIfStale();
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const firstAttemptUrl = `${stripTrailingSlash(this.resolvedBackendUrl)}${normalizedPath}`;
    try {
      return await this.requestInternal<T>(method, firstAttemptUrl, options);
    } catch (error) {
      if (!this.shouldRetryAfterUnreachable(error)) throw error;
      if (!this.invalidateResolvedUrl()) throw error;
      const retryUrl = `${stripTrailingSlash(this.resolvedBackendUrl)}${normalizedPath}`;
      return this.requestInternal<T>(method, retryUrl, options);
    }
  }

  private shouldRetryAfterUnreachable(error: unknown): boolean {
    return error instanceof AtlasMcpError && error.code === 'BACKEND_UNREACHABLE';
  }

  private getReviewOutcomesPath(projectId: string, reviewType: ReviewType, reviewId: string): string {
    const encodedProjectId = encodeURIComponent(projectId);
    const encodedReviewId = encodeURIComponent(reviewId);
    if (reviewType === 'branch_review') {
      return `/projects/${encodedProjectId}/branch-reviews/${encodedReviewId}/review/outcomes`;
    }
    if (reviewType === 'pr_review') {
      return `/projects/${encodedProjectId}/pr-reviews/${encodedReviewId}/review/outcomes`;
    }
    if (reviewType === 'workspace_review') {
      return `/projects/${encodedProjectId}/workspace-reviews/${encodedReviewId}/review/outcomes`;
    }
    return `/projects/${encodedProjectId}/changesets/${encodedReviewId}/review/outcomes`;
  }

  private async requestInternal<T>(
    method: string,
    url: string,
    options?: { body?: unknown } & RequestOptions
  ): Promise<T> {
    const timeoutMs = Number.isFinite(options?.timeoutMs) && Number(options?.timeoutMs) > 0
      ? Number(options?.timeoutMs)
      : this.config.requestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers = new Headers();
    headers.set('Accept', 'application/json');

    let body: string | undefined;
    if (options?.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set('Content-Type', 'application/json');
    }

    if (this.config.apiToken) {
      headers.set('Authorization', `Bearer ${this.config.apiToken}`);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AtlasMcpError('REQUEST_TIMEOUT', `Request timed out after ${timeoutMs}ms`, {
          details: { url, method, timeoutMs },
        });
      }
      throw new AtlasMcpError('BACKEND_UNREACHABLE', `Atlas backend not reachable at ${url}`, {
        details: { url, method, error, resolvedSource: this.resolvedSource },
      });
    }

    clearTimeout(timeout);

    const text = await response.text();
    const payload = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      if (response.status === 404 && options?.allowNotFound) {
        return {} as T;
      }
      throw this.mapHttpError(response.status, payload, method, url);
    }

    if (payload && typeof payload === 'object') {
      return payload as T;
    }

    return {} as T;
  }

  private mapHttpError(status: number, payload: unknown, method: string, url: string): AtlasMcpError {
    const message = extractErrorMessage(payload) || `Request failed with status ${status}`;
    const lower = message.toLowerCase();

    if (lower.includes('no active ai provider')) {
      return new AtlasMcpError('NO_ACTIVE_PROVIDER', message, { status, details: { method, url, payload } });
    }

    if (lower.includes('project not found')) {
      return new AtlasMcpError('PROJECT_NOT_FOUND', message, { status, details: { method, url, payload } });
    }

    if (lower.includes('branch review not found')) {
      return new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', message, { status, details: { method, url, payload } });
    }

    if (lower.includes('pr review not found')) {
      return new AtlasMcpError('PR_REVIEW_NOT_FOUND', message, { status, details: { method, url, payload } });
    }

    if (lower.includes('workspace review not found')) {
      return new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', message, { status, details: { method, url, payload } });
    }

    if (lower.includes('changeset not found')) {
      return new AtlasMcpError('CHANGESET_NOT_FOUND', message, { status, details: { method, url, payload } });
    }

    if (
      lower.includes('paths must include at least one file path')
      || lower.includes('recommendationkey is required')
      || lower.includes('recommendation must be')
      || lower.includes('status must be one of: addressed, dismissed')
    ) {
      return new AtlasMcpError('INVALID_INPUT', message, { status, details: { method, url, payload } });
    }

    if (status === 400) {
      return new AtlasMcpError('INVALID_INPUT', message, { status, details: { method, url, payload } });
    }

    if (status === 408 || status === 504) {
      return new AtlasMcpError('REQUEST_TIMEOUT', message, { status, details: { method, url, payload } });
    }

    return new AtlasMcpError('UNKNOWN_ERROR', message, { status, details: { method, url, payload } });
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const maybeError = (payload as Record<string, unknown>).error;
  if (typeof maybeError === 'string' && maybeError.trim()) return maybeError;
  const maybeMessage = (payload as Record<string, unknown>).message;
  if (typeof maybeMessage === 'string' && maybeMessage.trim()) return maybeMessage;
  return null;
}
