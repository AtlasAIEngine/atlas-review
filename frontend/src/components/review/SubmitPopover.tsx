/**
 * SubmitPopover — Direction C top-bar submission popover. 380px wide,
 * anchored top-right under the Submit button. Markdown toolbar + textarea
 * + three radio tiles (Comment / Approve / Request changes).
 *
 * Branch kind: only Comment is active. Approve / Request changes show
 * "Open a PR to enable" with a blocked icon. Submitting a branch comment
 * surfaces the documented "open a PR to comment" error inline —
 * branch-only reviews have no GitHub destination to publish to.
 * PR kind: all three active, Comment default. Submit routes through
 * `submitPrReview` to `prReviewApi.publishToGitHub`.
 *
 * Escape closes; Cmd/Ctrl+Enter submits. First focus lands on textarea;
 * Escape returns focus to the anchor (caller handles that via onClose).
 */

import { useEffect, useRef, useState } from 'react';
import { Btn, Kbd } from './primitives';
import type { ReviewActionMenuItem } from './BranchActionsPopover';
import {
  submitBranchComment,
  submitPrReview,
} from '@/lib/reviewPublishActions';
import { formatShortcut } from '@/utils/keyboardShortcuts';

export type SubmitKind = 'branch' | 'pr';
export type SubmitAction = 'comment' | 'approve' | 'request_changes';
export type SubmitFindingSelectionAction = Extract<SubmitAction, 'comment' | 'request_changes'>;
export type SubmitFindingSelectionResult = { ok: true } | { ok: false; error: string };

interface SubmitPopoverProps {
  kind: SubmitKind;
  /** Defaults: branch = 'comment', PR = 'comment'. */
  initialAction?: SubmitAction;
  /** Required for both branch + PR submissions. */
  projectId: string;
  /** Required when kind === 'branch'. */
  branchReviewId?: string | null;
  /** Required when kind === 'pr'. */
  prReviewId?: string | null;
  /** Optional PR url for the "Open on GitHub" footer. */
  prHtmlUrl?: string | null;
  /**
   * Optional stale-review message shown as a banner at the top of the
   * popover (PR kind only). The shell top bar already surfaces the stale
   * chip — this gives reviewers the explanation when they're actually
   * mid-submit.
   */
  staleReviewMessage?: string | null;
  /** Optional tab-specific review/walkthrough action rendered first. */
  reviewAction?: ReviewActionMenuItem | null;
  /** Hide PR submit controls when Actions is open outside a reviewed snapshot. */
  showSubmitForm?: boolean;
  /** Disable the Approve tile when this PR already has an approval. */
  approveDisabled?: boolean;
  onClose: () => void;
  /**
   * Called when submission succeeds so the caller can re-fetch publication
   * state / refresh the PR. If omitted, the popover still closes on
   * success.
   */
  onSubmitted?: (action: SubmitAction) => void;
  /**
   * Optional PR-only override for Comment / Request changes. The reviewed
   * snapshot owns finding selection, so callers can route those actions to
   * the full finding-selection dialog while keeping Approve on this popover.
   */
  onOpenFindingSelection?: (
    action: SubmitFindingSelectionAction,
    body: string,
  ) => SubmitFindingSelectionResult;
  /**
   * Optional PR-only override for Approve. The Findings panel owns approval
   * guards because it has the current unresolved-finding state.
   */
  onOpenApproval?: () => SubmitFindingSelectionResult;
  /**
   * Optional hook letting callers open the PR url through their own
   * external-opener (electron/tauri shell) instead of `window.open`.
   */
  onOpenOnGitHub?: () => void;
  /** Incremented by the shell when keyboard focus should move into the menu. */
  focusRequestKey?: number;
}

const ACTION_LABELS: Record<SubmitAction, { label: string; description: string }> = {
  comment:         { label: 'Comment',         description: 'Leave a comment without changing approval state.' },
  approve:         { label: 'Approve',         description: 'Submit approval; requires a connected PR.' },
  request_changes: { label: 'Request changes', description: 'Block merge with required-change feedback.' },
};

export function SubmitPopover({
  kind,
  initialAction,
  projectId,
  branchReviewId,
  prReviewId,
  prHtmlUrl,
  staleReviewMessage,
  reviewAction,
  showSubmitForm = true,
  approveDisabled = false,
  onClose,
  onSubmitted,
  onOpenFindingSelection,
  onOpenApproval,
  onOpenOnGitHub,
  focusRequestKey = 0,
}: SubmitPopoverProps) {
  const defaultAction = initialAction ?? 'comment';
  const submitShortcut = formatShortcut(['primary', 'enter']);
  const [action, setAction] = useState<SubmitAction>(defaultAction);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusRequestKey > 0) return;
    if (showSubmitForm) textareaRef.current?.focus();
  }, [focusRequestKey, showSubmitForm]);

  useEffect(() => {
    if (focusRequestKey <= 0) return;
    window.requestAnimationFrame(() => {
      const firstButton = containerRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      firstButton?.focus();
    });
  }, [focusRequestKey]);

  useEffect(() => {
    if (approveDisabled && action === 'approve') {
      setAction('comment');
    }
  }, [action, approveDisabled]);

  const handleSubmit = async (nextAction: SubmitAction, nextBody: string) => {
    if (submitting) return;
    if (kind === 'pr' && nextAction === 'approve' && approveDisabled) return;
    if (kind === 'pr' && nextAction === 'approve' && onOpenApproval) {
      setErrorMessage(null);
      const result = onOpenApproval();
      if (result.ok) {
        onClose();
      } else {
        setErrorMessage(result.error);
      }
      return;
    }
    if (
      kind === 'pr'
      && (nextAction === 'comment' || nextAction === 'request_changes')
      && onOpenFindingSelection
    ) {
      setErrorMessage(null);
      const result = onOpenFindingSelection(nextAction, nextBody);
      if (result.ok) {
        onClose();
      } else {
        setErrorMessage(result.error);
      }
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      if (kind === 'pr') {
        if (!prReviewId) {
          setErrorMessage('No pull request is selected.');
          return;
        }
        const result = await submitPrReview({
          projectId,
          prReviewId,
          body: nextBody,
          decision: nextAction,
        });
        if (result.ok) {
          onSubmitted?.(nextAction);
          onClose();
        } else {
          setErrorMessage(result.error);
        }
      } else {
        if (!branchReviewId) {
          setErrorMessage('No branch review is selected.');
          return;
        }
        const result = await submitBranchComment({
          projectId,
          branchReviewId,
          body: nextBody,
        });
        if (result.ok) {
          onSubmitted?.(nextAction);
          onClose();
        } else {
          setErrorMessage(result.error);
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (!showSubmitForm) return;
        event.preventDefault();
        void handleSubmit(action, body);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, body, onClose, submitting, kind, projectId, branchReviewId, prReviewId, showSubmitForm, approveDisabled]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [onClose]);

  const insertAround = (prefix: string, suffix = prefix) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const selected = body.slice(start, end);
    const next = body.slice(0, start) + prefix + selected + suffix + body.slice(end);
    setBody(next);
    window.requestAnimationFrame(() => {
      el.focus();
      const cursor = start + prefix.length + selected.length + suffix.length;
      el.setSelectionRange(cursor, cursor);
    });
  };

  const canApprove = kind === 'pr' && !approveDisabled;
  const canRequestChanges = kind === 'pr';

  const radioFor = (choice: SubmitAction, enabled: boolean) => {
    const labels = ACTION_LABELS[choice];
    const isActive = action === choice && enabled;
    const disabledDescription = choice === 'approve' && kind === 'pr' && approveDisabled
      ? 'This PR is already approved.'
      : 'Open a PR to enable';
    return (
      <button
        key={choice}
        type="button"
        disabled={!enabled}
        onClick={() => { if (enabled) setAction(choice); }}
        style={{
          display: 'grid',
          gridTemplateColumns: '14px 1fr',
          gap: 8,
          alignItems: 'start',
          padding: '8px 10px',
          textAlign: 'left',
          borderRadius: 4,
          border: `1px solid ${isActive ? 'color-mix(in oklab, var(--accent-blue) 40%, transparent)' : 'var(--border-default)'}`,
          background: isActive
            ? 'color-mix(in oklab, var(--accent-blue) 10%, transparent)'
            : enabled
              ? 'var(--bg-surface)'
              : 'var(--review-control-muted-bg)',
          cursor: enabled ? 'pointer' : 'not-allowed',
          opacity: enabled ? 1 : 0.55,
          width: '100%',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            border: `1px solid ${isActive ? 'var(--accent-blue)' : 'var(--border-default)'}`,
            background: isActive ? 'var(--accent-blue)' : 'transparent',
            marginTop: 2,
            display: 'inline-block',
          }}
        />
        <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
            {labels.label}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
            {enabled ? labels.description : disabledDescription}
          </span>
        </span>
      </button>
    );
  };

  const handleOpenGitHub = () => {
    if (onOpenOnGitHub) {
      onOpenOnGitHub();
      return;
    }
    if (prHtmlUrl) {
      window.open(prHtmlUrl, '_blank', 'noopener');
    }
  };

  const focusMenuButton = (direction: 'next' | 'prev') => {
    const buttons = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
    if (buttons.length === 0) return;
    const activeElement = document.activeElement;
    const currentIndex = buttons.findIndex((button) => button === activeElement);
    const fallbackIndex = direction === 'next' ? -1 : 0;
    const fromIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
    const nextIndex = direction === 'next'
      ? (fromIndex + 1) % buttons.length
      : (fromIndex - 1 + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Submit review"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const activeElement = document.activeElement as HTMLElement | null;
        const tag = (activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || activeElement?.isContentEditable) return;
        e.preventDefault();
        focusMenuButton(e.key === 'ArrowDown' ? 'next' : 'prev');
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: 0,
        width: 380,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        boxShadow: 'var(--review-card-shadow-strong)',
        zIndex: 100,
        padding: 14,
        display: 'grid',
        gap: 12,
      }}
    >
      {reviewAction && (
        <div
          style={{
            display: 'grid',
            gap: 6,
            paddingBottom: 12,
            borderBottom: '1px solid var(--review-shell-divider)',
          }}
        >
          <Btn
            variant="primary"
            size="sm"
            accent={reviewAction.tone === 'danger' ? 'var(--sev-high)' : undefined}
            onClick={() => { reviewAction.onClick(); onClose(); }}
            disabled={reviewAction.disabled}
          >
            {reviewAction.tone === 'danger' && (
              <span style={{ width: 6, height: 6, background: '#fff', borderRadius: 1, display: 'inline-block' }} />
            )}
            {reviewAction.label}
          </Btn>
          {reviewAction.description && (
            <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.45 }}>
              {reviewAction.description}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          {showSubmitForm ? 'Submit review' : 'Actions'}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
          {kind === 'pr' ? 'PR review' : 'Branch review'}
        </span>
      </div>

      {showSubmitForm && kind === 'pr' && staleReviewMessage && (
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            color: 'var(--sev-med)',
            background: 'color-mix(in oklab, var(--sev-med) 12%, transparent)',
            border: '1px solid color-mix(in oklab, var(--sev-med) 30%, transparent)',
            borderRadius: 4,
            padding: '6px 8px',
          }}
        >
          {staleReviewMessage}
        </div>
      )}

      {showSubmitForm && (
        <>
          {/* Markdown toolbar */}
          <div style={{ display: 'flex', gap: 4 }}>
            <MdButton title="Bold" onClick={() => insertAround('**')}><strong>B</strong></MdButton>
            <MdButton title="Italic" onClick={() => insertAround('_')}><em>I</em></MdButton>
            <MdButton title="Inline code" onClick={() => insertAround('`')}>
              <span style={{ fontFamily: 'var(--font-mono)' }}>&lt;/&gt;</span>
            </MdButton>
            <MdButton title="Link" onClick={() => insertAround('[', '](url)')}>link</MdButton>
          </div>

          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Leave a comment or summary… (${submitShortcut} to submit)`}
            rows={5}
            style={{
              width: '100%',
              resize: 'vertical',
              padding: 10,
              background: 'var(--bg-base)',
              border: '1px solid var(--border-default)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-ui)',
              fontSize: 12,
              lineHeight: 1.5,
              outline: 'none',
            }}
          />

          <div style={{ display: 'grid', gap: 6 }}>
            {radioFor('comment', true)}
            {radioFor('approve', canApprove)}
            {radioFor('request_changes', canRequestChanges)}
          </div>

          {errorMessage && (
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.4,
                color: 'var(--sev-high)',
                background: 'color-mix(in oklab, var(--sev-high) 10%, transparent)',
                border: '1px solid color-mix(in oklab, var(--sev-high) 30%, transparent)',
                borderRadius: 4,
                padding: '6px 8px',
              }}
            >
              {errorMessage}
            </div>
          )}
        </>
      )}

      {!showSubmitForm && !reviewAction && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          No review action is available for the current state.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Btn variant="bare" size="sm" onClick={onClose}>
          Cancel
        </Btn>
        <div style={{ flex: 1 }} />
        {(onOpenOnGitHub || (kind === 'pr' && prHtmlUrl)) && (
          <Btn variant="ghost" size="sm" onClick={handleOpenGitHub}>
            Open on GitHub
          </Btn>
        )}
        {showSubmitForm && (
          <Btn
            variant="primary"
            size="sm"
            onClick={() => { void handleSubmit(action, body); }}
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : <>Submit <Kbd tone="onPrimary">&#8984;&#9166;</Kbd></>}
          </Btn>
        )}
      </div>
    </div>
  );
}

function MdButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        borderRadius: 4,
        border: '1px solid var(--border-default)',
        background: 'var(--bg-surface)',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
