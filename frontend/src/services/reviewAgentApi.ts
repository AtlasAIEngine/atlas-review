import { api } from '@/services/api';

export type ReviewAgentReviewType = 'changeset' | 'branch_review' | 'workspace_review' | 'pr_review';

export interface ReviewAgentScope {
  projectId: string;
  reviewType: ReviewAgentReviewType;
  reviewId: string;
}

export interface ReviewAgentOpenOptions {
  prompt?: string;
}

export type ReviewAgentAttachment =
  | { type: 'finding'; recommendationKey: string; findingId?: string }
  | { type: 'file'; path: string }
  | { type: 'line_range'; path: string; startLine: number; endLine: number; side?: 'LEFT' | 'RIGHT'; selectedText?: string }
  | { type: 'github_thread'; threadNodeId: string }
  | { type: 'github_issue_comment'; commentNodeId: string };

export type ReviewAgentAction =
  | { type: 'draft_pr_reply'; threadNodeId: string; body: string }
  | { type: 'fix_findings'; recommendationKeys: string[] }
  | { type: 'run_review'; mode?: 'standard' | 'full' }
  | { type: 'set_outcome'; recommendationKey: string; status: 'addressed' | 'dismissed'; note?: string }
  | {
      type: 'publish_pr_review';
      action: 'comment' | 'approve' | 'request_changes';
      body?: string;
      recommendationKeys?: string[];
    };

export interface ReviewAgentActionResult {
  status: 'opened' | 'posted' | 'applied' | 'failed';
  label: string;
  detail?: string;
  at: string;
}

export interface ReviewAgentSession {
  id: string;
  projectId: string;
  userId: string | null;
  reviewType: ReviewAgentReviewType;
  reviewId: string;
  providerType: string | null;
  providerModel: string | null;
  providerSessionId: string | null;
  title: string | null;
  status: 'active' | 'deleted';
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReviewAgentMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tokensUsed: number;
  model: string | null;
  meta: (Record<string, unknown> & {
    actions?: ReviewAgentAction[];
    actionResults?: Record<string, ReviewAgentActionResult>;
  }) | null;
  createdAt: string | null;
}

function scopeParams(scope: Omit<ReviewAgentScope, 'projectId'>) {
  return {
    reviewType: scope.reviewType,
    reviewId: scope.reviewId,
  };
}

export const reviewAgentApi = {
  listSessions: async (scope: ReviewAgentScope) => {
    const response = await api.get<{ success: boolean; sessions: ReviewAgentSession[] }>(
      `/projects/${scope.projectId}/review-agent/sessions`,
      { params: scopeParams(scope) }
    );
    return response.data;
  },

  createSession: async (
    scope: ReviewAgentScope,
    payload: { providerType?: string | null; providerModel?: string | null; title?: string | null } = {}
  ) => {
    const response = await api.post<{ success: boolean; session: ReviewAgentSession }>(
      `/projects/${scope.projectId}/review-agent/sessions`,
      {
        ...scopeParams(scope),
        ...payload,
      }
    );
    return response.data;
  },

  getMessages: async (scope: ReviewAgentScope, sessionId: string) => {
    const response = await api.get<{ success: boolean; messages: ReviewAgentMessage[] }>(
      `/projects/${scope.projectId}/review-agent/sessions/${sessionId}/messages`,
      { params: scopeParams(scope) }
    );
    return response.data;
  },

  deleteSession: async (scope: ReviewAgentScope, sessionId: string) => {
    const response = await api.delete<{ success: boolean; deleted: boolean }>(
      `/projects/${scope.projectId}/review-agent/sessions/${sessionId}`,
      { params: scopeParams(scope) }
    );
    return response.data;
  },

  recordActionResult: async (
    scope: ReviewAgentScope,
    sessionId: string,
    messageId: string,
    actionKey: string,
    result: ReviewAgentActionResult
  ) => {
    const response = await api.patch<{ success: boolean; message: ReviewAgentMessage }>(
      `/projects/${scope.projectId}/review-agent/sessions/${sessionId}/messages/${messageId}/action-results`,
      {
        ...scopeParams(scope),
        actionKey,
        result,
      }
    );
    return response.data;
  },
};
