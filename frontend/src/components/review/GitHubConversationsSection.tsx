import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import type {
  GitHubPrConversations,
  GitHubPrIssueComment,
  GitHubPrReviewThread,
  GitHubPrThreadComment,
} from '@/types';
import type { ReviewAgentAttachment, ReviewAgentOpenOptions } from '@/services/reviewAgentApi';
import {
  GitHubConversationAvatar,
  GitHubConversationMarkdown,
  formatGitHubConversationExactTime,
  formatGitHubConversationTime,
  getGitHubConversationDiffTarget,
} from './GitHubConversation';
import { CollapsibleSection } from './ReviewWidgets';

function getGitHubConversationPreview(body: string | null | undefined): string {
  return String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#>*_\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeGitHubReviewState(value: string | null | undefined): string {
  return String(value || '').trim().toUpperCase();
}

function getGitHubReviewStatusDisplay(sync: GitHubPrConversations['sync'] | null | undefined) {
  const decision = normalizeGitHubReviewState(sync?.reviewDecision);
  const latestState = normalizeGitHubReviewState(sync?.latestReviewState);
  const stateCounts = sync?.reviewStateCounts || {};
  const approvedCount = Number(stateCounts.APPROVED || 0);
  const changesRequestedCount = Number(stateCounts.CHANGES_REQUESTED || 0);
  const commentedCount = Number(stateCounts.COMMENTED || 0);

  if (decision === 'APPROVED') {
    return { label: 'Approved', tone: 'ok' as const };
  }
  if (decision === 'CHANGES_REQUESTED') {
    return { label: 'Changes requested', tone: 'danger' as const };
  }
  if (decision === 'REVIEW_REQUIRED') {
    return { label: 'Review required', tone: 'warn' as const };
  }
  if (latestState === 'APPROVED') {
    return { label: 'Approved', tone: 'ok' as const };
  }
  if (latestState === 'CHANGES_REQUESTED') {
    return { label: 'Changes requested', tone: 'danger' as const };
  }
  if (latestState === 'COMMENTED' || commentedCount > 0) {
    return { label: 'Commented', tone: 'info' as const };
  }
  if (approvedCount > 0) {
    return { label: 'Approved', tone: 'ok' as const };
  }
  if (changesRequestedCount > 0) {
    return { label: 'Changes requested', tone: 'danger' as const };
  }
  return null;
}

function GitHubReviewStatusSummary({ sync }: { sync: GitHubPrConversations['sync'] | null | undefined }) {
  const display = getGitHubReviewStatusDisplay(sync);
  const stateCounts = sync?.reviewStateCounts || {};
  const approvedCount = Number(stateCounts.APPROVED || 0);
  const changesRequestedCount = Number(stateCounts.CHANGES_REQUESTED || 0);
  const commentedCount = Number(stateCounts.COMMENTED || 0);
  const mergeState = normalizeGitHubReviewState(sync?.mergeStateStatus).replace(/_/g, ' ').toLowerCase();
  const toneColor = display?.tone === 'ok'
    ? 'var(--sev-ok)'
    : display?.tone === 'danger'
      ? 'var(--sev-high)'
      : display?.tone === 'warn'
        ? 'var(--sev-med)'
        : 'var(--accent-blue)';

  if (!display && !sync?.latestReviewAuthor && !mergeState) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
      padding: '7px 8px',
      border: '1px solid var(--review-shell-divider)',
      borderRadius: 4,
      background: 'var(--review-panel-alt-bg)',
      fontSize: 10.5,
      color: 'var(--text-tertiary)',
    }}>
      {display && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          color: toneColor,
          fontWeight: 700,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: toneColor }} />
          {display.label}
        </span>
      )}
      {approvedCount > 0 && <span>{approvedCount} approved</span>}
      {changesRequestedCount > 0 && <span>{changesRequestedCount} requested changes</span>}
      {commentedCount > 0 && <span>{commentedCount} commented</span>}
      {sync?.latestReviewAuthor && sync.latestReviewState && (
        <span title={formatGitHubConversationExactTime(sync.latestReviewSubmittedAt)}>
          Latest: {sync.latestReviewState.toLowerCase().replace(/_/g, ' ')} by {sync.latestReviewAuthor}
        </span>
      )}
      {mergeState && <span>Merge: {mergeState}</span>}
    </div>
  );
}

export function GitHubConversationComment({
  comment,
  isReply,
  isBusy = false,
  prAuthorLogin,
  onOpen,
  onUpdate,
  onDelete,
  onConfirmDelete,
}: {
  comment: GitHubPrThreadComment | GitHubPrIssueComment;
  isReply?: boolean;
  isBusy?: boolean;
  prAuthorLogin?: string | null;
  onOpen?: () => void;
  onUpdate?: (comment: GitHubPrThreadComment | GitHubPrIssueComment, body: string) => Promise<void>;
  onDelete?: (comment: GitHubPrThreadComment | GitHubPrIssueComment) => Promise<void>;
  onConfirmDelete?: (comment: GitHubPrThreadComment | GitHubPrIssueComment) => Promise<boolean>;
}) {
  const commentAuthorLogin = String(comment.authorLogin || '').trim();
  const isPrAuthor = Boolean(
    commentAuthorLogin
    && String(prAuthorLogin || '').trim().toLowerCase() === commentAuthorLogin.toLowerCase()
  );
  const canEdit = comment.canEdit === true && Boolean(onUpdate);
  const canDelete = comment.canDelete === true && Boolean(onDelete);
  const [isEditing, setIsEditing] = useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [editDraft, setEditDraft] = useState(comment.body || comment.bodyText || '');
  const [localError, setLocalError] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const normalizedEditDraft = editDraft.trim();
  const stopRowEvent = (event: SyntheticEvent) => {
    event.stopPropagation();
  };
  useEffect(() => {
    if (!isActionMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && actionMenuRef.current?.contains(target)) return;
      setIsActionMenuOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isActionMenuOpen]);
  const submitEdit = async () => {
    if (!canEdit || !normalizedEditDraft || isBusy) return;
    setLocalError(null);
    try {
      await onUpdate?.(comment, normalizedEditDraft);
      setIsEditing(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to update GitHub comment');
    }
  };
  const deleteComment = async () => {
    if (!canDelete || isBusy) return;
    setIsActionMenuOpen(false);
    const confirmed = onConfirmDelete
      ? await onConfirmDelete(comment)
      : true;
    if (!confirmed) return;
    setLocalError(null);
    try {
      await onDelete?.(comment);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to delete GitHub comment');
    }
  };

  return (
    <div
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? (event) => {
        event.stopPropagation();
        onOpen();
      } : undefined}
      onKeyDown={onOpen ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }
      } : undefined}
      title={onOpen ? 'Open this comment in the diff' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr)',
        gap: 8,
        paddingLeft: isReply ? 16 : 0,
        borderLeft: isReply ? '2px solid var(--border-default)' : '2px solid transparent',
        cursor: onOpen ? 'pointer' : undefined,
      }}
    >
      <GitHubConversationAvatar
        avatarUrl={comment.authorAvatarUrl}
        login={comment.authorLogin}
      />
      <div style={{ minWidth: 0, display: 'grid', gap: 4, position: 'relative' }}>
        {!isEditing && (canEdit || canDelete) && (
          <div
            ref={actionMenuRef}
            onClick={stopRowEvent}
            onKeyDown={stopRowEvent}
            style={{ position: 'absolute', top: -2, right: 0, zIndex: 2 }}
          >
            <button
              type="button"
              aria-label="Comment actions"
              aria-expanded={isActionMenuOpen}
              onClick={() => setIsActionMenuOpen((prev) => !prev)}
              disabled={isBusy}
              style={{
                width: 24,
                height: 22,
                display: 'inline-grid',
                placeItems: 'center',
                color: isBusy ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                background: isActionMenuOpen ? 'var(--bg-hover)' : 'transparent',
                border: '1px solid transparent',
                borderRadius: 4,
                cursor: isBusy ? 'default' : 'pointer',
                padding: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="4" cy="8" r="1.4" />
                <circle cx="8" cy="8" r="1.4" />
                <circle cx="12" cy="8" r="1.4" />
              </svg>
            </button>
            {isActionMenuOpen && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 24,
                  right: 0,
                  minWidth: 108,
                  padding: 4,
                  border: '1px solid var(--border-default)',
                  borderRadius: 6,
                  background: 'var(--review-panel-bg)',
                  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.32)',
                  display: 'grid',
                  gap: 2,
                }}
              >
                {canEdit && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setLocalError(null);
                      setEditDraft(comment.body || comment.bodyText || '');
                      setIsEditing(true);
                      setIsActionMenuOpen(false);
                    }}
                    style={{
                      textAlign: 'left',
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: 4,
                      padding: '6px 8px',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    Edit
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      void deleteComment();
                    }}
                    style={{
                      textAlign: 'left',
                      fontSize: 11,
                      color: 'var(--accent-red)',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: 4,
                      padding: '6px 8px',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-tertiary)', paddingRight: (!isEditing && (canEdit || canDelete)) ? 30 : 0 }}>
          <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>
            {commentAuthorLogin || 'github'}
          </span>
          {isReply && <span>reply</span>}
          <span title={formatGitHubConversationExactTime(comment.updatedAt || comment.createdAt)}>
            {formatGitHubConversationTime(comment.updatedAt || comment.createdAt)}
          </span>
          {isPrAuthor && (
            <span style={{
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-default)',
              borderRadius: 8,
              padding: '0 5px',
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '16px',
            }}>
              Author
            </span>
          )}
        </div>
        {isEditing ? (
          <div
            onClick={stopRowEvent}
            onKeyDown={stopRowEvent}
            style={{ display: 'grid', gap: 6 }}
          >
            <textarea
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value)}
              rows={3}
              disabled={isBusy}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                resize: 'vertical',
                minHeight: 70,
                borderRadius: 4,
                border: '1px solid var(--border-default)',
                background: 'var(--review-code-bg)',
                color: 'var(--text-primary)',
                padding: '8px 10px',
                fontSize: 12,
                lineHeight: 1.45,
                fontFamily: 'var(--font-sans)',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => {
                  void submitEdit();
                }}
                disabled={isBusy || !normalizedEditDraft}
                style={{
                  fontSize: 10,
                  color: isBusy || !normalizedEditDraft ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                  background: 'transparent',
                  border: '1px solid var(--border-default)',
                  borderRadius: 3,
                  padding: '2px 7px',
                  cursor: isBusy || !normalizedEditDraft ? 'default' : 'pointer',
                }}
              >
                {isBusy ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setLocalError(null);
                  setEditDraft(comment.body || comment.bodyText || '');
                  setIsEditing(false);
                }}
                disabled={isBusy}
                style={{
                  fontSize: 10,
                  color: 'var(--text-secondary)',
                  background: 'transparent',
                  border: '1px solid var(--border-default)',
                  borderRadius: 3,
                  padding: '2px 7px',
                  cursor: isBusy ? 'default' : 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <GitHubConversationMarkdown body={comment.body || comment.bodyText} />
        )}
        {localError && (
          <div style={{ fontSize: 10.5, color: 'var(--accent-red)', lineHeight: 1.4 }}>
            {localError}
          </div>
        )}
      </div>
    </div>
  );
}

function GitHubConversationThreadRow({
  thread,
  muted = false,
  prAuthorLogin,
  onOpen,
  onAskAgent,
  onReply,
  onSetResolved,
  onUpdateComment,
  onDeleteComment,
  onConfirmDeleteComment,
  busyCommentId,
  isBusy = false,
}: {
  thread: GitHubPrReviewThread;
  muted?: boolean;
  prAuthorLogin?: string | null;
  onOpen?: (thread: GitHubPrReviewThread) => void;
  onAskAgent?: (attachments: ReviewAgentAttachment[], options?: ReviewAgentOpenOptions) => void;
  onReply?: (thread: GitHubPrReviewThread, body: string) => Promise<void>;
  onSetResolved?: (thread: GitHubPrReviewThread, resolved: boolean) => Promise<void>;
  onUpdateComment?: (comment: GitHubPrThreadComment, body: string) => Promise<void>;
  onDeleteComment?: (comment: GitHubPrThreadComment) => Promise<void>;
  onConfirmDeleteComment?: (comment: GitHubPrThreadComment) => Promise<boolean>;
  busyCommentId?: string | null;
  isBusy?: boolean;
}) {
  const [isReplying, setIsReplying] = useState(false);
  const [isResolvedExpanded, setIsResolvedExpanded] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const firstComment = thread.comments[0] || null;
  const lastComment = thread.comments[thread.comments.length - 1] || firstComment;
  const visibleComments = thread.comments.slice(0, 4);
  const hiddenCommentCount = Math.max(0, thread.comments.length - visibleComments.length);
  const isCollapsedResolved = thread.isResolved && !isResolvedExpanded;
  const previewText = useMemo(() => (
    getGitHubConversationPreview(firstComment?.bodyText || firstComment?.body).slice(0, 180)
  ), [firstComment?.body, firstComment?.bodyText]);
  const target = getGitHubConversationDiffTarget(thread);
  const location = target?.path
    ? `${target.path}${target.line ? `:${target.line}` : ''}`
    : 'General review thread';
  const isNavigable = Boolean(target?.path && onOpen);
  const normalizedReplyDraft = replyDraft.trim();
  const stopRowEvent = (event: SyntheticEvent) => {
    event.stopPropagation();
  };
  const toggleResolvedExpanded = (event: SyntheticEvent) => {
    event.stopPropagation();
    setIsResolvedExpanded((prev) => !prev);
  };
  useEffect(() => {
    setIsResolvedExpanded(false);
    setIsReplying(false);
    setReplyDraft('');
    setLocalError(null);
  }, [thread.id, thread.isResolved]);
  const submitReply = async () => {
    if (!onReply || !normalizedReplyDraft || isBusy) return;
    setLocalError(null);
    try {
      await onReply(thread, normalizedReplyDraft);
      setReplyDraft('');
      setIsReplying(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to reply to GitHub conversation');
    }
  };
  const updateResolution = async () => {
    if (!onSetResolved || isBusy) return;
    setLocalError(null);
    try {
      await onSetResolved(thread, !thread.isResolved);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to update GitHub conversation');
    }
  };
  const askAgent = (event: SyntheticEvent) => {
    event.stopPropagation();
    if (!onAskAgent) return;
    const attachments: ReviewAgentAttachment[] = [
      { type: 'github_thread', threadNodeId: thread.nodeId || thread.id },
    ];
    if (target?.path && target.line) {
      attachments.push({
        type: 'line_range',
        path: target.path,
        startLine: target.line,
        endLine: target.line,
        side: target.side,
      });
    }
    onAskAgent(attachments, {
      prompt: 'Can you help me understand this PR review thread and draft a response?',
    });
  };
  return (
    <div
      role={isNavigable ? 'button' : undefined}
      tabIndex={isNavigable ? 0 : undefined}
      onClick={isNavigable ? () => onOpen?.(thread) : undefined}
      onKeyDown={isNavigable ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen?.(thread);
        }
      } : undefined}
      title={isNavigable ? `Open ${location} in diff` : undefined}
      style={{
        border: `1px solid ${muted ? 'var(--border-default)' : 'var(--review-shell-divider)'}`,
        borderRadius: 4,
        padding: '10px 12px',
        background: muted ? 'var(--review-panel-alt-bg)' : 'var(--bg-surface)',
        display: 'grid',
        gap: 6,
        cursor: isNavigable ? 'pointer' : 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {thread.isResolved && (
          <button
            type="button"
            onClick={toggleResolvedExpanded}
            onKeyDown={stopRowEvent}
            title={isResolvedExpanded ? 'Collapse resolved conversation' : 'Expand resolved conversation'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--sev-ok)',
              border: '1px solid var(--sev-ok)',
              borderRadius: 3,
              padding: '1px 5px',
              flexShrink: 0,
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 9, lineHeight: 1 }}>
              {isResolvedExpanded ? 'v' : '>'}
            </span>
            Resolved
          </button>
        )}
        {thread.isOutdated && (
          <span style={{
            fontSize: 10,
            color: 'var(--sev-med)',
            border: '1px solid var(--sev-med)',
            borderRadius: 3,
            padding: '1px 5px',
            flexShrink: 0,
            background: 'color-mix(in oklab, var(--sev-med) 12%, transparent)',
            fontWeight: 700,
          }}>
            Outdated
          </span>
        )}
        <span style={{
          fontSize: 10.5,
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {location}
        </span>
      </div>
      {isCollapsedResolved ? (
        <div style={{
          fontSize: 11,
          color: 'var(--text-secondary)',
          lineHeight: 1.45,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {previewText || 'Resolved conversation'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {visibleComments.length > 0 ? visibleComments.map((comment) => (
            <GitHubConversationComment
              key={comment.id}
              comment={comment}
              isReply={Boolean(comment.replyToNodeId)}
              isBusy={isBusy || busyCommentId === comment.id}
              prAuthorLogin={prAuthorLogin}
              onOpen={isNavigable ? () => onOpen?.(thread) : undefined}
              onUpdate={onUpdateComment ? (targetComment, body) => onUpdateComment(targetComment as GitHubPrThreadComment, body) : undefined}
              onDelete={onDeleteComment ? (targetComment) => onDeleteComment(targetComment as GitHubPrThreadComment) : undefined}
              onConfirmDelete={onConfirmDeleteComment ? (targetComment) => onConfirmDeleteComment(targetComment as GitHubPrThreadComment) : undefined}
            />
          )) : (
            <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' }}>
              No comment body
            </div>
          )}
          {hiddenCommentCount > 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
              +{hiddenCommentCount} more repl{hiddenCommentCount === 1 ? 'y' : 'ies'}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
        <span>{thread.commentCount} comment{thread.commentCount === 1 ? '' : 's'}</span>
        <span title={formatGitHubConversationExactTime(lastComment?.updatedAt || thread.lastCommentAt || thread.syncedAt)}>
          {formatGitHubConversationTime(lastComment?.updatedAt || thread.lastCommentAt || thread.syncedAt)}
        </span>
        {thread.resolvedByLogin && <span>Resolved by {thread.resolvedByLogin}</span>}
      </div>
      {(onAskAgent || onReply || onSetResolved) && !isCollapsedResolved && (
        <div
          onClick={stopRowEvent}
          onKeyDown={stopRowEvent}
          style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
        >
          {onAskAgent && (
            <button
              type="button"
              onClick={askAgent}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: isBusy ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Ask Atlas
            </button>
          )}
          {onReply && (
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                setIsReplying((prev) => !prev);
              }}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: isBusy ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Reply
            </button>
          )}
          {onSetResolved && (
            <button
              type="button"
              onClick={() => {
                void updateResolution();
              }}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: isBusy ? 'var(--text-tertiary)' : (thread.isResolved ? 'var(--text-secondary)' : 'var(--sev-ok)'),
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              {isBusy ? 'Updating...' : thread.isResolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
        </div>
      )}
      {isReplying && (
        <div
          onClick={stopRowEvent}
          onKeyDown={stopRowEvent}
          style={{ display: 'grid', gap: 6 }}
        >
          <textarea
            value={replyDraft}
            onChange={(event) => setReplyDraft(event.target.value)}
            placeholder="Reply on GitHub..."
            rows={3}
            disabled={isBusy}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              minHeight: 70,
              borderRadius: 4,
              border: '1px solid var(--border-default)',
              background: 'var(--review-code-bg)',
              color: 'var(--text-primary)',
              padding: '8px 10px',
              fontSize: 12,
              lineHeight: 1.45,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => {
                void submitReply();
              }}
              disabled={isBusy || !normalizedReplyDraft}
              style={{
                fontSize: 10,
                color: isBusy || !normalizedReplyDraft ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy || !normalizedReplyDraft ? 'default' : 'pointer',
              }}
            >
              {isBusy ? 'Sending...' : 'Send reply'}
            </button>
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                setReplyDraft('');
                setIsReplying(false);
              }}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: 'var(--text-secondary)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {localError && (
        <div style={{ fontSize: 10.5, color: 'var(--accent-red)', lineHeight: 1.4 }}>
          {localError}
        </div>
      )}
    </div>
  );
}

function GitHubIssueCommentRow({
  comment,
  prAuthorLogin,
  onAskAgent,
  onReply,
  onUpdate,
  onDelete,
  onConfirmDelete,
  isBusy = false,
}: {
  comment: GitHubPrIssueComment;
  prAuthorLogin?: string | null;
  onAskAgent?: (attachments: ReviewAgentAttachment[], options?: ReviewAgentOpenOptions) => void;
  onReply?: (body: string) => Promise<void>;
  onUpdate?: (comment: GitHubPrIssueComment, body: string) => Promise<void>;
  onDelete?: (comment: GitHubPrIssueComment) => Promise<void>;
  onConfirmDelete?: (comment: GitHubPrIssueComment) => Promise<boolean>;
  isBusy?: boolean;
}) {
  const [isReplying, setIsReplying] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const normalizedReplyDraft = replyDraft.trim();
  const submitReply = async () => {
    if (!onReply || !normalizedReplyDraft || isBusy) return;
    setLocalError(null);
    try {
      await onReply(normalizedReplyDraft);
      setReplyDraft('');
      setIsReplying(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to reply to PR comment');
    }
  };
  const askAgent = () => {
    if (!onAskAgent) return;
    onAskAgent([{ type: 'github_issue_comment', commentNodeId: comment.nodeId || comment.id }], {
      prompt: 'Can you help me understand this PR comment and draft a response?',
    });
  };

  return (
    <div style={{
      border: '1px solid var(--review-shell-divider)',
      borderRadius: 4,
      padding: '10px 12px',
      background: 'var(--bg-surface)',
      display: 'grid',
      gap: 8,
    }}>
      <GitHubConversationComment
        comment={comment}
        prAuthorLogin={prAuthorLogin}
        isBusy={isBusy}
        onUpdate={onUpdate ? (targetComment, body) => onUpdate(targetComment as GitHubPrIssueComment, body) : undefined}
        onDelete={onDelete ? (targetComment) => onDelete(targetComment as GitHubPrIssueComment) : undefined}
        onConfirmDelete={onConfirmDelete ? (targetComment) => onConfirmDelete(targetComment as GitHubPrIssueComment) : undefined}
      />
      {(onAskAgent || onReply) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {onAskAgent && (
            <button
              type="button"
              onClick={askAgent}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: isBusy ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Ask Atlas
            </button>
          )}
          {onReply && (
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                setIsReplying((prev) => !prev);
              }}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: isBusy ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Reply
            </button>
          )}
        </div>
      )}
      {isReplying && (
        <div style={{ display: 'grid', gap: 6 }}>
          <textarea
            value={replyDraft}
            onChange={(event) => setReplyDraft(event.target.value)}
            placeholder="Reply on GitHub..."
            rows={3}
            disabled={isBusy}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              minHeight: 70,
              borderRadius: 4,
              border: '1px solid var(--border-default)',
              background: 'var(--review-code-bg)',
              color: 'var(--text-primary)',
              padding: '8px 10px',
              fontSize: 12,
              lineHeight: 1.45,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => {
                void submitReply();
              }}
              disabled={isBusy || !normalizedReplyDraft}
              style={{
                fontSize: 10,
                color: isBusy || !normalizedReplyDraft ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy || !normalizedReplyDraft ? 'default' : 'pointer',
              }}
            >
              {isBusy ? 'Sending...' : 'Send reply'}
            </button>
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                setReplyDraft('');
                setIsReplying(false);
              }}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: 'var(--text-secondary)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {localError && (
        <div style={{ fontSize: 10.5, color: 'var(--accent-red)', lineHeight: 1.4 }}>
          {localError}
        </div>
      )}
    </div>
  );
}

export function GitHubConversationsSection({
  conversations,
  isLoading,
  isSyncing,
  error,
  prAuthorLogin,
  onRefresh,
  onOpenThread,
  onAskAgent,
  onReplyThread,
  onSetThreadResolved,
  onUpdateComment,
  onDeleteComment,
  onConfirmDeleteComment,
  onReplyIssueComment,
  onUpdateIssueComment,
  onDeleteIssueComment,
  onConfirmDeleteIssueComment,
  busyThreadId,
  busyCommentId,
  busyIssueCommentId,
}: {
  conversations: GitHubPrConversations | null;
  isLoading: boolean;
  isSyncing: boolean;
  error: string | null;
  prAuthorLogin?: string | null;
  onRefresh: () => void;
  onOpenThread?: (thread: GitHubPrReviewThread) => void;
  onAskAgent?: (attachments: ReviewAgentAttachment[], options?: ReviewAgentOpenOptions) => void;
  onReplyThread?: (thread: GitHubPrReviewThread, body: string) => Promise<void>;
  onSetThreadResolved?: (thread: GitHubPrReviewThread, resolved: boolean) => Promise<void>;
  onUpdateComment?: (comment: GitHubPrThreadComment, body: string) => Promise<void>;
  onDeleteComment?: (comment: GitHubPrThreadComment) => Promise<void>;
  onConfirmDeleteComment?: (comment: GitHubPrThreadComment) => Promise<boolean>;
  onReplyIssueComment?: (body: string) => Promise<void>;
  onUpdateIssueComment?: (comment: GitHubPrIssueComment, body: string) => Promise<void>;
  onDeleteIssueComment?: (comment: GitHubPrIssueComment) => Promise<void>;
  onConfirmDeleteIssueComment?: (comment: GitHubPrIssueComment) => Promise<boolean>;
  busyThreadId?: string | null;
  busyCommentId?: string | null;
  busyIssueCommentId?: string | null;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const [showOutdated, setShowOutdated] = useState(false);
  const summary = conversations?.summary || null;
  const threads = conversations?.threads || [];
  const currentThreads = threads.filter((thread) => !thread.isOutdated);
  const outdatedThreads = threads.filter((thread) => thread.isOutdated);
  const openThreads = currentThreads.filter((thread) => !thread.isResolved);
  const resolvedThreads = currentThreads.filter((thread) => thread.isResolved);
  const openOutdatedThreads = outdatedThreads.filter((thread) => !thread.isResolved);
  const resolvedOutdatedThreads = outdatedThreads.filter((thread) => thread.isResolved);
  const issueComments = conversations?.issueComments || [];
  const shownThreads = [...openThreads, ...resolvedThreads].slice(0, 8);
  const shownOutdatedThreads = showOutdated
    ? [...openOutdatedThreads, ...resolvedOutdatedThreads].slice(0, 8)
    : [];
  const hiddenOutdatedCount = Math.max(0, outdatedThreads.length - shownOutdatedThreads.length);
  const shownIssueComments = issueComments.slice(-4).reverse();
  const hasContent = shownThreads.length > 0 || outdatedThreads.length > 0 || shownIssueComments.length > 0;

  return (
    <CollapsibleSection
      title="GitHub conversations"
      isOpen={isOpen}
      onToggle={() => setIsOpen((prev) => !prev)}
      badge={(summary?.openThreads || 0) + (summary?.issueComments || 0)}
      headerActions={(
        <button
          type="button"
          onClick={onRefresh}
          disabled={isSyncing}
          style={{
            fontSize: 10,
            color: isSyncing ? 'var(--text-tertiary)' : 'var(--accent-blue)',
            background: 'transparent',
            border: '1px solid var(--border-default)',
            borderRadius: 3,
            padding: '2px 7px',
            cursor: isSyncing ? 'default' : 'pointer',
          }}
        >
          {isSyncing ? 'Syncing...' : 'Sync'}
        </button>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
          <span>Open: {summary?.openThreads ?? 0}</span>
          <span>Resolved: {summary?.resolvedThreads ?? 0}</span>
          <span>Outdated: {summary?.outdatedThreads ?? 0}</span>
          <span>PR comments: {summary?.issueComments ?? 0}</span>
          {summary?.syncedAt && (
            <span title={`Synced ${formatGitHubConversationExactTime(summary.syncedAt)}`}>
              Synced {formatGitHubConversationTime(summary.syncedAt)}
            </span>
          )}
        </div>
        {error && (
          <div style={{ fontSize: 10.5, color: 'var(--accent-red)', lineHeight: 1.45 }}>
            {error}
          </div>
        )}
        <GitHubReviewStatusSummary sync={conversations?.sync || null} />
        {isLoading && !hasContent ? (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            Loading GitHub conversations...
          </div>
        ) : hasContent ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {shownThreads.map((thread) => (
              <GitHubConversationThreadRow
                key={thread.id}
                thread={thread}
                prAuthorLogin={prAuthorLogin}
                onOpen={onOpenThread}
                onAskAgent={onAskAgent}
                onReply={onReplyThread}
                onSetResolved={onSetThreadResolved}
                onUpdateComment={onUpdateComment}
                onDeleteComment={onDeleteComment}
                onConfirmDeleteComment={onConfirmDeleteComment}
                isBusy={busyThreadId === thread.id}
                busyCommentId={busyCommentId}
              />
            ))}
            {outdatedThreads.length > 0 && (
              <button
                type="button"
                onClick={() => setShowOutdated((prev) => !prev)}
                aria-expanded={showOutdated}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  width: '100%',
                  minWidth: 0,
                  padding: '7px 9px',
                  borderRadius: 4,
                  border: '1px solid var(--border-default)',
                  background: 'var(--review-panel-alt-bg)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: 10.5,
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span aria-hidden="true" style={{ fontSize: 10, lineHeight: 1 }}>
                    {showOutdated ? 'v' : '>'}
                  </span>
                  <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Outdated conversations
                  </span>
                  <span style={{
                    color: 'var(--sev-med)',
                    border: '1px solid var(--sev-med)',
                    borderRadius: 8,
                    padding: '0 5px',
                    fontSize: 10,
                    fontWeight: 700,
                    lineHeight: '16px',
                    background: 'color-mix(in oklab, var(--sev-med) 10%, transparent)',
                  }}>
                    {outdatedThreads.length}
                  </span>
                </span>
                <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>
                  {showOutdated ? 'Hide' : 'Show'}
                </span>
              </button>
            )}
            {shownOutdatedThreads.map((thread) => (
              <GitHubConversationThreadRow
                key={thread.id}
                thread={thread}
                muted
                prAuthorLogin={prAuthorLogin}
                onOpen={onOpenThread}
                onAskAgent={onAskAgent}
                onReply={onReplyThread}
                onSetResolved={onSetThreadResolved}
                onUpdateComment={onUpdateComment}
                onDeleteComment={onDeleteComment}
                onConfirmDeleteComment={onConfirmDeleteComment}
                isBusy={busyThreadId === thread.id}
                busyCommentId={busyCommentId}
              />
            ))}
            {hiddenOutdatedCount > 0 && showOutdated && (
              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', padding: '0 2px' }}>
                +{hiddenOutdatedCount} more outdated conversation{hiddenOutdatedCount === 1 ? '' : 's'}
              </div>
            )}
            {shownIssueComments.map((comment) => (
              <GitHubIssueCommentRow
                key={comment.id}
                comment={comment}
                prAuthorLogin={prAuthorLogin}
                onAskAgent={onAskAgent}
                onReply={onReplyIssueComment}
                onUpdate={onUpdateIssueComment}
                onDelete={onDeleteIssueComment}
                onConfirmDelete={onConfirmDeleteIssueComment}
                isBusy={busyIssueCommentId === comment.id}
              />
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            No synced GitHub conversations yet.
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
