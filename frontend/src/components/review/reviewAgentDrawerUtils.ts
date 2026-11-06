import type { ReviewAgentAction, ReviewAgentAttachment, ReviewAgentScope } from '@/services/reviewAgentApi';
import type { ReviewAgentMessage } from '@/services/reviewAgentApi';

export type ReviewAgentLocalMessage = ReviewAgentMessage & {
  isStreaming?: boolean;
};

export function makeReviewAgentLocalMessage(
  role: 'user' | 'assistant' | 'system',
  content: string,
  extra: Partial<ReviewAgentLocalMessage> = {}
): ReviewAgentLocalMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: extra.sessionId || '',
    role,
    content,
    tokensUsed: 0,
    model: null,
    meta: null,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

export function getReviewAgentAttachmentLabel(attachment: ReviewAgentAttachment): string {
  if (attachment.type === 'finding') return `Finding ${attachment.recommendationKey.slice(0, 32)}`;
  if (attachment.type === 'line_range') return `${attachment.path}:${attachment.startLine}-${attachment.endLine}`;
  if (attachment.type === 'github_thread') return `GitHub thread ${attachment.threadNodeId.slice(0, 32)}`;
  if (attachment.type === 'github_issue_comment') return `GitHub comment ${attachment.commentNodeId.slice(0, 32)}`;
  return attachment.path;
}

export function isSameReviewAgentScope(left: ReviewAgentScope | null, right: ReviewAgentScope | null): boolean {
  return Boolean(
    left
    && right
    && left.projectId === right.projectId
    && left.reviewType === right.reviewType
    && left.reviewId === right.reviewId
  );
}

function stableReviewAgentHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function getReviewAgentActionKey(action: ReviewAgentAction, index = 0): string {
  const hash = stableReviewAgentHash(JSON.stringify(action));
  if (action.type === 'draft_pr_reply') {
    return `${index}:draft_pr_reply:${hash}`;
  }
  if (action.type === 'fix_findings') {
    return `${index}:fix_findings:${hash}`;
  }
  if (action.type === 'run_review') {
    return `${index}:run_review:${hash}`;
  }
  if (action.type === 'set_outcome') {
    return `${index}:set_outcome:${hash}`;
  }
  if (action.type === 'publish_pr_review') {
    return `${index}:publish_pr_review:${hash}`;
  }
  return `${index}:unknown`;
}
