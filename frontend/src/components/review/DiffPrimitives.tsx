/**
 * DiffPrimitives — Shared diff rendering components extracted from TrustDiffViewer.
 * Used by both TrustDiffViewer (tab-based view) and SummaryDiffView (scrollable overview).
 */

import { useState } from 'react';

import type { DiffLine, DiffLineOrCollapsed, DiffSegment, CollapsedSection, ConfidenceEntry } from '@/utils/diff';
import type { SyntaxToken } from '@/utils/syntaxHighlight';
import {
  buildSyntaxAwareSegmentTokens,
  resolveLineSyntaxTokens,
  type SyntaxTokenLookup,
} from '@/components/trustDiffSyntax';

// ── Type guard ──────────────────────────────────────────────────────────

export function isCollapsedSection(item: DiffLineOrCollapsed): item is CollapsedSection {
  return (item as CollapsedSection).type === 'collapsed';
}

// ── Unified Diff Line ───────────────────────────────────────────────────

export function UnifiedDiffLine({
  line,
  syntaxTokens,
  confEntry,
  isFlash,
  commentControl,
  noteControl,
  selectionMeta,
}: {
  line: DiffLine;
  syntaxTokens: SyntaxTokenLookup;
  confEntry?: ConfidenceEntry;
  isFlash?: boolean;
  commentControl?: {
    enabled: boolean;
    visible?: boolean;
    active?: boolean;
    hasComment?: boolean;
    disabledReason?: string;
    onClick?: () => void;
  };
  noteControl?: {
    enabled: boolean;
    visible?: boolean;
    active?: boolean;
    hasComment?: boolean;
    disabledReason?: string;
    onClick?: () => void;
  };
  selectionMeta?: {
    path: string;
    side: 'LEFT' | 'RIGHT';
    lineNumber?: number | null;
  };
}) {
  const [isHovered, setIsHovered] = useState(false);
  const bgColor =
    line.type === 'add' ? 'var(--diff-add-bg)' :
    line.type === 'del' ? 'var(--diff-del-bg)' :
    'transparent';
  const gutterBg =
    line.type === 'add' ? 'var(--diff-add-line)' :
    line.type === 'del' ? 'var(--diff-del-line)' :
    'transparent';
  const markerColor =
    line.type === 'add' ? 'var(--diff-add-symbol)' :
    line.type === 'del' ? 'var(--diff-del-symbol)' :
    'var(--text-tertiary)';
  const commentVisible = Boolean(commentControl?.visible ?? commentControl);
  const showNoteControl = Boolean(noteControl?.visible ?? noteControl);
  const markerClickable = Boolean(commentControl?.onClick && commentVisible && line.type !== 'context');
  const oldLineClickable = Boolean(commentControl?.onClick && commentVisible && line.type === 'del' && line.oldNum != null);
  const newLineClickable = Boolean(commentControl?.onClick && commentVisible);
  const commentHoverVisible = isHovered && commentVisible;
  const noteHoverVisible = isHovered && showNoteControl;
  const showOldCommentBadge = commentHoverVisible && oldLineClickable;
  const showNewCommentBadge = commentHoverVisible && newLineClickable && line.type !== 'del';
  const commentBadgeBg = commentControl?.enabled ? 'rgba(59, 130, 246, 0.16)' : 'rgba(148, 163, 184, 0.16)';
  const commentBadgeColor = commentControl?.enabled ? 'var(--accent-blue)' : 'var(--text-tertiary)';
  const lineTokens = resolveLineSyntaxTokens(line, syntaxTokens, 'unified');

  return (
    <div
      data-atlas-diff-line="true"
      data-atlas-diff-path={selectionMeta?.path}
      data-atlas-diff-side={selectionMeta?.side}
      data-atlas-diff-line-number={selectionMeta?.lineNumber ?? undefined}
      data-old-line={line.oldNum ?? undefined}
      data-new-line={line.newNum ?? undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        display: 'flex',
        background: isFlash ? 'var(--review-line-jump-bg)' : (confEntry?.bg || bgColor),
        borderLeft: isFlash
          ? '4px solid var(--accent-blue)'
          : (confEntry ? `4px solid ${confEntry.color}` : '4px solid transparent'),
        boxShadow: isFlash
          ? 'inset 0 0 0 1px var(--review-line-jump-border), inset 0 0 0 999px var(--review-line-jump-glow)'
          : 'none',
        minHeight: 'var(--diff-line-height)',
        minWidth: 0,
        transition: isFlash ? 'background 0.3s ease, box-shadow 0.3s ease, border-left-color 0.3s ease' : undefined,
      }}>
      <button
        type="button"
        onClick={noteControl?.enabled ? noteControl.onClick : undefined}
        disabled={!noteControl?.enabled}
        aria-label={noteControl?.hasComment ? 'Edit private note' : 'Add private note'}
        title={!noteControl?.enabled ? noteControl?.disabledReason : undefined}
        style={{
          width: 22,
          minWidth: 22,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRight: '1px solid var(--diff-gutter-border)',
          background: noteControl?.active ? 'rgba(212, 175, 55, 0.16)' : 'transparent',
          color: noteControl?.hasComment || noteControl?.active ? 'var(--accent-yellow)' : 'var(--text-tertiary)',
          cursor: noteControl?.enabled ? 'pointer' : 'default',
          userSelect: 'none',
          fontSize: 12,
          fontWeight: 700,
          padding: 0,
          opacity: showNoteControl ? (noteControl?.enabled || noteControl?.hasComment ? 1 : 0.55) : 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <span style={{
          opacity: noteHoverVisible && noteControl?.enabled && !noteControl?.hasComment ? 0 : 1,
        }}>
          ●
        </span>
        <span style={{
          position: 'absolute',
          inset: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: noteHoverVisible && noteControl?.enabled && !noteControl?.hasComment ? 1 : 0,
          pointerEvents: 'none',
        }}>
          <span style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            background: 'rgba(212, 175, 55, 0.18)',
            color: 'var(--accent-yellow)',
            lineHeight: 1,
          }}>
            +
          </span>
        </span>
      </button>
      {/* Old line number */}
      <button
        type="button"
        onClick={oldLineClickable ? commentControl?.onClick : undefined}
        disabled={!oldLineClickable}
        aria-label={commentControl?.hasComment ? 'Edit line comment' : 'Add line comment'}
        title={!oldLineClickable ? commentControl?.disabledReason : undefined}
        style={{
          width: 'var(--line-num-width)',
          minWidth: 'var(--line-num-width)',
          textAlign: 'right',
          padding: '0 var(--space-2)',
          color: 'var(--text-tertiary)',
          background: commentControl?.active && line.type === 'del' && commentControl?.enabled ? 'rgba(59, 130, 246, 0.14)' : gutterBg,
          userSelect: 'none',
          border: 'none',
          borderRight: '1px solid var(--diff-gutter-border)',
          fontSize: 'var(--diff-font-size)',
          cursor: oldLineClickable ? 'pointer' : 'default',
          fontFamily: 'var(--font-mono)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {line.oldNum ?? ''}
        <span style={{
          position: 'absolute',
          left: 2,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: showOldCommentBadge ? 1 : 0,
          pointerEvents: 'none',
        }}>
          <span style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            background: commentBadgeBg,
            color: commentBadgeColor,
            lineHeight: 1,
          }}>
            +
          </span>
        </span>
      </button>
      {/* New line number */}
      <button
        type="button"
        onClick={newLineClickable ? commentControl?.onClick : undefined}
        disabled={!newLineClickable}
        aria-label={commentControl?.hasComment ? 'Edit line comment' : 'Add line comment'}
        title={!newLineClickable ? commentControl?.disabledReason : undefined}
        style={{
          width: 'var(--line-num-width)',
          minWidth: 'var(--line-num-width)',
          textAlign: 'right',
          padding: '0 var(--space-2)',
          color: 'var(--text-tertiary)',
          background: commentControl?.active && commentControl?.enabled ? 'rgba(59, 130, 246, 0.14)' : gutterBg,
          userSelect: 'none',
          border: 'none',
          borderRight: '1px solid var(--diff-gutter-border)',
          fontSize: 'var(--diff-font-size)',
          cursor: newLineClickable ? 'pointer' : 'default',
          fontFamily: 'var(--font-mono)',
          position: 'relative',
          overflow: 'hidden',
        }}>
        {line.newNum ?? ''}
        <span style={{
          position: 'absolute',
          left: 2,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: showNewCommentBadge ? 1 : 0,
          pointerEvents: 'none',
        }}>
          <span style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            background: commentBadgeBg,
            color: commentBadgeColor,
            lineHeight: 1,
          }}>
            +
          </span>
        </span>
      </button>
      {/* Content */}
      <span data-atlas-diff-content="true" style={{
        padding: '0 var(--space-2)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        flex: 1,
        minWidth: 0,
        color: 'var(--text-primary)',
        userSelect: 'text',
        cursor: 'text',
      }}>
        <span
          onClick={markerClickable ? commentControl?.onClick : undefined}
          title={!markerClickable ? commentControl?.disabledReason : undefined}
          style={{
            color: markerColor,
            userSelect: 'none',
            cursor: markerClickable ? 'pointer' : 'default',
          }}
        >
          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
        </span>
        {line.segments ? (
          <SyntaxAwareSegments segments={line.segments} type={line.type} tokens={lineTokens} />
        ) : lineTokens ? (
          <SyntaxLine tokens={lineTokens} />
        ) : (
          line.content
        )}
      </span>
    </div>
  );
}

// ── Intraline Segments (word-level highlighting) ────────────────────────

export function SyntaxAwareSegments({
  segments,
  type,
  tokens,
}: {
  segments: DiffSegment[];
  type: DiffLine['type'];
  tokens?: SyntaxToken[] | null;
}) {
  const highlightBg = type === 'add' ? 'var(--diff-add-char)' : 'var(--diff-del-char)';
  const mergedTokens = buildSyntaxAwareSegmentTokens(segments, tokens);

  return (
    <>
      {mergedTokens.map((token, i) => (
        <span
          key={i}
          style={{
            color: token.color || undefined,
            background: token.changeHighlighted ? highlightBg : 'transparent',
            borderRadius: token.changeHighlighted ? 2 : 0,
          }}
        >
          {token.text}
        </span>
      ))}
    </>
  );
}

// ── Syntax Line ─────────────────────────────────────────────────────────

export function SyntaxLine({ tokens }: { tokens: SyntaxToken[] }) {
  return (
    <>
      {tokens.map((token, i) => (
        <span key={i} style={{ color: token.color }}>
          {token.text}
        </span>
      ))}
    </>
  );
}

// ── Split Diff Line ──────────────────────────────────────────────────────

export function SplitDiffLine({
  line,
  side,
  syntaxTokens,
  confEntry,
  commentControl,
  noteControl,
  selectionMeta,
}: {
  line: DiffLine;
  side: 'left' | 'right';
  syntaxTokens: SyntaxTokenLookup;
  confEntry?: ConfidenceEntry;
  commentControl?: {
    enabled: boolean;
    visible?: boolean;
    active?: boolean;
    hasComment?: boolean;
    disabledReason?: string;
    onClick?: () => void;
  };
  noteControl?: {
    enabled: boolean;
    visible?: boolean;
    active?: boolean;
    hasComment?: boolean;
    disabledReason?: string;
    onClick?: () => void;
  };
  selectionMeta?: {
    path: string;
    side: 'LEFT' | 'RIGHT';
    lineNumber?: number | null;
  };
}) {
  const [isHovered, setIsHovered] = useState(false);
  const bgColor =
    line.type === 'add' ? 'var(--diff-add-bg)' :
    line.type === 'del' ? 'var(--diff-del-bg)' :
    'transparent';
  const gutterBg =
    line.type === 'add' ? 'var(--diff-add-line)' :
    line.type === 'del' ? 'var(--diff-del-line)' :
    'transparent';
  const markerColor =
    line.type === 'add' ? 'var(--diff-add-symbol)' :
    line.type === 'del' ? 'var(--diff-del-symbol)' :
    'var(--text-tertiary)';
  const commentVisible = Boolean(commentControl?.visible ?? commentControl);
  const showNoteControl = Boolean(noteControl?.visible ?? noteControl);
  const markerClickable = Boolean(commentControl?.onClick && commentVisible && line.type !== 'context');
  const commentHoverVisible = isHovered && commentVisible;
  const noteHoverVisible = isHovered && showNoteControl;
  const showCommentBadge = commentHoverVisible && Boolean(commentControl?.onClick && commentVisible);
  const commentBadgeBg = commentControl?.enabled ? 'rgba(59, 130, 246, 0.16)' : 'rgba(148, 163, 184, 0.16)';
  const commentBadgeColor = commentControl?.enabled ? 'var(--accent-blue)' : 'var(--text-tertiary)';

  const lineNum = side === 'left' ? line.oldNum : line.newNum;
  const lineTokens = resolveLineSyntaxTokens(line, syntaxTokens, side);

  return (
    <div
      data-atlas-diff-line="true"
      data-atlas-diff-path={selectionMeta?.path}
      data-atlas-diff-side={selectionMeta?.side}
      data-atlas-diff-line-number={selectionMeta?.lineNumber ?? undefined}
      data-old-line={line.oldNum ?? undefined}
      data-new-line={line.newNum ?? undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        display: 'flex',
        background: confEntry?.bg || bgColor,
        borderLeft: confEntry ? `4px solid ${confEntry.color}` : '4px solid transparent',
        minHeight: 'var(--diff-line-height)',
        minWidth: 0,
      }}
    >
      <button
        type="button"
        onClick={noteControl?.enabled ? noteControl.onClick : undefined}
        disabled={!noteControl?.enabled}
        aria-label={noteControl?.hasComment ? 'Edit private note' : 'Add private note'}
        title={!noteControl?.enabled ? noteControl?.disabledReason : undefined}
        style={{
          width: 22,
          minWidth: 22,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRight: '1px solid var(--diff-gutter-border)',
          background: noteControl?.active ? 'rgba(212, 175, 55, 0.16)' : 'transparent',
          color: noteControl?.hasComment || noteControl?.active ? 'var(--accent-yellow)' : 'var(--text-tertiary)',
          cursor: noteControl?.enabled ? 'pointer' : 'default',
          userSelect: 'none',
          fontSize: 12,
          fontWeight: 700,
          padding: 0,
          opacity: showNoteControl ? (noteControl?.enabled || noteControl?.hasComment ? 1 : 0.55) : 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <span style={{
          opacity: noteHoverVisible && noteControl?.enabled && !noteControl?.hasComment ? 0 : 1,
        }}>
          ●
        </span>
        <span style={{
          position: 'absolute',
          inset: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: noteHoverVisible && noteControl?.enabled && !noteControl?.hasComment ? 1 : 0,
          pointerEvents: 'none',
        }}>
          <span style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            background: 'rgba(212, 175, 55, 0.18)',
            color: 'var(--accent-yellow)',
            lineHeight: 1,
          }}>
            +
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={commentControl?.onClick}
        disabled={!commentControl?.onClick}
        aria-label={commentControl?.hasComment ? 'Edit line comment' : 'Add line comment'}
        title={!commentControl?.enabled ? commentControl?.disabledReason : undefined}
        style={{
          width: 'var(--line-num-width)',
          minWidth: 'var(--line-num-width)',
          textAlign: 'right',
          padding: '0 var(--space-2)',
          color: 'var(--text-tertiary)',
          background: commentControl?.active && commentControl?.enabled ? 'rgba(59, 130, 246, 0.14)' : gutterBg,
          userSelect: 'none',
          border: 'none',
          borderRight: '1px solid var(--diff-gutter-border)',
          fontSize: 'var(--diff-font-size)',
          cursor: (showCommentBadge || commentControl?.hasComment) ? 'pointer' : 'default',
          fontFamily: 'var(--font-mono)',
          position: 'relative',
          overflow: 'hidden',
        }}>
        {lineNum ?? ''}
        <span style={{
          position: 'absolute',
          left: 2,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: (showCommentBadge || commentControl?.hasComment) ? 1 : 0,
          pointerEvents: commentControl?.hasComment ? 'auto' : 'none',
        }}>
          <span style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            background: commentBadgeBg,
            color: commentBadgeColor,
            lineHeight: 1,
          }}>
            +
          </span>
        </span>
      </button>
        <span
          onClick={markerClickable ? commentControl?.onClick : undefined}
          title={!markerClickable && side === 'right' ? commentControl?.disabledReason : undefined}
          style={{
          width: 18,
          minWidth: 18,
          padding: '0 2px',
          color: markerColor,
          userSelect: 'none',
          borderRight: '1px solid var(--diff-gutter-border)',
          cursor: markerClickable ? 'pointer' : 'default',
          background: gutterBg,
        }}
      >
        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
      </span>
      <span data-atlas-diff-content="true" style={{
        padding: '0 var(--space-2)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        flex: 1,
        minWidth: 0,
        color: 'var(--text-primary)',
        userSelect: 'text',
        cursor: 'text',
      }}>
        {line.segments ? (
          <SyntaxAwareSegments segments={line.segments} type={line.type} tokens={lineTokens} />
        ) : lineTokens ? (
          <SyntaxLine tokens={lineTokens} />
        ) : (
          line.content
        )}
      </span>
    </div>
  );
}

// ── Split Row Type ──────────────────────────────────────────────────────

export interface SplitRow {
  leftLine: DiffLine | null;
  rightLine: DiffLine | null;
  collapsed?: CollapsedSection;
}

// ── Collapsed Section Bar ───────────────────────────────────────────────

export function CollapsedBar({
  section,
  onExpand,
  newStartLine,
  newEndLine,
}: {
  section: CollapsedSection;
  onExpand: (startIdx: number) => void;
  newStartLine?: number | null;
  newEndLine?: number | null;
}) {
  return (
    <div
      data-collapsed-start-idx={section.startIdx}
      data-collapsed-new-start={newStartLine ?? undefined}
      data-collapsed-new-end={newEndLine ?? undefined}
      onClick={() => onExpand(section.startIdx)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 30,
        padding: '0 12px',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--review-toolbar-bg) 94%, var(--accent-blue) 6%), var(--review-toolbar-bg))',
        borderTop: '1px solid var(--review-shell-divider)',
        borderBottom: '1px solid var(--review-shell-divider)',
        color: 'var(--text-secondary)',
        fontSize: 11,
        fontWeight: 650,
        letterSpacing: 0.2,
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'color-mix(in srgb, var(--review-toolbar-bg) 72%, var(--accent-blue) 28%)';
        e.currentTarget.style.borderTopColor = 'color-mix(in srgb, var(--accent-blue) 34%, var(--review-shell-divider))';
        e.currentTarget.style.borderBottomColor = 'color-mix(in srgb, var(--accent-blue) 34%, var(--review-shell-divider))';
        e.currentTarget.style.color = 'var(--text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'linear-gradient(180deg, color-mix(in srgb, var(--review-toolbar-bg) 94%, var(--accent-blue) 6%), var(--review-toolbar-bg))';
        e.currentTarget.style.borderTopColor = 'var(--review-shell-divider)';
        e.currentTarget.style.borderBottomColor = 'var(--review-shell-divider)';
        e.currentTarget.style.color = 'var(--text-secondary)';
      }}
    >
      <span aria-hidden="true" style={{ color: 'var(--accent-blue)', fontSize: 13, lineHeight: 1 }}>⌄</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: 'var(--accent-blue)',
          boxShadow: '0 0 10px color-mix(in srgb, var(--accent-blue) 44%, transparent)',
        }} />
        Show {section.count} hidden lines
      </span>
      <span aria-hidden="true" style={{ color: 'var(--accent-blue)', fontSize: 13, lineHeight: 1 }}>⌄</span>
    </div>
  );
}
