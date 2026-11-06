import fs from 'fs/promises';
import path from 'path';
import { getProjectById } from '../../db/queries.js';
import branchReviewService from '../branchReviewService.js';
import prReviewService from '../prReviewService.js';
import workspaceReviewService from '../workspaceReviewService.js';
import changesetService from '../changesetService.js';
import reviewOutcomeService from '../reviewOutcomeService.js';
import prReviewConversationService from '../prReviewConversationService.js';

const VALID_ATTACHMENT_TYPES = new Set(['finding', 'file', 'line_range', 'github_thread', 'github_issue_comment']);
const MAX_ATTACHMENTS = 8;
const MAX_FILE_CONTEXT_BYTES = 32 * 1024;
const MAX_GITHUB_COMMENTS_PER_THREAD = 8;
const MAX_GITHUB_COMMENT_BODY_CHARS = 4000;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeReviewType(value) {
  const reviewType = normalizeText(value).toLowerCase();
  if (['changeset', 'branch_review', 'workspace_review', 'pr_review'].includes(reviewType)) {
    return reviewType;
  }
  throw new Error('reviewType must be one of: changeset, branch_review, workspace_review, pr_review');
}

function normalizeScope(rawScope = {}) {
  const projectId = normalizeText(rawScope.projectId);
  const reviewType = normalizeReviewType(rawScope.reviewType);
  const reviewId = normalizeText(rawScope.reviewId);
  if (!projectId) throw new Error('projectId is required');
  if (!reviewId) throw new Error('reviewId is required');
  return { projectId, reviewType, reviewId };
}

function normalizePathValue(value) {
  const normalized = normalizeText(value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..')) return '';
  return normalized;
}

function normalizeAttachments(rawAttachments = []) {
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments
    .slice(0, MAX_ATTACHMENTS)
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return null;
      const type = normalizeText(attachment.type).toLowerCase();
      if (!VALID_ATTACHMENT_TYPES.has(type)) return null;
      if (type === 'finding') {
        const recommendationKey = normalizeText(attachment.recommendationKey).toLowerCase();
        const findingId = normalizeFindingId(attachment.findingId);
        return recommendationKey ? { type, recommendationKey, ...(findingId ? { findingId } : {}) } : null;
      }
      if (type === 'file') {
        const filePath = normalizePathValue(attachment.path);
        return filePath ? { type, path: filePath } : null;
      }
      if (type === 'github_thread') {
        const threadNodeId = normalizeText(attachment.threadNodeId);
        return threadNodeId ? { type, threadNodeId } : null;
      }
      if (type === 'github_issue_comment') {
        const commentNodeId = normalizeText(attachment.commentNodeId);
        return commentNodeId ? { type, commentNodeId } : null;
      }
      const filePath = normalizePathValue(attachment.path);
      const startLine = Math.max(1, Math.trunc(Number(attachment.startLine) || 1));
      const endLine = Math.max(startLine, Math.trunc(Number(attachment.endLine) || startLine));
      const side = normalizeText(attachment.side).toUpperCase();
      const selectedText = truncateText(attachment.selectedText || '', 8000);
      return filePath ? {
        type,
        path: filePath,
        startLine,
        endLine,
        side: side === 'LEFT' || side === 'RIGHT' ? side : undefined,
        ...(selectedText ? { selectedText } : {}),
      } : null;
    })
    .filter(Boolean);
}

function normalizeRecommendationKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeFindingId(value) {
  const normalized = normalizeText(value).toUpperCase();
  return /^F[1-9]\d*$/.test(normalized) ? normalized : '';
}

function getReviewJson(review) {
  if (!review || typeof review !== 'object') return null;
  if (review.reviewJson && typeof review.reviewJson === 'object') return review.reviewJson;
  if (review.reviewData && typeof review.reviewData === 'object') return review.reviewData;
  return null;
}

function getReviewRecommendations(reviewJson) {
  if (!reviewJson) return [];
  return [
    ...(Array.isArray(reviewJson.recommendations) ? reviewJson.recommendations : []),
    ...(Array.isArray(reviewJson.previousFindings) ? reviewJson.previousFindings : []),
  ].filter((rec) => rec && typeof rec === 'object' && rec.type !== 'praise');
}

function getRecommendationKey(rec) {
  try {
    return reviewOutcomeService.getRecommendationIdentityKey(rec);
  } catch {
    return normalizeRecommendationKey(rec?.recommendationKey);
  }
}

function buildFindingRefs(reviewJson) {
  const used = new Set();
  return getReviewRecommendations(reviewJson).map((rec, index) => {
    const existing = normalizeFindingId(rec.findingId);
    let findingId = existing;
    if (!findingId || used.has(findingId)) {
      let nextIndex = index + 1;
      while (used.has(`F${nextIndex}`)) nextIndex += 1;
      findingId = `F${nextIndex}`;
    }
    used.add(findingId);
    return {
      findingId,
      recommendationKey: getRecommendationKey(rec),
      title: rec.title || '(untitled)',
      severity: rec.severity || 'unknown',
      file: rec.file || rec.sourceAnchor?.file || null,
      line: rec.line || rec.sourceAnchor?.line || null,
    };
  }).filter((entry) => entry.recommendationKey);
}

function findRecommendation(reviewJson, recommendationKey) {
  const normalizedKey = normalizeRecommendationKey(recommendationKey);
  if (!normalizedKey || !reviewJson) return null;
  const allRecommendations = getReviewRecommendations(reviewJson);
  return allRecommendations.find((rec) => (
    normalizeRecommendationKey(getRecommendationKey(rec)) === normalizedKey
  )) || null;
}

function truncateText(value, maxChars = MAX_GITHUB_COMMENT_BODY_CHARS) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n[truncated]`;
}

function compactGitHubComment(comment) {
  if (!comment) return null;
  return {
    id: comment.id || comment.nodeId || null,
    nodeId: comment.nodeId || comment.id || null,
    authorLogin: comment.authorLogin || null,
    body: truncateText(comment.bodyText || comment.body || ''),
    path: comment.path || null,
    line: comment.line ?? null,
    startLine: comment.startLine ?? null,
    side: comment.side || null,
    diffHunk: truncateText(comment.diffHunk || '', 1600) || null,
    createdAt: comment.createdAt || null,
    updatedAt: comment.updatedAt || null,
    htmlUrl: comment.htmlUrl || null,
  };
}

function compactGitHubThread(thread) {
  if (!thread) return null;
  const comments = Array.isArray(thread.comments) ? thread.comments : [];
  return {
    id: thread.id || thread.nodeId || null,
    nodeId: thread.nodeId || thread.id || null,
    isResolved: Boolean(thread.isResolved),
    isOutdated: Boolean(thread.isOutdated),
    resolvedByLogin: thread.resolvedByLogin || null,
    path: thread.path || null,
    line: thread.line ?? null,
    startLine: thread.startLine ?? null,
    side: thread.side || null,
    commentCount: thread.commentCount ?? comments.length,
    comments: comments.slice(0, MAX_GITHUB_COMMENTS_PER_THREAD).map(compactGitHubComment).filter(Boolean),
    commentsTruncated: comments.length > MAX_GITHUB_COMMENTS_PER_THREAD,
  };
}

async function loadAttachedGitHubConversation(scope, project, attachment) {
  if (scope.reviewType !== 'pr_review') {
    return { unavailableReason: 'GitHub conversation attachments are only available for PR reviews.' };
  }

  const conversations = await prReviewConversationService.listConversations(scope.projectId, scope.reviewId, {
    userId: project.user_id || null,
  });

  if (attachment.type === 'github_thread') {
    const thread = (conversations.threads || []).find((candidate) => (
      candidate.nodeId === attachment.threadNodeId || candidate.id === attachment.threadNodeId
    ));
    return {
      thread: compactGitHubThread(thread),
      summary: conversations.summary || null,
      unavailableReason: thread ? null : 'GitHub review thread was not found in the persisted conversation snapshot.',
    };
  }

  const issueComment = (conversations.issueComments || []).find((candidate) => (
    candidate.nodeId === attachment.commentNodeId || candidate.id === attachment.commentNodeId
  ));
  return {
    issueComment: compactGitHubComment(issueComment),
    summary: conversations.summary || null,
    unavailableReason: issueComment ? null : 'GitHub PR comment was not found in the persisted conversation snapshot.',
  };
}

function compactReviewSummary(review, reviewType) {
  const reviewJson = getReviewJson(review);
  const actionable = getReviewRecommendations(reviewJson);
  return {
    reviewType,
    reviewId: review?.id || null,
    displayId: review?.displayId || null,
    status: review?.reviewStatus || review?.status || null,
    riskLevel: review?.reviewRiskLevel || reviewJson?.riskLevel || null,
    summary: review?.reviewSummary || reviewJson?.summary || null,
    findingCount: actionable.length,
    highCount: actionable.filter((rec) => rec?.severity === 'high' || rec?.severity === 'critical').length,
    fileCount: review?.fileCount || reviewJson?.stats?.filesAnalyzed || null,
    headSha: review?.reviewHeadSha || review?.headSha || null,
    baseSha: review?.baseSha || review?.mergeBaseSha || review?.reviewMergeBaseSha || null,
    branchName: review?.branchName || review?.headBranch || null,
    baseBranch: review?.baseBranch || null,
    title: review?.title || null,
  };
}

async function readLocalFileSnippet(projectPath, relativePath) {
  if (!projectPath || !relativePath) return null;
  const fullPath = path.resolve(projectPath, relativePath);
  const rootPath = path.resolve(projectPath);
  if (fullPath !== rootPath && !fullPath.startsWith(`${rootPath}${path.sep}`)) {
    return null;
  }

  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return null;
    const file = await fs.open(fullPath, 'r');
    try {
      const length = Math.min(stat.size, MAX_FILE_CONTEXT_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, 0);
      return {
        path: relativePath,
        bytesRead: length,
        truncated: stat.size > length,
        content: buffer.toString('utf8'),
      };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function loadReview(project, scope) {
  if (scope.reviewType === 'branch_review') {
    const review = await branchReviewService.getById(scope.reviewId);
    if (!review || review.projectId !== scope.projectId) return null;
    return review;
  }

  if (scope.reviewType === 'pr_review') {
    const review = await prReviewService.getById(scope.reviewId);
    if (!review || review.projectId !== scope.projectId) return null;
    return review;
  }

  if (scope.reviewType === 'workspace_review') {
    if (!project.path) return null;
    return workspaceReviewService.getById(project.path, scope.reviewId, { includeContent: false });
  }

  if (!project.path) return null;
  const changeset = await changesetService.getChangeSet(project.path, scope.reviewId);
  if (!changeset) return null;
  return {
    ...changeset,
    reviewJson: changeset.reviewData || changeset.review || null,
    reviewStatus: changeset.reviewStatus || (changeset.reviewData ? 'reviewed' : 'none'),
    reviewSummary: changeset.reviewSummary || changeset.reviewData?.summary || null,
    reviewRiskLevel: changeset.reviewRiskLevel || changeset.reviewData?.riskLevel || null,
  };
}

async function hydrateContext(rawInput = {}) {
  const scope = normalizeScope(rawInput);
  const attachments = normalizeAttachments(rawInput.attachments);
  const project = await getProjectById(scope.projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const review = await loadReview(project, scope);
  if (!review) {
    throw new Error('Review not found');
  }

  const reviewJson = getReviewJson(review);
  const findingRefs = buildFindingRefs(reviewJson);
  const findingKeys = attachments
    .filter((attachment) => attachment.type === 'finding')
    .map((attachment) => attachment.recommendationKey);
  const outcomeState = findingKeys.length > 0
    ? await reviewOutcomeService.listOutcomes(scope, {
      recommendationKeys: findingKeys,
      reviewRecommendations: Array.isArray(reviewJson?.recommendations) ? reviewJson.recommendations : [],
    }).catch(() => null)
    : null;

  const hydratedAttachments = [];
  for (const attachment of attachments) {
    if (attachment.type === 'finding') {
      hydratedAttachments.push({
        ...attachment,
        finding: findRecommendation(reviewJson, attachment.recommendationKey),
        outcome: outcomeState?.byRecommendationKey?.[attachment.recommendationKey] || null,
      });
      continue;
    }

    if (attachment.type === 'github_thread' || attachment.type === 'github_issue_comment') {
      const conversationContext = await loadAttachedGitHubConversation(scope, project, attachment).catch((error) => ({
        unavailableReason: error?.message || 'GitHub conversation context was unavailable.',
      }));
      hydratedAttachments.push({
        ...attachment,
        conversation: conversationContext,
      });
      continue;
    }

    const snippet = await readLocalFileSnippet(project.path, attachment.path);
    hydratedAttachments.push({
      ...attachment,
      file: snippet,
    });
  }

  return {
    scope,
    project: {
      id: project.id,
      name: project.name || null,
      path: project.path || null,
      github: {
        owner: project.github_repo_owner || null,
        repo: project.github_repo_name || null,
      },
    },
    review: compactReviewSummary(review, scope.reviewType),
    findingRefs,
    attachments: hydratedAttachments,
    safeActions: {
      readOnly: true,
      canProposeFixIssues: true,
      canPublishGithub: false,
      canSetOutcomes: false,
    },
  };
}

function formatReviewAgentContext(context) {
  const lines = [
    'Atlas review context:',
    `Project: ${context.project.name || context.project.id}`,
    `Scope: ${context.scope.reviewType} ${context.scope.reviewId}`,
    `Review status: ${context.review.status || 'unknown'}`,
    `Risk: ${context.review.riskLevel || 'unknown'}`,
    `Summary: ${context.review.summary || 'No review summary is available.'}`,
    `Findings: ${context.review.findingCount} actionable, ${context.review.highCount} high/critical`,
  ];

  if (context.review.title) lines.push(`PR title: ${context.review.title}`);
  if (context.review.branchName) lines.push(`Branch/head: ${context.review.branchName}`);
  if (context.review.baseBranch) lines.push(`Base branch: ${context.review.baseBranch}`);
  if (Array.isArray(context.findingRefs) && context.findingRefs.length > 0) {
    lines.push('Finding ID map:');
    for (const finding of context.findingRefs.slice(0, 20)) {
      const location = finding.file ? ` @ ${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';
      lines.push(`- ${finding.findingId}: ${finding.severity} - ${finding.title}${location}`);
      lines.push(`  recommendationKey: ${finding.recommendationKey}`);
    }
    if (context.findingRefs.length > 20) {
      lines.push(`- ${context.findingRefs.length - 20} additional findings omitted from the compact map.`);
    }
  }

  for (const attachment of context.attachments || []) {
    lines.push('');
    if (attachment.type === 'finding') {
      const finding = attachment.finding;
      const findingId = attachment.findingId || context.findingRefs?.find((entry) => entry.recommendationKey === attachment.recommendationKey)?.findingId;
      lines.push(`Attached finding: ${findingId ? `${findingId} ` : ''}${attachment.recommendationKey}`);
      if (!finding) {
        lines.push('Finding details were not found in the persisted review payload.');
        continue;
      }
      lines.push(`Title: ${finding.title || '(untitled)'}`);
      lines.push(`Severity: ${finding.severity || 'unknown'}`);
      lines.push(`Location: ${finding.file || finding.sourceAnchor?.file || 'unanchored'}${finding.line || finding.sourceAnchor?.line ? `:${finding.line || finding.sourceAnchor?.line}` : ''}`);
      lines.push(`Description: ${finding.description || 'No description provided.'}`);
      if (finding.sourceAnchor?.snippet || finding.targetSnippet || finding.evidenceSnippet) {
        lines.push('Snippet:');
        lines.push('```');
        lines.push(finding.sourceAnchor?.snippet || finding.targetSnippet || finding.evidenceSnippet);
        lines.push('```');
      }
      if (finding.suggestedFix) {
        lines.push('Suggested fix:');
        lines.push(finding.suggestedFix);
      }
      if (attachment.outcome) {
        lines.push(`Current reviewer outcome: ${attachment.outcome.status}${attachment.outcome.note ? ` (${attachment.outcome.note})` : ''}`);
      }
      continue;
    }

    if (attachment.type === 'github_thread') {
      const thread = attachment.conversation?.thread;
      lines.push(`Attached GitHub review thread: ${attachment.threadNodeId}`);
      if (!thread) {
        lines.push(attachment.conversation?.unavailableReason || 'Thread details were unavailable.');
        continue;
      }
      lines.push(`Status: ${thread.isResolved ? 'resolved' : 'open'}${thread.isOutdated ? ', outdated' : ''}`);
      lines.push(`Location: ${thread.path || 'general'}${thread.line ? `:${thread.line}` : ''}${thread.side ? ` (${thread.side})` : ''}`);
      lines.push(`Comments: ${thread.commentCount}`);
      for (const comment of thread.comments || []) {
        lines.push('');
        lines.push(`Comment by ${comment.authorLogin || 'github'}${comment.updatedAt || comment.createdAt ? ` at ${comment.updatedAt || comment.createdAt}` : ''}:`);
        if (comment.diffHunk) {
          lines.push('Diff hunk:');
          lines.push('```diff');
          lines.push(comment.diffHunk);
          lines.push('```');
        }
        lines.push(comment.body || '(empty comment body)');
      }
      if (thread.commentsTruncated) {
        lines.push('');
        lines.push('Additional thread comments were omitted from this compact context.');
      }
      continue;
    }

    if (attachment.type === 'github_issue_comment') {
      const comment = attachment.conversation?.issueComment;
      lines.push(`Attached GitHub PR comment: ${attachment.commentNodeId}`);
      if (!comment) {
        lines.push(attachment.conversation?.unavailableReason || 'PR comment details were unavailable.');
        continue;
      }
      lines.push(`Comment by ${comment.authorLogin || 'github'}${comment.updatedAt || comment.createdAt ? ` at ${comment.updatedAt || comment.createdAt}` : ''}:`);
      lines.push(comment.body || '(empty comment body)');
      continue;
    }

    lines.push(attachment.type === 'line_range'
      ? `Attached line range: ${attachment.path}:${attachment.startLine}-${attachment.endLine}`
      : `Attached file: ${attachment.path}`);
    if (attachment.type === 'line_range' && attachment.selectedText) {
      lines.push('Selected code:');
      lines.push('```');
      lines.push(attachment.selectedText);
      lines.push('```');
    }
    if (attachment.file?.content) {
      lines.push(attachment.file.truncated
        ? `File content (first ${attachment.file.bytesRead} bytes, truncated):`
        : 'File content:');
      lines.push('```');
      lines.push(attachment.file.content);
      lines.push('```');
    } else {
      lines.push('Local file content was unavailable; use read-only file tools if more context is needed.');
    }
  }

  lines.push('');
  lines.push('Action affordances: read-only answers are allowed. Fixes must be routed through Atlas Fix Issues. GitHub publishing and outcome changes require explicit user confirmation outside this assistant response.');

  return lines.join('\n');
}

export default {
  hydrateContext,
  formatReviewAgentContext,
  __testing: {
    normalizeAttachments,
    normalizeScope,
    normalizeFindingId,
    findRecommendation,
    buildFindingRefs,
    compactReviewSummary,
    compactGitHubThread,
    compactGitHubComment,
  },
};
