/**
 * BranchActionsPopover — branch-only Actions popover. Replaces the
 * Submit form with three primary actions matching the legacy ActionBar:
 *
 *   1. Open on GitHub — opens the branch compare URL in the browser
 *   2. Copy        — dropdown: Copy as Prompt / Copy as GitHub comment /
 *                    Copy Markdown / Download Markdown
 *   3. Fix Issues  — opens the existing Fix Issues agent flow
 *
 * Branches don't publish to GitHub from Atlas (no PR destination), so the
 * Comment / Approve / Request changes form lives only in the PR variant
 * (`SubmitPopover`).
 */

import { useEffect, useRef, useState } from 'react';
import toast from '@/lib/toast';
import { Btn } from './primitives';
import { copyTextToClipboard, downloadMarkdownFile } from './reviewPanelUtils';

export interface ReviewActionMenuItem {
  label: string;
  description?: string | null;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onClick: () => void;
}

export interface BranchActionsPopoverProps {
  /** Display label rendered in the popover header. */
  contextLabel?: string;
  /** Optional URL to open in the browser; renders the Open on GitHub button. */
  githubUrl?: string | null;
  /**
   * Pre-built export strings. Pass null/undefined to disable the
   * corresponding entry in the Copy submenu.
   */
  exports: {
    prompt?: string | null;
    githubComment?: string | null;
    markdown?: string | null;
    /** Filename without extension. ".md" is appended on download. */
    markdownFilenameBase?: string | null;
  };
  /** Open the fix-issues selection dialog. Disable button when omitted. */
  onOpenFixDialog?: (() => void) | null;
  /** Optional reason shown when Fix Issues cannot run for this branch view. */
  fixIssuesDisabledReason?: string | null;
  /** Optional tab-specific review/walkthrough action rendered first. */
  reviewAction?: ReviewActionMenuItem | null;
  /** Called whenever the popover wants to close (Esc, outside click, action complete). */
  onClose: () => void;
  /** Optional overrides for external link opening (Tauri / electron shells). */
  onOpenExternal?: (url: string) => void;
  /** Incremented by the shell when keyboard focus should move into the menu. */
  focusRequestKey?: number;
}

type CopyOption =
  | { id: 'prompt';        label: 'Copy as Prompt';         action: 'copy';     value: string }
  | { id: 'githubComment'; label: 'Copy as GitHub comment'; action: 'copy';     value: string }
  | { id: 'markdown';      label: 'Copy Markdown';          action: 'copy';     value: string }
  | { id: 'download';      label: 'Download Markdown';      action: 'download'; value: string; filename: string };

export function BranchActionsPopover({
  contextLabel,
  githubUrl,
  exports,
  onOpenFixDialog,
  fixIssuesDisabledReason = null,
  reviewAction,
  onClose,
  onOpenExternal,
  focusRequestKey = 0,
}: BranchActionsPopoverProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    if (focusRequestKey <= 0) return;
    window.requestAnimationFrame(() => {
      const firstButton = containerRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      firstButton?.focus();
    });
  }, [focusRequestKey]);

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

  useEffect(() => {
    if (!copyMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const node = containerRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setCopyMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [copyMenuOpen]);

  const filenameBase = (exports.markdownFilenameBase || 'review-summary').trim() || 'review-summary';
  const fixIssuesEnabled = Boolean(onOpenFixDialog) && !fixIssuesDisabledReason;

  const copyOptions: CopyOption[] = [];
  if (exports.prompt) {
    copyOptions.push({ id: 'prompt', label: 'Copy as Prompt', action: 'copy', value: exports.prompt });
  }
  if (exports.githubComment) {
    copyOptions.push({ id: 'githubComment', label: 'Copy as GitHub comment', action: 'copy', value: exports.githubComment });
  }
  if (exports.markdown) {
    copyOptions.push({ id: 'markdown', label: 'Copy Markdown', action: 'copy', value: exports.markdown });
    copyOptions.push({ id: 'download', label: 'Download Markdown', action: 'download', value: exports.markdown, filename: `${filenameBase}.md` });
  }

  const handleOpenGitHub = () => {
    if (!githubUrl) return;
    if (onOpenExternal) onOpenExternal(githubUrl);
    else window.open(githubUrl, '_blank', 'noopener');
  };

  const handleCopyOption = async (option: CopyOption) => {
    setCopyMenuOpen(false);
    if (option.action === 'download') {
      const ok = downloadMarkdownFile(option.filename, option.value);
      if (ok) toast.success('Markdown downloaded');
      else toast.error('Download failed');
      return;
    }
    const ok = await copyTextToClipboard(option.value);
    if (ok) toast.success('Copied to clipboard');
    else toast.error('Copy failed');
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Branch actions"
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
        width: 320,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        boxShadow: 'var(--review-card-shadow-strong)',
        zIndex: 50,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          paddingBottom: 4,
          borderBottom: '1px solid var(--review-shell-divider)',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          Branch actions
        </span>
        {contextLabel && (
          <span
            style={{
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              maxWidth: 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={contextLabel}
          >
            {contextLabel}
          </span>
        )}
      </div>

      {reviewAction && (
        <div
          style={{
            display: 'grid',
            gap: 6,
            paddingBottom: 10,
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

      <Btn
        variant="ghost"
        size="sm"
        onClick={() => { handleOpenGitHub(); onClose(); }}
        disabled={!githubUrl}
        title={githubUrl ? undefined : 'No GitHub remote detected on this project'}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 0a8 8 0 00-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.88-1.16-.88-1.16-.72-.49.06-.48.06-.48.79.06 1.21.82 1.21.82.71 1.21 1.86.86 2.31.66.07-.52.28-.86.5-1.06-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82A7.6 7.6 0 018 4.72c.68.003 1.37.092 2.01.27 1.52-1.04 2.19-.82 2.19-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.47v2.17c0 .21.15.46.55.38A8 8 0 008 0z" />
        </svg>
        Open on GitHub
      </Btn>

      <div style={{ position: 'relative' }}>
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => setCopyMenuOpen((v) => !v)}
          disabled={copyOptions.length === 0}
          title={copyOptions.length === 0 ? 'No review data to export yet' : undefined}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="5" y="5" width="9" height="9" rx="1.5" />
            <path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" />
          </svg>
          Copy
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2 }} aria-hidden>
            <polyline points="3 5 6 8 9 5" />
          </svg>
        </Btn>
        {copyMenuOpen && copyOptions.length > 0 && (
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: 5,
              boxShadow: 'var(--review-card-shadow-strong)',
              padding: 4,
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              zIndex: 60,
            }}
          >
            {copyOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => { void handleCopyOption(option); }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: '7px 10px',
                  fontSize: 12,
                  textAlign: 'left',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  borderRadius: 3,
                  fontFamily: 'inherit',
                  transition: 'background var(--transition-fast)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface-raised)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          if (!fixIssuesEnabled) return;
          onOpenFixDialog?.();
          onClose();
        }}
        disabled={!fixIssuesEnabled}
        title={fixIssuesEnabled
          ? 'Open Fix Issues with the Atlas agent'
          : (fixIssuesDisabledReason || 'No fixable branch findings are available')}
        style={{
          width: '100%',
          border: 'none',
          borderRadius: 5,
          padding: '7px 10px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 7,
          background: 'transparent',
          color: fixIssuesEnabled ? 'var(--text-primary)' : 'var(--text-tertiary)',
          fontFamily: 'var(--font-sans)',
          fontSize: 12,
          fontWeight: 650,
          cursor: fixIssuesEnabled ? 'pointer' : 'not-allowed',
          opacity: fixIssuesEnabled ? 1 : 0.55,
        }}
        onMouseEnter={(e) => {
          if (fixIssuesEnabled) e.currentTarget.style.background = 'var(--bg-surface-raised)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
          aria-hidden
        >
          <path d="M9 2 4 9h4l-1 5 5-7H8l1-5Z" />
        </svg>
        Fix issues with agent
      </button>
    </div>
  );
}
