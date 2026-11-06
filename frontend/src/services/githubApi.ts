/**
 * GitHub API Client
 * Service for interacting with GitHub integration endpoints
 */

import axios from 'axios';
import { getApiBaseUrl } from './api';
import { resolveGitHubApiAuthToken } from './githubAuthToken';
import type { IntegrationCheck } from '@/types';

const api = axios.create({
  baseURL: getApiBaseUrl(),
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor (add auth token if available)
api.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();
  const token = resolveGitHubApiAuthToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface GitHubInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  avatarUrl: string;
  isActive: boolean;
  tokenExpiresAt: string;
  reposCount: number | null;
  reposKnown?: boolean;
  repoAccessState?: 'loaded' | 'unknown' | 'refresh_failed' | 'reauth_required';
  repoAccessMessage?: string | null;
  permissions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

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
  language: string | null;
  size: number;
}

export interface CloneRequest {
  owner: string;
  repo: string;
  installationId?: number;
  branch?: string;
  name?: string;
  description?: string;
}

export interface ClonedProject {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  framework: string | null;
  language: string | null;
  path: string;
  github: {
    repoId: number;
    repoFullName: string;
    defaultBranch: string;
    syncEnabled: boolean;
    syncStatus: string;
  };
  hasMemory: boolean;
  createdAt: string;
}

export interface GitHubSyncStatus {
  project: {
    id: string;
    githubRepoId: number | null;
    githubRepoFullName: string | null;
    githubInstallationId: number | null;
    defaultBranch: string | null;
    lastSyncAt: string | null;
    syncEnabled: boolean;
    syncStatus: string;
  };
  recentEvents: Array<{
    id: string;
    direction: 'to_github' | 'from_github';
    eventType: string;
    status: 'pending' | 'in_progress' | 'success' | 'failed';
    commitSha: string | null;
    commitMessage: string | null;
    branch: string;
    filesCount: number;
    errorMessage: string | null;
    durationMs: number | null;
    createdAt: string;
  }>;
}

export interface GitStatus {
  success: boolean;
  isRepo: boolean;
  branch?: string;
  originUrl?: string | null;
  isGitHub?: boolean;
  owner?: string | null;
  repo?: string | null;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  hasUpstream?: boolean;
  modified?: number;
  created?: number;
  deleted?: number;
  staged?: number;
  conflicted?: number;
  message?: string;
}

export type SyncLifecycleState =
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'superseded';

export interface SyncLifecycleSnapshot {
  event?: string | null;
  projectId: string | null;
  jobId: string | null;
  syncType: 'push' | 'pull' | null;
  state: SyncLifecycleState;
  commitSha: string | null;
  reason: string | null;
  retry: {
    count: number;
    max: number;
    willRetry: boolean;
    backoffMs: number | null;
    nextAttemptAt: string | null;
  };
  filesChanged: string[];
  terminal: boolean;
  superseded: boolean;
  reusedExistingJob: boolean;
  timestamps: {
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
  };
  updatedAt: string;
}

export interface ProjectSyncQueueJob {
  id: string;
  type: 'push' | 'pull' | null;
  status: 'pending' | 'processing' | 'completed' | 'failed' | string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  retryCount: number;
  commitSha: string | null;
  reason: string | null;
  filesChanged: string[];
  lifecycle: SyncLifecycleSnapshot;
}

export interface ProjectSyncStatusResponse {
  success: boolean;
  syncEnabled: boolean;
  status: string;
  repository?: string;
  branch?: string;
  lastSyncSha?: string | null;
  lastSyncAt?: string | null;
  webhookConfigured?: boolean;
  currentJob?: ProjectSyncQueueJob | null;
  lifecycle?: {
    current: SyncLifecycleSnapshot | null;
    lastOutcome: SyncLifecycleSnapshot | null;
    pending: {
      total: number;
      queued: number;
      processing: number;
      retrying: number;
    };
    maxRetries: number;
  };
}

export interface SyncHistoryResponse {
  history: Array<{
    id: string;
    type: 'push' | 'pull';
    status: 'pending' | 'processing' | 'completed' | 'failed' | string;
    lifecycleState: SyncLifecycleState;
    commitSha?: string | null;
    commitMessage?: string | null;
    filesChanged?: string[];
    errorMessage?: string | null;
    retryCount: number;
    retry: SyncLifecycleSnapshot['retry'];
    reason?: string | null;
    createdAt: string;
    startedAt?: string | null;
    completedAt?: string | null;
    duration?: number | null;
    lifecycle: SyncLifecycleSnapshot;
  }>;
  total: number;
}

export const githubApi = {
  /**
   * Get Git status for a project (branch, dirty, ahead/behind)
   */
  async getGitStatus(projectId: string): Promise<GitStatus> {
    const response = await api.get(`/projects/${projectId}/git/status`);
    return response.data;
  },

  /**
   * Get GitHub App installation URL
   * Pass targetId to generate a direct install link for a specific org.
   */
  async getInstallUrl(targetId?: number): Promise<{ installUrl: string }> {
    const params = targetId ? `?target_id=${targetId}` : '';
    const response = await api.get(`/github/install${params}`);
    return response.data;
  },

  /**
   * Get the authenticated user's GitHub organizations
   */
  async getUserOrgs(): Promise<Array<{ id: number; login: string; avatarUrl: string; description: string | null }>> {
    const response = await api.get('/github/user/orgs');
    return response.data.orgs || [];
  },

  /**
   * Get smart GitHub connection URL
   * Returns the appropriate URL based on the user's connection state:
   * - No installation: returns installation URL
   * - Has installation but no user token: returns OAuth authorization URL
   * - Fully connected: returns null
   */
  async getConnectUrl(force?: 'new-account'): Promise<{ url: string | null; step: string; message: string; userCode?: string; verificationUri?: string }> {
    const params = force ? `?force=${encodeURIComponent(force)}` : '';
    const response = await api.get(`/github/connect${params}`);
    return response.data;
  },

  /**
   * Get user's GitHub installations
   */
  async getInstallations(options?: { summary?: boolean; reactivateAccount?: string }): Promise<GitHubInstallation[]> {
    const searchParams = new URLSearchParams();
    if (options?.summary) searchParams.set('summary', '1');
    if (options?.reactivateAccount) searchParams.set('reactivateAccount', options.reactivateAccount);
    const params = searchParams.toString() ? `?${searchParams.toString()}` : '';
    const response = await api.get(`/github/installations${params}`);
    return response.data.installations;
  },

  /**
   * Get repositories accessible via installation
   */
  async getRepositories(installationId: number): Promise<GitHubRepository[]> {
    const response = await api.get(`/github/repositories/${installationId}`);
    return response.data.repositories;
  },

  /**
   * Get repository details
   */
  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    const response = await api.get(`/github/repo/${owner}/${repo}`);
    return response.data.repository;
  },

  /**
   * Clone a GitHub repository.
   * Returns the cloned project and any detected integrations needing configuration.
   */
  async cloneRepository(data: CloneRequest): Promise<{
    project: ClonedProject;
    alreadyExists?: boolean;
    integrations: IntegrationCheck[];
    autoLinkedIntegrations: Array<{ id: string; name: string; supabaseProjectName?: string }>;
  }> {
    const response = await api.post('/github/clone', data);
    return {
      project: response.data.project,
      alreadyExists: response.data.alreadyExists === true,
      integrations: Array.isArray(response.data.integrations) ? response.data.integrations : [],
      autoLinkedIntegrations: Array.isArray(response.data.autoLinkedIntegrations) ? response.data.autoLinkedIntegrations : [],
    };
  },

  /**
   * Disconnect GitHub integration (all installations)
   */
  async disconnect(): Promise<void> {
    await api.delete('/github/disconnect');
  },

  /**
   * Disconnect a single GitHub installation by ID
   */
  async disconnectInstallation(installationId: number): Promise<{ success: boolean }> {
    const response = await api.delete(`/github/installations/${installationId}`);
    return response.data;
  },

  /**
   * Get GitHub sync status for a project
   */
  async getSyncStatus(projectId: string): Promise<GitHubSyncStatus> {
    const response = await api.get(`/projects/${projectId}/github/status`);
    return response.data;
  },

  /**
   * Enable GitHub sync for a project
   */
  async enableSync(projectId: string): Promise<void> {
    await api.post(`/projects/${projectId}/github/enable`);
  },

  /**
   * Disable GitHub sync for a project
   */
  async disableSync(projectId: string): Promise<void> {
    await api.post(`/projects/${projectId}/github/disable`);
  },

  /**
   * Check GitHub service health
   */
  async checkHealth(): Promise<{ healthy: boolean; appName?: string; error?: string }> {
    const response = await api.get('/github/health');
    return response.data;
  },

  /**
   * Get detailed sync status for a project (bidirectional sync)
   */
  async getProjectSyncStatus(projectId: string): Promise<ProjectSyncStatusResponse> {
    const response = await api.get(`/github/projects/${projectId}/sync/status`);
    return response.data;
  },

  /**
   * Get sync history for a project
   */
  async getSyncHistory(projectId: string, limit = 20): Promise<SyncHistoryResponse> {
    const response = await api.get(`/github/projects/${projectId}/sync/history?limit=${limit}`);
    return response.data;
  },

  /**
   * Manually trigger a sync operation
   */
  async triggerSync(projectId: string, type: 'push' | 'pull', message?: string): Promise<{
    success: boolean;
    message: string;
    reusedExistingJob: boolean;
    lifecycle: SyncLifecycleSnapshot;
    job: ProjectSyncQueueJob;
    repository: string;
    branch: string;
    commitSha?: string | null;
  }> {
    const response = await api.post(`/github/projects/${projectId}/sync`, {
      type,
      message,
    });
    return response.data;
  },

  /**
   * Create a new GitHub repository for a project
   */
  async createRepository(projectId: string, data: { name: string; private: boolean }): Promise<{
    success: boolean;
    repository: {
      id: number;
      fullName: string;
      htmlUrl: string;
      cloneUrl: string;
    };
  }> {
    const response = await api.post(`/github/projects/${projectId}/create-repo`, data);
    return response.data;
  },

  /**
   * Unlink project from GitHub and clear all GitHub-related data
   */
  async unlinkProject(projectId: string): Promise<{ success: boolean; message: string }> {
    const response = await api.post(`/github/projects/${projectId}/unlink`);
    return response.data;
  },
};

export default githubApi;
