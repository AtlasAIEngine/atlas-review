/**
 * API Client
 * Axios-based client for AtlasEngine backend API
 */

import axios from 'axios';
// @ts-ignore Shared JS helper is consumed by both backend and frontend runtimes.
import reviewPrecisionStats from '../../../shared/reviewPrecisionStats.js';
const { normalizePrecisionIssueCounters: normalizeSharedPrecisionIssueCounters } = reviewPrecisionStats as {
  normalizePrecisionIssueCounters: (stats: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, unknown>;
};
import type {
  Project,
  Preview,
  MemoryStats,
  FileItem,
  QuotaSummary,
  UiEditPayload,
  UiSelection,
  TestCase,
  TestStep,
  TestResult,
  ChangeSetIndex,
  ChangeSet,
  BranchReview,
  BranchReviewDiffScope,
  WorkspaceReview,
  BranchReviewScope,
  BranchReviewFileSummary,
  BranchReviewFileContent,
  PrReview,
  GitHubPrConversations,
  GitHubPrIssueComment,
  GitHubPrReviewThread,
  GitHubPrThreadComment,
  ReviewPublicationRecord,
  ReviewPublicationState,
  ReviewCommentEligibility,
  GitHubReviewAction,
  ReviewParityGate,
  ReviewLifecycle,
  LegacyReviewStatus,
  ReviewLifecycleStatus,
  ReviewRecommendation,
  RiskLevel,
  ReviewRecommendationOutcome,
  ReviewOutcomeScope,
  ReviewOutcomeTelemetry,
  ReviewFixRunArtifact,
  ReviewFixRunArtifactStatus,
  TrustAnalyticsRateMetric,
  TrustAnalyticsValueMetric,
  TrustReviewAnalytics,
  TrustAnalyticsScope,
  TrustAnalyticsReviewType,
  TrustAnalyticsSummary,
  TrustAnalyticsTimeseries,
  TrustAnalyticsBreakdown,
  TrustAnalyticsBreakdownDimension,
  TrustAnalyticsBreakdownMetric,
  ProjectSecret,
  IntegrationsResponse,
  DeploymentsResponse,
} from '@/types';
import { buildReviewRecommendationKey, normalizeRecommendationKeyPart } from '@/utils/reviewRecommendationKeys';
import { getBrowserDefaultApiBaseUrl } from '@/utils/apiBaseUrl';

// Dynamic API base URL - can be changed at runtime for desktop mode
const _DESKTOP_PORT = import.meta.env?.VITE_DESKTOP_BACKEND_PORT;
let _rawBaseUrl = import.meta.env?.VITE_API_BASE_URL
  || (_DESKTOP_PORT ? `http://127.0.0.1:${_DESKTOP_PORT}/api` : getBrowserDefaultApiBaseUrl());

// Normalise: all backend routes are mounted under /api, so ensure the base
// URL ends with /api.  A common misconfiguration is setting
// VITE_API_BASE_URL=http://localhost:3000 without the /api suffix.
// Strip trailing slashes first so /api/ doesn't bypass the endsWith check.
if (_rawBaseUrl) {
  _rawBaseUrl = _rawBaseUrl.replace(/\/+$/, '');
  if (!_rawBaseUrl.endsWith('/api')) {
    _rawBaseUrl += '/api';
  }
}
let API_BASE_URL = _rawBaseUrl;
const AUTH_TOKEN_STORAGE_KEY = 'auth_token';

/**
 * Set the API base URL dynamically (for desktop mode port discovery)
 */
export function setApiBaseUrl(url: string) {
  // Normalise — ensure /api suffix (see comment above)
  let normalized = url.replace(/\/+$/, '');
  if (normalized && !normalized.endsWith('/api')) {
    normalized += '/api';
  }
  API_BASE_URL = normalized;
  // Update the existing axios instance's baseURL
  api.defaults.baseURL = normalized;
}

/**
 * Get the current API base URL
 */
export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export function getAuthToken(): string | null {
  try {
    const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function getSocketAuth(): { token: string } | undefined {
  const token = getAuthToken();
  return token ? { token } : undefined;
}

// ---------------------------------------------------------------------------
// Guest-scoped review-sync fetch helper
// ---------------------------------------------------------------------------

const REVIEW_SYNC_AUTH_TOKEN_STORAGE_KEY = 'review_sync_auth_token';
const REVIEW_SYNC_USER_ID_STORAGE_KEY = 'review_sync_user_id';
let _ensureGuestSyncSessionPromise: Promise<string | null> | null = null;

export function getReviewSyncAuthToken(): string | null {
  try {
    const v = localStorage.getItem(REVIEW_SYNC_AUTH_TOKEN_STORAGE_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function setReviewSyncAuthToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(REVIEW_SYNC_AUTH_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(REVIEW_SYNC_AUTH_TOKEN_STORAGE_KEY);
    }
  } catch {
    /* noop */
  }
}

function setReviewSyncUserId(userId: string | null): void {
  try {
    if (userId) {
      localStorage.setItem(REVIEW_SYNC_USER_ID_STORAGE_KEY, userId);
    } else {
      localStorage.removeItem(REVIEW_SYNC_USER_ID_STORAGE_KEY);
    }
  } catch {
    /* noop */
  }
}

/**
 * Issue (or reuse) a guest review-sync session for this device. Idempotent;
 * concurrent calls share the same in-flight promise so we don't mint
 * multiple sessions from a single page load.
 */
function detectClientSource(): 'desktop' | 'browser' {
  // Tauri v2 exposes `__TAURI_INTERNALS__`; user agent also carries "Tauri".
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    if (w.__TAURI_INTERNALS__ || w.__TAURI__) return 'desktop';
    if (typeof navigator !== 'undefined' && /tauri/i.test(navigator.userAgent || '')) {
      return 'desktop';
    }
  }
  return 'browser';
}

export async function ensureGuestSyncSession(): Promise<string | null> {
  const cached = getReviewSyncAuthToken();
  if (cached) return cached;
  if (_ensureGuestSyncSessionPromise) return _ensureGuestSyncSessionPromise;

  _ensureGuestSyncSessionPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/review-sync/guest-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientSource: detectClientSource() }),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        success?: boolean;
        session?: { authToken?: string; userId?: string };
      };
      const token = payload?.session?.authToken || null;
      const userId = payload?.session?.userId || null;
      if (token) setReviewSyncAuthToken(token);
      if (userId) setReviewSyncUserId(userId);
      return token;
    } catch {
      return null;
    } finally {
      _ensureGuestSyncSessionPromise = null;
    }
  })();

  return _ensureGuestSyncSessionPromise;
}

interface FetchReviewSyncOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Fetch wrapper that attaches the guest review-sync authToken as a Bearer
 * header. Distinct from fetchAdmin/axios flows that use the admin JWT.
 */
export async function fetchReviewSync<T = unknown>(
  path: string,
  options: FetchReviewSyncOptions = {}
): Promise<T> {
  const token = getReviewSyncAuthToken() || (await ensureGuestSyncSession());
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const { body, ...rest } = options;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      message = payload?.error || payload?.message || message;
    } catch {
      /* noop */
    }
    throw new Error(message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface ApiErrorPayload {
  success?: boolean;
  error?: string;
  message?: string;
  details?: string;
  remediation?: string;
}

export function describeApiError(error: any, fallback: string): string {
  const payload = error?.response?.data as ApiErrorPayload | undefined;
  const primary = payload?.error
    || payload?.message
    || error?.message
    || fallback;
  const remediation = payload?.remediation;
  if (typeof remediation === 'string' && remediation.trim() && remediation.trim() !== primary) {
    return `${primary} ${remediation.trim()}`;
  }
  return primary;
}

export type ReviewPolicySource = 'trusted' | 'working_tree';

export type ReviewPolicyContentSource = 'saved' | 'generated' | 'starter';

export interface ReviewPolicyDefaults {
  requireEvidence?: boolean;
  allowPraise?: boolean;
  maxRecommendations?: number | null;
}

export interface ReviewPolicyLinterEntry {
  enabled?: boolean;
  allowAtlasManagedFallback?: boolean;
}

export interface ReviewPolicyLinters {
  enabled?: boolean;
  mode?: 'project_only' | 'fallback_if_missing' | (string & {});
  eslint?: ReviewPolicyLinterEntry;
  tsc?: ReviewPolicyLinterEntry;
  dotnet?: ReviewPolicyLinterEntry;
  dotnetFormat?: ReviewPolicyLinterEntry;
  semgrep?: ReviewPolicyLinterEntry;
}

export interface ReviewPolicyDocument {
  version?: number;
  defaults?: ReviewPolicyDefaults;
  promptAppend?: string[];
  rules?: {
    suppressionRules?: unknown[];
    mustCheckRules?: unknown[];
  };
  linters?: ReviewPolicyLinters | null;
  paths?: unknown[];
}

export interface ReviewPolicyParseError {
  code: string;
  message: string;
}

export interface ReviewPolicyLinterStatusEntry {
  policyDefaultEligible: boolean;
  runtimeReady: boolean;
  atlasManagedEligible: boolean;
  effectiveMode: 'project_linter' | 'atlas_managed' | 'unavailable';
  hasConfig: boolean;
  hasBinary: boolean | null;
  configLabel: string | null;
  binaryLabel: string | null;
}

export type ReviewPolicyLinterStatus = Record<string, ReviewPolicyLinterStatusEntry>;

type BranchReviewRunOptions = BranchReviewScope & {
  reviewMode?: 'auto' | 'full';
  resetSnapshot?: boolean;
  policySource?: ReviewPolicySource;
  partial?: boolean;
  force?: boolean;
};

type PrReviewRunOptions = {
  reviewMode?: 'auto' | 'full' | 'agentic_discovery';
  forceFullScope?: boolean;
  policySource?: ReviewPolicySource;
};

type WorkspaceReviewRunOptions = {
  reviewMode?: 'auto' | 'full';
  policySource?: ReviewPolicySource;
};

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

function shouldPreferReviewSyncAuth(url: unknown): boolean {
  return String(url || '').includes('/pr-reviews');
}

// Request interceptor (add auth token if available)
api.interceptors.request.use(async (config) => {
  const legacyToken = getAuthToken();
  const preferReviewSync = shouldPreferReviewSyncAuth(config.url);
  const existingReviewSyncToken = preferReviewSync ? getReviewSyncAuthToken() : null;
  const reviewSyncToken = preferReviewSync && !legacyToken
    ? (existingReviewSyncToken || await ensureGuestSyncSession())
    : null;
  const token = reviewSyncToken || legacyToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor (handle errors)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const serverMessage = error?.response?.data?.error
      || error?.response?.data?.message
      || error?.response?.data?.details;
    if (typeof serverMessage === 'string' && serverMessage.trim()) {
      error.message = serverMessage.trim();
    }

    if (error.response?.status === 401) {
      // Handle unauthorized
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ============================================================================
// TEMPLATE API
// ============================================================================

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  githubRepo: string;
  framework: string;
  language: string;
}

export const templateApi = {
  list: async () => {
    const response = await api.get<{ success: boolean; templates: Template[] }>('/templates');
    return response.data;
  },
};

// ============================================================================
// PROJECT API
// ============================================================================

export const projectApi = {
  create: async (data: { name: string; description?: string; framework?: string; language?: string; templateId?: string }) => {
    const response = await api.post<{ success: boolean; project: Project }>('/projects', data);
    return response.data;
  },

  list: async (params?: { limit?: number; offset?: number; status?: string }) => {
    const response = await api.get<{ success: boolean; projects: Project[] }>('/projects', { params });
    return response.data;
  },

  get: async (id: string) => {
    const response = await api.get<{ success: boolean; project: Project }>(`/projects/${id}`);
    return response.data;
  },

  update: async (id: string, data: Partial<Project>) => {
    const response = await api.patch<{ success: boolean }>(`/projects/${id}`, data);
    return response.data;
  },

  delete: async (id: string) => {
    const response = await api.delete<{ success: boolean }>(`/projects/${id}`);
    return response.data;
  },

  deleteAttachments: async (id: string) => {
    const response = await api.delete<{ success: boolean; deleted: boolean; count: number }>(`/projects/${id}/attachments`);
    return response.data;
  },

  revealInFolder: async (id: string) => {
    const response = await api.post<{ success: boolean; path: string }>(`/projects/${id}/reveal`);
    return response.data;
  },

  getGitStatus: async (id: string) => {
    const response = await api.get<{ success: boolean } & GitStatus>(`/projects/${id}/git-status`);
    return response.data;
  },

  revealAttachments: async (id: string) => {
    const response = await api.post<{ success: boolean; path: string }>(`/projects/${id}/attachments/reveal`);
    return response.data;
  },

  /**
   * Open a local folder as a project (trust pipeline)
   */
  openLocal: async (localPath: string, name?: string) => {
    const response = await api.post<{
      success: boolean;
      alreadyExists?: boolean;
      project: {
        id: string;
        sessionId: string;
        name: string;
        description: string;
        hasGit: boolean;
        branch: string | null;
        watching: boolean;
        createdAt: string;
      };
    }>('/projects/open-local', { localPath, name });
    return response.data;
  },

  pickLocalFolder: async () => {
    const response = await api.post<{
      success: boolean;
      cancelled?: boolean;
      localPath: string | null;
    }>('/projects/open-local/dialog');
    return response.data;
  },

  build: async (id: string) => {
    const response = await api.post<{ success: boolean; buildId: string; logs?: string }>(`/projects/${id}/build`);
    return response.data;
  },

  deploy: async (id: string, buildId: string) => {
    const response = await api.post<{ success: boolean; preview: Preview }>(`/projects/${id}/deploy`, { buildId });
    return response.data;
  },

  listFiles: async (id: string, path = '') => {
    const response = await api.get<{ success: boolean; files: FileItem[] }>(`/projects/${id}/files`, {
      params: { path },
    });
    return response.data;
  },

  getFileContent: async (id: string, path: string) => {
    const response = await api.get<{ success: boolean; content: string }>(`/projects/${id}/files/content`, {
      params: { path },
    });
    return response.data;
  },

  updateFileContent: async (id: string, path: string, content: string) => {
    const response = await api.put<{ success: boolean }>(`/projects/${id}/files/content`, { path, content });
    return response.data;
  },

  generateName: async (id: string) => {
    const response = await api.post<{ success: boolean; name: string | null }>(`/projects/${id}/generate-name`);
    return response.data;
  },

  getPreviewState: async (id: string) => {
    const response = await api.get<{ success: boolean; preview: ProjectPreviewState }>(`/projects/${id}/preview-state`);
    return response.data;
  },

  /**
   * Download project as tar.gz archive for cloud deployment.
   */
  getArchive: async (id: string, queryParams?: string): Promise<ArrayBuffer> => {
    const response = await api.get(`/projects/${id}/archive${queryParams || ''}`, {
      responseType: 'arraybuffer',
    });
    return response.data;
  },
};

export type AgentInstructionTarget = 'claude' | 'codex' | 'cursor' | 'copilot' | 'vscode' | 'windsurf';

export interface AgentInstructionPreviewEntry {
  target: AgentInstructionTarget;
  label: string;
  filePath: string;
  relativeFilePath: string;
  content: string;
}

export interface AgentInstructionMutationResult {
  target: AgentInstructionTarget;
  label: string;
  filePath: string;
  relativeFilePath: string;
  changed: boolean;
  created?: boolean;
  removed?: boolean;
  backupPath: string | null;
  dryRun: boolean;
}

export interface AgentInstructionFailure {
  target?: string;
  label?: string;
  filePath?: string;
  error?: string;
  message?: string;
}

export const agentInstructionApi = {
  preview: async (projectId: string, targets: AgentInstructionTarget[]) => {
    const response = await api.get<{
      success: boolean;
      instructionBlock: string;
      previews: AgentInstructionPreviewEntry[];
    }>(`/projects/${projectId}/agent-instructions/preview`, {
      params: { targets: targets.join(',') },
    });
    return response.data;
  },

  generate: async (projectId: string, data: { targets: AgentInstructionTarget[]; dryRun?: boolean }) => {
    const response = await api.post<{
      success: boolean;
      instructionBlock: string;
      results: AgentInstructionMutationResult[];
      failures: AgentInstructionFailure[];
    }>(`/projects/${projectId}/agent-instructions`, data);
    return response.data;
  },

  remove: async (projectId: string, data: { targets: AgentInstructionTarget[]; dryRun?: boolean }) => {
    const response = await api.delete<{
      success: boolean;
      results: AgentInstructionMutationResult[];
      failures: AgentInstructionFailure[];
    }>(`/projects/${projectId}/agent-instructions`, {
      data,
    });
    return response.data;
  },
};

export const uiEditsApi = {
  save: async (projectId: string, selection: UiSelection, edits: UiEditPayload) => {
    const response = await api.post<{ success: boolean; path: string }>(
      `/projects/${projectId}/ui-edits`,
      { selection, edits }
    );
    return response.data;
  },
  get: async (projectId: string) => {
    const response = await api.get<{ success: boolean; content: string }>(
      `/projects/${projectId}/files/content`,
      { params: { path: 'public/atlas-ui-edits.json' } }
    );
    return response.data;
  },
};

// ============================================================================
// MEMORY API
// ============================================================================

export const memoryApi = {
  get: async (projectId: string) => {
    const response = await api.get<{ success: boolean; content: string; stats: MemoryStats }>(
      `/projects/${projectId}/memory`
    );
    return response.data;
  },

  update: async (projectId: string, updates: Record<string, string>) => {
    const response = await api.post<{ success: boolean }>(`/projects/${projectId}/memory`, { updates });
    return response.data;
  },

  createCheckpoint: async (projectId: string, name: string, notes?: string) => {
    const response = await api.post<{ success: boolean; checkpoint: any }>(`/projects/${projectId}/memory/checkpoint`, {
      name,
      notes,
    });
    return response.data;
  },

  getStats: async (projectId: string) => {
    const response = await api.get<{ success: boolean; stats: MemoryStats }>(`/projects/${projectId}/memory/stats`);
    return response.data;
  },

  compact: async (projectId: string, keepLastN = 5) => {
    const response = await api.post<{ success: boolean; removedCount: number }>(
      `/projects/${projectId}/memory/compact`,
      { keepLastN }
    );
    return response.data;
  },

  getHealth: async (projectId: string) => {
    const response = await api.get<{ success: boolean; health: any }>(`/projects/${projectId}/memory/health`);
    return response.data;
  },
};

export interface ReviewPolicyFileResponse {
  success: boolean;
  exists?: boolean;
  path: string;
  content: string;
  defaultContent?: string;
  contentSource?: ReviewPolicyContentSource;
  normalizedPolicy?: ReviewPolicyDocument | null;
  contentParseError?: ReviewPolicyParseError | null;
  starterPolicy?: ReviewPolicyDocument | null;
  linterStatus?: ReviewPolicyLinterStatus;
}

export const reviewPolicyApi = {
  get: async (projectId: string) => {
    const response = await api.get<ReviewPolicyFileResponse>(`/projects/${projectId}/review-policy`);
    return response.data;
  },

  update: async (projectId: string, content: string) => {
    const response = await api.put<ReviewPolicyFileResponse>(`/projects/${projectId}/review-policy`, { content });
    return response.data;
  },

  reset: async (projectId: string) => {
    const response = await api.post<ReviewPolicyFileResponse>(`/projects/${projectId}/review-policy/reset`);
    return response.data;
  },
};

// ============================================================================
// CHAT API
// ============================================================================

export interface UploadedFile {
  filename: string;
  originalName: string;
  path: string;
  mimetype: string;
  size: number;
  relativePath: string;
}

export const chatApi = {
  getRuntimeStatus: async (projectId: string) => {
    const response = await api.get<{
      success: boolean;
      active: boolean;
      startedAt: string | null;
      hasStreamContent: boolean;
      streamStartedAt: string | null;
    }>(`/chat/sessions/${projectId}/runtime-status`);
    return response.data;
  },

  /**
   * Upload files (images) for use in chat messages
   */
  uploadFiles: async (projectId: string, files: File[]) => {
    const formData = new FormData();
    files.forEach((file) => {
      formData.append('files', file);
    });

    // Add userId for authentication (mock for MVP)
    formData.append('userId', localStorage.getItem('userId') || '00000000-0000-0000-0000-000000000000');

    // Use the `api` axios instance so auth interceptor and 401 handler apply
    const response = await api.post<{ success: boolean; files: UploadedFile[]; count: number }>(
      `/chat/sessions/${projectId}/upload`,
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      }
    );

    return response.data;
  },

  getSlashCommands: async (projectId: string) => {
    const response = await api.get<{ success: boolean; commands: any[] }>(
      `/chat/sessions/${projectId}/commands`
    );
    return response.data;
  },

  saveSystemMessage: async (
    projectId: string,
    payload: { content: string; tone?: 'success' | 'error'; meta?: Record<string, any> }
  ) => {
    const response = await api.post<{ success: boolean }>(
      `/chat/sessions/${projectId}/system-message`,
      payload
    );
    return response.data;
  },
};

// ============================================================================
// QUOTA API
// ============================================================================

export const quotaApi = {
  getSummary: async () => {
    const response = await api.get<QuotaSummary>('/quotas/summary');
    return response.data;
  },
};

// ============================================================================
// DEV SERVER API
// ============================================================================

export interface DevServer {
  running: boolean;
  port?: number;
  url?: string;
  status?: string;
  error?: string | null;
  projectType?: string;
  startedAt?: string;
  uptime?: number;
  requiresDevServer?: boolean;
  supabasePlaceholder?: {
    injected: boolean;
    missingKeys: string[];
  };
}

export type ProjectPreviewLifecycle =
  | 'empty'
  | 'scaffolding'
  | 'dev_server_ready'
  | 'starting_dev_server'
  | 'dev_server_live'
  | 'static_ready'
  | 'dev_server_error';

export interface ProjectPreviewState {
  state: ProjectPreviewLifecycle;
  currentPath: string | null;
  requiresDevServer: boolean;
  hasPreviewableRoot: boolean;
  hasActiveAiRun: boolean;
  hasStreamContent: boolean;
  canAutoStartDevServer: boolean;
  canManualStartDevServer: boolean;
  devServer: DevServer;
}

export const devServerApi = {
  start: async (projectId: string) => {
    const response = await api.post<{ success: boolean; devServer: DevServer }>(`/devservers/${projectId}/start`);
    return response.data;
  },

  stop: async (projectId: string) => {
    const response = await api.delete<{ success: boolean; message: string }>(`/devservers/${projectId}`);
    return response.data;
  },

  getStatus: async (projectId: string) => {
    const response = await api.get<{ success: boolean; devServer: DevServer }>(`/devservers/${projectId}/status`);
    return response.data;
  },

  getLogs: async (projectId: string, limit?: number) => {
    const response = await api.get<{ success: boolean; logs: any[] }>(`/devservers/${projectId}/logs`, {
      params: { limit },
    });
    return response.data;
  },
};

// ============================================================================
// HEALTH API
// ============================================================================

export const healthApi = {
  check: async () => {
    const response = await api.get('/health');
    return response.data;
  },
};

// ============================================================================
// GITHUB API
// ============================================================================

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  description: string | null;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt: string;
  language?: string;
  size: number;
}

export interface GitHubInstallation {
  id: number;
  installation_id: number;
  account_login: string;
  account_type: string;
  account_avatar_url?: string;
  repositories_accessible?: string;
  permissions?: string;
  is_active: boolean;
  created_at: string;
}

export interface CreateRepoResponse {
  success: boolean;
  message: string;
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: string;
    private: boolean;
    html_url: string;
    clone_url: string;
    default_branch: string;
    created_at: string;
  };
  sync: {
    enabled: boolean;
    status: string;
    initial_commit: string;
    branch: string;
  };
}

export const githubApi = {
  /**
   * Get user's GitHub installation
   */
  getInstallation: async () => {
    const response = await api.get<{ success: boolean; installation: GitHubInstallation | null }>(
      '/github/installation'
    );
    return response.data;
  },

  /**
   * Get GitHub App connection URL
   */
  getConnectUrl: async () => {
    const response = await api.get<{ success: boolean; url: string }>('/github/connect');
    return response.data;
  },

  /**
   * List accessible repositories
   */
  getRepositories: async (page = 1, perPage = 100) => {
    const response = await api.get<{ success: boolean; repositories: GitHubRepository[] }>('/github/repositories', {
      params: { page, per_page: perPage },
    });
    return response.data;
  },

  /**
   * Clone a GitHub repository into AtlasEngine
   */
  cloneRepository: async (data: {
    owner: string;
    repo: string;
    name?: string;
    description?: string;
  }) => {
    const response = await api.post<{ success: boolean; project: Project; message: string }>(
      '/github/clone',
      data
    );
    return response.data;
  },

  /**
   * Create a new GitHub repository from an AtlasEngine project
   */
  createRepository: async (
    projectId: string,
    data: {
      name: string;
      description?: string;
      private?: boolean;
      org?: string;
    }
  ) => {
    const response = await api.post<CreateRepoResponse>(
      `/github/projects/${projectId}/create-repo`,
      data
    );
    return response.data;
  },

  /**
   * Disconnect GitHub account
   */
  disconnectAccount: async () => {
    const response = await api.post<{ success: boolean; message: string }>('/github/disconnect');
    return response.data;
  },

  /**
   * Get GitHub service health
   */
  getHealth: async () => {
    const response = await api.get<{ success: boolean; status: string; appName?: string; appId?: string }>(
      '/github/health'
    );
    return response.data;
  },
};

// ============================================================================
// TEST API
// ============================================================================

export const testApi = {
  /**
   * List all tests for a project
   */
  list: async (projectId: string) => {
    const response = await api.get<{ success: boolean; tests: TestCase[] }>(
      `/projects/${projectId}/tests`
    );
    return response.data;
  },

  /**
   * Create a new test
   */
  create: async (projectId: string, test: { name: string; steps: TestStep[] }) => {
    const response = await api.post<{ success: boolean; test: TestCase }>(
      `/projects/${projectId}/tests`,
      test
    );
    return response.data;
  },

  /**
   * Get a single test
   */
  get: async (projectId: string, testId: string) => {
    const response = await api.get<{ success: boolean; test: TestCase }>(
      `/projects/${projectId}/tests/${testId}`
    );
    return response.data;
  },

  /**
   * Update a test
   */
  update: async (projectId: string, testId: string, test: { name?: string; steps?: TestStep[] }) => {
    const response = await api.put<{ success: boolean; test: TestCase }>(
      `/projects/${projectId}/tests/${testId}`,
      test
    );
    return response.data;
  },

  /**
   * Delete a test
   */
  delete: async (projectId: string, testId: string) => {
    const response = await api.delete<{ success: boolean; message: string }>(
      `/projects/${projectId}/tests/${testId}`
    );
    return response.data;
  },

  /**
   * Get test results
   */
  getResults: async (projectId: string, testId: string, limit = 10) => {
    const response = await api.get<{ success: boolean; results: TestResult[] }>(
      `/projects/${projectId}/tests/${testId}/results`,
      { params: { limit } }
    );
    return response.data;
  },

  /**
   * Save a test result
   */
  saveResult: async (projectId: string, testId: string, result: Omit<TestResult, 'testId' | 'timestamp'>) => {
    const response = await api.post<{ success: boolean; result: TestResult }>(
      `/projects/${projectId}/tests/${testId}/results`,
      result
    );
    return response.data;
  },
};

// ============================================================================
// SCREENSHOT API
// ============================================================================

export interface ScreenshotComparison {
  match: boolean;
  matchPercentage: number;
  diffImageData?: string;
  baselineImageData?: string;
  totalPixels: number;
  diffPixels: number;
  error?: string;
  noBaseline?: boolean;
}

export interface BaselineInfo {
  exists: boolean;
  imageData?: string;
  path?: string;
}

export function normalizeCommitSha(rawCommitSha: unknown): string | null {
  if (typeof rawCommitSha === 'string') {
    const trimmed = rawCommitSha.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (rawCommitSha && typeof rawCommitSha === 'object') {
    const nestedCommitSha = (rawCommitSha as { commitSha?: unknown }).commitSha;
    if (typeof nestedCommitSha === 'string') {
      const trimmed = nestedCommitSha.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }

  return null;
}

export function shortCommitSha(rawCommitSha: unknown): string | null {
  const commitSha = normalizeCommitSha(rawCommitSha);
  return commitSha ? commitSha.substring(0, 7) : null;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toNullableFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeReasonCodeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();
  for (const entry of value) {
    const normalized = String(entry || '').trim().toLowerCase();
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= 20) break;
  }
  return Array.from(deduped);
}

function normalizeReviewGateStatus(value: unknown): 'pass' | 'warn' | 'fail' | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pass' || normalized === 'warn' || normalized === 'fail') {
    return normalized;
  }
  return undefined;
}

function normalizeReviewModelGate(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const gate = value as Record<string, unknown>;
  return {
    ...gate,
    status: normalizeReviewGateStatus(gate.status),
    reasonCodes: normalizeReasonCodeList(gate.reasonCodes),
    criticalReasonCodes: normalizeReasonCodeList(gate.criticalReasonCodes),
    warningReasonCodes: normalizeReasonCodeList(gate.warningReasonCodes),
    source: typeof gate.source === 'string' && gate.source.trim() ? gate.source.trim() : undefined,
    evaluatedAt: typeof gate.evaluatedAt === 'string' && gate.evaluatedAt.trim()
      ? gate.evaluatedAt.trim()
      : undefined,
  };
}

function normalizePrecisionIssueCounters(stats: Record<string, unknown>) {
  return normalizeSharedPrecisionIssueCounters(stats);
}

function normalizeReviewProfileStats(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const profile = value as Record<string, unknown>;
  return {
    id: typeof profile.id === 'string' && profile.id.trim() ? profile.id.trim() : undefined,
    label: typeof profile.label === 'string' && profile.label.trim() ? profile.label.trim() : undefined,
    source: typeof profile.source === 'string' && profile.source.trim() ? profile.source.trim().toLowerCase() : undefined,
    presetId: typeof profile.presetId === 'string' && profile.presetId.trim() ? profile.presetId.trim() : null,
    detectionSignals: Array.isArray(profile.detectionSignals)
      ? profile.detectionSignals.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [],
  };
}

function normalizeShapedScopeStats(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const scope = value as Record<string, unknown>;
  const classCountsRaw = scope.classCounts && typeof scope.classCounts === 'object' && !Array.isArray(scope.classCounts)
    ? scope.classCounts as Record<string, unknown>
    : {};
  return {
    rawFileCount: toFiniteNumber(scope.rawFileCount, 0),
    reviewUnitCount: toFiniteNumber(scope.reviewUnitCount, 0),
    pairedFiles: toFiniteNumber(scope.pairedFiles, 0),
    classCounts: {
      deep: toFiniteNumber(classCountsRaw.deep, 0),
      structural: toFiniteNumber(classCountsRaw.structural, 0),
      shallow: toFiniteNumber(classCountsRaw.shallow, 0),
      collapsed: toFiniteNumber(classCountsRaw.collapsed, 0),
      skip: toFiniteNumber(classCountsRaw.skip, 0),
    },
  };
}

function normalizeReviewRecommendation(rawRecommendation: unknown): unknown {
  if (!rawRecommendation || typeof rawRecommendation !== 'object') return rawRecommendation;
  const recommendation = rawRecommendation as Record<string, unknown>;
  const commentEligibility = (
    recommendation.commentEligibility
    && typeof recommendation.commentEligibility === 'object'
    && !Array.isArray(recommendation.commentEligibility)
  ) ? recommendation.commentEligibility as Record<string, unknown> : null;
  return {
    ...recommendation,
    findingId: normalizeReviewFindingId(recommendation.findingId),
    recommendationKey: buildReviewRecommendationKey({
      recommendationKey: typeof recommendation.recommendationKey === 'string'
        ? recommendation.recommendationKey
        : undefined,
      type: String(recommendation.type || '').trim().toLowerCase() as ReviewRecommendation['type'],
      severity: String(recommendation.severity || '').trim().toLowerCase() as RiskLevel,
      title: typeof recommendation.title === 'string' ? recommendation.title : '',
      description: typeof recommendation.description === 'string' ? recommendation.description : '',
      file: typeof recommendation.file === 'string' ? recommendation.file : undefined,
      line: typeof recommendation.line === 'number' ? recommendation.line : undefined,
      targetSnippet: typeof recommendation.targetSnippet === 'string' ? recommendation.targetSnippet : undefined,
      suggestedFix: typeof recommendation.suggestedFix === 'string' ? recommendation.suggestedFix : undefined,
    }),
    commentEligible: recommendation.commentEligible === true,
    commentEligibility: commentEligibility ? {
      eligible: commentEligibility.eligible === true,
      confidence: typeof commentEligibility.confidence === 'string' && commentEligibility.confidence.trim()
        ? commentEligibility.confidence.trim().toLowerCase()
        : null,
      reasonCodes: Array.isArray(commentEligibility.reasonCodes)
        ? commentEligibility.reasonCodes
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter(Boolean)
        : [],
    } : undefined,
  };
}

function normalizeReviewFindingId(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^F[1-9]\d*$/.test(normalized) ? normalized : undefined;
}

function assignClientReviewFindingIds(recommendations: unknown[], previousFindings: unknown[]): {
  recommendations: unknown[];
  previousFindings: unknown[];
} {
  const used = new Set<string>();
  const assign = (entry: unknown, index: number): unknown => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const recommendation = entry as Record<string, unknown>;
    const existing = normalizeReviewFindingId(recommendation.findingId);
    let findingId = existing;
    if (!findingId || used.has(findingId)) {
      let nextIndex = index + 1;
      while (used.has(`F${nextIndex}`)) nextIndex += 1;
      findingId = `F${nextIndex}`;
    }
    used.add(findingId);
    return { ...recommendation, findingId };
  };

  const normalizedRecommendations = recommendations.map((entry, index) => assign(entry, index));
  const normalizedPreviousFindings = previousFindings.map((entry, index) => (
    assign(entry, normalizedRecommendations.length + index)
  ));
  return {
    recommendations: normalizedRecommendations,
    previousFindings: normalizedPreviousFindings,
  };
}

function normalizeReviewData(reviewData: unknown): unknown {
  if (!reviewData || typeof reviewData !== 'object') {
    return reviewData;
  }

  const review = reviewData as Record<string, unknown>;
  const stats = (review.stats && typeof review.stats === 'object')
    ? review.stats as Record<string, unknown>
    : {};
  const rollout = (stats.reviewModelRollout && typeof stats.reviewModelRollout === 'object')
    ? stats.reviewModelRollout as Record<string, unknown>
    : null;
  const normalizedRuntimeGate = normalizeReviewModelGate(stats.reviewModelGate);
  const normalizedRolloutGate = normalizeReviewModelGate(rollout?.gate);
  const tokensUsed = (review.tokensUsed && typeof review.tokensUsed === 'object')
    ? review.tokensUsed as Record<string, unknown>
    : {};
  const timing = (review.timing && typeof review.timing === 'object')
    ? review.timing as Record<string, unknown>
    : {};
  const verificationStatus = (review.verificationStatus && typeof review.verificationStatus === 'object')
    ? review.verificationStatus as Record<string, unknown>
    : null;
  const normalizedCostSource = (
    review.costSource === 'provider_native'
    || review.costSource === 'pricing_table'
    || review.costSource === 'fallback_pricing'
  ) ? review.costSource : (
    stats.costSource === 'provider_native'
    || stats.costSource === 'pricing_table'
    || stats.costSource === 'fallback_pricing'
  ) ? stats.costSource : null;
  const normalizedEstimatedCost = toNullableFiniteNumber(
    review.estimatedCost ?? stats.estimatedCostUsd ?? stats.providerNativeCostUsd ?? stats.agenticCostUsd
  );
  const normalizedCostIsApproximate = review.costIsApproximate === true
    || stats.costIsApproximate === true;

  const normalizedRiskLevel = (
    review.riskLevel === 'low'
    || review.riskLevel === 'medium'
    || review.riskLevel === 'high'
    || review.riskLevel === 'critical'
  ) ? review.riskLevel : undefined;

  const normalizedRecommendations = Array.isArray(review.recommendations)
    ? review.recommendations.map((rawRecommendation) => normalizeReviewRecommendation(rawRecommendation))
    : [];
  const normalizedPreviousFindings = Array.isArray(review.previousFindings)
    ? review.previousFindings.map((rawRecommendation) => normalizeReviewRecommendation(rawRecommendation))
    : [];
  const findingsWithIds = assignClientReviewFindingIds(normalizedRecommendations, normalizedPreviousFindings);

  const normalizedCommentEligibility = normalizeReviewCommentEligibility(stats.commentEligibility);

  return {
    ...review,
    summary: typeof review.summary === 'string' ? review.summary : '',
    riskLevel: normalizedRiskLevel,
    changeGroups: Array.isArray(review.changeGroups) ? review.changeGroups : [],
    recommendations: findingsWithIds.recommendations,
    previousFindings: findingsWithIds.previousFindings,
    verificationStatus: verificationStatus ? {
      overallStatus: typeof verificationStatus.overallStatus === 'string' ? verificationStatus.overallStatus.trim().toLowerCase() : undefined,
      summary: typeof verificationStatus.summary === 'string' && verificationStatus.summary.trim() ? verificationStatus.summary.trim() : null,
      lines: Array.isArray(verificationStatus.lines)
        ? verificationStatus.lines.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
      failingChecks: Array.isArray(verificationStatus.failingChecks)
        ? verificationStatus.failingChecks.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
      passingChecks: Array.isArray(verificationStatus.passingChecks)
        ? verificationStatus.passingChecks.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
      pendingChecks: Array.isArray(verificationStatus.pendingChecks)
        ? verificationStatus.pendingChecks.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
    } : null,
    stats: {
      ...stats,
      filesAnalyzed: toFiniteNumber(stats.filesAnalyzed, 0),
      totalAdditions: toFiniteNumber(stats.totalAdditions, 0),
      totalDeletions: toFiniteNumber(stats.totalDeletions, 0),
      estimatedComplexity: typeof stats.estimatedComplexity === 'string' ? stats.estimatedComplexity : 'moderate',
      commentEligibility: normalizedCommentEligibility || undefined,
      reviewProfile: normalizeReviewProfileStats(stats.reviewProfile),
      shapedScope: normalizeShapedScopeStats(stats.shapedScope),
      ...normalizePrecisionIssueCounters(stats),
      reviewModelGate: normalizedRuntimeGate,
      reviewModelRollout: rollout ? {
        ...rollout,
        gate: normalizedRolloutGate,
      } : undefined,
      estimatedCostUsd: normalizedEstimatedCost,
      costSource: normalizedCostSource,
      costIsApproximate: normalizedCostIsApproximate,
      providerNativeCostUsd: toNullableFiniteNumber(stats.providerNativeCostUsd ?? stats.agenticCostUsd),
      costPricingKey: typeof stats.costPricingKey === 'string' && stats.costPricingKey.trim()
        ? stats.costPricingKey.trim()
        : null,
      reviewTotalDurationMs: toNullableFiniteNumber(stats.reviewTotalDurationMs ?? timing.totalMs),
    },
    tokensUsed: {
      input: toFiniteNumber(tokensUsed.input, 0),
      output: toFiniteNumber(tokensUsed.output, 0),
    },
    estimatedCost: normalizedEstimatedCost,
    costSource: normalizedCostSource,
    costIsApproximate: normalizedCostIsApproximate,
  };
}

function normalizeReviewCommentEligibility(rawEligibility: unknown): ReviewCommentEligibility | null {
  if (!rawEligibility || typeof rawEligibility !== 'object' || Array.isArray(rawEligibility)) {
    return null;
  }
  const payload = rawEligibility as Record<string, unknown>;
  const reasonCountsRaw = payload.reasonCounts && typeof payload.reasonCounts === 'object' && !Array.isArray(payload.reasonCounts)
    ? payload.reasonCounts as Record<string, unknown>
    : {};
  return {
    totalFindings: toFiniteNumber(payload.totalFindings, 0),
    eligibleFindings: toFiniteNumber(payload.eligibleFindings, 0),
    withheldFindings: toFiniteNumber(payload.withheldFindings, 0),
    reasonCounts: Object.fromEntries(
      Object.entries(reasonCountsRaw)
        .map(([key, value]) => [String(key || '').trim().toLowerCase(), toFiniteNumber(value, 0)])
        .filter(([key]) => key)
    ),
  };
}

function normalizeReviewParityGate(rawGate: unknown): ReviewParityGate | null {
  if (!rawGate || typeof rawGate !== 'object' || Array.isArray(rawGate)) {
    return null;
  }
  const payload = rawGate as Record<string, unknown>;
  const status = String(payload.status || '').trim().toLowerCase();
  if (status !== 'ready' && status !== 'warn' && status !== 'blocked') {
    return null;
  }
  return {
    status,
    reasonCodes: Array.isArray(payload.reasonCodes)
      ? payload.reasonCodes.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
      : [],
    reviewTier: typeof payload.reviewTier === 'string' && payload.reviewTier.trim()
      ? payload.reviewTier.trim().toLowerCase()
      : null,
    totalFiles: toFiniteNumber(payload.totalFiles, 0),
    deepReviewedFiles: toFiniteNumber(payload.deepReviewedFiles, 0),
    deepCoverageRate: payload.deepCoverageRate == null ? undefined : Math.min(1, Math.max(0, Number(payload.deepCoverageRate) || 0)),
    totalFindings: toFiniteNumber(payload.totalFindings, 0),
    eligibleFindings: toFiniteNumber(payload.eligibleFindings, 0),
    withheldFindings: toFiniteNumber(payload.withheldFindings, 0),
    commentReadyRate: payload.commentReadyRate == null ? undefined : Math.min(1, Math.max(0, Number(payload.commentReadyRate) || 0)),
    verificationSummary: typeof payload.verificationSummary === 'string' && payload.verificationSummary.trim()
      ? payload.verificationSummary.trim()
      : null,
  };
}

const LEGACY_REVIEW_STATUS_TO_LIFECYCLE: Record<LegacyReviewStatus, ReviewLifecycleStatus> = {
  none: 'completed',
  queued: 'queued',
  reviewing: 'running',
  reviewed: 'completed',
  failed: 'failed',
};
const CANONICAL_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>([
  'queued',
  'running',
  'retrying',
  'partial',
  'failed',
  'completed',
]);
const ACTIVE_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['queued', 'running', 'retrying']);
const TERMINAL_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['partial', 'failed', 'completed']);
const RETRY_LIFECYCLE_PHASES = new Set(['provider_retry', 'retrying']);
const PARTIAL_LIFECYCLE_PHASES = new Set(['partial', 'chunk_partial', 'single_partial', 'file_partial']);
const ACTIVE_LIFECYCLE_PHASES = new Set([
  'queued',
  'reviewing',
  'running',
  'retrying',
  'preparing_files',
  'file_triage',
  'file_review_start',
  'file_review_inflight',
  'file_review_failed',
  'file_partial',
  'single_start',
  'single_inflight',
  'chunk_start',
  'chunk_inflight',
  'chunk_split',
  'provider_retry',
  'synthesizing',
]);

function normalizeStatusString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLifecycleStatusValue(value: unknown, fallback: ReviewLifecycleStatus = 'queued'): ReviewLifecycleStatus {
  const normalized = normalizeStatusString(value);
  if (normalized && CANONICAL_LIFECYCLE_STATUSES.has(normalized as ReviewLifecycleStatus)) {
    return normalized as ReviewLifecycleStatus;
  }
  if (normalized && normalized in LEGACY_REVIEW_STATUS_TO_LIFECYCLE) {
    return LEGACY_REVIEW_STATUS_TO_LIFECYCLE[normalized as LegacyReviewStatus];
  }
  return fallback;
}

function mapLifecycleStatusToDefaultPhase(
  status: ReviewLifecycleStatus,
  sourceStatus: string | null
): string {
  if (status === 'completed') {
    return sourceStatus === 'none' ? 'idle' : 'complete';
  }
  if (status === 'running') return 'running';
  return status;
}

function normalizeReviewLifecycleSnapshot(
  rawLifecycle: unknown,
  fallbackSourceStatus: unknown = null
): ReviewLifecycle | null {
  const lifecycle = (rawLifecycle && typeof rawLifecycle === 'object')
    ? rawLifecycle as Record<string, unknown>
    : null;

  if (!lifecycle && fallbackSourceStatus == null) {
    return null;
  }

  const sourceStatus = normalizeStatusString(lifecycle?.sourceStatus ?? fallbackSourceStatus);
  const baseStatus = normalizeLifecycleStatusValue(
    lifecycle?.status ?? sourceStatus,
    sourceStatus ? normalizeLifecycleStatusValue(sourceStatus) : 'queued'
  );
  const rawError = typeof lifecycle?.error === 'string' ? lifecycle.error.trim() : '';
  const hasError = rawError.length > 0;

  const phaseFromPayload = typeof lifecycle?.phase === 'string' && lifecycle.phase.trim()
    ? lifecycle.phase.trim()
    : mapLifecycleStatusToDefaultPhase(baseStatus, sourceStatus);
  const normalizedPhase = phaseFromPayload.trim().toLowerCase();

  let status = baseStatus;
  if (!TERMINAL_LIFECYCLE_STATUSES.has(status)) {
    if (RETRY_LIFECYCLE_PHASES.has(normalizedPhase)) {
      status = 'retrying';
    } else if (normalizedPhase === 'queued') {
      status = 'queued';
    } else if (ACTIVE_LIFECYCLE_PHASES.has(normalizedPhase)) {
      status = 'running';
    }
  }
  if (status === 'completed' && (hasError || PARTIAL_LIFECYCLE_PHASES.has(normalizedPhase))) {
    status = 'partial';
  }

  const phase = status === 'partial' && normalizedPhase === 'complete'
    ? 'partial'
    : phaseFromPayload;
  const isTerminal = TERMINAL_LIFECYCLE_STATUSES.has(status);
  const isActive = ACTIVE_LIFECYCLE_STATUSES.has(status)
    || ACTIVE_LIFECYCLE_PHASES.has(normalizedPhase);

  return {
    status,
    phase,
    isActive,
    isTerminal,
    canRetry: isTerminal,
    error: (status === 'failed' || status === 'partial') ? rawError || null : null,
    updatedAt: typeof lifecycle?.updatedAt === 'string' ? lifecycle.updatedAt : null,
    reviewedAt: typeof lifecycle?.reviewedAt === 'string' ? lifecycle.reviewedAt : null,
    hasProgress: typeof lifecycle?.hasProgress === 'boolean' ? lifecycle.hasProgress : undefined,
    sourceStatus,
  };
}

function normalizeReviewActionEligibility(rawEligibility: unknown) {
  if (!rawEligibility || typeof rawEligibility !== 'object') {
    return null;
  }
  const payload = rawEligibility as Record<string, unknown>;
  return {
    canApprove: payload.canApprove !== false,
    canRequestChanges: payload.canRequestChanges !== false,
    approveBlockedReason: typeof payload.approveBlockedReason === 'string' && payload.approveBlockedReason.trim()
      ? payload.approveBlockedReason.trim()
      : null,
    blockedReason: typeof payload.blockedReason === 'string' && payload.blockedReason.trim()
      ? payload.blockedReason.trim()
      : null,
    requestChangesBlockedReason: typeof payload.requestChangesBlockedReason === 'string' && payload.requestChangesBlockedReason.trim()
      ? payload.requestChangesBlockedReason.trim()
      : null,
    staleReason: typeof payload.staleReason === 'string' && payload.staleReason.trim()
      ? payload.staleReason.trim()
      : null,
  };
}

function normalizeTrustAnalyticsRateMetric(rawMetric: unknown): TrustAnalyticsRateMetric {
  const metric = (rawMetric && typeof rawMetric === 'object')
    ? rawMetric as Record<string, unknown>
    : {};
  return {
    value: metric.value == null ? null : toFiniteNumber(metric.value, 0),
    numerator: toFiniteNumber(metric.numerator, 0),
    denominator: toFiniteNumber(metric.denominator, 0),
    sampleSize: toFiniteNumber(metric.sampleSize, 0),
    minimumSampleSize: toFiniteNumber(metric.minimumSampleSize, 0),
    isInsufficientSample: metric.isInsufficientSample === true,
  };
}

function normalizeTrustAnalyticsValueMetric(rawMetric: unknown): TrustAnalyticsValueMetric {
  const metric = (rawMetric && typeof rawMetric === 'object')
    ? rawMetric as Record<string, unknown>
    : {};
  return {
    value: metric.value == null ? null : toFiniteNumber(metric.value, 0),
    sampleSize: toFiniteNumber(metric.sampleSize, 0),
  };
}

function normalizeTrustReviewAnalytics(rawAnalytics: unknown): TrustReviewAnalytics | null {
  if (!rawAnalytics || typeof rawAnalytics !== 'object') {
    return null;
  }
  const analytics = rawAnalytics as Record<string, unknown>;
  const meta = analytics.meta && typeof analytics.meta === 'object'
    ? analytics.meta as Record<string, unknown>
    : {};
  const immediateValue = analytics.immediateValue && typeof analytics.immediateValue === 'object'
    ? analytics.immediateValue as Record<string, unknown>
    : {};
  const trustQuality = analytics.trustQuality && typeof analytics.trustQuality === 'object'
    ? analytics.trustQuality as Record<string, unknown>
    : {};
  const followThrough = analytics.followThrough && typeof analytics.followThrough === 'object'
    ? analytics.followThrough as Record<string, unknown>
    : {};
  const reliability = analytics.reliability && typeof analytics.reliability === 'object'
    ? analytics.reliability as Record<string, unknown>
    : {};
  const reviewType = meta.reviewType === 'branch_review' ? 'branch_review' : 'changeset';
  const reliabilityTier = String(reliability.reviewReliability || '').trim().toLowerCase();
  const gateStatus = String(reliability.gateStatus || '').trim().toLowerCase();
  const reviewStatus = String(reliability.reviewStatus || '').trim().toLowerCase();
  return {
    meta: {
      projectId: typeof meta.projectId === 'string' ? meta.projectId : null,
      reviewType,
      reviewId: typeof meta.reviewId === 'string' ? meta.reviewId : null,
      displayId: typeof meta.displayId === 'string' ? meta.displayId : null,
      branchName: typeof meta.branchName === 'string' ? meta.branchName : null,
      completedAt: typeof meta.completedAt === 'string' ? meta.completedAt : null,
      providerType: typeof meta.providerType === 'string' ? meta.providerType : null,
      providerModel: typeof meta.providerModel === 'string' ? meta.providerModel : null,
    },
    immediateValue: {
      ttfsMs: immediateValue.ttfsMs == null ? null : toFiniteNumber(immediateValue.ttfsMs, 0),
      reviewDurationMs: immediateValue.reviewDurationMs == null ? null : toFiniteNumber(immediateValue.reviewDurationMs, 0),
      deepCoverage: normalizeTrustAnalyticsRateMetric(immediateValue.deepCoverage),
      issuesFound: toFiniteNumber(immediateValue.issuesFound, 0),
      highRiskFindings: toFiniteNumber(immediateValue.highRiskFindings, 0),
    },
    trustQuality: {
      groundedIssueRate: normalizeTrustAnalyticsRateMetric(trustQuality.groundedIssueRate),
      unsupportedIssueRate: normalizeTrustAnalyticsRateMetric(trustQuality.unsupportedIssueRate),
      lowEvidenceIssueRate: normalizeTrustAnalyticsRateMetric(trustQuality.lowEvidenceIssueRate),
      uncorroboratedHighRiskRate: normalizeTrustAnalyticsRateMetric(trustQuality.uncorroboratedHighRiskRate),
      outcomeSuppressionRate: normalizeTrustAnalyticsRateMetric(trustQuality.outcomeSuppressionRate),
    },
    followThrough: {
      issueAddressedRate: normalizeTrustAnalyticsRateMetric(followThrough.issueAddressedRate),
      issueDismissedRate: normalizeTrustAnalyticsRateMetric(followThrough.issueDismissedRate),
      issueOutcomeCoverage: normalizeTrustAnalyticsRateMetric(followThrough.issueOutcomeCoverage),
      addressedCount: toFiniteNumber(followThrough.addressedCount, 0),
      dismissedCount: toFiniteNumber(followThrough.dismissedCount, 0),
    },
    reliability: {
      reviewReliability: reliabilityTier === 'partial' || reliabilityTier === 'files_only' || reliabilityTier === 'failed'
        ? reliabilityTier
        : 'full',
      gateStatus: gateStatus === 'pass' || gateStatus === 'warn' || gateStatus === 'fail'
        ? gateStatus
        : null,
      gateReasonCodes: Array.isArray(reliability.gateReasonCodes)
        ? reliability.gateReasonCodes.filter((value): value is string => typeof value === 'string')
        : [],
      gateEvaluatedAt: typeof reliability.gateEvaluatedAt === 'string' ? reliability.gateEvaluatedAt : null,
      omittedFiles: toFiniteNumber(reliability.omittedFiles, 0),
      failedFiles: toFiniteNumber(reliability.failedFiles, 0),
      reviewStatus: reviewStatus === 'queued' || reviewStatus === 'reviewing' || reviewStatus === 'reviewed' || reviewStatus === 'failed'
        ? reviewStatus as TrustReviewAnalytics['reliability']['reviewStatus']
        : 'none',
    },
  };
}

function normalizeTrustAnalyticsSummary(rawSummary: unknown): TrustAnalyticsSummary {
  const summary = (rawSummary && typeof rawSummary === 'object')
    ? rawSummary as Record<string, unknown>
    : {};
  const hero = summary.hero && typeof summary.hero === 'object'
    ? summary.hero as Record<string, unknown>
    : {};
  const quality = summary.quality && typeof summary.quality === 'object'
    ? summary.quality as Record<string, unknown>
    : {};
  const outcome = summary.outcome && typeof summary.outcome === 'object'
    ? summary.outcome as Record<string, unknown>
    : {};
  const reliability = summary.reliability && typeof summary.reliability === 'object'
    ? summary.reliability as Record<string, unknown>
    : {};
  const windowPayload = summary.window && typeof summary.window === 'object'
    ? summary.window as Record<string, unknown>
    : {};
  const reviewType = summary.reviewType === 'branch_review' || summary.reviewType === 'changeset' || summary.reviewType === 'pr_review'
    ? summary.reviewType
    : null;
  const scope = summary.scope === 'branches' || summary.scope === 'prs' ? summary.scope : 'all';
  const windowKey = windowPayload.key === '24h' || windowPayload.key === '30d' || windowPayload.key === 'custom'
    ? windowPayload.key
    : '7d';
  return {
    projectId: typeof summary.projectId === 'string' ? summary.projectId : null,
    reviewType,
    scope,
    window: {
      key: windowKey,
      from: typeof windowPayload.from === 'string' ? windowPayload.from : new Date(0).toISOString(),
      to: typeof windowPayload.to === 'string' ? windowPayload.to : new Date(0).toISOString(),
    },
    reviewCount: toFiniteNumber(summary.reviewCount, 0),
    comparison: {
      dominantScope: summary.comparison && typeof summary.comparison === 'object' && (
        (summary.comparison as Record<string, unknown>).dominantScope === 'branches'
        || (summary.comparison as Record<string, unknown>).dominantScope === 'prs'
      )
        ? ((summary.comparison as Record<string, unknown>).dominantScope as 'branches' | 'prs')
        : 'balanced',
      branchScopedCount: summary.comparison && typeof summary.comparison === 'object'
        ? toFiniteNumber((summary.comparison as Record<string, unknown>).branchScopedCount, 0)
        : 0,
      prReviewCount: summary.comparison && typeof summary.comparison === 'object'
        ? toFiniteNumber((summary.comparison as Record<string, unknown>).prReviewCount, 0)
        : 0,
      branchShare: summary.comparison && typeof summary.comparison === 'object'
        ? toFiniteNumber((summary.comparison as Record<string, unknown>).branchShare, 0)
        : 0,
      prShare: summary.comparison && typeof summary.comparison === 'object'
        ? toFiniteNumber((summary.comparison as Record<string, unknown>).prShare, 0)
        : 0,
    },
    heroCards: Array.isArray(summary.heroCards)
      ? summary.heroCards
        .map((card) => {
          const payload = card && typeof card === 'object' ? card as Record<string, unknown> : {};
          const key = typeof payload.key === 'string' ? payload.key : '';
          const label = typeof payload.label === 'string' ? payload.label : '';
          const description = typeof payload.description === 'string' ? payload.description : '';
          if (!key || !label) return null;
          return { key, label, description };
        })
        .filter((card): card is { key: string; label: string; description: string } => card != null)
      : [],
    scopeBreakdown: {
      branchScopedCount: summary.scopeBreakdown && typeof summary.scopeBreakdown === 'object'
        ? toFiniteNumber((summary.scopeBreakdown as Record<string, unknown>).branchScopedCount, 0)
        : 0,
      branchReviewCount: summary.scopeBreakdown && typeof summary.scopeBreakdown === 'object'
        ? toFiniteNumber((summary.scopeBreakdown as Record<string, unknown>).branchReviewCount, 0)
        : 0,
      workspaceReviewCount: summary.scopeBreakdown && typeof summary.scopeBreakdown === 'object'
        ? toFiniteNumber((summary.scopeBreakdown as Record<string, unknown>).workspaceReviewCount, 0)
        : 0,
      changesetCount: summary.scopeBreakdown && typeof summary.scopeBreakdown === 'object'
        ? toFiniteNumber((summary.scopeBreakdown as Record<string, unknown>).changesetCount, 0)
        : 0,
      prReviewCount: summary.scopeBreakdown && typeof summary.scopeBreakdown === 'object'
        ? toFiniteNumber((summary.scopeBreakdown as Record<string, unknown>).prReviewCount, 0)
        : 0,
    },
    hero: {
      medianTtfsMs: normalizeTrustAnalyticsValueMetric(hero.medianTtfsMs),
      medianReviewDurationMs: normalizeTrustAnalyticsValueMetric(hero.medianReviewDurationMs),
      deepCoverageRate: normalizeTrustAnalyticsRateMetric(hero.deepCoverageRate),
      findingsFoundPerReview: {
        value: hero.findingsFoundPerReview && typeof hero.findingsFoundPerReview === 'object' && (hero.findingsFoundPerReview as Record<string, unknown>).value != null
          ? toFiniteNumber((hero.findingsFoundPerReview as Record<string, unknown>).value, 0)
          : (hero.issuesFoundPerReview && typeof hero.issuesFoundPerReview === 'object' && (hero.issuesFoundPerReview as Record<string, unknown>).value != null
            ? toFiniteNumber((hero.issuesFoundPerReview as Record<string, unknown>).value, 0)
            : null),
        numerator: hero.findingsFoundPerReview && typeof hero.findingsFoundPerReview === 'object'
          ? toFiniteNumber((hero.findingsFoundPerReview as Record<string, unknown>).numerator, 0)
          : (hero.issuesFoundPerReview && typeof hero.issuesFoundPerReview === 'object'
            ? toFiniteNumber((hero.issuesFoundPerReview as Record<string, unknown>).numerator, 0)
            : 0),
        denominator: hero.findingsFoundPerReview && typeof hero.findingsFoundPerReview === 'object'
          ? toFiniteNumber((hero.findingsFoundPerReview as Record<string, unknown>).denominator, 0)
          : (hero.issuesFoundPerReview && typeof hero.issuesFoundPerReview === 'object'
            ? toFiniteNumber((hero.issuesFoundPerReview as Record<string, unknown>).denominator, 0)
            : 0),
        sampleSize: hero.findingsFoundPerReview && typeof hero.findingsFoundPerReview === 'object'
          ? toFiniteNumber((hero.findingsFoundPerReview as Record<string, unknown>).sampleSize, 0)
          : (hero.issuesFoundPerReview && typeof hero.issuesFoundPerReview === 'object'
            ? toFiniteNumber((hero.issuesFoundPerReview as Record<string, unknown>).sampleSize, 0)
            : 0),
      },
      issuesFoundPerReview: {
        value: hero.issuesFoundPerReview && typeof hero.issuesFoundPerReview === 'object' && (hero.issuesFoundPerReview as Record<string, unknown>).value != null
          ? toFiniteNumber((hero.issuesFoundPerReview as Record<string, unknown>).value, 0)
          : null,
        numerator: hero.issuesFoundPerReview && typeof hero.issuesFoundPerReview === 'object'
          ? toFiniteNumber((hero.issuesFoundPerReview as Record<string, unknown>).numerator, 0)
          : 0,
        denominator: hero.issuesFoundPerReview && typeof hero.issuesFoundPerReview === 'object'
          ? toFiniteNumber((hero.issuesFoundPerReview as Record<string, unknown>).denominator, 0)
          : 0,
        sampleSize: hero.issuesFoundPerReview && typeof hero.issuesFoundPerReview === 'object'
          ? toFiniteNumber((hero.issuesFoundPerReview as Record<string, unknown>).sampleSize, 0)
          : 0,
      },
      commentReadyFindingsPerReview: {
        value: hero.commentReadyFindingsPerReview && typeof hero.commentReadyFindingsPerReview === 'object' && (hero.commentReadyFindingsPerReview as Record<string, unknown>).value != null
          ? toFiniteNumber((hero.commentReadyFindingsPerReview as Record<string, unknown>).value, 0)
          : null,
        numerator: hero.commentReadyFindingsPerReview && typeof hero.commentReadyFindingsPerReview === 'object'
          ? toFiniteNumber((hero.commentReadyFindingsPerReview as Record<string, unknown>).numerator, 0)
          : 0,
        denominator: hero.commentReadyFindingsPerReview && typeof hero.commentReadyFindingsPerReview === 'object'
          ? toFiniteNumber((hero.commentReadyFindingsPerReview as Record<string, unknown>).denominator, 0)
          : 0,
        sampleSize: hero.commentReadyFindingsPerReview && typeof hero.commentReadyFindingsPerReview === 'object'
          ? toFiniteNumber((hero.commentReadyFindingsPerReview as Record<string, unknown>).sampleSize, 0)
          : 0,
      },
      medianChangedFiles: normalizeTrustAnalyticsValueMetric(hero.medianChangedFiles),
      verificationContextRate: normalizeTrustAnalyticsRateMetric(hero.verificationContextRate),
      groundedIssueRate: normalizeTrustAnalyticsRateMetric(hero.groundedIssueRate),
    },
    quality: {
      groundedIssueRate: normalizeTrustAnalyticsRateMetric(quality.groundedIssueRate),
      unsupportedIssueRate: normalizeTrustAnalyticsRateMetric(quality.unsupportedIssueRate),
      lowEvidenceIssueRate: normalizeTrustAnalyticsRateMetric(quality.lowEvidenceIssueRate),
      uncorroboratedHighRiskRate: normalizeTrustAnalyticsRateMetric(quality.uncorroboratedHighRiskRate),
      outcomeSuppressionRate: normalizeTrustAnalyticsRateMetric(quality.outcomeSuppressionRate),
    },
    outcome: {
      issueAddressedRate: normalizeTrustAnalyticsRateMetric(outcome.issueAddressedRate),
      issueDismissedRate: normalizeTrustAnalyticsRateMetric(outcome.issueDismissedRate),
      issueOutcomeCoverage: normalizeTrustAnalyticsRateMetric(outcome.issueOutcomeCoverage),
      addressedCount: toFiniteNumber(outcome.addressedCount, 0),
      dismissedCount: toFiniteNumber(outcome.dismissedCount, 0),
    },
    reliability: {
      fullCount: toFiniteNumber(reliability.fullCount, 0),
      partialCount: toFiniteNumber(reliability.partialCount, 0),
      filesOnlyCount: toFiniteNumber(reliability.filesOnlyCount, 0),
      failedCount: toFiniteNumber(reliability.failedCount, 0),
      partialRate: normalizeTrustAnalyticsRateMetric(reliability.partialRate),
      filesOnlyRate: normalizeTrustAnalyticsRateMetric(reliability.filesOnlyRate),
      failedRate: normalizeTrustAnalyticsRateMetric(reliability.failedRate),
      gateWarnRate: normalizeTrustAnalyticsRateMetric(reliability.gateWarnRate),
      gateFailRate: normalizeTrustAnalyticsRateMetric(reliability.gateFailRate),
    },
  };
}

function normalizeTrustAnalyticsTimeseries(rawTimeseries: unknown): TrustAnalyticsTimeseries {
  const timeseries = (rawTimeseries && typeof rawTimeseries === 'object')
    ? rawTimeseries as Record<string, unknown>
    : {};
  const windowPayload = timeseries.window && typeof timeseries.window === 'object'
    ? timeseries.window as Record<string, unknown>
    : {};
  const reviewType = timeseries.reviewType === 'branch_review' || timeseries.reviewType === 'changeset' || timeseries.reviewType === 'pr_review'
    ? timeseries.reviewType
    : null;
  const scope = timeseries.scope === 'branches' || timeseries.scope === 'prs' ? timeseries.scope : 'all';
  const windowKey = windowPayload.key === '24h' || windowPayload.key === '30d' || windowPayload.key === 'custom'
    ? windowPayload.key
    : '7d';
  const interval = timeseries.interval === 'hour' || timeseries.interval === 'week' ? timeseries.interval : 'day';
  const metric = timeseries.metric === 'review_duration_ms'
    || timeseries.metric === 'deep_coverage_rate'
    || timeseries.metric === 'grounded_issue_rate'
    || timeseries.metric === 'issue_addressed_rate'
    || timeseries.metric === 'issue_dismissed_rate'
    || timeseries.metric === 'partial_rate'
    || timeseries.metric === 'review_count'
    || timeseries.metric === 'issues_found'
    || timeseries.metric === 'findings_found'
    ? timeseries.metric
    : 'ttfs_ms';
  const points = Array.isArray(timeseries.points) ? timeseries.points : [];
  return {
    projectId: typeof timeseries.projectId === 'string' ? timeseries.projectId : null,
    reviewType,
    scope,
    window: {
      key: windowKey,
      from: typeof windowPayload.from === 'string' ? windowPayload.from : new Date(0).toISOString(),
      to: typeof windowPayload.to === 'string' ? windowPayload.to : new Date(0).toISOString(),
    },
    metric,
    metricLabel: typeof timeseries.metricLabel === 'string' ? timeseries.metricLabel : '',
    metricDescription: typeof timeseries.metricDescription === 'string' ? timeseries.metricDescription : '',
    interval,
    points: points.map((point) => {
      const payload = point && typeof point === 'object' ? point as Record<string, unknown> : {};
      return {
        bucketStart: typeof payload.bucketStart === 'string' ? payload.bucketStart : new Date(0).toISOString(),
        bucketEnd: typeof payload.bucketEnd === 'string' ? payload.bucketEnd : new Date(0).toISOString(),
        reviewCount: toFiniteNumber(payload.reviewCount, 0),
        value: payload.value == null ? null : toFiniteNumber(payload.value, 0),
        numerator: payload.numerator == null ? null : toFiniteNumber(payload.numerator, 0),
        denominator: payload.denominator == null ? null : toFiniteNumber(payload.denominator, 0),
        sampleSize: toFiniteNumber(payload.sampleSize, 0),
        aggregation: payload.aggregation === 'median'
          ? 'median'
          : payload.aggregation === 'count'
            ? 'count'
            : payload.aggregation === 'sum'
              ? 'sum'
              : 'rate',
      };
    }),
  };
}

function normalizeTrustAnalyticsBreakdownMetric(rawMetric: unknown): TrustAnalyticsBreakdown['groups'][number]['metric'] {
  const metric = rawMetric && typeof rawMetric === 'object'
    ? rawMetric as Record<string, unknown>
    : {};
  return {
    value: metric.value == null ? null : toFiniteNumber(metric.value, 0),
    numerator: toFiniteNumber(metric.numerator, 0),
    denominator: metric.denominator == null ? null : toFiniteNumber(metric.denominator, 0),
    sampleSize: toFiniteNumber(metric.sampleSize, 0),
    minimumSampleSize: toFiniteNumber(metric.minimumSampleSize, 0),
    isInsufficientSample: metric.isInsufficientSample === true,
  };
}

function normalizeTrustAnalyticsBreakdown(rawBreakdown: unknown): TrustAnalyticsBreakdown {
  const breakdown = (rawBreakdown && typeof rawBreakdown === 'object')
    ? rawBreakdown as Record<string, unknown>
    : {};
  const windowPayload = breakdown.window && typeof breakdown.window === 'object'
    ? breakdown.window as Record<string, unknown>
    : {};
  const reviewType = breakdown.reviewType === 'branch_review' || breakdown.reviewType === 'changeset' || breakdown.reviewType === 'pr_review'
    ? breakdown.reviewType
    : null;
  const scope = breakdown.scope === 'branches' || breakdown.scope === 'prs' ? breakdown.scope : 'all';
  const windowKey = windowPayload.key === '24h' || windowPayload.key === '30d' || windowPayload.key === 'custom'
    ? windowPayload.key
    : '7d';
  const by = breakdown.by === 'language' || breakdown.by === 'path_pattern'
    ? breakdown.by
    : 'provider_model';
  const metric = breakdown.metric === 'grounded_issue_rate'
    || breakdown.metric === 'deep_coverage_rate'
    || breakdown.metric === 'issue_addressed_rate'
    || breakdown.metric === 'issue_dismissed_rate'
    || breakdown.metric === 'issue_outcome_coverage'
    || breakdown.metric === 'partial_rate'
    || breakdown.metric === 'review_count'
    || breakdown.metric === 'issues_found'
    || breakdown.metric === 'findings_found'
    || breakdown.metric === 'high_risk_findings'
    ? breakdown.metric
    : 'review_count';
  const groups = Array.isArray(breakdown.groups) ? breakdown.groups : [];
  return {
    projectId: typeof breakdown.projectId === 'string' ? breakdown.projectId : null,
    reviewType,
    scope,
    window: {
      key: windowKey,
      from: typeof windowPayload.from === 'string' ? windowPayload.from : new Date(0).toISOString(),
      to: typeof windowPayload.to === 'string' ? windowPayload.to : new Date(0).toISOString(),
    },
    by: by as TrustAnalyticsBreakdownDimension,
    metric: metric as TrustAnalyticsBreakdownMetric,
    groups: groups.map((group) => {
      const payload = group && typeof group === 'object' ? group as Record<string, unknown> : {};
      return {
        key: typeof payload.key === 'string' ? payload.key : 'unknown',
        label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : 'unknown',
        reviewCount: toFiniteNumber(payload.reviewCount, 0),
        metric: normalizeTrustAnalyticsBreakdownMetric(payload.metric),
      };
    }),
  };
}

function normalizeChangesetPayload<T extends ChangeSetIndex | ChangeSet>(changeset: T): T {
  if (!changeset || typeof changeset !== 'object') {
    return changeset;
  }

  const normalized = { ...changeset } as T & Record<string, unknown>;
  const rawCommitSha = normalized.commitSha;
  const normalizedCommitSha = normalizeCommitSha(rawCommitSha);

  if (normalizedCommitSha) {
    normalized.commitSha = normalizedCommitSha;
  } else {
    delete normalized.commitSha;
  }

  if (
    (!normalized.commitMessage || typeof normalized.commitMessage !== 'string')
    && rawCommitSha
    && typeof rawCommitSha === 'object'
    && typeof (rawCommitSha as { commitMessage?: unknown }).commitMessage === 'string'
  ) {
    normalized.commitMessage = (rawCommitSha as { commitMessage: string }).commitMessage;
  }

  if ('reviewData' in normalized) {
    normalized.reviewData = normalizeReviewData(normalized.reviewData);
  }
  if ('trustAnalytics' in normalized) {
    normalized.trustAnalytics = normalizeTrustReviewAnalytics(normalized.trustAnalytics) as ChangeSet['trustAnalytics'];
  }
  if ('reviewLifecycle' in normalized || 'reviewStatus' in normalized) {
    normalized.reviewLifecycle = normalizeReviewLifecycleSnapshot(
      normalized.reviewLifecycle,
      normalized.reviewStatus
    );
  }
  if ('verification' in normalized && normalized.verification && typeof normalized.verification === 'object') {
    const verification = normalized.verification as Record<string, unknown>;
    const rawChecks = verification.checks && typeof verification.checks === 'object'
      ? verification.checks as Record<string, unknown>
      : {};
    normalized.verification = {
      lint: verification.lint === 'pass' || verification.lint === 'fail' ? verification.lint : 'not_run',
      unit: verification.unit === 'pass' || verification.unit === 'fail' ? verification.unit : 'not_run',
      e2e: verification.e2e === 'pass' || verification.e2e === 'fail' ? verification.e2e : 'not_run',
      lastRunAt: typeof verification.lastRunAt === 'string' ? verification.lastRunAt : null,
      logs: verification.logs && typeof verification.logs === 'object'
        ? Object.fromEntries(
          Object.entries(verification.logs as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string')
        )
        : {},
      checks: Object.fromEntries(
        Object.entries(rawChecks)
          .filter(([, value]) => value && typeof value === 'object')
          .map(([key, value]) => {
            const check = value as Record<string, unknown>;
            return [key, {
              id: typeof check.id === 'string' && check.id.trim() ? check.id.trim() : key,
              label: typeof check.label === 'string' ? check.label : undefined,
              kind: typeof check.kind === 'string' ? check.kind : undefined,
              command: typeof check.command === 'string' ? check.command : undefined,
              status: check.status === 'pass' || check.status === 'fail' ? check.status : 'not_run',
              lastRunAt: typeof check.lastRunAt === 'string' ? check.lastRunAt : null,
              duration: toFiniteNumber(check.duration, 0) || undefined,
              exitCode: Number.isFinite(Number(check.exitCode)) ? Number(check.exitCode) : undefined,
            }];
          })
      ),
    } as ChangeSet['verification'];
  }

  return normalized as T;
}

function normalizeBranchReviewPayload<T extends BranchReview>(branchReview: T): T {
  if (!branchReview || typeof branchReview !== 'object') {
    return branchReview;
  }
  const normalized = { ...branchReview } as T & Record<string, unknown>;
  if ('reviewJson' in normalized) {
    normalized.reviewJson = normalizeReviewData(normalized.reviewJson) as BranchReview['reviewJson'];
  }
  if ('trustAnalytics' in normalized) {
    normalized.trustAnalytics = normalizeTrustReviewAnalytics(normalized.trustAnalytics) as BranchReview['trustAnalytics'];
  }
  normalized.reviewLifecycle = normalizeReviewLifecycleSnapshot(
    normalized.reviewLifecycle,
    normalized.reviewStatus
  );
  normalized.reviewActionEligibility = normalizeReviewActionEligibility(normalized.reviewActionEligibility);
  return normalized as T;
}

function normalizePrReviewPayload<T extends PrReview>(prReview: T): T {
  if (!prReview || typeof prReview !== 'object') {
    return prReview;
  }
  const normalized = { ...prReview } as T & Record<string, unknown>;
  normalized.assignees = Array.isArray(normalized.assignees)
    ? normalized.assignees
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
    : [];
  normalized.requestedReviewers = Array.isArray(normalized.requestedReviewers)
    ? normalized.requestedReviewers
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
    : [];
  normalized.reviewerParticipants = Array.isArray(normalized.reviewerParticipants)
    ? normalized.reviewerParticipants
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
    : [];
  normalized.githubCommentCount = Math.max(0, Math.trunc(Number(normalized.githubCommentCount) || 0));
  normalized.githubReviewCommentCount = Math.max(0, Math.trunc(Number(normalized.githubReviewCommentCount) || 0));
  normalized.githubReviewDecision = normalizeNullableString(normalized.githubReviewDecision);
  normalized.githubMergeStateStatus = normalizeNullableString(normalized.githubMergeStateStatus);
  normalized.githubLatestReviewState = normalizeNullableString(normalized.githubLatestReviewState);
  normalized.githubLatestReviewAuthor = normalizeNullableString(normalized.githubLatestReviewAuthor);
  normalized.githubLatestReviewSubmittedAt = normalizeNullableString(normalized.githubLatestReviewSubmittedAt);
  normalized.githubReviewStatusSyncedAt = normalizeNullableString(normalized.githubReviewStatusSyncedAt);
  normalized.githubUpdatedAt = normalizeNullableString(normalized.githubUpdatedAt);
  normalized.githubReviewStateCounts = normalizeNumberRecord(normalized.githubReviewStateCounts);
  if ('reviewJson' in normalized) {
    normalized.reviewJson = normalizeReviewData(normalized.reviewJson) as PrReview['reviewJson'];
  }
  normalized.reviewLifecycle = normalizeReviewLifecycleSnapshot(
    normalized.reviewLifecycle,
    normalized.reviewStatus
  );
  normalized.reviewActionEligibility = normalizeReviewActionEligibility(normalized.reviewActionEligibility);
  normalized.reviewCommentEligibility = normalizeReviewCommentEligibility(normalized.reviewCommentEligibility);
  normalized.reviewParityGate = normalizeReviewParityGate(normalized.reviewParityGate);
  const latestPublicationAction = normalizeStatusString(normalized.latestPublicationAction);
  normalized.latestPublicationAction = latestPublicationAction === 'approve'
    ? 'approve'
    : latestPublicationAction === 'request_changes'
      ? 'request_changes'
      : latestPublicationAction === 'comment'
        ? 'comment'
        : null;
  normalized.latestPublicationHeadSha = typeof normalized.latestPublicationHeadSha === 'string'
    && normalized.latestPublicationHeadSha.trim()
    ? normalized.latestPublicationHeadSha.trim()
    : null;
  normalized.latestPublicationAt = typeof normalized.latestPublicationAt === 'string'
    && normalized.latestPublicationAt.trim()
    ? normalized.latestPublicationAt.trim()
    : null;
  normalized.latestApprovedPublicationHeadSha = typeof normalized.latestApprovedPublicationHeadSha === 'string'
    && normalized.latestApprovedPublicationHeadSha.trim()
    ? normalized.latestApprovedPublicationHeadSha.trim()
    : null;
  normalized.latestApprovedPublicationAt = typeof normalized.latestApprovedPublicationAt === 'string'
    && normalized.latestApprovedPublicationAt.trim()
    ? normalized.latestApprovedPublicationAt.trim()
    : null;
  return normalized as T;
}

// ============================================================================
// CHANGESET API
// ============================================================================

export interface RevertResult {
  revertedFiles: { path: string; action: 'reverted' | 'deleted' | 'restored' }[];
  errors: { path: string; error: string }[];
}

export interface ReapplyResult {
  reappliedFiles: { path: string; action: 'reapplied' | 'deleted' | 'created' }[];
  errors: { path: string; error: string }[];
}

export interface CommitResult {
  commitSha: string;
  branch: string;
  warnings?: string[];
}

export interface CommitError {
  success: false;
  errors: string[];
  warnings?: string[];
  blockedReason: string;
}

export interface GitStatus {
  isGitRepo: boolean;
  currentBranch: string | null;
  originUrl?: string | null;
  isGitHub?: boolean;
  owner?: string | null;
  repo?: string | null;
  ahead?: number;
  behind?: number;
  hasUpstream?: boolean;
  dirty?: boolean;
  modified?: number;
  created?: number;
  deleted?: number;
  staged?: number;
  conflicted?: number;
  // The current branch HEAD SHA. Used by the walkthrough flow to detect
  // whether new commits have landed since the loaded walkthrough — without
  // requiring a parent-component refetch first.
  headSha?: string | null;
}

export interface AvailableChecks {
  lint: boolean;
  unit: boolean;
  e2e: boolean;
  hasChecks?: boolean;
  checks?: VerifyCheckConfig[];
  projectType?: string | null;
}

export interface VerificationCheckResult {
  status: 'pass' | 'fail';
  exitCode: number;
  logs: string;
  duration: number;
  checkId?: string;
  kind?: string;
  label?: string;
}

export type VerificationResults = Record<string, VerificationCheckResult>;

export interface PublishMethod {
  method: 'vercel' | 'script' | 'manual';
  command?: string;
  instructions?: string[];
  packageManager?: 'pnpm' | 'yarn' | 'npm';
  deployCommands?: {
    install: string;
    deploy: string;
  };
  hasDeployScript?: boolean;
}

export interface PublishPreflight {
  isGitRepo: boolean;
  workingTreeClean: boolean;
  changesetCommitted: boolean;
  changesetCommitSha: string | null;
}

export interface EligibleChangeset {
  id: string;
  displayId?: string | null;
  title: string;
  commitMessage?: string | null;
  status: import('@/types').ChangeSetStatus;
  createdAt: string;
  fileCount: number;
  commitSha?: string | null;
  verification?: Omit<import('@/types').ChangeSetVerification, 'logs'> | null;
}

export interface MissingSecret {
  integration: string;
  key: string;
  docsUrl: string;
}

export interface DatabaseProvisioning {
  needsDatabase: boolean;
  dbType?: string;
  dbPackage?: string;
  supabaseConnected: boolean;
  supabaseLinked: boolean;
  supabaseProjectRef?: string | null;
  supabaseProjectName?: string | null;
}

export interface PublishStatus {
  canPublish: boolean;
  reason?: string;
  latestChangeset?: {
    id: string;
    displayId?: string | null;
    title: string;
    createdAt: string;
    verification: import('@/types').ChangeSetVerification;
    commitSha?: string;
  };
  eligibleChangesets: EligibleChangeset[];
  publishMethod: PublishMethod;
  availableChecks: AvailableChecks;
  preflight: PublishPreflight;
  secretsReady?: boolean;
  missingSecrets?: MissingSecret[];
  databaseProvisioning?: DatabaseProvisioning;
}

export interface PublishResult {
  success: boolean;
  logs?: string;
  url?: string;
  error?: string;
  instructions?: string[];
}

export const changesetApi = {
  /**
   * Get git repository status for a project
   */
  getGitStatus: async (projectId: string) => {
    const response = await api.get<{ success: boolean } & GitStatus>(
      `/projects/${projectId}/git-status`
    );
    return response.data;
  },

  /**
   * List all changesets for a project (index only, no file contents)
   */
  list: async (projectId: string) => {
    const response = await api.get<{ success: boolean; changesets: ChangeSetIndex[] }>(
      `/projects/${projectId}/changesets`
    );
    return {
      ...response.data,
      changesets: response.data.changesets.map(cs => normalizeChangesetPayload(cs)),
    };
  },

  /**
   * Get a single changeset with full file contents
   */
  get: async (projectId: string, changesetId: string) => {
    const response = await api.get<{ success: boolean; changeset: ChangeSet }>(
      `/projects/${projectId}/changesets/${changesetId}`
    );
    return {
      ...response.data,
      changeset: normalizeChangesetPayload(response.data.changeset),
    };
  },

  /**
   * Revert a changeset
   */
  revert: async (projectId: string, changesetId: string) => {
    const response = await api.post<{ success: boolean; message: string } & RevertResult>(
      `/projects/${projectId}/changesets/${changesetId}/revert`
    );
    return response.data;
  },

  /**
   * Reapply a reverted changeset
   */
  reapply: async (projectId: string, changesetId: string) => {
    const response = await api.post<{ success: boolean; message: string } & ReapplyResult>(
      `/projects/${projectId}/changesets/${changesetId}/reapply`
    );
    return response.data;
  },

  /**
   * Commit a changeset to git
   */
  commit: async (projectId: string, changesetId: string, message?: string) => {
    const response = await api.post<{ success: boolean; message: string } & CommitResult>(
      `/projects/${projectId}/changesets/${changesetId}/commit`,
      message ? { message } : {}
    );
    return {
      ...response.data,
      commitSha: normalizeCommitSha((response.data as any).commitSha) || '',
    };
  },

  /**
   * Get available verification checks for a project
   */
  getAvailableChecks: async (projectId: string) => {
    const response = await api.get<{ success: boolean } & AvailableChecks>(
      `/projects/${projectId}/available-checks`
    );
    return response.data;
  },

  /**
   * Run verification checks on a changeset
   */
  runVerification: async (
    projectId: string,
    changesetId: string,
    checks?: string[]
  ) => {
    const response = await api.post<{
      success: boolean;
      verification: import('@/types').ChangeSetVerification;
      results: VerificationResults;
      status?: import('@/types').ChangeSetStatus;
      autoCommitted?: boolean;
      commitSha?: string | null;
    }>(
      `/projects/${projectId}/changesets/${changesetId}/verify`,
      checks ? { checks } : {}
    );
    return {
      ...response.data,
      commitSha: normalizeCommitSha(response.data.commitSha) || null,
    };
  },

  /**
   * Update a changeset's summary
   */
  updateSummary: async (projectId: string, changesetId: string, summary: string) => {
    const response = await api.patch<{ success: boolean; changeset: { id: string; summary: string | null } }>(
      `/projects/${projectId}/changesets/${changesetId}/summary`,
      { summary }
    );
    return response.data;
  },

  /**
   * Get per-project verification check config
   */
  getVerifyConfig: async (projectId: string): Promise<VerifyConfig> => {
    const response = await api.get<VerifyConfig>(
      `/projects/${projectId}/verify-config`
    );
    return response.data;
  },

  /**
   * Update per-project verification check config
   */
  updateVerifyConfig: async (projectId: string, config: Partial<VerifyConfig>): Promise<VerifyConfig> => {
    const response = await api.put<VerifyConfig>(
      `/projects/${projectId}/verify-config`,
      config
    );
    return response.data;
  },
};

export interface VerifyConfig {
  version?: number;
  autoRun?: 'never' | 'on_changeset';
  projectType?: string | null;
  checks: VerifyCheckConfig[];
  lint: boolean;
  unit: boolean;
  e2e: boolean;
}

export interface VerifyCheckConfig {
  id: string;
  label: string;
  kind: 'lint' | 'typecheck' | 'build' | 'unit' | 'integration' | 'e2e' | 'custom';
  command: string;
  workdir?: string;
  enabled: boolean;
  source?: string;
}

// ============================================================================
// ACTIONS API — Unified action execution
// ============================================================================

export interface ActionResult {
  success: boolean;
  actionId: string | null;
  type: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ActionLogEntry {
  id: string;
  project_id: string;
  changeset_id: string | null;
  action_type: string;
  action_status: 'pending' | 'running' | 'completed' | 'failed';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error_message: string | null;
  triggered_at: string;
  completed_at: string | null;
}

export const actionApi = {
  /**
   * Execute an action against a changeset
   */
  execute: async (projectId: string, changesetId: string, actionType: string, options?: Record<string, unknown>) => {
    const response = await api.post<ActionResult & { success: boolean }>(
      `/projects/${projectId}/changesets/${changesetId}/actions/${actionType}`,
      options || {}
    );
    return response.data;
  },

  /**
   * Shorthand: push
   */
  push: async (projectId: string, changesetId: string, options?: { branch?: string; remote?: string }) => {
    const response = await api.post<ActionResult & { success: boolean }>(
      `/projects/${projectId}/changesets/${changesetId}/actions/push`,
      options || {}
    );
    return response.data;
  },

  /**
   * Shorthand: deploy
   */
  deploy: async (projectId: string, changesetId: string, options?: { projectName?: string }) => {
    const response = await api.post<ActionResult & { success: boolean }>(
      `/projects/${projectId}/changesets/${changesetId}/actions/deploy`,
      options || {}
    );
    return response.data;
  },

  /**
   * Shorthand: rollback
   */
  rollback: async (projectId: string, changesetId: string, options?: { autoPush?: boolean }) => {
    const response = await api.post<ActionResult & { success: boolean }>(
      `/projects/${projectId}/changesets/${changesetId}/actions/rollback`,
      options || {}
    );
    return response.data;
  },

  /**
   * Shorthand: verify
   */
  verify: async (projectId: string, changesetId: string, options?: { checks?: string[] }) => {
    const response = await api.post<ActionResult & { success: boolean }>(
      `/projects/${projectId}/changesets/${changesetId}/actions/verify`,
      options || {}
    );
    return response.data;
  },

  /**
   * Download export bundle
   */
  exportBundle: (projectId: string, changesetId: string) => {
    return `${api.defaults.baseURL}/projects/${projectId}/changesets/${changesetId}/export-bundle`;
  },

  /**
   * Get action execution log
   */
  getLog: async (projectId: string, options?: { changesetId?: string; actionType?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.changesetId) params.set('changesetId', options.changesetId);
    if (options?.actionType) params.set('actionType', options.actionType);
    if (options?.limit) params.set('limit', String(options.limit));
    const response = await api.get<{ success: boolean; actions: ActionLogEntry[] }>(
      `/projects/${projectId}/actions-log?${params.toString()}`
    );
    return response.data;
  },
};

// ============================================================================
// GIT WATCHER API
// ============================================================================

interface WatcherStatus {
  projectId: string;
  branch?: string;
  lastKnownHead?: string | null;
  watching: boolean;
}

export const watcherApi = {
  /**
   * Start watching a project for git changes
   */
  start: async (projectId: string, branch?: string) => {
    const response = await api.post<{ success: boolean; watching: boolean; status: WatcherStatus }>(
      `/projects/${projectId}/watcher/start`,
      { branch }
    );
    return response.data;
  },

  /**
   * Stop watching a project
   */
  stop: async (projectId: string) => {
    const response = await api.post<{ success: boolean; stopped: boolean }>(
      `/projects/${projectId}/watcher/stop`
    );
    return response.data;
  },

  /**
   * Get watcher status for a project
   */
  getStatus: async (projectId: string) => {
    const response = await api.get<{ success: boolean; watching: boolean; status: WatcherStatus }>(
      `/projects/${projectId}/watcher/status`
    );
    return response.data;
  },

  /**
   * Manual sync — immediately poll for changes
   */
  syncNow: async (projectId: string) => {
    const response = await api.post<{ success: boolean; synced: boolean; status: WatcherStatus }>(
      `/projects/${projectId}/watcher/sync`
    );
    return response.data;
  },
};

// ============================================================================
// PUBLISH API
// ============================================================================

export const publishApi = {
  /**
   * Get publish status for a project
   */
  getStatus: async (projectId: string) => {
    const response = await api.get<{ success: boolean } & PublishStatus>(
      `/projects/${projectId}/publish-status`
    );
    return response.data;
  },

  /**
   * Execute publish for a project
   * @param changesetId - Optional specific changeset ID to publish (defaults to latest eligible)
   */
  publish: async (projectId: string, changesetId?: string) => {
    const response = await api.post<PublishResult & { changesetId?: string }>(
      `/projects/${projectId}/publish`,
      changesetId ? { changesetId } : {}
    );
    return response.data;
  },

  /**
   * Commit all uncommitted working tree changes
   */
  commitWorkingTree: async (projectId: string, message?: string) => {
    const response = await api.post<{
      success: boolean;
      message: string;
      commitSha: string;
      branch: string;
      filesCommitted: string[];
    }>(`/projects/${projectId}/commit-working-tree`, { message });
    return response.data;
  },
};

export const screenshotApi = {
  /**
   * Save a screenshot
   */
  saveScreenshot: async (
    projectId: string,
    testId: string,
    stepIndex: number,
    imageData: string,
    type: 'current' | 'baseline' = 'current'
  ) => {
    const response = await api.post<{ success: boolean; screenshot: { path: string; size: number } }>(
      `/projects/${projectId}/tests/${testId}/screenshots`,
      { stepIndex, imageData, type }
    );
    return response.data;
  },

  /**
   * Get baseline screenshot
   */
  getBaseline: async (projectId: string, testId: string, stepIndex: number) => {
    const response = await api.get<{ success: boolean; baseline: BaselineInfo }>(
      `/projects/${projectId}/tests/${testId}/screenshots/${stepIndex}/baseline`
    );
    return response.data;
  },

  /**
   * Set baseline screenshot
   */
  setBaseline: async (projectId: string, testId: string, stepIndex: number, imageData?: string) => {
    const response = await api.post<{ success: boolean; baseline: { success: boolean; path: string } }>(
      `/projects/${projectId}/tests/${testId}/screenshots/${stepIndex}/set-baseline`,
      imageData ? { imageData } : {}
    );
    return response.data;
  },

  /**
   * Compare screenshot against baseline
   */
  compareScreenshot: async (
    projectId: string,
    testId: string,
    stepIndex: number,
    imageData: string,
    threshold = 0.001
  ) => {
    const response = await api.post<{ success: boolean; comparison: ScreenshotComparison }>(
      `/projects/${projectId}/tests/${testId}/screenshots/${stepIndex}/compare`,
      { imageData, threshold }
    );
    return response.data;
  },
};

// ============================================================================
// ATLAS HOSTING API
// ============================================================================

export interface AtlasHostingStatus {
  enabled: boolean;
  reason?: string;
}

export interface PublishAttempt {
  id: string;
  project_id: string;
  changeset_id: string | null;
  commit_hash: string | null;
  vercel_project_id: string | null;
  deployment_id: string | null;
  deployment_url: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  started_at: string | null;
  finished_at: string | null;
  logs: string | null;
  error_message: string | null;
  created_at: string;
}

export interface AtlasHostingEventHandlers {
  onLog?: (text: string) => void;
  onComplete?: (data: { success: boolean; url: string; vercelUrl?: string; deploymentId: string }) => void;
  onError?: (error: string) => void;
  onStatus?: (status: string) => void;
}

export interface PublishHistory {
  history: PublishAttempt[];
  lastDeploymentUrl: string | null;
  lastDeploymentAt: string | null;
}

export interface ProductionStatus {
  hasProduction: boolean;
  deployment?: {
    url: string;
    deployedAt: string;
    commitHash: string | null;
    changeset: {
      id: string;
      displayId: string | null;
      title: string;
      summary: string | null;
    } | null;
  };
}

export interface PromoteDeploymentResponse {
  success: boolean;
  message: string;
  production: {
    deploymentId: string | null;
    changesetId: string | null;
    commitHash: string | null;
    url: string | null;
    updatedAt: string | null;
  };
}

export interface DeploymentSettings {
  configured: boolean;
  hasToken: boolean;
  hasTeamId: boolean;
  teamId?: string | null;
  tokenPreview?: string | null;
}

export interface SaveDeploymentSettingsResponse {
  success: boolean;
  username: string;
  message: string;
  teamId?: string | null;
  tokenPreview?: string | null;
}

export interface ResetDeploymentSettingsResponse {
  success: boolean;
  message: string;
}

export const atlasHostingApi = {
  /**
   * Get Atlas Hosting status (is it configured?)
   */
  getStatus: async () => {
    const response = await api.get<{ success: boolean } & AtlasHostingStatus>('/atlas-hosting/status');
    return response.data;
  },

  /**
   * Get deployment settings (desktop-only)
   */
  getDeploymentSettings: async () => {
    const response = await api.get<{ success: boolean } & DeploymentSettings>('/atlas-hosting/deployment-settings');
    return response.data;
  },

  /**
   * Save Vercel deployment credentials (desktop-only)
   * Validates the token against Vercel API before persisting
   */
  saveDeploymentSettings: async (vercelToken: string, vercelTeamId?: string) => {
    const response = await api.put<SaveDeploymentSettingsResponse>('/atlas-hosting/deployment-settings', {
      vercelToken,
      vercelTeamId,
    });
    return response.data;
  },

  resetDeploymentSettings: async () => {
    const response = await api.delete<ResetDeploymentSettingsResponse>('/atlas-hosting/deployment-settings');
    return response.data;
  },

  /**
   * Get current production deployment status
   */
  getProductionStatus: async (projectId: string) => {
    const response = await api.get<{ success: boolean } & ProductionStatus>(
      `/projects/${projectId}/production-status`
    );
    return response.data;
  },

  /**
   * Start Atlas Hosting deployment
   */
  startPublish: async (projectId: string, changesetId: string, commitHash: string) => {
    const response = await api.post<{
      success: boolean;
      publishAttemptId: string;
      message: string;
    }>(`/projects/${projectId}/publish/atlas-hosting`, {
      changesetId,
      commitHash,
    });
    return response.data;
  },

  /**
   * Subscribe to deployment events via SSE
   * Returns a cleanup function to close the connection
   */
  subscribeToEvents: (attemptId: string, handlers: AtlasHostingEventHandlers): (() => void) => {
    // EventSource doesn't support custom headers; pass auth token via query param.
    // TODO: Backend SSE endpoints need to accept req.query.token for auth validation.
    const token = getAuthToken();
    const authParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const eventSource = new EventSource(`${API_BASE_URL}/publish/atlas-hosting/${attemptId}/events${authParam}`);

    eventSource.addEventListener('log', (event) => {
      const data = JSON.parse(event.data);
      handlers.onLog?.(data.text);
    });

    eventSource.addEventListener('status', (event) => {
      const data = JSON.parse(event.data);
      handlers.onStatus?.(data.status);
    });

    eventSource.addEventListener('complete', (event) => {
      const data = JSON.parse(event.data);
      handlers.onComplete?.(data);
      eventSource.close();
    });

    eventSource.addEventListener('error', (event) => {
      // Check if it's an SSE error event with data
      if (event instanceof MessageEvent && event.data) {
        try {
          const data = JSON.parse(event.data);
          handlers.onError?.(data.error || 'Deployment failed');
        } catch {
          handlers.onError?.('Deployment failed');
        }
      } else {
        // Connection error
        handlers.onError?.('Connection to deployment server lost');
      }
      eventSource.close();
    });

    // Return cleanup function
    return () => {
      eventSource.close();
    };
  },

  /**
   * Get a single publish attempt
   */
  getAttempt: async (attemptId: string) => {
    const response = await api.get<{ success: boolean; attempt: PublishAttempt }>(
      `/publish/atlas-hosting/${attemptId}`
    );
    return response.data;
  },

  /**
   * Get publish history for a project
   */
  getHistory: async (projectId: string, limit = 10) => {
    const response = await api.get<{ success: boolean } & PublishHistory>(
      `/projects/${projectId}/publish-history`,
      { params: { limit } }
    );
    return response.data;
  },

  /**
   * Get deployment history with production pointer
   */
  getDeployments: async (projectId: string, limit = 20) => {
    const response = await api.get<{ success: boolean } & DeploymentsResponse>(
      `/projects/${projectId}/deployments`,
      { params: { limit } }
    );
    return response.data;
  },

  /**
   * Promote a previous deployment to production (rollback)
   */
  promoteDeployment: async (projectId: string, deploymentId: string) => {
    const response = await api.post<PromoteDeploymentResponse>(
      `/projects/${projectId}/deployments/${deploymentId}/promote`
    );
    return response.data;
  },

  /**
   * Subscribe to promotion events via SSE (for streaming logs)
   * Returns a cleanup function to close the connection
   */
  subscribeToPromoteEvents: (
    projectId: string,
    deploymentId: string,
    handlers: {
      onLog?: (text: string) => void;
      onComplete?: (data: PromoteDeploymentResponse) => void;
      onError?: (error: string) => void;
      onStatus?: (status: string) => void;
    }
  ): (() => void) => {
    // EventSource doesn't support custom headers; pass auth token via query param
    const token = getAuthToken();
    const authParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const eventSource = new EventSource(
      `${API_BASE_URL}/projects/${projectId}/deployments/${deploymentId}/promote/events${authParam}`
    );

    eventSource.addEventListener('log', (event) => {
      const data = JSON.parse(event.data);
      handlers.onLog?.(data.text);
    });

    eventSource.addEventListener('status', (event) => {
      const data = JSON.parse(event.data);
      handlers.onStatus?.(data.status);
    });

    eventSource.addEventListener('complete', (event) => {
      const data = JSON.parse(event.data);
      handlers.onComplete?.(data);
      eventSource.close();
    });

    eventSource.addEventListener('error', (event) => {
      if (event instanceof MessageEvent && event.data) {
        try {
          const data = JSON.parse(event.data);
          handlers.onError?.(data.error || 'Promotion failed');
        } catch {
          handlers.onError?.('Promotion failed');
        }
      } else {
        handlers.onError?.('Connection to server lost');
      }
      eventSource.close();
    });

    return () => {
      eventSource.close();
    };
  },
};

// ============================================================================
// HOSTING MANAGEMENT API
// ============================================================================

export interface HostingInfo {
  vercelProjectId: string;
  vercelProjectName: string;
  customDomain: string;
  lastDeploymentUrl: string | null;
  lastDeploymentAt: string | null;
}

export const hostingApi = {
  /**
   * Get hosting status for a project
   */
  getStatus: async (projectId: string) => {
    const response = await api.get<{
      success: boolean;
      hosting: HostingInfo | null;
      message?: string;
    }>(`/projects/${projectId}/hosting`);
    return response.data;
  },

  /**
   * Disable production URL (remove custom domain)
   * App becomes inaccessible at *.atlasengine.dev but Vercel project remains
   */
  disableDomain: async (projectId: string) => {
    const response = await api.delete<{
      success: boolean;
      message: string;
      domain: string;
    }>(`/projects/${projectId}/hosting/domain`);
    return response.data;
  },

  /**
   * Delete Vercel project entirely (nuclear option)
   * Requires confirmation by providing the project slug
   */
  deleteHosting: async (projectId: string, confirmSlug: string) => {
    const response = await api.delete<{
      success: boolean;
      message: string;
      deletedProject: string;
    }>(`/projects/${projectId}/hosting`, {
      data: { confirmSlug },
    });
    return response.data;
  },
};

// ============================================================================
// SECRETS API
// ============================================================================

export const secretsApi = {
  /**
   * List all secrets for a project (values masked)
   */
  list: async (projectId: string, environment = 'production') => {
    const response = await api.get<{ success: boolean; secrets: ProjectSecret[] }>(
      `/projects/${projectId}/secrets`,
      { params: { environment } }
    );
    return response.data;
  },

  /**
   * Get the full unmasked value of a secret (for reveal/copy)
   */
  getValue: async (projectId: string, secretId: string) => {
    const response = await api.get<{ success: boolean; value: string }>(
      `/projects/${projectId}/secrets/${secretId}/value`
    );
    return response.data;
  },

  /**
   * Create a new secret
   */
  create: async (
    projectId: string,
    data: { key: string; value: string; isSecret?: boolean; environment?: string }
  ) => {
    const response = await api.post<{ success: boolean; secret: ProjectSecret }>(
      `/projects/${projectId}/secrets`,
      data
    );
    return response.data;
  },

  /**
   * Update a secret
   */
  update: async (
    projectId: string,
    secretId: string,
    data: { key?: string; value?: string; isSecret?: boolean }
  ) => {
    const response = await api.put<{ success: boolean; secret: ProjectSecret }>(
      `/projects/${projectId}/secrets/${secretId}`,
      data
    );
    return response.data;
  },

  /**
   * Delete a secret
   */
  delete: async (projectId: string, secretId: string) => {
    const response = await api.delete<{ success: boolean; message: string }>(
      `/projects/${projectId}/secrets/${secretId}`
    );
    return response.data;
  },

  /**
   * Import secrets from .env file content
   */
  importEnv: async (
    projectId: string,
    content: string,
    environment = 'production'
  ) => {
    const response = await api.post<{
      success: boolean;
      created: number;
      updated: number;
      errors: string[];
      message: string;
    }>(`/projects/${projectId}/secrets/import`, { content, environment });
    return response.data;
  },

  /**
   * Detect known integrations and check for missing required environment variables
   */
  getIntegrations: async (projectId: string) => {
    const response = await api.get<IntegrationsResponse>(
      `/projects/${projectId}/secrets/integrations`
    );
    return response.data;
  },
};

// ==================== Claude API ====================

export interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  hasNativeAuth: boolean;
  hasStoredToken: boolean;
  hasOAuthToken?: boolean;
}

export interface ClaudeTestResult {
  authenticated: boolean;
  error?: string;
  deferredValidation?: boolean;
}

export interface ClaudeModel {
  id: string;
  name: string;
  alias: string;
  description?: string;
}

export interface ClaudeModelsResponse {
  models: ClaudeModel[];
  defaultModel: string;
}

export const claudeApi = {
  /**
   * Get Claude CLI status (installation and auth)
   */
  getStatus: async (options?: { refresh?: boolean }) => {
    console.log('[claudeApi] getStatus called, baseURL:', api.defaults.baseURL);
    const response = await api.get<{ success: boolean; data: ClaudeStatus }>(
      '/claude/status',
      {
        params: options?.refresh ? { refresh: '1' } : undefined,
      }
    );
    return response.data;
  },

  /**
   * Test Claude connection with optional token
   */
  testConnection: async (token?: string) => {
    const response = await api.post<{ success: boolean; data: ClaudeTestResult }>(
      '/claude/test',
      { token }
    );
    return response.data;
  },

  /**
   * Save OAuth token
   */
  saveToken: async (token: string) => {
    const response = await api.post<{ success: boolean; message: string }>(
      '/claude/token',
      { token }
    );
    return response.data;
  },

  /**
   * Clear OAuth token
   */
  clearToken: async () => {
    const response = await api.delete<{ success: boolean; message: string }>(
      '/claude/token'
    );
    return response.data;
  },

  /**
   * Get available models and user's default
   */
  getModels: async () => {
    const response = await api.get<{ success: boolean; data: ClaudeModelsResponse }>(
      '/claude/models'
    );
    return response.data;
  },

  /**
   * Update user's default model
   */
  setDefaultModel: async (model: string) => {
    const response = await api.put<{ success: boolean; message: string; model: string }>(
      '/claude/models/default',
      { model }
    );
    return response.data;
  },

  /**
   * Discover available models by probing Claude CLI
   * This makes API calls, so cached for 24h
   */
  discoverModels: async () => {
    const response = await api.post<{
      success: boolean;
      data: {
        models: ClaudeModel[];
        availableCount: number;
        cachedAt: number;
      }
    }>('/claude/models/discover');
    return response.data;
  },
};

// ============================================================================
// SETTINGS API
// ============================================================================

export interface SettingValue {
  key: string;
  value: string | null;
  exists: boolean;
  updatedAt?: string;
}

export type ReviewModelStrategy = 'smart' | 'latency_first' | 'max_quality' | 'custom' | 'adaptive' | 'performance';

export interface ReviewModelAdaptiveConfig {
  fastPathMaxFiles: number;
  fastPathMaxDiffChars: number;
  preferQualityOnHighRisk: boolean;
}

export type ReviewModelRolloutMode = 'off' | 'shadow' | 'canary' | 'on';

export interface ReviewModelRolloutConfig {
  mode: ReviewModelRolloutMode;
  canaryPercent: number;
  projectAllowlist: string[];
}

const DEFAULT_REVIEW_MODEL_ADAPTIVE: ReviewModelAdaptiveConfig = {
  fastPathMaxFiles: 12,
  fastPathMaxDiffChars: 45000,
  preferQualityOnHighRisk: true,
};

const DEFAULT_REVIEW_MODEL_ROLLOUT: ReviewModelRolloutConfig = {
  mode: 'on',
  canaryPercent: 25,
  projectAllowlist: [],
};

export interface ReviewModelConfig {
  strategy: ReviewModelStrategy;
  customModels?: {
    triage?: string;
    review?: string;
    synthesis?: string;
  };
  adaptive?: ReviewModelAdaptiveConfig;
  rollout?: ReviewModelRolloutConfig;
}

const REVIEW_MODEL_STRATEGY_SETTING_KEY = 'review_model_strategy';
const REVIEW_MODEL_CUSTOM_SETTING_KEY = 'review_model_custom';
const REVIEW_MODEL_ADAPTIVE_SETTING_KEY = 'review_model_adaptive';
const REVIEW_MODEL_ROLLOUT_SETTING_KEY = 'review_model_rollout';
const VALID_REVIEW_MODEL_STRATEGIES: ReviewModelStrategy[] = ['smart', 'latency_first', 'max_quality', 'custom', 'adaptive', 'performance'];
const VALID_REVIEW_MODEL_ROLLOUT_MODES: ReviewModelRolloutMode[] = ['off', 'shadow', 'canary', 'on'];

function normalizeReviewModelStrategy(value: unknown): ReviewModelStrategy {
  if (typeof value !== 'string') return 'smart';
  const normalized = value.trim().toLowerCase() as ReviewModelStrategy;
  return VALID_REVIEW_MODEL_STRATEGIES.includes(normalized) ? normalized : 'smart';
}

function parseReviewModelCustomModels(raw: string | null): ReviewModelConfig['customModels'] {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: ReviewModelConfig['customModels'] = {};
    for (const phase of ['triage', 'review', 'synthesis'] as const) {
      const value = parsed[phase];
      if (typeof value === 'string' && value.trim()) {
        next[phase] = value.trim();
      }
    }
    return next;
  } catch {
    return {};
  }
}

function clampReviewAdaptiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function parseReviewModelAdaptive(raw: string | null): ReviewModelAdaptiveConfig {
  if (!raw) return { ...DEFAULT_REVIEW_MODEL_ADAPTIVE };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_REVIEW_MODEL_ADAPTIVE };
    }
    return {
      fastPathMaxFiles: clampReviewAdaptiveInt(
        (parsed as { fastPathMaxFiles?: unknown }).fastPathMaxFiles,
        DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxFiles,
        1,
        200
      ),
      fastPathMaxDiffChars: clampReviewAdaptiveInt(
        (parsed as { fastPathMaxDiffChars?: unknown }).fastPathMaxDiffChars,
        DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxDiffChars,
        2000,
        1000000
      ),
      preferQualityOnHighRisk:
        typeof (parsed as { preferQualityOnHighRisk?: unknown }).preferQualityOnHighRisk === 'boolean'
          ? (parsed as { preferQualityOnHighRisk: boolean }).preferQualityOnHighRisk
          : DEFAULT_REVIEW_MODEL_ADAPTIVE.preferQualityOnHighRisk,
    };
  } catch {
    return { ...DEFAULT_REVIEW_MODEL_ADAPTIVE };
  }
}

function normalizeRolloutPatternList(value: unknown): string[] {
  if (!value) return [];
  const source = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const deduped = new Set<string>();
  for (const entry of source) {
    const normalized = String(entry || '').trim().toLowerCase();
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= 100) break;
  }
  return Array.from(deduped);
}

function parseReviewModelRollout(raw: string | null): ReviewModelRolloutConfig {
  if (!raw) return { ...DEFAULT_REVIEW_MODEL_ROLLOUT };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_REVIEW_MODEL_ROLLOUT };
    }
    const modeRaw = String((parsed as { mode?: unknown }).mode || '').trim().toLowerCase() as ReviewModelRolloutMode;
    return {
      mode: VALID_REVIEW_MODEL_ROLLOUT_MODES.includes(modeRaw) ? modeRaw : DEFAULT_REVIEW_MODEL_ROLLOUT.mode,
      canaryPercent: clampReviewAdaptiveInt(
        (parsed as { canaryPercent?: unknown }).canaryPercent,
        DEFAULT_REVIEW_MODEL_ROLLOUT.canaryPercent,
        0,
        100
      ),
      projectAllowlist: normalizeRolloutPatternList((parsed as { projectAllowlist?: unknown }).projectAllowlist),
    };
  } catch {
    return { ...DEFAULT_REVIEW_MODEL_ROLLOUT };
  }
}

export const settingsApi = {
  /**
   * Get a setting value by key
   */
  get: async (key: string): Promise<SettingValue> => {
    const response = await api.get<{
      success: boolean;
      key: string;
      value: string | null;
      exists: boolean;
      updatedAt?: string;
    }>(`/settings/${key}`);
    return response.data;
  },

  /**
   * Set a setting value (upsert)
   */
  set: async (key: string, value: string): Promise<SettingValue> => {
    const response = await api.put<{
      success: boolean;
      key: string;
      value: string;
      updatedAt: string;
    }>(`/settings/${key}`, { value });
    return { ...response.data, exists: true };
  },

  /**
   * Delete a setting
   */
  delete: async (key: string): Promise<{ deleted: boolean }> => {
    const response = await api.delete<{
      success: boolean;
      deleted: boolean;
      key?: string;
    }>(`/settings/${key}`);
    return { deleted: response.data.deleted };
  },

  /**
   * Get all settings
   */
  getAll: async (): Promise<Record<string, { value: string; updatedAt: string }>> => {
    const response = await api.get<{
      success: boolean;
      settings: Record<string, { value: string; updatedAt: string }>;
      count: number;
    }>('/settings');
    return response.data.settings;
  },

  /**
   * Reset all cached/setup state for sign-out.
   * Clears setup wizard state, detected providers, and preferences.
   */
  resetForSignout: async (): Promise<{ success: boolean; message: string }> => {
    const response = await api.post<{ success: boolean; message: string }>(
      '/settings/reset-for-signout'
    );
    return response.data;
  },

  /**
   * Get review model routing configuration from global settings.
   */
  getReviewModelConfig: async (): Promise<ReviewModelConfig> => {
    const [strategyRes, customRes, adaptiveRes, rolloutRes] = await Promise.all([
      settingsApi.get(REVIEW_MODEL_STRATEGY_SETTING_KEY),
      settingsApi.get(REVIEW_MODEL_CUSTOM_SETTING_KEY),
      settingsApi.get(REVIEW_MODEL_ADAPTIVE_SETTING_KEY),
      settingsApi.get(REVIEW_MODEL_ROLLOUT_SETTING_KEY),
    ]);
    const strategy = normalizeReviewModelStrategy(strategyRes.value);
    const customModels = parseReviewModelCustomModels(customRes.value);
    const adaptive = parseReviewModelAdaptive(adaptiveRes.value);
    const rollout = parseReviewModelRollout(rolloutRes.value);
    return {
      strategy,
      customModels,
      adaptive,
      rollout,
    };
  },

  /**
   * Persist review model routing configuration into global settings.
   */
  setReviewModelConfig: async (config: ReviewModelConfig): Promise<ReviewModelConfig> => {
    const strategy = normalizeReviewModelStrategy(config?.strategy);
    const customModels = config?.customModels || {};
    const adaptive: ReviewModelAdaptiveConfig = {
      fastPathMaxFiles: clampReviewAdaptiveInt(
        config?.adaptive?.fastPathMaxFiles,
        DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxFiles,
        1,
        200
      ),
      fastPathMaxDiffChars: clampReviewAdaptiveInt(
        config?.adaptive?.fastPathMaxDiffChars,
        DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxDiffChars,
        2000,
        1000000
      ),
      preferQualityOnHighRisk: config?.adaptive?.preferQualityOnHighRisk !== undefined
        ? !!config.adaptive.preferQualityOnHighRisk
        : DEFAULT_REVIEW_MODEL_ADAPTIVE.preferQualityOnHighRisk,
    };
    const rollout: ReviewModelRolloutConfig = {
      mode: VALID_REVIEW_MODEL_ROLLOUT_MODES.includes(
        String(config?.rollout?.mode || '').trim().toLowerCase() as ReviewModelRolloutMode
      )
        ? (String(config?.rollout?.mode || '').trim().toLowerCase() as ReviewModelRolloutMode)
        : DEFAULT_REVIEW_MODEL_ROLLOUT.mode,
      canaryPercent: clampReviewAdaptiveInt(
        config?.rollout?.canaryPercent,
        DEFAULT_REVIEW_MODEL_ROLLOUT.canaryPercent,
        0,
        100
      ),
      projectAllowlist: normalizeRolloutPatternList(config?.rollout?.projectAllowlist),
    };
    await Promise.all([
      settingsApi.set(REVIEW_MODEL_STRATEGY_SETTING_KEY, strategy),
      settingsApi.set(REVIEW_MODEL_CUSTOM_SETTING_KEY, JSON.stringify(customModels)),
      settingsApi.set(REVIEW_MODEL_ADAPTIVE_SETTING_KEY, JSON.stringify(adaptive)),
      settingsApi.set(REVIEW_MODEL_ROLLOUT_SETTING_KEY, JSON.stringify(rollout)),
    ]);
    const nextConfig = {
      strategy,
      customModels,
      adaptive,
      rollout,
    };
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('review-model-config-changed', { detail: nextConfig }));
    }
    return nextConfig;
  },
};

export interface McpStatusResponse {
  success: boolean;
  trustedContext: boolean;
  mcpServer: {
    packageExists: boolean;
    binaryExists: boolean;
    setupModuleExists: boolean;
    buildReady: boolean;
    remediation: string;
    details?: string;
    serverNameDefault?: string;
    serverBinaryPath?: string;
    guidanceSource?: 'shared' | 'fallback';
    setupSeparationSummary?: string;
    workflowPolicySummary?: string;
    recommendedCommands?: {
      list: string;
      auto: string;
      autoDryRun: string;
    };
  };
}

export interface McpAgentRecommendedCommands {
  preferred: string;
  dryRun: string;
  snippet: string;
}

export interface McpWorkflowGuidance {
  strategyId: 'codex_global_skill' | 'claude_global_guidance' | 'opencode_global_skill';
  title: string;
  defaultSummary: string;
  installSummary: string;
  installSteps: string[];
  snippetLabel: string;
  snippet: string;
  overrideSummary: string;
  fallbackSummary: string;
}

export interface McpWorkflowGuidanceState {
  status: 'installed' | 'not_installed' | 'manual_install_required' | 'not_supported';
  label: string;
  summary: string;
  detectedPath?: string | null;
}

export interface McpConnectionState {
  status: 'configured' | 'detected' | 'not_detected' | 'parse_error';
  label: string;
}

export interface McpSupportedAgent {
  id: string;
  displayName: string;
  format: 'json' | 'toml';
  configScope: 'user' | 'workspace';
  docsUrl: string;
  wrapperKey: string | null;
  supportStatus: 'shipped' | 'experimental' | 'deferred';
  supportLabel: string;
  restartHint: string;
  autoWriteSupported: boolean;
  recommendedCommands: McpAgentRecommendedCommands;
  workflowGuidance: McpWorkflowGuidance | null;
  workflowGuidanceState: McpWorkflowGuidanceState;
}

export interface McpDetectedAgent {
  id: string;
  displayName: string;
  format: 'json' | 'toml';
  configScope: 'user' | 'workspace';
  docsUrl: string;
  wrapperKey?: string;
  supportStatus: 'shipped' | 'experimental' | 'deferred';
  supportLabel: string;
  restartHint: string;
  autoWriteSupported: boolean;
  recommendedCommands: McpAgentRecommendedCommands;
  workflowGuidance: McpWorkflowGuidance | null;
  workflowGuidanceState: McpWorkflowGuidanceState;
  configPaths: string[];
  selectedConfigPath: string;
  existingConfigPath: string | null;
  isInstalled: boolean;
  alreadyConfigured: boolean;
  parseError: string | null;
  mcpConnectionState: McpConnectionState;
}

export interface McpAgentsResponse {
  success: boolean;
  supportedAgents: McpSupportedAgent[];
  detectedAgents: McpDetectedAgent[];
}

export interface McpConfigResponse {
  success: boolean;
  agent: {
    id: string;
    displayName: string;
    format: 'json' | 'toml';
    configScope: 'user' | 'workspace';
    docsUrl: string;
    wrapperKey: string | null;
    supportStatus: 'shipped' | 'experimental' | 'deferred';
    supportLabel: string;
    restartHint: string;
    autoWriteSupported: boolean;
    recommendedCommands: McpAgentRecommendedCommands;
    workflowGuidance: McpWorkflowGuidance | null;
    workflowGuidanceState: McpWorkflowGuidanceState;
  };
  backendUrl: string;
  serverName: string;
  configPath: string;
  snippet: string;
  jsonObject: Record<string, unknown> | null;
  serverEntry: Record<string, unknown>;
}

export interface McpSetupSyncRequest {
  backendUrl?: string;
  selectedAgentIds: string[];
  removeUnselected?: boolean;
  dryRun?: boolean;
  buildIfNeeded?: boolean;
}

export interface McpSetupSyncResponse {
  success: boolean;
  mode: 'sync';
  backendUrl: string | null;
  serverName?: string | null;
  selectedAgentIds: string[];
  supportedAgentIds: string[];
  removeUnselected: boolean;
  dryRun: boolean;
  build?: {
    packageExists: boolean;
    binaryExists: boolean;
    setupModuleExists: boolean;
    buildReady: boolean;
  };
  buildAttempt?: {
    attempted: boolean;
    command: string | null;
    commandResult: {
      ok: boolean;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    } | null;
    cooldownRemainingMs?: number | null;
    error: string | null;
  };
  appliedResults: Array<{
    agentId: string;
    agentDisplayName: string;
    changed: boolean;
    configPath: string;
  }>;
  removedResults: Array<{
    agentId: string;
    agentDisplayName: string;
    changed: boolean;
    removed: boolean;
    configPath: string;
  }>;
  failures: Array<{
    agentId: string;
    action: 'apply' | 'remove';
    message: string;
  }>;
  restartHints: Array<{
    agentId: string;
    hint: string;
  }>;
}

export interface McpWorkflowGuidanceInstallRequest {
  agentId: string;
  dryRun?: boolean;
  buildIfNeeded?: boolean;
}

export interface McpWorkflowGuidanceInstallResponse {
  success: boolean;
  mode: 'workflow_guidance_install';
  dryRun: boolean;
  agentId: string;
  changed: boolean;
  targetPath: string;
  statusBefore: McpWorkflowGuidanceState;
  statusAfter: McpWorkflowGuidanceState;
  build?: {
    packageExists: boolean;
    binaryExists: boolean;
    setupModuleExists: boolean;
    buildReady: boolean;
  };
  buildAttempt?: {
    attempted: boolean;
    command: string | null;
    commandResult: {
      ok: boolean;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    } | null;
    cooldownRemainingMs?: number | null;
    error: string | null;
  };
}

export interface McpRemoveIntegrationsRequest {
  dryRun?: boolean;
  buildIfNeeded?: boolean;
}

export interface McpRemoveIntegrationsResponse {
  success: boolean;
  mode: 'remove_integrations';
  dryRun: boolean;
  targetAgentIds: string[];
  removedResults: Array<{
    agentId: string;
    agentDisplayName: string;
    changed: boolean;
    removed: boolean;
    configPath: string;
    backupPath: string | null;
    dryRun: boolean;
    warnings: string[];
  }>;
  workflowGuidanceResults: Array<{
    agentId: string;
    changed: boolean;
    dryRun: boolean;
    targetPath: string;
    statusBefore: McpWorkflowGuidanceState;
    statusAfter: McpWorkflowGuidanceState;
  }>;
  failures: Array<{
    agentId: string;
    action: 'remove_config' | 'remove_workflow_guidance';
    message: string;
  }>;
  restartHints: Array<{
    agentId: string;
    hint: string;
  }>;
  build?: {
    packageExists: boolean;
    binaryExists: boolean;
    setupModuleExists: boolean;
    buildReady: boolean;
  };
  buildAttempt?: {
    attempted: boolean;
    command: string | null;
    commandResult: {
      ok: boolean;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    } | null;
    cooldownRemainingMs?: number | null;
    error: string | null;
  };
}

// Backend mounts these helpers under `/api/mcp/status`, `/api/mcp/agents`, `/api/mcp/config`, and `/api/mcp/setup/*`.
export const mcpApi = {
  getStatus: async (backendUrl?: string): Promise<McpStatusResponse> => {
    const response = await api.get<McpStatusResponse>('/mcp/status', {
      params: backendUrl ? { backendUrl } : undefined,
    });
    return response.data;
  },

  getAgents: async (backendUrl?: string): Promise<McpAgentsResponse> => {
    const response = await api.get<McpAgentsResponse>('/mcp/agents', {
      params: backendUrl ? { backendUrl } : undefined,
    });
    return response.data;
  },

  getConfig: async (agent: string, backendUrl?: string): Promise<McpConfigResponse> => {
    const response = await api.get<McpConfigResponse>('/mcp/config', {
      params: {
        agent,
        ...(backendUrl ? { backendUrl } : {}),
      },
    });
    return response.data;
  },

  syncSetup: async (payload: McpSetupSyncRequest): Promise<McpSetupSyncResponse> => {
    const response = await api.post<McpSetupSyncResponse>('/mcp/setup/sync', payload);
    return response.data;
  },

  installWorkflowGuidance: async (
    payload: McpWorkflowGuidanceInstallRequest,
  ): Promise<McpWorkflowGuidanceInstallResponse> => {
    const response = await api.post<McpWorkflowGuidanceInstallResponse>('/mcp/setup/workflow-guidance', payload);
    return response.data;
  },

  removeIntegrations: async (
    payload: McpRemoveIntegrationsRequest = {},
  ): Promise<McpRemoveIntegrationsResponse> => {
    const response = await api.post<McpRemoveIntegrationsResponse>('/mcp/setup/remove-integrations', payload);
    return response.data;
  },
};

// ============================================================================
// PROVIDER API — AI provider management (CLI detection + BYOK)
// ============================================================================

export const providerApi = {
  /**
   * List all configured providers
   */
  list: async () => {
    const response = await api.get<{
      success: boolean;
      providers: import('../types').AIProvider[];
      activeProvider: import('../types').AIProvider | null;
      // Set when the backend served cached data and kicked off a refresh
      // in the background; the UI may refetch shortly to pick up fresh state.
      scanInFlight?: boolean;
    }>('/providers');
    return response.data;
  },

  /**
   * Get available provider types and models
   */
  getConfigs: async () => {
    const response = await api.get<{
      success: boolean;
      configs: Array<{
        type: string;
        label: string;
        models: Array<{ id: string; label: string }>;
        defaultModel: string;
        reviewModelDefaults?: {
          triage?: string | null;
          walkthrough?: string | null;
          review?: string | null;
          synthesis?: string | null;
        };
        cliReviewModelDefaults?: {
          triage?: string | null;
          walkthrough?: string | null;
          review?: string | null;
          synthesis?: string | null;
        };
      }>;
    }>('/providers/configs');
    return response.data;
  },

  /**
   * Scan for CLI-detected providers
   */
  scan: async () => {
    const response = await api.post<{
      success: boolean;
      providers: import('../types').AIProvider[];
      activeProvider: import('../types').AIProvider | null;
    }>('/providers/scan');
    return response.data;
  },

  /**
   * Test an API key without saving
   */
  testConnection: async (type: string, apiKey: string) => {
    const response = await api.post<{
      success: boolean;
      latencyMs: number;
      error?: string;
    }>('/providers/test', { type, apiKey });
    return response.data;
  },

  /**
   * Add or update a BYOK provider
   */
  addBYOK: async (type: string, apiKey: string, model?: string) => {
    const response = await api.post<{
      success: boolean;
      provider: import('../types').AIProvider;
    }>('/providers/byok', { type, apiKey, model });
    return response.data;
  },

  /**
   * Remove a provider
   */
  remove: async (providerId: string) => {
    const response = await api.delete<{ success: boolean }>(`/providers/${providerId}`);
    return response.data;
  },

  /**
   * Set the active provider
   */
  setActive: async (providerId: string) => {
    const response = await api.put<{
      success: boolean;
      provider: import('../types').AIProvider;
    }>('/providers/active', { providerId });
    return response.data;
  },

  /**
   * Update model for a provider
   */
  updateModel: async (providerId: string, model: string) => {
    const response = await api.put<{
      success: boolean;
      provider: import('../types').AIProvider;
    }>(`/providers/${providerId}/model`, { model });
    return response.data;
  },

  /**
   * Validate all providers
   */
  validateAll: async () => {
    const response = await api.post<{
      success: boolean;
      providers: import('../types').AIProvider[];
      activeProvider: import('../types').AIProvider | null;
    }>('/providers/validate');
    return response.data;
  },

  // -- OpenCode Setup Wizard --

  /**
   * Get OpenCode CLI installation and configuration status
   */
  getOpenCodeStatus: async () => {
    const response = await api.get<{
      success: boolean;
      installed: boolean;
      binaryPath: string | null;
      configuredProviders: Array<{ type: string; hasKey: boolean }>;
      activeModel: string | null;
      configuredProvider: string | null;
    }>('/providers/opencode-status');
    return response.data;
  },

  /**
   * Configure OpenCode with a provider
   */
  configureOpenCode: async (providerType: string, apiKey?: string, model?: string) => {
    const response = await api.post<{
      success: boolean;
      configPath: string;
    }>('/providers/opencode-configure', { providerType, apiKey, model });
    return response.data;
  },

  /**
   * Set the active OpenCode model without reconfiguring auth
   */
  setOpenCodeActive: async (model: string) => {
    const response = await api.post<{
      success: boolean;
      model: string;
    }>('/providers/opencode-set-active', { model });
    return response.data;
  },

  /**
   * Verify OpenCode can connect to its configured provider
   */
  verifyOpenCode: async () => {
    const response = await api.post<{
      success: boolean;
      error?: string;
      latencyMs: number;
    }>('/providers/opencode-verify');
    return response.data;
  },

  /**
   * Check Ollama status and list available models
   */
  getOllamaModels: async () => {
    const response = await api.get<{
      success: boolean;
      running: boolean;
      models: Array<{ id: string; label: string }>;
    }>('/providers/ollama-models');
    return response.data;
  },

  /**
   * Get curated NVIDIA NIM models
   */
  getNvidiaModels: async (options?: { toolSupportOnly?: boolean; reviewCapableOnly?: boolean }) => {
    const queryParts: string[] = [];
    if (options?.toolSupportOnly) queryParts.push('toolSupportOnly=true');
    if (options?.reviewCapableOnly) queryParts.push('reviewCapableOnly=true');
    const params = queryParts.length ? `?${queryParts.join('&')}` : '';
    const response = await api.get<{
      success: boolean;
      models: Array<{ id: string; label: string; toolSupport?: boolean }>;
    }>(`/providers/nvidia-models${params}`);
    return response.data;
  },

  /**
   * Get dynamically resolved models from OpenCode's configured providers
   */
  getOpenCodeModels: async () => {
    const response = await api.get<{
      success: boolean;
      models: Array<{ id: string; label: string; toolSupport?: boolean }>;
      activeModel: string;
    }>('/providers/opencode-models');
    return response.data;
  },

  /**
   * Get ALL OpenCode models (no tool-support filter) for the review system
   */
  getOpenCodeModelsForReview: async () => {
    const response = await api.get<{
      success: boolean;
      models: Array<{ id: string; label: string; toolSupport?: boolean }>;
      activeModel: string;
    }>('/providers/opencode-models-review');
    return response.data;
  },

  /**
   * Get the active provider for a specific context (review or build)
   */
  getContextActive: async (context: 'review' | 'build') => {
    const response = await api.get<{
      success: boolean;
      data: { providerId: string; model: string | null } | null;
    }>(`/providers/context-active/${context}`);
    return response.data;
  },

  /**
   * Set the active provider for a specific context (review or build)
   */
  setContextActive: async (context: 'review' | 'build', providerId: string, model?: string) => {
    const response = await api.put<{
      success: boolean;
      data: { providerId: string; model: string | null };
    }>(`/providers/context-active/${context}`, { providerId, model });
    return response.data;
  },

  // -- CLI Auth Status --

  /**
   * Get CLI auth status for all three CLI tools
   */
  getCliAuthStatus: async () => {
    const response = await api.get<{
      success: boolean;
      auth: Record<string, {
        authenticated: boolean;
        source: string | null;
        binaryPath?: string | null;
        prerequisite?: {
          type: string;
          status: 'ok' | 'missing' | 'detected_not_configured';
          envVar?: string | null;
          detectedPath?: string | null;
          message: string;
          remediation?: string | null;
        } | null;
      }>;
    }>('/providers/cli-auth-status');
    return response.data;
  },

  // -- CLI Auto-Install --

  /**
   * Get CLI install status (npm availability + which tools are installed)
   */
  getCliInstallStatus: async () => {
    const response = await api.get<{
      success: boolean;
      npmAvailable: boolean;
      npmSource: string | null;
      installableTools: string[];
      installed: Record<string, { installed: boolean; binaryPath: string | null }>;
      activeAttempts: Record<string, CliInstallAttempt>;
    }>('/providers/cli-install-status');
    return response.data;
  },

  /**
   * Start a CLI install attempt that can be polled safely by browser/desktop clients.
   */
  installCli: async (packageKey: string) => {
    const response = await api.post<{
      success: boolean;
      reused: boolean;
      attempt: CliInstallAttempt;
    }>('/providers/install-cli', {
      package: packageKey,
    });
    return response.data;
  },

  getCliInstallAttempt: async (attemptId: string) => {
    const response = await api.get<{
      success: boolean;
      attempt: CliInstallAttempt;
    }>(`/providers/install-cli/${attemptId}`);
    return response.data;
  },
};

export interface CliInstallAttempt {
  attemptId: string;
  packageKey: string;
  status: 'queued' | 'installing' | 'success' | 'error';
  logs: string[];
  error: string | null;
  binaryPath: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ReviewSyncLocalStatus {
  enabled: boolean;
  configured: boolean;
  serverUrl: string | null;
  userId: string | null;
  deviceId: string | null;
  pendingEvents: number;
  state: 'idle' | 'syncing' | 'error' | 'disabled';
  lastSyncedAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
}

export const reviewSyncApi = {
  getLocalStatus: async (): Promise<ReviewSyncLocalStatus> => {
    const response = await api.get<{ success: boolean; status: ReviewSyncLocalStatus }>('/review-sync/local-status');
    return response.data.status;
  },

  flushLocal: async (): Promise<{ status: string; pendingEvents?: number; acknowledged?: number; error?: string }> => {
    const response = await api.post<{
      success: boolean;
      result: { status: string; pendingEvents?: number; acknowledged?: number; error?: string };
    }>('/review-sync/local-sync');
    return response.data.result;
  },
};

// ============================================================================
// CLI ADAPTERS API — Build-mode CLI tool discovery
// ============================================================================

export interface CLIAdapter {
  type: string;      // Provider type key (e.g. 'anthropic', 'openai', 'google')
  name: string;      // Human-readable name (e.g. 'Claude Code', 'Codex CLI')
  supported: boolean; // Whether the adapter is fully supported for build mode
  defaultModel?: string | null;
  models?: Array<{
    alias: string;
    name: string;
    description: string;
  }>;
}

export const cliAdaptersApi = {
  /**
   * Get available CLI adapters for build mode
   */
  list: async () => {
    const response = await api.get<{
      success: boolean;
      adapters: CLIAdapter[];
    }>('/cli-adapters');
    return response.data;
  },
};

// ============================================================================
// REVIEW API — Trust Pipeline code reviews
// ============================================================================

type ReviewOutcomeScopeInput = Pick<ReviewOutcomeScope, 'reviewType' | 'reviewId'>;

export interface ReviewOutcomeMutationPayload {
  recommendation?: ReviewRecommendation;
  recommendationKey?: string;
  status: 'addressed' | 'dismissed';
  note?: string;
}

export interface ReviewOutcomeClearPayload {
  recommendation?: ReviewRecommendation;
  recommendationKey?: string;
}

export interface ReviewOutcomeListResponse {
  success: boolean;
  scope: {
    projectId: string;
    reviewType: ReviewOutcomeScope['reviewType'];
    reviewId: string;
  };
  outcomes: ReviewRecommendationOutcome[];
  byRecommendationKey: Record<string, ReviewRecommendationOutcome>;
  telemetry: ReviewOutcomeTelemetry;
  outcome?: ReviewRecommendationOutcome | null;
  deletedOutcome?: ReviewRecommendationOutcome | null;
}

export interface ReviewPublicationListResponse {
  success: boolean;
  publication: ReviewPublicationState;
  reviewSubmission?: {
    event: string;
    githubReviewId?: string | null;
    htmlUrl?: string | null;
    state?: string | null;
    commentCount?: number;
    submittedAt?: string | null;
  } | null;
  results?: Array<{
    recommendationKey: string;
    manualLineCommentId?: string | null;
    status: 'published' | 'already_published' | 'skipped' | 'failed';
    reason?: string | null;
    path?: string | null;
    line?: number | null;
    githubReviewId?: string | null;
  }>;
}

export interface ReviewFixRunListResponse {
  success: boolean;
  scope: {
    projectId: string;
    reviewType: ReviewOutcomeScope['reviewType'];
    reviewId: string;
  };
  runs: ReviewFixRunArtifact[];
}

export interface ReviewFixRunLatestResponse {
  success: boolean;
  scope: {
    projectId: string;
    reviewType: ReviewOutcomeScope['reviewType'];
    reviewId: string;
  };
  run: ReviewFixRunArtifact | null;
}

export interface ReviewFixVerificationSnapshotResponse {
  success: boolean;
  alreadyCommitted: boolean;
  commitCreated: boolean;
  commitSha: string;
  branch?: string;
  filesCommitted: string[];
  targetFilePaths: string[];
  commitMessage: string;
}

function buildReviewOutcomeEndpoint(projectId: string, scope: ReviewOutcomeScopeInput): string {
  if (scope.reviewType === 'branch_review') {
    return `/projects/${projectId}/branch-reviews/${scope.reviewId}/review/outcomes`;
  }
  if (scope.reviewType === 'pr_review') {
    return `/projects/${projectId}/pr-reviews/${scope.reviewId}/review/outcomes`;
  }
  if (scope.reviewType === 'workspace_review') {
    return `/projects/${projectId}/workspace-reviews/${scope.reviewId}/review/outcomes`;
  }
  return `/projects/${projectId}/changesets/${scope.reviewId}/review/outcomes`;
}

function buildReviewFixRunEndpoint(projectId: string, scope: ReviewOutcomeScopeInput): string {
  if (scope.reviewType === 'branch_review') {
    return `/projects/${projectId}/branch-reviews/${scope.reviewId}/review/fix-runs`;
  }
  if (scope.reviewType === 'pr_review') {
    return `/projects/${projectId}/pr-reviews/${scope.reviewId}/review/fix-runs`;
  }
  if (scope.reviewType === 'workspace_review') {
    return `/projects/${projectId}/workspace-reviews/${scope.reviewId}/review/fix-runs`;
  }
  return `/projects/${projectId}/changesets/${scope.reviewId}/review/fix-runs`;
}

function normalizeReviewOutcomeEntry(rawEntry: unknown): ReviewRecommendationOutcome | null {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const entry = rawEntry as Record<string, unknown>;
  const recommendationKey = normalizeRecommendationKeyPart(entry.recommendationKey);
  if (!recommendationKey) return null;
  const statusValue = String(entry.status || '').trim().toLowerCase();
  if (statusValue !== 'addressed' && statusValue !== 'dismissed') return null;
  const updatedAt = String(entry.updatedAt || '').trim();
  if (!updatedAt) return null;
  const noteRaw = typeof entry.note === 'string' ? entry.note.trim() : '';
  const dimensionsSource = (
    entry.dimensions && typeof entry.dimensions === 'object'
  ) ? entry.dimensions as Record<string, unknown> : {};
  const dimensions = {
    providerType: String(dimensionsSource.providerType || '').trim().toLowerCase() || undefined,
    providerModel: String(dimensionsSource.providerModel || '').trim().toLowerCase() || undefined,
    language: String(dimensionsSource.language || '').trim().toLowerCase() || undefined,
    pathPattern: String(dimensionsSource.pathPattern || '').trim().toLowerCase() || undefined,
  };
  return {
    recommendationKey,
    status: statusValue,
    note: noteRaw || undefined,
    dimensions,
    updatedAt,
  };
}

function normalizeReviewFixFindingStateEntry(rawKey: string, rawEntry: unknown): import('../types').ReviewFixFindingState | null {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const entry = rawEntry as Record<string, unknown>;
  const recommendationKey = normalizeRecommendationKeyPart(rawKey || entry.recommendationKey);
  const status = String(entry.status || '').trim().toLowerCase();
  if (!recommendationKey || !status) return null;
  const validStatuses = new Set([
    'queued',
    'running',
    'touched',
    'patch_applied',
    'verification_pending',
    're_reviewing',
    'still_open',
    'failed',
    'stopped',
    'skipped',
  ]);
  if (!validStatuses.has(status)) return null;
  return {
    recommendationKey,
    status: status as import('../types').ReviewFixStatus,
    updatedAt: String(entry.updatedAt || '').trim() || new Date().toISOString(),
    filePaths: Array.isArray(entry.filePaths)
      ? entry.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
      : undefined,
    error: String(entry.error || '').trim() || null,
  };
}

function normalizeReviewFixFindingStateMap(rawMap: unknown): Record<string, import('../types').ReviewFixFindingState> {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const normalized: Record<string, import('../types').ReviewFixFindingState> = {};
  for (const [rawKey, rawEntry] of Object.entries(rawMap as Record<string, unknown>)) {
    const entry = normalizeReviewFixFindingStateEntry(rawKey, rawEntry);
    if (!entry) continue;
    normalized[entry.recommendationKey] = entry;
  }
  return normalized;
}

function normalizeReviewFixBuildSummary(rawSummary: unknown): import('../types').ReviewFixBuildSummary | null {
  if (!rawSummary || typeof rawSummary !== 'object') return null;
  const summary = rawSummary as Record<string, unknown>;
  const filePaths = Array.isArray(summary.filePaths)
    ? summary.filePaths.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const newFiles = Array.isArray(summary.newFiles)
    ? summary.newFiles.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const modifiedFiles = Array.isArray(summary.modifiedFiles)
    ? summary.modifiedFiles.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  return {
    filesChanged: toFiniteNumber(summary.filesChanged, filePaths.length),
    filePaths,
    newFiles,
    modifiedFiles,
    changesetId: String(summary.changesetId || '').trim() || null,
    changesetTitle: String(summary.changesetTitle || '').trim() || null,
  };
}

function normalizeReviewFixRunArtifact(
  rawRun: unknown,
  projectId: string,
  scope: ReviewOutcomeScopeInput
): ReviewFixRunArtifact | null {
  if (!rawRun || typeof rawRun !== 'object') return null;
  const run = rawRun as Record<string, unknown>;
  const id = String(run.id || '').trim();
  const status = String(run.status || '').trim().toLowerCase();
  const validStatuses = new Set(['running', 'patch_applied', 'verification_pending', 'failed', 'stopped', 'skipped']);
  if (!id || !validStatuses.has(status)) return null;
  return {
    id,
    projectId: String(run.projectId || projectId).trim() || projectId,
    reviewType: (String(run.reviewType || scope.reviewType).trim().toLowerCase() || scope.reviewType) as ReviewOutcomeScope['reviewType'],
    reviewId: String(run.reviewId || scope.reviewId).trim() || scope.reviewId,
    status: status as ReviewFixRunArtifactStatus,
    transcriptVisibility: 'hidden',
    providerType: String(run.providerType || '').trim() || null,
    providerModel: String(run.providerModel || '').trim() || null,
    selectedRecommendationKeys: Array.isArray(run.selectedRecommendationKeys)
      ? run.selectedRecommendationKeys.map((value) => normalizeRecommendationKeyPart(value)).filter(Boolean)
      : [],
    recommendationStatuses: normalizeReviewFixFindingStateMap(run.recommendationStatuses),
    buildSummary: normalizeReviewFixBuildSummary(run.buildSummary),
    error: String(run.error || '').trim() || null,
    startedAt: String(run.startedAt || '').trim() || new Date().toISOString(),
    completedAt: String(run.completedAt || '').trim() || null,
    stoppedAt: String(run.stoppedAt || '').trim() || null,
    failedAt: String(run.failedAt || '').trim() || null,
    createdAt: String(run.createdAt || '').trim() || null,
    updatedAt: String(run.updatedAt || '').trim() || null,
  };
}

function normalizeReviewFixRunListResponse(
  rawResponse: ReviewFixRunListResponse,
  projectId: string,
  scope: ReviewOutcomeScopeInput
): ReviewFixRunListResponse {
  const runs = Array.isArray(rawResponse?.runs)
    ? rawResponse.runs.map((run) => normalizeReviewFixRunArtifact(run, projectId, scope)).filter(Boolean) as ReviewFixRunArtifact[]
    : [];
  return {
    success: rawResponse?.success !== false,
    scope: {
      projectId,
      reviewType: scope.reviewType,
      reviewId: scope.reviewId,
    },
    runs,
  };
}

function normalizeReviewFixRunLatestResponse(
  rawResponse: ReviewFixRunLatestResponse,
  projectId: string,
  scope: ReviewOutcomeScopeInput
): ReviewFixRunLatestResponse {
  return {
    success: rawResponse?.success !== false,
    scope: {
      projectId,
      reviewType: scope.reviewType,
      reviewId: scope.reviewId,
    },
    run: normalizeReviewFixRunArtifact(rawResponse?.run, projectId, scope),
  };
}

function normalizeReviewOutcomeMap(rawMap: unknown): Record<string, ReviewRecommendationOutcome> {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const normalized: Record<string, ReviewRecommendationOutcome> = {};
  for (const [rawKey, rawEntry] of Object.entries(rawMap as Record<string, unknown>)) {
    const recommendationKey = normalizeRecommendationKeyPart(rawKey);
    if (!recommendationKey) continue;
    const entry = normalizeReviewOutcomeEntry(rawEntry);
    if (!entry) continue;
    normalized[recommendationKey] = entry;
  }
  return normalized;
}

function normalizeReviewOutcomeTelemetry(rawTelemetry: unknown): ReviewOutcomeTelemetry {
  if (!rawTelemetry || typeof rawTelemetry !== 'object') {
    return {
      total: 0,
      addressed: 0,
      dismissed: 0,
      addressedRate: 0,
      dismissedRate: 0,
      issueTotal: 0,
      issueAddressed: 0,
      issueDismissed: 0,
      issueAddressedRate: 0,
      issueDismissedRate: 0,
    };
  }
  const telemetry = rawTelemetry as Record<string, unknown>;
  return {
    total: toFiniteNumber(telemetry.total, 0),
    addressed: toFiniteNumber(telemetry.addressed, 0),
    dismissed: toFiniteNumber(telemetry.dismissed, 0),
    addressedRate: toFiniteNumber(telemetry.addressedRate, 0),
    dismissedRate: toFiniteNumber(telemetry.dismissedRate, 0),
    issueTotal: toFiniteNumber(telemetry.issueTotal, 0),
    issueAddressed: toFiniteNumber(telemetry.issueAddressed, 0),
    issueDismissed: toFiniteNumber(telemetry.issueDismissed, 0),
    issueAddressedRate: toFiniteNumber(telemetry.issueAddressedRate, 0),
    issueDismissedRate: toFiniteNumber(telemetry.issueDismissedRate, 0),
  };
}

function normalizeReviewOutcomeResponse(
  rawResponse: ReviewOutcomeListResponse,
  projectId: string,
  scope: ReviewOutcomeScopeInput
): ReviewOutcomeListResponse {
  const normalizedOutcomes = Array.isArray(rawResponse?.outcomes)
    ? rawResponse.outcomes.map((entry) => normalizeReviewOutcomeEntry(entry)).filter(Boolean) as ReviewRecommendationOutcome[]
    : [];
  const byRecommendationKey = normalizeReviewOutcomeMap(rawResponse?.byRecommendationKey);
  for (const entry of normalizedOutcomes) {
    byRecommendationKey[entry.recommendationKey] = entry;
  }
  const normalizedOutcome = normalizeReviewOutcomeEntry(rawResponse?.outcome) || null;
  const normalizedDeletedOutcome = normalizeReviewOutcomeEntry(rawResponse?.deletedOutcome) || null;

  return {
    success: rawResponse?.success !== false,
    scope: {
      projectId,
      reviewType: scope.reviewType,
      reviewId: scope.reviewId,
    },
    outcomes: Object.values(byRecommendationKey).sort((a, b) => (
      Date.parse(String(b.updatedAt || '')) - Date.parse(String(a.updatedAt || ''))
    )),
    byRecommendationKey,
    telemetry: normalizeReviewOutcomeTelemetry(rawResponse?.telemetry),
    outcome: normalizedOutcome,
    deletedOutcome: normalizedDeletedOutcome,
  };
}

function normalizeReviewPublicationRecord(rawEntry: unknown): ReviewPublicationRecord | null {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const entry = rawEntry as Record<string, unknown>;
  const recommendationKey = normalizeRecommendationKeyPart(entry.recommendationKey);
  if (!recommendationKey) return null;
  const rawAction = String(entry.action || '').trim().toLowerCase();
  const action: GitHubReviewAction = rawAction === 'approve'
    ? 'approve'
    : rawAction === 'request_changes'
      ? 'request_changes'
      : 'comment';
  const rawPrNumber = Number(entry.githubPrNumber);
  const rawLine = Number(entry.line);
  return {
    recommendationKey,
    channel: String(entry.channel || 'github_pr_review').trim() || 'github_pr_review',
    action,
    githubReviewId: String(entry.githubReviewId || '').trim() || null,
    githubPrNumber: Number.isFinite(rawPrNumber) ? rawPrNumber : null,
    headSha: String(entry.headSha || '').trim() || null,
    path: String(entry.path || '').trim() || null,
    line: Number.isFinite(rawLine) ? rawLine : null,
    publishedAt: String(entry.publishedAt || '').trim() || null,
    updatedAt: String(entry.updatedAt || '').trim() || null,
  };
}

function normalizeReviewPublicationState(
  rawPublication: unknown,
  projectId: string,
  reviewId: string
): ReviewPublicationState {
  const publication = rawPublication && typeof rawPublication === 'object'
    ? rawPublication as Record<string, unknown>
    : {};
  const scopeSource = publication.scope && typeof publication.scope === 'object'
    ? publication.scope as Record<string, unknown>
    : {};
  const byRecommendationKey: Record<string, ReviewPublicationRecord> = {};

  const rawList = Array.isArray(publication.publications) ? publication.publications : [];
  for (const rawEntry of rawList) {
    const entry = normalizeReviewPublicationRecord(rawEntry);
    if (!entry) continue;
    byRecommendationKey[entry.recommendationKey] = entry;
  }
  if (publication.byRecommendationKey && typeof publication.byRecommendationKey === 'object') {
    for (const [rawKey, rawEntry] of Object.entries(publication.byRecommendationKey as Record<string, unknown>)) {
      const key = String(rawKey || '').trim().toLowerCase();
      if (!key) continue;
      const entry = normalizeReviewPublicationRecord(rawEntry);
      if (!entry) continue;
      byRecommendationKey[key] = entry;
    }
  }

  const publications = Object.values(byRecommendationKey).sort((left, right) => (
    Date.parse(String(right.updatedAt || right.publishedAt || ''))
    - Date.parse(String(left.updatedAt || left.publishedAt || ''))
  ));
  const latestActionRaw = String(publication.latestAction || '').trim().toLowerCase();

  return {
    scope: {
      projectId: String(scopeSource.projectId || projectId).trim() || projectId,
      reviewType: 'pr_review',
      reviewId: String(scopeSource.reviewId || reviewId).trim() || reviewId,
    },
    publications,
    byRecommendationKey,
    totalPublished: Number.isFinite(Number(publication.totalPublished))
      ? Number(publication.totalPublished)
      : publications.length,
    latestAction: latestActionRaw === 'approve'
      ? 'approve'
      : latestActionRaw === 'request_changes'
        ? 'request_changes'
        : latestActionRaw === 'comment'
          ? 'comment'
          : null,
    latestPublishedAt: String(publication.latestPublishedAt || '').trim() || null,
  };
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, rawCount] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = String(key || '').trim().toUpperCase();
    const count = Math.max(0, Math.trunc(Number(rawCount) || 0));
    if (normalizedKey && count > 0) result[normalizedKey] = count;
  }
  return result;
}

function normalizeNullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGitHubPrThreadComment(rawComment: unknown): GitHubPrThreadComment | null {
  if (!rawComment || typeof rawComment !== 'object') return null;
  const comment = rawComment as Record<string, unknown>;
  const id = normalizeNullableString(comment.id) || normalizeNullableString(comment.nodeId);
  if (!id) return null;
  return {
    id,
    nodeId: normalizeNullableString(comment.nodeId) || id,
    databaseId: normalizeNullableNumber(comment.databaseId),
    threadNodeId: normalizeNullableString(comment.threadNodeId),
    replyToNodeId: normalizeNullableString(comment.replyToNodeId),
    githubReviewNodeId: normalizeNullableString(comment.githubReviewNodeId),
    githubReviewDatabaseId: normalizeNullableNumber(comment.githubReviewDatabaseId),
    body: typeof comment.body === 'string' ? comment.body : '',
    bodyText: normalizeNullableString(comment.bodyText),
    authorLogin: normalizeNullableString(comment.authorLogin),
    authorAvatarUrl: normalizeNullableString(comment.authorAvatarUrl),
    authorUrl: normalizeNullableString(comment.authorUrl),
    htmlUrl: normalizeNullableString(comment.htmlUrl),
    path: normalizeNullableString(comment.path),
    line: normalizeNullableNumber(comment.line),
    startLine: normalizeNullableNumber(comment.startLine),
    side: normalizeNullableString(comment.side),
    diffHunk: normalizeNullableString(comment.diffHunk),
    isMinimized: comment.isMinimized === true,
    minimizedReason: normalizeNullableString(comment.minimizedReason),
    createdAt: normalizeNullableString(comment.createdAt),
    updatedAt: normalizeNullableString(comment.updatedAt),
    syncedAt: normalizeNullableString(comment.syncedAt),
    canEdit: comment.canEdit === true,
    canDelete: comment.canDelete === true,
  };
}

function normalizeGitHubPrReviewThread(rawThread: unknown): GitHubPrReviewThread | null {
  if (!rawThread || typeof rawThread !== 'object') return null;
  const thread = rawThread as Record<string, unknown>;
  const id = normalizeNullableString(thread.id) || normalizeNullableString(thread.nodeId);
  if (!id) return null;
  const comments = Array.isArray(thread.comments)
    ? thread.comments.map(normalizeGitHubPrThreadComment).filter(Boolean) as GitHubPrThreadComment[]
    : [];
  return {
    id,
    nodeId: normalizeNullableString(thread.nodeId) || id,
    githubPrNumber: normalizeNullableNumber(thread.githubPrNumber),
    isResolved: thread.isResolved === true,
    isOutdated: thread.isOutdated === true,
    resolvedByLogin: normalizeNullableString(thread.resolvedByLogin),
    path: normalizeNullableString(thread.path),
    line: normalizeNullableNumber(thread.line),
    startLine: normalizeNullableNumber(thread.startLine),
    side: normalizeNullableString(thread.side),
    originalLine: normalizeNullableNumber(thread.originalLine),
    originalStartLine: normalizeNullableNumber(thread.originalStartLine),
    firstCommentAt: normalizeNullableString(thread.firstCommentAt),
    lastCommentAt: normalizeNullableString(thread.lastCommentAt),
    commentCount: Math.max(0, Math.trunc(Number(thread.commentCount || comments.length) || 0)),
    syncedAt: normalizeNullableString(thread.syncedAt),
    comments,
  };
}

function normalizeGitHubPrIssueComment(rawComment: unknown): GitHubPrIssueComment | null {
  if (!rawComment || typeof rawComment !== 'object') return null;
  const comment = rawComment as Record<string, unknown>;
  const id = normalizeNullableString(comment.id) || normalizeNullableString(comment.nodeId);
  if (!id) return null;
  return {
    id,
    nodeId: normalizeNullableString(comment.nodeId) || id,
    databaseId: normalizeNullableNumber(comment.databaseId),
    githubPrNumber: normalizeNullableNumber(comment.githubPrNumber),
    body: typeof comment.body === 'string' ? comment.body : '',
    bodyText: normalizeNullableString(comment.bodyText),
    authorLogin: normalizeNullableString(comment.authorLogin),
    authorAvatarUrl: normalizeNullableString(comment.authorAvatarUrl),
    authorUrl: normalizeNullableString(comment.authorUrl),
    htmlUrl: normalizeNullableString(comment.htmlUrl),
    createdAt: normalizeNullableString(comment.createdAt),
    updatedAt: normalizeNullableString(comment.updatedAt),
    syncedAt: normalizeNullableString(comment.syncedAt),
    canEdit: comment.canEdit === true,
    canDelete: comment.canDelete === true,
  };
}

function normalizeGitHubPrConversations(rawConversations: unknown): GitHubPrConversations {
  const conversations = rawConversations && typeof rawConversations === 'object'
    ? rawConversations as Record<string, unknown>
    : {};
  const threads = Array.isArray(conversations.threads)
    ? conversations.threads.map(normalizeGitHubPrReviewThread).filter(Boolean) as GitHubPrReviewThread[]
    : [];
  const issueComments = Array.isArray(conversations.issueComments)
    ? conversations.issueComments.map(normalizeGitHubPrIssueComment).filter(Boolean) as GitHubPrIssueComment[]
    : [];
  const summarySource = conversations.summary && typeof conversations.summary === 'object'
    ? conversations.summary as Record<string, unknown>
    : {};
  const syncSource = conversations.sync && typeof conversations.sync === 'object'
    ? conversations.sync as Record<string, unknown>
    : null;
  return {
    threads,
    issueComments,
    summary: {
      totalThreads: Math.max(0, Math.trunc(Number(summarySource.totalThreads || threads.length) || 0)),
      openThreads: Math.max(0, Math.trunc(Number(summarySource.openThreads || threads.filter((thread) => !thread.isResolved).length) || 0)),
      resolvedThreads: Math.max(0, Math.trunc(Number(summarySource.resolvedThreads || threads.filter((thread) => thread.isResolved).length) || 0)),
      outdatedThreads: Math.max(0, Math.trunc(Number(summarySource.outdatedThreads || threads.filter((thread) => thread.isOutdated).length) || 0)),
      threadComments: Math.max(0, Math.trunc(Number(summarySource.threadComments || threads.reduce((sum, thread) => sum + thread.commentCount, 0)) || 0)),
      issueComments: Math.max(0, Math.trunc(Number(summarySource.issueComments || issueComments.length) || 0)),
      syncedAt: normalizeNullableString(summarySource.syncedAt),
    },
    sync: syncSource
      ? {
          githubPrNumber: normalizeNullableNumber(syncSource.githubPrNumber),
          pullRequestNodeId: normalizeNullableString(syncSource.pullRequestNodeId),
          reviewDecision: normalizeNullableString(syncSource.reviewDecision),
          mergeStateStatus: normalizeNullableString(syncSource.mergeStateStatus),
          latestReviewState: normalizeNullableString(syncSource.latestReviewState),
          latestReviewAuthor: normalizeNullableString(syncSource.latestReviewAuthor),
          latestReviewSubmittedAt: normalizeNullableString(syncSource.latestReviewSubmittedAt),
          reviewStateCounts: normalizeNumberRecord(syncSource.reviewStateCounts),
          threadCount: Math.max(0, Math.trunc(Number(syncSource.threadCount || threads.length) || 0)),
          issueCommentCount: Math.max(0, Math.trunc(Number(syncSource.issueCommentCount || issueComments.length) || 0)),
          syncedAt: normalizeNullableString(syncSource.syncedAt),
        }
      : null,
  };
}

export const reviewApi = {
  /**
   * Trigger a review on a changeset
   */
  review: async (projectId: string, changesetId: string, force = false) => {
    const response = await api.post<{
      success: boolean;
      review: import('../types').ReviewResult;
    }>(`/projects/${projectId}/changesets/${changesetId}/review`, { force });
    return {
      ...response.data,
      review: normalizeReviewData(response.data.review) as import('../types').ReviewResult,
    };
  },

  /**
   * Add a changeset to the review queue
   */
  enqueue: async (projectId: string, changesetId: string, force = false) => {
    const response = await api.post<{
      success: boolean;
      position: number;
      id: string;
    }>(`/projects/${projectId}/changesets/${changesetId}/review/queue`, { force });
    return response.data;
  },

  /**
   * Cancel a queued review
   */
  cancelQueue: async (projectId: string, changesetId: string) => {
    const response = await api.delete<{
      success: boolean;
      cancelled: boolean;
    }>(`/projects/${projectId}/changesets/${changesetId}/review/queue`);
    return response.data;
  },

  /**
   * Dismiss a failed review state for a changeset.
   */
  dismissFailure: async (projectId: string, changesetId: string) => {
    const response = await api.post<{ success: boolean }>(
      `/projects/${projectId}/changesets/${changesetId}/review/dismiss`
    );
    return response.data;
  },

  /**
   * List persisted recommendation outcomes for the review scope.
   */
  getOutcomes: async (projectId: string, scope: ReviewOutcomeScopeInput) => {
    const endpoint = buildReviewOutcomeEndpoint(projectId, scope);
    const response = await api.get<ReviewOutcomeListResponse>(endpoint);
    return normalizeReviewOutcomeResponse(response.data, projectId, scope);
  },

  /**
   * Persist one recommendation outcome with optimistic-friendly upsert semantics.
   */
  setOutcome: async (projectId: string, scope: ReviewOutcomeScopeInput, payload: ReviewOutcomeMutationPayload) => {
    const endpoint = buildReviewOutcomeEndpoint(projectId, scope);
    const response = await api.put<ReviewOutcomeListResponse>(endpoint, payload);
    return normalizeReviewOutcomeResponse(response.data, projectId, scope);
  },

  /**
   * Clear one persisted recommendation outcome.
   */
  clearOutcome: async (projectId: string, scope: ReviewOutcomeScopeInput, payload: ReviewOutcomeClearPayload) => {
    const endpoint = buildReviewOutcomeEndpoint(projectId, scope);
    const response = await api.delete<ReviewOutcomeListResponse>(endpoint, {
      data: payload,
    });
    return normalizeReviewOutcomeResponse(response.data, projectId, scope);
  },

  /**
   * Read the latest persisted issue-fixer run summary for the review scope.
   */
  getLatestFixRun: async (projectId: string, scope: ReviewOutcomeScopeInput) => {
    const endpoint = `${buildReviewFixRunEndpoint(projectId, scope)}/latest`;
    const response = await api.get<ReviewFixRunLatestResponse>(endpoint);
    return normalizeReviewFixRunLatestResponse(response.data, projectId, scope);
  },

  /**
   * List recent persisted issue-fixer run summaries for the review scope.
   */
  listFixRuns: async (projectId: string, scope: ReviewOutcomeScopeInput, options?: { limit?: number }) => {
    const endpoint = buildReviewFixRunEndpoint(projectId, scope);
    const response = await api.get<ReviewFixRunListResponse>(endpoint, {
      params: options,
    });
    return normalizeReviewFixRunListResponse(response.data, projectId, scope);
  },

  createVerificationSnapshot: async (
    projectId: string,
    scope: ReviewOutcomeScopeInput,
    runId: string,
    message?: string,
  ) => {
    if (scope.reviewType !== 'branch_review') {
      throw new Error('Verification snapshot commits are only supported for branch reviews.');
    }
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      throw new Error('runId is required to create a verification snapshot commit.');
    }
    const response = await api.post<ReviewFixVerificationSnapshotResponse>(
      `${buildReviewFixRunEndpoint(projectId, scope)}/${normalizedRunId}/verification-snapshot`,
      message ? { message } : {}
    );
    return {
      ...response.data,
      commitSha: normalizeCommitSha(response.data.commitSha) || response.data.commitSha,
      filesCommitted: Array.isArray(response.data.filesCommitted)
        ? response.data.filesCommitted.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
      targetFilePaths: Array.isArray(response.data.targetFilePaths)
        ? response.data.targetFilePaths.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
      commitMessage: String(response.data.commitMessage || '').trim(),
    };
  },

  /**
   * Get review queue status
   */
  getQueue: async () => {
    const response = await api.get<{
      success: boolean;
      queue: Array<{
        id: string;
        type?: 'changeset' | 'branch_review' | 'pr_review' | 'workspace_review';
        changesetId: string | null;
        branchReviewId?: string | null;
        prReviewId?: string | null;
        workspaceReviewId?: string | null;
        status: string;
        queuedAt: string;
        position?: number;
        projectId?: string | null;
        updatedAt?: string;
        reviewError?: string | null;
        autoReviewSnapshot?: {
          headSha?: string | null;
          mergeBaseSha?: string | null;
          baseBranch?: string | null;
        } | null;
        progress?: {
          phase?: string;
          currentChunk?: number;
          totalChunks?: number;
          filesCompleted?: number;
          totalFiles?: number;
          activeChunkFiles?: number;
          elapsedSeconds?: number;
          splitDepth?: number;
          splitParts?: number;
          reviewModel?: string | null;
          reviewModelStrategy?: string | null;
          reviewModelEffectiveStrategy?: string | null;
          diffScopeMode?: 'full' | 'delta' | null;
          diffScopeCommitCount?: number;
          diffBaseSha?: string | null;
          diffHeadSha?: string | null;
          retryAttempt?: number;
          retryMaxAttempts?: number;
          retryDelayMs?: number;
          error?: string | null;
          updatedAt?: string;
        } | null;
        lifecycle?: ReviewLifecycle | null;
      }>;
    }>('/review-queue');
    return {
      ...response.data,
      queue: response.data.queue.map((entry) => ({
        ...entry,
        lifecycle: normalizeReviewLifecycleSnapshot(entry.lifecycle, entry.status),
      })),
    };
  },

  cancelQueueEntry: async (entryId: string) => {
    const response = await api.delete<{ success: boolean; stopped: boolean; was: 'queued' | 'running' | null }>(
      `/review-queue/${encodeURIComponent(entryId)}`
    );
    return response.data;
  },
};

// ============================================================================
// BRANCH REVIEW API — Trust Pipeline branch-level reviews
// ============================================================================

type BranchReviewGetResponse = {
  success: boolean;
  branchReview: BranchReview & {
    files: Array<BranchReviewFileSummary | BranchReviewFileContent>;
  };
};

type BranchReviewGetOptions = {
  includeContent?: boolean;
  forceRefresh?: boolean;
  includeAllFiles?: boolean;
  visibleFileLimit?: number;
};

const BR_SUMMARY_CACHE_TTL_MS = 5000;
const branchReviewSummaryCache = new Map<string, {
  expiresAt: number;
  response: BranchReviewGetResponse;
}>();
const branchReviewInFlight = new Map<string, Promise<BranchReviewGetResponse>>();
const branchReviewSummaryGeneration = new Map<string, number>();

function getBranchReviewSummaryCacheKey(projectId: string, brId: string): string {
  return `${projectId}:${brId}`;
}

function pruneBranchReviewSummaryCache(): void {
  const now = Date.now();
  for (const [key, entry] of branchReviewSummaryCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      branchReviewSummaryCache.delete(key);
    }
  }
}

function invalidateBranchReviewSummaryCache(projectId?: string, brId?: string): void {
  if (!projectId) {
    branchReviewSummaryCache.clear();
    branchReviewInFlight.clear();
    branchReviewSummaryGeneration.clear();
    return;
  }
  const targetSummaryKeys = new Set<string>();
  const projectPrefix = `${projectId}:`;
  const specificSummaryKey = brId ? `${projectId}:${brId}` : null;

  if (specificSummaryKey) {
    targetSummaryKeys.add(specificSummaryKey);
  } else {
    for (const key of branchReviewSummaryCache.keys()) {
      if (key.startsWith(projectPrefix)) targetSummaryKeys.add(key);
    }
    for (const key of branchReviewSummaryGeneration.keys()) {
      if (key.startsWith(projectPrefix)) targetSummaryKeys.add(key);
    }
    for (const key of branchReviewInFlight.keys()) {
      const summaryKey = key.replace(/:(summary|content|all|content-all)$/, '');
      if (summaryKey.startsWith(projectPrefix)) targetSummaryKeys.add(summaryKey);
    }
  }

  for (const summaryKey of targetSummaryKeys) {
    branchReviewSummaryCache.delete(summaryKey);
    const nextGeneration = (branchReviewSummaryGeneration.get(summaryKey) || 0) + 1;
    branchReviewSummaryGeneration.set(summaryKey, nextGeneration);
    for (const inFlightKey of branchReviewInFlight.keys()) {
      if (inFlightKey.startsWith(`${summaryKey}:`)) {
        branchReviewInFlight.delete(inFlightKey);
      }
    }
  }
}

export const trustAnalyticsApi = {
  getSummary: async (
    projectId: string,
    params: {
      window?: '24h' | '7d' | '30d' | 'custom';
      from?: string;
      to?: string;
      scope?: TrustAnalyticsScope;
      reviewType?: TrustAnalyticsReviewType | 'all';
    } = {}
  ) => {
    const response = await api.get<{ success: boolean; summary: TrustAnalyticsSummary }>(
      "/projects/" + projectId + "/trust-analytics/summary",
      { params }
    );
    return {
      ...response.data,
      summary: normalizeTrustAnalyticsSummary(response.data.summary),
    };
  },

  getTimeseries: async (
    projectId: string,
    params: {
      metric: TrustAnalyticsTimeseries['metric'];
      window?: '24h' | '7d' | '30d' | 'custom';
      from?: string;
      to?: string;
      interval?: 'hour' | 'day' | 'week';
      scope?: TrustAnalyticsScope;
      reviewType?: TrustAnalyticsReviewType | 'all';
    }
  ) => {
    const response = await api.get<{ success: boolean; timeseries: TrustAnalyticsTimeseries }>(
      "/projects/" + projectId + "/trust-analytics/timeseries",
      { params }
    );
    return {
      ...response.data,
      timeseries: normalizeTrustAnalyticsTimeseries(response.data.timeseries),
    };
  },

  getBreakdown: async (
    projectId: string,
    params: {
      metric: TrustAnalyticsBreakdownMetric;
      by: TrustAnalyticsBreakdownDimension;
      window?: '24h' | '7d' | '30d' | 'custom';
      from?: string;
      to?: string;
      limit?: number;
      scope?: TrustAnalyticsScope;
      reviewType?: TrustAnalyticsReviewType | 'all';
    }
  ) => {
    const response = await api.get<{ success: boolean; breakdown: TrustAnalyticsBreakdown }>(
      "/projects/" + projectId + "/trust-analytics/breakdown",
      { params }
    );
    return {
      ...response.data,
      breakdown: normalizeTrustAnalyticsBreakdown(response.data.breakdown),
    };
  },
};

export const branchReviewApi = {
  /**
   * List all branch reviews for a project
   */
  list: async (projectId: string, options?: { refreshCurrent?: boolean; waitForReconcile?: boolean }) => {
    const params: Record<string, string> = {};
    if (options?.refreshCurrent) params.refreshCurrent = '1';
    // Phase 05: first-load flash mitigation. Caller opts in; backend
    // applies a threshold so large projects still return immediately.
    if (options?.waitForReconcile) params.wait = 'reconcile';
    const response = await api.get<{ success: boolean; branchReviews: BranchReview[] }>(
      `/projects/${projectId}/branch-reviews`,
      Object.keys(params).length > 0 ? { params } : undefined
    );
    return {
      ...response.data,
      branchReviews: response.data.branchReviews.map(br => normalizeBranchReviewPayload(br)),
    };
  },

  /**
   * Create or update a branch review for a selected local branch.
   * This is intentionally on-demand so initial branch listing stays cheap.
   */
  ensureForBranch: async (
    projectId: string,
    branchName: string,
    options?: { diffScope?: BranchReviewDiffScope }
  ) => {
    const response = await api.post<{ success: boolean; branchReview: BranchReview }>(
      `/projects/${projectId}/branches/review`,
      {
        branchName,
        ...(options?.diffScope ? { diffScope: options.diffScope } : {}),
      }
    );
    return {
      ...response.data,
      branchReview: normalizeBranchReviewPayload(response.data.branchReview),
    };
  },

  getLastCommitPreview: async (
    projectId: string,
    branchName: string
  ) => {
    const response = await api.get<{
      success: boolean;
      preview: {
        branchName: string;
        baseBranch: string;
        mergeBaseSha?: string | null;
        forkPointSha?: string | null;
        headSha?: string | null;
        fileCount: number;
        totalAdditions: number;
        totalDeletions: number;
        commitCount: number;
        firstCommitAt?: string | null;
        lastCommitAt?: string | null;
        commits?: Array<{
          hash?: string | null;
          message?: string | null;
          author?: string | null;
          date?: string | null;
        }>;
      };
    }>(
      `/projects/${projectId}/branches/last-commit-preview`,
      { params: { branchName } }
    );
    return response.data;
  },

  /**
   * Get a single branch review with on-demand diff content
   */
  get: async (
    projectId: string,
    brId: string,
    options?: BranchReviewGetOptions
  ) => {
    const includeContent = !!options?.includeContent;
    const forceRefresh = !!options?.forceRefresh;
    const includeAllFiles = !!options?.includeAllFiles;
    const visibleFileLimit = Number.isFinite(Number(options?.visibleFileLimit)) && Number(options?.visibleFileLimit) > 0
      ? Math.floor(Number(options?.visibleFileLimit))
      : null;
    const summaryKey = getBranchReviewSummaryCacheKey(projectId, brId);
    const limitTag = visibleFileLimit ? `:lim${visibleFileLimit}` : '';
    const baseRequestKey = `${summaryKey}:${includeContent
      ? (includeAllFiles ? 'content-all' : 'content')
      : (includeAllFiles ? 'all' : 'summary')}${limitTag}`;
    const requestKey = forceRefresh ? `${baseRequestKey}:force` : baseRequestKey;
    const generationAtRequest = branchReviewSummaryGeneration.get(summaryKey) || 0;
    // A custom limit is also "non-summary" for caching — different limits
    // produce different file lists, so reuse of the 200-row summary cache
    // would mask the new files.
    const isPlainSummary = !includeContent && !includeAllFiles && !visibleFileLimit;

    if (isPlainSummary) {
      pruneBranchReviewSummaryCache();
      if (branchReviewInFlight.has(requestKey)) {
        return branchReviewInFlight.get(requestKey)!;
      }
      if (!forceRefresh) {
        const cached = branchReviewSummaryCache.get(summaryKey);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.response;
        }
      }
    }

    if (branchReviewInFlight.has(requestKey)) {
      return branchReviewInFlight.get(requestKey)!;
    }

    const request = api.get<BranchReviewGetResponse>(
      `/projects/${projectId}/branch-reviews/${brId}`,
      {
        params: {
          ...(includeContent ? { includeContent: '1' } : {}),
          ...(includeAllFiles ? { includeAllFiles: 'true' } : {}),
          ...(visibleFileLimit ? { visibleFileLimit: String(visibleFileLimit) } : {}),
          ...(forceRefresh ? { _: String(Date.now()) } : {}),
        },
      }
    ).then((response) => {
      const normalizedResponse = {
        ...response.data,
        branchReview: normalizeBranchReviewPayload(response.data.branchReview),
      };
      if (isPlainSummary) {
        const currentGeneration = branchReviewSummaryGeneration.get(summaryKey) || 0;
        if (currentGeneration !== generationAtRequest) {
          return normalizedResponse;
        }
        pruneBranchReviewSummaryCache();
        branchReviewSummaryCache.set(summaryKey, {
          response: normalizedResponse,
          expiresAt: Date.now() + BR_SUMMARY_CACHE_TTL_MS,
        });
      }
      return normalizedResponse;
    }).finally(() => {
      branchReviewInFlight.delete(requestKey);
    });

    branchReviewInFlight.set(requestKey, request);
    return request;
  },

  /**
   * Refresh a branch review's local git metadata before review actions.
   */
  refresh: async (projectId: string, brId: string) => {
    const response = await api.post<{ success: boolean; branchReview: BranchReview }>(
      `/projects/${projectId}/branch-reviews/${brId}/refresh`
    );
    invalidateBranchReviewSummaryCache(projectId, brId);
    return {
      ...response.data,
      branchReview: normalizeBranchReviewPayload(response.data.branchReview),
    };
  },

  /**
   * Fetch before/after content for a subset of branch review files
   */
  getFileContents: async (projectId: string, brId: string, paths: string[]) => {
    const response = await api.post<{
      success: boolean;
      files: BranchReviewFileContent[];
      missingPaths?: string[];
    }>(
      `/projects/${projectId}/branch-reviews/${brId}/files/content`,
      { paths }
    );
    return response.data;
  },

  /**
   * Update branch review status
   */
  updateStatus: async (projectId: string, brId: string, status: string) => {
    const response = await api.patch<{ success: boolean; branchReview: BranchReview }>(
      `/projects/${projectId}/branch-reviews/${brId}/status`,
      { status }
    );
    invalidateBranchReviewSummaryCache(projectId, brId);
    return {
      ...response.data,
      branchReview: normalizeBranchReviewPayload(response.data.branchReview),
    };
  },

  /**
   * Trigger AI review on a branch review
   */
  triggerReview: async (
    projectId: string,
    brId: string,
    options?: BranchReviewRunOptions
  ) => {
    const response = await api.post<{
      success: boolean;
      message?: string;
      review?: import('@/types').ReviewResult;
      branchReview: BranchReview;
    }>(
      `/projects/${projectId}/branch-reviews/${brId}/review`,
      options
        ? {
          ...(options.includePatterns || options.excludePatterns || options.applyGlobalIgnorePatterns === false
            ? { scope: {
              includePatterns: options.includePatterns,
              excludePatterns: options.excludePatterns,
              applyGlobalIgnorePatterns: options.applyGlobalIgnorePatterns,
            } }
            : {}),
          ...(options.reviewMode ? { reviewMode: options.reviewMode } : {}),
          ...(options.resetSnapshot ? { resetSnapshot: true } : {}),
          ...(options.policySource ? { policySource: options.policySource } : {}),
        }
        : undefined
    );
    invalidateBranchReviewSummaryCache(projectId, brId);
    return {
      ...response.data,
      review: response.data.review
        ? normalizeReviewData(response.data.review) as import('@/types').ReviewResult
        : response.data.review,
      branchReview: normalizeBranchReviewPayload(response.data.branchReview),
    };
  },

  /**
   * Queue AI review on a branch review (non-blocking)
   */
  queueReview: async (
    projectId: string,
    brId: string,
    options?: BranchReviewRunOptions
  ) => {
    const response = await api.post<{
      success: boolean;
      position?: number;
      id?: string;
      alreadyReviewed?: boolean;
      reason?: string;
      branchReview?: BranchReview;
    }>(
      `/projects/${projectId}/branch-reviews/${brId}/review/queue`,
      options
        ? {
          ...(options.includePatterns || options.excludePatterns || options.applyGlobalIgnorePatterns === false
            ? { scope: {
              includePatterns: options.includePatterns,
              excludePatterns: options.excludePatterns,
              applyGlobalIgnorePatterns: options.applyGlobalIgnorePatterns,
            } }
            : {}),
          ...(options.reviewMode ? { reviewMode: options.reviewMode } : {}),
          ...(options.resetSnapshot ? { resetSnapshot: true } : {}),
          ...(options.policySource ? { policySource: options.policySource } : {}),
          ...(options.partial === true ? { partial: true } : {}),
          ...(options.force === true ? { force: true } : {}),
        }
        : undefined
    );
    invalidateBranchReviewSummaryCache(projectId, brId);
    return {
      ...response.data,
      branchReview: response.data.branchReview
        ? normalizeBranchReviewPayload(response.data.branchReview)
        : response.data.branchReview,
    };
  },

  /**
   * Stop a queued or running branch review
   */
  stopReview: async (projectId: string, brId: string) => {
    const response = await api.delete<{ success: boolean; stopped: boolean; was: 'queued' | 'running' | null }>(
      `/projects/${projectId}/branch-reviews/${brId}/review/queue`
    );
    invalidateBranchReviewSummaryCache(projectId, brId);
    return response.data;
  },

  /**
   * Delete a branch review and reset the branch to its initial state
   */
  delete: async (projectId: string, brId: string) => {
    const response = await api.delete<{
      success: boolean;
      deleted: boolean;
      branchReview?: BranchReview;
      stopped?: { stopped: boolean; was: 'queued' | 'running' | null };
    }>(
      `/projects/${projectId}/branch-reviews/${brId}`
    );
    invalidateBranchReviewSummaryCache(projectId, brId);
    return {
      ...response.data,
      branchReview: response.data.branchReview
        ? normalizeBranchReviewPayload(response.data.branchReview)
        : response.data.branchReview,
    };
  },

  /**
   * Update the project's base branch
   */
  updateBaseBranch: async (projectId: string, baseBranch: string) => {
    const response = await api.patch<{ success: boolean; baseBranchDisplay: string; baseBranchRef: string }>(
      `/projects/${projectId}/base-branch`,
      { baseBranch }
    );
    invalidateBranchReviewSummaryCache(projectId);
    return response.data;
  },

  /**
   * Per-review base override (Phase 05). Pins the review's base so it
   * survives project-wide Change Base cascades and reconcile healing.
   * Pass `pin: false` to un-pin and let reconcile heal it back to the
   * project-wide base on the next tick.
   */
  updateReviewBaseBranch: async (
    projectId: string,
    brId: string,
    baseBranch: string,
    options?: { pin?: boolean }
  ) => {
    const body: { baseBranch?: string; pin: boolean } = { pin: options?.pin ?? true };
    if (body.pin) body.baseBranch = baseBranch;
    const response = await api.patch<{ success: boolean; branchReview: BranchReview }>(
      `/projects/${projectId}/branch-reviews/${brId}/base-branch`,
      body
    );
    invalidateBranchReviewSummaryCache(projectId, brId);
    // Normalize the returned branch review the same way the list and
    // detail endpoints' responses are normalized — otherwise callers
    // can observe inconsistent date/SHA shapes across API entry points.
    return {
      ...response.data,
      branchReview: normalizeBranchReviewPayload(response.data.branchReview),
    };
  },

  invalidateCache: (projectId?: string, brId?: string) => {
    invalidateBranchReviewSummaryCache(projectId, brId);
  },

  /**
   * List local branches for the project repo
   */
  listBranches: async (projectId: string, options?: { reviewableOnly?: boolean }) => {
    const response = await api.get<{
      success: boolean;
      branches: Array<{
        name: string;
        current: boolean;
        headSha?: string | null;
        lastCommitAt?: string | null;
        aheadCount?: number | null;
        isWorktree?: boolean;
        worktreePath?: string | null;
        worktreeName?: string | null;
        worktreeHead?: string | null;
      }>;
    }>(
      `/projects/${projectId}/branches`,
      options?.reviewableOnly ? { params: { reviewableOnly: '1' } } : undefined
    );
    return response.data;
  },
};

type WorkspaceReviewGetOptions = {
  includeContent?: boolean;
  includeAllFiles?: boolean;
  visibleFileLimit?: number;
};

function buildWorkspaceReviewParams(options?: WorkspaceReviewGetOptions): Record<string, string> | undefined {
  if (!options) return undefined;
  const params: Record<string, string> = {};
  if (options.includeContent) params.includeContent = '1';
  if (options.includeAllFiles) params.includeAllFiles = 'true';
  if (Number.isFinite(Number(options.visibleFileLimit)) && Number(options.visibleFileLimit) > 0) {
    params.visibleFileLimit = String(Math.floor(Number(options.visibleFileLimit)));
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

export const workspaceReviewApi = {
  list: async (projectId: string, options?: WorkspaceReviewGetOptions) => {
    const params = buildWorkspaceReviewParams(options);
    const response = await api.get<{ success: boolean; workspaceReviews: WorkspaceReview[] }>(
      `/projects/${projectId}/workspace-reviews`,
      params ? { params } : undefined
    );
    return {
      ...response.data,
      workspaceReviews: response.data.workspaceReviews.map((review) => normalizeBranchReviewPayload(review as unknown as BranchReview) as unknown as WorkspaceReview),
    };
  },

  get: async (projectId: string, workspaceReviewId: string, options?: WorkspaceReviewGetOptions) => {
    const params = buildWorkspaceReviewParams(options);
    const response = await api.get<{ success: boolean; workspaceReview: WorkspaceReview }>(
      `/projects/${projectId}/workspace-reviews/${workspaceReviewId}`,
      params ? { params } : undefined
    );
    return {
      ...response.data,
      workspaceReview: normalizeBranchReviewPayload(response.data.workspaceReview as unknown as BranchReview) as unknown as WorkspaceReview,
    };
  },

  getFileContents: async (projectId: string, workspaceReviewId: string, paths: string[]) => {
    const response = await api.post<{
      success: boolean;
      files: BranchReviewFileContent[];
      missingPaths?: string[];
    }>(
      `/projects/${projectId}/workspace-reviews/${workspaceReviewId}/files/content`,
      { paths }
    );
    return response.data;
  },

  queueReview: async (projectId: string, workspaceReviewId: string, options?: WorkspaceReviewRunOptions) => {
    const response = await api.post<{
      success: boolean;
      position: number;
      id: string;
      workspaceReview?: WorkspaceReview;
      alreadyRunning?: boolean;
    }>(
      `/projects/${projectId}/workspace-reviews/${workspaceReviewId}/review/queue`,
      options
        ? {
          ...(options.reviewMode ? { reviewMode: options.reviewMode } : {}),
          ...(options.policySource ? { policySource: options.policySource } : {}),
        }
        : undefined
    );
    return {
      ...response.data,
      workspaceReview: response.data.workspaceReview
        ? normalizeBranchReviewPayload(response.data.workspaceReview as unknown as BranchReview) as unknown as WorkspaceReview
        : response.data.workspaceReview,
    };
  },

  stopReview: async (projectId: string, workspaceReviewId: string) => {
    const response = await api.delete<{ success: boolean; stopped: boolean; was: 'queued' | 'running' | null }>(
      `/projects/${projectId}/workspace-reviews/${workspaceReviewId}/review/queue`
    );
    return response.data;
  },
};

// ============================================================================
// PR REVIEW API — GitHub Pull Request reviews
// ============================================================================

type PrReviewGetResponse = {
  success: boolean;
  prReview: PrReview;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    oldPath: string | null;
  }>;
};

type PrReviewGetOptions = {
  includeAllFiles?: boolean;
  visibleFileLimit?: number;
};

type PrReviewConversationsResponse = {
  success: boolean;
  conversations: GitHubPrConversations;
};

const PR_SUMMARY_CACHE_TTL_MS = 10 * 60 * 1000;
const prReviewSummaryCache = new Map<string, {
  expiresAt: number;
  response: PrReviewGetResponse;
}>();
const prReviewInFlight = new Map<string, Promise<PrReviewGetResponse>>();
const prReviewSummaryGeneration = new Map<string, number>();

function getPrReviewSummaryCacheKey(projectId: string, prId: string): string {
  return `${projectId}:${prId}`;
}

function prunePrReviewSummaryCache(): void {
  const now = Date.now();
  for (const [key, entry] of prReviewSummaryCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      prReviewSummaryCache.delete(key);
    }
  }
}

function invalidatePrReviewSummaryCache(projectId?: string, prId?: string): void {
  if (!projectId) {
    prReviewSummaryCache.clear();
    prReviewInFlight.clear();
    prReviewSummaryGeneration.clear();
    return;
  }

  const targetSummaryKeys = new Set<string>();
  const projectPrefix = `${projectId}:`;
  const specificSummaryKey = prId ? `${projectId}:${prId}` : null;

  if (specificSummaryKey) {
    targetSummaryKeys.add(specificSummaryKey);
  } else {
    for (const key of prReviewSummaryCache.keys()) {
      if (key.startsWith(projectPrefix)) targetSummaryKeys.add(key);
    }
    for (const key of prReviewSummaryGeneration.keys()) {
      if (key.startsWith(projectPrefix)) targetSummaryKeys.add(key);
    }
    for (const key of prReviewInFlight.keys()) {
      const summaryKey = key.replace(/:(summary|all)$/, '');
      if (summaryKey.startsWith(projectPrefix)) targetSummaryKeys.add(summaryKey);
    }
  }

  for (const summaryKey of targetSummaryKeys) {
    prReviewSummaryCache.delete(summaryKey);
    const nextGeneration = (prReviewSummaryGeneration.get(summaryKey) || 0) + 1;
    prReviewSummaryGeneration.set(summaryKey, nextGeneration);
    prReviewInFlight.delete(`${summaryKey}:summary`);
    prReviewInFlight.delete(`${summaryKey}:all`);
  }
}

export const prReviewApi = {
  /** List all PR reviews for a project */
  list: async (projectId: string) => {
    const response = await api.get<{ success: boolean; prReviews: PrReview[]; lastSyncedAt?: string | null }>(
      `/projects/${projectId}/pr-reviews`
    );
    return {
      ...response.data,
      lastSyncedAt: response.data.lastSyncedAt ?? null,
      prReviews: response.data.prReviews.map((pr) => normalizePrReviewPayload(pr)),
    };
  },

  /** Sync open PRs from GitHub */
  sync: async (projectId: string) => {
    const response = await api.post<{ success: boolean; prReviews: PrReview[]; synced: number; lastSyncedAt?: string | null }>(
      `/projects/${projectId}/pr-reviews/sync`
    );
    invalidatePrReviewSummaryCache(projectId);
    return {
      ...response.data,
      lastSyncedAt: response.data.lastSyncedAt ?? null,
      prReviews: response.data.prReviews.map((pr) => normalizePrReviewPayload(pr)),
    };
  },

  /** Refresh a single PR review from GitHub */
  refresh: async (projectId: string, prId: string) => {
    const response = await api.post<{ success: boolean; prReview: PrReview }>(
      `/projects/${projectId}/pr-reviews/${prId}/refresh`
    );
    invalidatePrReviewSummaryCache(projectId, prId);
    return {
      ...response.data,
      prReview: normalizePrReviewPayload(response.data.prReview),
    };
  },

  /** Clear a PR review result while keeping the PR record intact */
  delete: async (projectId: string, prId: string) => {
    const response = await api.delete<{ success: boolean; deleted: boolean; prReview: PrReview }>(
      `/projects/${projectId}/pr-reviews/${prId}`
    );
    invalidatePrReviewSummaryCache(projectId, prId);
    return {
      ...response.data,
      prReview: normalizePrReviewPayload(response.data.prReview),
    };
  },

  /** Get a single PR review with file manifest */
  get: async (projectId: string, prId: string, options?: PrReviewGetOptions) => {
    const includeAllFiles = !!options?.includeAllFiles;
    const visibleFileLimit = Number.isFinite(Number(options?.visibleFileLimit)) && Number(options?.visibleFileLimit) > 0
      ? Math.floor(Number(options?.visibleFileLimit))
      : null;
    const summaryKey = getPrReviewSummaryCacheKey(projectId, prId);
    const limitTag = visibleFileLimit ? `:lim${visibleFileLimit}` : '';
    const requestKey = `${summaryKey}:${includeAllFiles ? 'all' : 'summary'}${limitTag}`;
    const generationAtRequest = prReviewSummaryGeneration.get(summaryKey) || 0;
    const isPlainSummary = !includeAllFiles && !visibleFileLimit;

    if (isPlainSummary) {
      prunePrReviewSummaryCache();
    }
    if (prReviewInFlight.has(requestKey)) {
      return prReviewInFlight.get(requestKey)!;
    }

    if (isPlainSummary) {
      const cached = prReviewSummaryCache.get(summaryKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
      }
    }

    const request = api.get<PrReviewGetResponse>(`/projects/${projectId}/pr-reviews/${prId}`, {
      params: {
        ...(includeAllFiles ? { includeAllFiles: 'true' } : {}),
        ...(visibleFileLimit ? { visibleFileLimit: String(visibleFileLimit) } : {}),
      },
    })
      .then((response) => {
        const normalizedResponse = {
          ...response.data,
          prReview: normalizePrReviewPayload(response.data.prReview),
        };
        if (isPlainSummary) {
          const currentGeneration = prReviewSummaryGeneration.get(summaryKey) || 0;
          if (currentGeneration !== generationAtRequest) {
            return normalizedResponse;
          }
          prunePrReviewSummaryCache();
          prReviewSummaryCache.set(summaryKey, {
            response: normalizedResponse,
            expiresAt: Date.now() + PR_SUMMARY_CACHE_TTL_MS,
          });
        }
        return normalizedResponse;
      })
      .finally(() => {
        prReviewInFlight.delete(requestKey);
      });

    prReviewInFlight.set(requestKey, request);
    return request;
  },

  /** Fetch before/after content for specific files */
  getFileContents: async (projectId: string, prId: string, paths: string[]) => {
    const response = await api.post<{
      success: boolean;
      files: Array<{
        path: string;
        before: string | null;
        after: string | null;
        status: string;
        oldPath: string | null;
        patch: string | null;
      }>;
      missingPaths: string[];
    }>(`/projects/${projectId}/pr-reviews/${prId}/files/content`, { paths });
    return response.data;
  },

  /** Queue an AI review for a PR */
  queueReview: async (projectId: string, prId: string, options?: PrReviewRunOptions) => {
    const response = await api.post<{ success: boolean; position: number; id: string }>(
      `/projects/${projectId}/pr-reviews/${prId}/review/queue`,
      options
        ? {
          ...(options.reviewMode ? { reviewMode: options.reviewMode } : {}),
          ...(options.forceFullScope ? { forceFullScope: true } : {}),
          ...(options.policySource ? { policySource: options.policySource } : {}),
        }
        : undefined
    );
    invalidatePrReviewSummaryCache(projectId, prId);
    return response.data;
  },

  /** Stop a queued or running PR review */
  stopReview: async (projectId: string, prId: string) => {
    const response = await api.delete<{ success: boolean; stopped: boolean; was: 'queued' | 'running' | null }>(
      `/projects/${projectId}/pr-reviews/${prId}/review/queue`
    );
    invalidatePrReviewSummaryCache(projectId, prId);
    return response.data;
  },

  /** Get persisted GitHub publication state for a PR review */
  getPublications: async (projectId: string, prId: string) => {
    const response = await api.get<ReviewPublicationListResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/github-review/publications`
    );
    return {
      ...response.data,
      publication: normalizeReviewPublicationState(response.data.publication, projectId, prId),
    };
  },

  /** Get persisted GitHub conversation state for a PR review */
  getConversations: async (projectId: string, prId: string) => {
    const response = await api.get<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations`
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Sync GitHub PR conversations and return the persisted state */
  syncConversations: async (projectId: string, prId: string) => {
    const response = await api.post<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/sync`
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Reply to a synced GitHub PR review thread */
  replyToConversationThread: async (projectId: string, prId: string, threadNodeId: string, body: string) => {
    const response = await api.post<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/threads/reply`,
      { threadNodeId, body }
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Create a new GitHub PR review thread on a diff line */
  createConversationThread: async (
    projectId: string,
    prId: string,
    payload: { path: string; line: number; side?: 'LEFT' | 'RIGHT'; body: string },
  ) => {
    const response = await api.post<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/threads`,
      payload
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Resolve or reopen a synced GitHub PR review thread */
  setConversationThreadResolution: async (
    projectId: string,
    prId: string,
    threadNodeId: string,
    resolved: boolean,
  ) => {
    const response = await api.patch<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/threads/resolution`,
      { threadNodeId, resolved }
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Edit a synced GitHub PR review reply comment */
  updateConversationComment: async (projectId: string, prId: string, commentNodeId: string, body: string) => {
    const response = await api.patch<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/comments`,
      { commentNodeId, body }
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Delete a synced GitHub PR review reply comment */
  deleteConversationComment: async (projectId: string, prId: string, commentNodeId: string) => {
    const response = await api.delete<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/comments`,
      { data: { commentNodeId } }
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Add a top-level GitHub PR comment */
  addIssueComment: async (projectId: string, prId: string, body: string) => {
    const response = await api.post<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/issue-comments`,
      { body }
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Edit a synced top-level GitHub PR comment */
  updateIssueComment: async (projectId: string, prId: string, commentNodeId: string, body: string) => {
    const response = await api.patch<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/issue-comments`,
      { commentNodeId, body }
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Delete a synced top-level GitHub PR comment */
  deleteIssueComment: async (projectId: string, prId: string, commentNodeId: string) => {
    const response = await api.delete<PrReviewConversationsResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/conversations/issue-comments`,
      { data: { commentNodeId } }
    );
    return {
      ...response.data,
      conversations: normalizeGitHubPrConversations(response.data.conversations),
    };
  },

  /** Submit the current PR review to GitHub */
  publishToGitHub: async (
    projectId: string,
    prId: string,
    payload: {
      action: GitHubReviewAction;
      recommendationKeys?: string[];
      useExplicitRecommendationSelection?: boolean;
      body?: string | null;
      commentOverridesByRecommendationKey?: Record<string, string>;
      manualLineComments?: Array<{
        id: string;
        path: string;
        line: number;
        side?: 'LEFT' | 'RIGHT';
        body: string;
      }>;
      skipExistingPublicationCheck?: boolean;
    }
  ) => {
    const response = await api.post<ReviewPublicationListResponse>(
      `/projects/${projectId}/pr-reviews/${prId}/github-review`,
      payload
    );
    invalidatePrReviewSummaryCache(projectId, prId);
    return {
      ...response.data,
      publication: normalizeReviewPublicationState(response.data.publication, projectId, prId),
    };
  },

  invalidateCache: (projectId?: string, prId?: string) => {
    invalidatePrReviewSummaryCache(projectId, prId);
  },
};

// ============================================================================
// USAGE API — Review usage tracking and free tier limits
// ============================================================================

export interface UsageSummary {
  reviewCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  monthlyLimit: number;
  reviewsRemaining: number;
  limitReached: boolean;
}

export interface UsageRecord {
  id: string;
  projectId: string | null;
  changesetId: string | null;
  reviewType?: 'changeset' | 'branch_review' | 'pr_review' | null;
  reviewId?: string | null;
  providerType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  providerNativeCost?: number | null;
  costSource?: 'provider_native' | 'pricing_table' | 'fallback_pricing' | null;
  costIsApproximate?: boolean;
  reviewedAt: string;
}

export interface ProviderBreakdown {
  providerType: string;
  model: string;
  reviewCount: number;
  totalTokens: number;
  totalCost: number;
}

export const usageApi = {
  getSummary: async (): Promise<UsageSummary> => {
    const response = await api.get<{ success: boolean } & UsageSummary>('/usage/summary');
    return response.data;
  },

  getRecent: async (
    limit = 20,
    projectId?: string,
    reviewType?: UsageRecord['reviewType'],
    reviewId?: string,
  ): Promise<UsageRecord[]> => {
    const params: Record<string, string | number> = { limit };
    if (projectId) params.projectId = projectId;
    if (reviewType) params.reviewType = reviewType;
    if (reviewId) params.reviewId = reviewId;
    const response = await api.get<{
      success: boolean;
      records: UsageRecord[];
      count: number;
    }>('/usage/recent', { params });
    return response.data.records;
  },

  getBreakdown: async (): Promise<ProviderBreakdown[]> => {
    const response = await api.get<{
      success: boolean;
      breakdown: ProviderBreakdown[];
    }>('/usage/breakdown');
    return response.data.breakdown;
  },

  getLimitStatus: async (): Promise<{
    used: number;
    limit: number;
    remaining: number;
    limitReached: boolean;
  }> => {
    const response = await api.get<{
      success: boolean;
      used: number;
      limit: number;
      remaining: number;
      limitReached: boolean;
    }>('/usage/limit-status');
    return response.data;
  },
};

// Phase 11: walkthrough generation is decoupled from review.
export interface Walkthrough {
  id?: string;
  projectId: string;
  baseSha: string;
  headSha: string;
  changeGroups: Array<{
    label: string;
    description?: string;
    risk?: string;
    files: Array<{ path: string; additions: number; deletions: number; description?: string }>;
  }>;
  modelId?: string | null;
  providerType?: string | null;
  runMetadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export const walkthroughApi = {
  /**
   * Cache lookup. Returns the walkthrough or null on 404.
   */
  get: async (
    projectId: string,
    baseSha: string,
    headSha: string,
    options?: { includeStale?: boolean }
  ): Promise<(Walkthrough & { stale?: boolean; currentBaseSha?: string | null; currentHeadSha?: string | null }) | null> => {
    try {
      const response = await api.get<{
        success: boolean;
        walkthrough: Walkthrough;
        stale?: boolean;
        currentBaseSha?: string | null;
        currentHeadSha?: string | null;
      }>(
        `/projects/${projectId}/walkthroughs`,
        { params: { baseSha, headSha, ...(options?.includeStale ? { includeStale: '1' } : {}) } }
      );
      return response.data.walkthrough
        ? {
            ...response.data.walkthrough,
            stale: response.data.stale === true,
            currentBaseSha: response.data.currentBaseSha || null,
            currentHeadSha: response.data.currentHeadSha || null,
          }
        : null;
    } catch (err) {
      // Treat 404 as "no cached walkthrough yet" — surface CTA.
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) return null;
      throw err;
    }
  },

  /**
   * Generate a walkthrough. Cluster narration always runs on the provider's
   * cheap-tier model; synthesis is forced cheap-tier inside the generator
   * (see SYNTHESIS_USE_CHEAP_MODEL).
   * Pass `force: true` to bypass the (baseSha, headSha) cache.
   * Pass `signal` to abort the HTTP request — note this only stops the
   * frontend's awaiting; the backend may still complete and persist the row,
   * which a subsequent get() call will pick up as a cache hit.
   */
  generate: async (
    projectId: string,
    baseSha: string,
    headSha: string,
    options?: { force?: boolean; bypassCache?: boolean; signal?: AbortSignal; reviewType?: 'branch_review' | 'pr_review' | 'workspace_review'; reviewId?: string | null }
  ): Promise<Walkthrough & { noChanges?: boolean; incremental?: boolean; previousHeadSha?: string | null }> => {
    const response = await api.post<{
      success: boolean;
      walkthrough: Walkthrough;
      noChanges?: boolean;
      incremental?: boolean;
      previousHeadSha?: string | null;
      error?: string;
    }>(
      `/projects/${projectId}/walkthroughs`,
      {
        baseSha,
        headSha,
        force: options?.force === true,
        bypassCache: options?.bypassCache === true,
        ...(options?.reviewType ? { reviewType: options.reviewType } : {}),
        ...(options?.reviewId ? { reviewId: options.reviewId } : {}),
      },
      { signal: options?.signal }
    );
    if (response.data.success === false) {
      throw new Error(response.data.error || 'Failed to generate walkthrough');
    }
    return {
      ...response.data.walkthrough,
      noChanges: response.data.noChanges === true,
      incremental: response.data.incremental === true,
      previousHeadSha: response.data.previousHeadSha ?? null,
    };
  },

  recordStepRead: async (
    projectId: string,
    baseSha: string,
    headSha: string,
    stepIndex: number,
  ): Promise<void> => {
    await api.post<{ success: boolean }>(
      `/projects/${projectId}/walkthroughs/step-read`,
      { baseSha, headSha, stepIndex },
    );
  },
};

export const __testing = {
  buildReviewOutcomeEndpoint,
  buildReviewFixRunEndpoint,
};

export default api;
