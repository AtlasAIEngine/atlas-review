/**
 * StepFileSection — per-file slice inside a Walkthrough step.
 * Sticky file header (chev toggle + path + sev + +adds/−dels) followed
 * by the unified-diff hunks. See direction-c.jsx:1088-1111. Inline
 * AI-comment callouts are rendered in task 4 via `findings` + the
 * `HunkWithFindings` split.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ReviewRecommendation } from '@/types';
import type { DiffHunkLine, SevLevel } from './primitives';
import { SevChip } from './primitives';
import { SplitDiffLine, UnifiedDiffLine } from './DiffPrimitives';
import { parsePatch } from '@/utils/patchParse';
import type { ParsedPatchHunk } from '@/utils/patchParse';
import type { DiffLine } from '@/utils/diff';
import type { SyntaxTokenLookup } from '@/components/trustDiffSyntax';
import { useSyntaxTokens } from '@/hooks/useSyntaxTokens';
import type { ReviewAgentAttachment } from '@/services/reviewAgentApi';
import {
  getRecommendationPatchLine,
  getRecommendationSourceFile,
  getRecommendationSourceLine,
  resolveRecommendationDisplayAnchor,
  type RecommendationDisplayAnchorMode,
} from '@/utils/reviewNavigation';
import { buildReviewPathLookup } from '@/utils/reviewPathMatching';
import { InlineCommentCard, InlineComments, getInlineCommentAnchorLine, useCommentsByLine } from './InlineComments';
import { ManualLineCommentAuthor } from './ManualLineCommentAuthor';
import { AtlasAiMark } from './AtlasAiMark';
import { resolveAtlasDiffSelection, type AtlasDiffSelection } from './atlasDiffSelection';

interface StepFileSectionProps {
  path: string;
  oldPath?: string | null;
  sev?: SevLevel | null;
  adds: number;
  dels: number;
  patch?: string | null;
  /** Full pre-change file content. When present alongside `after`, the
   * walkthrough diff renders with the same syntax highlighting as the
   * Files tab; when missing the diff falls back to monochrome text. */
  before?: string | null;
  /** Full post-change file content. Pair with `before` to enable
   * syntax highlighting. */
  after?: string | null;
  /** Recommendations joined to this file (any line). Positioned via `rec.line`. */
  findings?: ReviewRecommendation[];
  active?: boolean;
  initiallyCollapsed?: boolean;
  /** Persisted outcome per recommendation key (controlled state for AICommentCard). */
  resolvedOutcomes?: Map<string, 'addressed' | 'dismissed'>;
  /** In-flight outcome persistence per recommendation key. */
  pendingOutcomes?: Map<string, 'addressed' | 'dismissed'>;
  /** Resolves a recommendation to its dedupe key. Defaults to identity if absent. */
  recommendationKey?: (rec: ReviewRecommendation) => string;
  onApplyFix?: (rec: ReviewRecommendation) => void;
  onComment?: (rec: ReviewRecommendation) => void;
  onDismiss?: (rec: ReviewRecommendation) => void;
  onAddressed?: (rec: ReviewRecommendation) => void;
  canCommentOnRecommendation?: boolean;
  commentDisabledReason?: string | null;
  getRecommendationComment?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearRecommendationComment?: (rec: ReviewRecommendation) => void;
  canCommentOnAnyLine?: boolean;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSaveManualLineComment?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  onAskAtlasSelection?: (payload: {
    attachment: Extract<ReviewAgentAttachment, { type: 'line_range' }>;
    prompt: string;
  }) => void;
  viewMode?: 'unified' | 'split';
}

export function StepFileSection({
  path,
  oldPath,
  sev,
  adds,
  dels,
  patch,
  before = null,
  after = null,
  findings,
  active = false,
  initiallyCollapsed = false,
  resolvedOutcomes,
  pendingOutcomes,
  recommendationKey,
  onApplyFix,
  onComment: _onComment,
  onDismiss: _onDismiss,
  onAddressed: _onAddressed,
  canCommentOnRecommendation = false,
  commentDisabledReason,
  getRecommendationComment,
  onSaveRecommendationComment,
  onClearRecommendationComment,
  canCommentOnAnyLine = false,
  getManualLineComment,
  onSaveManualLineComment,
  onClearManualLineComment,
  onAskAtlasSelection,
  viewMode = 'unified',
}: StepFileSectionProps) {
  void onApplyFix;
  void _onComment;
  void _onDismiss;
  void _onAddressed;

  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const [dismissedComments, setDismissedComments] = useState<Set<string>>(() => new Set());
  const [collapsedComments, setCollapsedComments] = useState<Set<string>>(() => new Set());
  const [openLineCommentKey, setOpenLineCommentKey] = useState<string | null>(null);
  const [atlasDiffSelection, setAtlasDiffSelection] = useState<AtlasDiffSelection | null>(null);
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const hunks: ParsedPatchHunk[] = useMemo(() => parsePatch(patch), [patch]);
  // Same hook the Files tab uses (see SummaryDiffView). Returns
  // `{ before: SyntaxTokenMap, after: SyntaxTokenMap }`, which is
  // structurally identical to `SyntaxTokenLookup`. When `before` /
  // `after` are not yet hydrated the hook returns empty maps, which
  // matches the previous EMPTY_SYNTAX_TOKENS behavior — diffs render
  // monochrome until content arrives, then re-render highlighted.
  const syntaxTokens: SyntaxTokenLookup = useSyntaxTokens(before, after, path);
  const safeFindings: ReviewRecommendation[] = useMemo(
    () => (Array.isArray(findings) ? findings : []),
    [findings],
  );
  const getResolvedOutcome = useCallback((rec: ReviewRecommendation) => {
    const key = recommendationKey?.(rec);
    return key ? (resolvedOutcomes?.get(key) || null) : null;
  }, [recommendationKey, resolvedOutcomes]);
  const getPendingOutcome = useCallback((rec: ReviewRecommendation) => {
    const key = recommendationKey?.(rec);
    return key ? (pendingOutcomes?.get(key) || null) : null;
  }, [recommendationKey, pendingOutcomes]);
  const renderedLineNumbers = useMemo(() => {
    const lines = new Set<number>();
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        const n = Number(line.n);
        if (Number.isFinite(n) && n > 0) lines.add(Math.floor(n));
      }
    }
    return lines;
  }, [hunks]);
  const canonicalPathLookup = useMemo(
    () => buildReviewPathLookup([path, oldPath || null]),
    [path, oldPath],
  );
  const commentsByLine = useCommentsByLine(safeFindings, path, renderedLineNumbers, canonicalPathLookup);
  const getCommentKey = useCallback((rec: ReviewRecommendation) => (
    rec.recommendationKey || `${getRecommendationSourceFile(rec)}-${getRecommendationPatchLine(rec)}-${rec.title}`
  ), []);
  const dismissInlineComment = useCallback((rec: ReviewRecommendation) => {
    setDismissedComments((prev) => {
      const next = new Set(prev);
      next.add(getCommentKey(rec));
      return next;
    });
  }, [getCommentKey]);
  const toggleInlineCommentCollapse = useCallback((rec: ReviewRecommendation) => {
    setCollapsedComments((prev) => {
      const next = new Set(prev);
      const key = getCommentKey(rec);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [getCommentKey]);
  const makeLineCommentKey = useCallback((line: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    if (!Number.isFinite(Number(line)) || Number(line) <= 0) return null;
    return `${path}:${side}:${Math.floor(Number(line))}`;
  }, [path]);
  const openLineCommentComposer = useCallback((line: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    if (!canCommentOnAnyLine) return;
    const key = makeLineCommentKey(line, side);
    if (!key) return;
    setOpenLineCommentKey(key);
  }, [canCommentOnAnyLine, makeLineCommentKey]);
  const closeLineCommentComposer = useCallback((line: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const key = makeLineCommentKey(line, side);
    setOpenLineCommentKey((prev) => (prev === key ? null : prev));
  }, [makeLineCommentKey]);
  const updateAtlasDiffSelection = useCallback(() => {
    if (!onAskAtlasSelection) return;
    setAtlasDiffSelection(resolveAtlasDiffSelection(sectionRef.current));
  }, [onAskAtlasSelection]);
  const handleAskAtlasSelection = useCallback(() => {
    if (!atlasDiffSelection) return;
    onAskAtlasSelection?.({
      attachment: atlasDiffSelection.attachment,
      prompt: atlasDiffSelection.prompt,
    });
    setAtlasDiffSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [atlasDiffSelection, onAskAtlasSelection]);

  // Recommendations that didn't anchor into any displayed hunk get
  // rendered at the end of the section with a plain line badge — per
  // plan: "don't fake an anchor".
  const unanchoredFindings = useMemo(() => {
    if (safeFindings.length === 0) return [] as ReviewRecommendation[];
    return safeFindings.filter((rec) => (
      resolveRecommendationDisplayAnchor(rec, renderedLineNumbers)?.mode === 'source-only'
    ));
  }, [safeFindings, renderedLineNumbers]);

  return (
    <div
      ref={sectionRef}
      data-step-file-section={path}
      onMouseUp={updateAtlasDiffSelection}
      onKeyUp={updateAtlasDiffSelection}
      style={{
        borderBottom: '1px solid var(--review-shell-divider)',
        background: active ? 'color-mix(in oklab, var(--accent-blue) 3%, transparent)' : 'transparent',
      }}
    >
      {atlasDiffSelection && onAskAtlasSelection && (
        <button
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleAskAtlasSelection();
          }}
          style={{
            position: 'fixed',
            top: atlasDiffSelection.rect.top,
            left: atlasDiffSelection.rect.left,
            zIndex: 40,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 11px 0 8px',
            borderRadius: 999,
            border: '1px solid rgba(var(--accent-blue-rgb), 0.36)',
            background: 'linear-gradient(180deg, rgba(20, 34, 57, 0.98), rgba(8, 14, 25, 0.98))',
            color: 'var(--text-primary)',
            boxShadow: '0 12px 30px rgba(0, 0, 0, 0.38), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.05)',
            fontSize: 12,
            fontWeight: 700,
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <AtlasAiMark size={18} />
          Ask Atlas
        </button>
      )}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
        style={{
          padding: '10px 20px',
          background: 'var(--review-panel-header-bg)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          position: 'sticky',
          top: 0,
          zIndex: 1,
          borderBottom: '1px solid var(--review-shell-divider)',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            color: 'var(--text-tertiary)',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform var(--transition-fast)',
            flexShrink: 0,
          }}
          aria-hidden
        >
          <polyline points="3 6 8 11 13 6" />
        </svg>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}
          aria-hidden
        >
          <path d="M4 2h5l3 3v9H4z" />
          <polyline points="9 2 9 5 12 5" />
        </svg>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {path}
        </span>
        {sev && <SevChip level={sev} />}
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--text-tertiary)',
            fontVariantNumeric: 'tabular-nums',
            display: 'inline-flex',
            gap: 6,
          }}
        >
          {adds > 0 && <span style={{ color: 'var(--sev-ok)' }}>+{adds}</span>}
          {dels > 0 && <span style={{ color: 'var(--sev-high)' }}>−{dels}</span>}
        </span>
      </div>

      {!collapsed && (
        <div>
          {hunks.length === 0 ? (
            <div
              style={{
                padding: '12px 20px',
                fontSize: 11.5,
                color: 'var(--text-tertiary)',
                fontStyle: 'italic',
              }}
            >
              Diff unavailable — open this file from the Files tab.
            </div>
          ) : (
            hunks.map((hunk, idx) => (
              <HunkWithFindings
                key={idx}
                hunk={hunk}
                path={path}
                syntaxTokens={syntaxTokens}
                commentsByLine={commentsByLine}
                dismissedComments={dismissedComments}
                collapsedComments={collapsedComments}
                getResolvedOutcome={getResolvedOutcome}
                getPendingOutcome={getPendingOutcome}
                canCommentOnRecommendation={canCommentOnRecommendation}
                commentDisabledReason={commentDisabledReason}
                getRecommendationComment={getRecommendationComment}
                onSaveRecommendationComment={onSaveRecommendationComment}
                onClearRecommendationComment={onClearRecommendationComment}
                canCommentOnAnyLine={canCommentOnAnyLine}
                getManualLineComment={getManualLineComment}
                onSaveManualLineComment={onSaveManualLineComment}
                onClearManualLineComment={onClearManualLineComment}
                openLineCommentKey={openLineCommentKey}
                makeLineCommentKey={makeLineCommentKey}
                onOpenLineComment={openLineCommentComposer}
                onCloseLineComment={closeLineCommentComposer}
                onDismissInlineComment={dismissInlineComment}
                onToggleInlineCommentCollapse={toggleInlineCommentCollapse}
                viewMode={viewMode}
              />
            ))
          )}

          {unanchoredFindings.length > 0 && (
            <div style={{ padding: '8px 20px 12px', display: 'grid', gap: 6 }}>
              {unanchoredFindings.map((rec, i) => {
                const key = recommendationKey?.(rec);
                return (
                  <InlineCommentCard
                    key={`unanchored-${i}`}
                    rec={rec}
                    mode="source-only"
                    sourceLine={getRecommendationSourceLine(rec)}
                    isCollapsed={key ? collapsedComments.has(key) : false}
                    resolvedAs={getResolvedOutcome(rec)}
                    pendingOutcome={getPendingOutcome(rec)}
                    onDismiss={dismissInlineComment}
                    onToggleCollapse={toggleInlineCommentCollapse}
                    canComment={canCommentOnRecommendation && rec.type !== 'praise'}
                    commentDisabledReason={rec.type !== 'praise' ? (commentDisabledReason || null) : null}
                    commentText={getRecommendationComment?.(rec)}
                    onSaveComment={onSaveRecommendationComment}
                    onClearComment={onClearRecommendationComment}
                    hideCollapse
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Render a single hunk, splitting at each recommendation line so an
 * AICommentCard appears inline at the anchor. Matches
 * direction-c.jsx:1114-1125.
 */
function HunkWithFindings({
  hunk,
  path,
  syntaxTokens,
  commentsByLine,
  dismissedComments,
  collapsedComments,
  getResolvedOutcome,
  getPendingOutcome,
  canCommentOnRecommendation,
  commentDisabledReason,
  getRecommendationComment,
  onSaveRecommendationComment,
  onClearRecommendationComment,
  canCommentOnAnyLine,
  getManualLineComment,
  onSaveManualLineComment,
  onClearManualLineComment,
  openLineCommentKey,
  makeLineCommentKey,
  onOpenLineComment,
  onCloseLineComment,
  onDismissInlineComment,
  onToggleInlineCommentCollapse,
  viewMode,
}: {
  hunk: ParsedPatchHunk;
  path: string;
  syntaxTokens: SyntaxTokenLookup;
  commentsByLine: Map<number, Array<{ rec: ReviewRecommendation; mode: RecommendationDisplayAnchorMode; sourceLine: number | null }>>;
  dismissedComments: Set<string>;
  collapsedComments: Set<string>;
  getResolvedOutcome: (rec: ReviewRecommendation) => 'addressed' | 'dismissed' | null;
  getPendingOutcome: (rec: ReviewRecommendation) => 'addressed' | 'dismissed' | null;
  canCommentOnRecommendation: boolean;
  commentDisabledReason?: string | null;
  getRecommendationComment?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearRecommendationComment?: (rec: ReviewRecommendation) => void;
  canCommentOnAnyLine: boolean;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSaveManualLineComment?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  openLineCommentKey: string | null;
  makeLineCommentKey: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => string | null;
  onOpenLineComment: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => void;
  onCloseLineComment: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => void;
  onDismissInlineComment: (rec: ReviewRecommendation) => void;
  onToggleInlineCommentCollapse: (rec: ReviewRecommendation) => void;
  viewMode: 'unified' | 'split';
}) {
  // Build the list of (anchorLineIdx → finding[]) splits. Multiple
  // findings can anchor at the same line; preserve order.
  const splits = useMemo(() => {
    const indexes = new Set<number>();
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i];
      const diffLine = toDiffLine(line);
      const anchorLineNum = getInlineCommentAnchorLine(diffLine);
      const lineNum = diffLine.newNum ?? diffLine.oldNum;
      const side = getManualLineCommentSide(line);
      if (anchorLineNum != null && commentsByLine.has(anchorLineNum)) {
        indexes.add(i);
      }
      if (lineNum != null && openLineCommentKey === makeLineCommentKey(lineNum, side)) {
        indexes.add(i);
      }
      if (lineNum != null && getManualLineComment?.(path, lineNum, side)?.trim()) {
        indexes.add(i);
      }
    }
    return [...indexes].sort((a, b) => a - b);
  }, [commentsByLine, getManualLineComment, hunk, makeLineCommentKey, openLineCommentKey, path]);

  const hunkHeader = (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5,
        color: 'var(--text-tertiary)',
        marginBottom: 6,
        padding: '4px 10px',
        background: 'var(--review-panel-header-bg)',
        borderRadius: 3,
        display: 'inline-block',
      }}
    >
      {hunk.header}
    </div>
  );

  if (splits.length === 0) {
    return (
      <div data-atlas-walkthrough-hunk-anchor="true" style={{ padding: '12px 20px' }}>
        {hunkHeader}
        {viewMode === 'split' ? (
          <SplitPatchHunk
            hunk={hunk}
            path={path}
            syntaxTokens={syntaxTokens}
            startIndex={0}
            endIndex={hunk.lines.length}
            canCommentOnAnyLine={canCommentOnAnyLine}
            commentDisabledReason={commentDisabledReason}
            getManualLineComment={getManualLineComment}
            openLineCommentKey={openLineCommentKey}
            makeLineCommentKey={makeLineCommentKey}
            onOpenLineComment={onOpenLineComment}
          />
        ) : (
          <WalkthroughUnifiedPatchHunk
            lines={hunk.lines}
            path={path}
            syntaxTokens={syntaxTokens}
            canCommentOnAnyLine={canCommentOnAnyLine}
            commentDisabledReason={commentDisabledReason}
            getManualLineComment={getManualLineComment}
            openLineCommentKey={openLineCommentKey}
            makeLineCommentKey={makeLineCommentKey}
            onOpenLineComment={onOpenLineComment}
          />
        )}
      </div>
    );
  }

  // Walk the split points, emitting DiffHunk for each slice and
  // AICommentCard(s) between them.
  const segments: React.ReactNode[] = [];
  const renderDiffSegment = (key: string, startIndex: number, endIndex: number) => (
    viewMode === 'split' ? (
      <SplitPatchHunk
        key={key}
        hunk={hunk}
        path={path}
        syntaxTokens={syntaxTokens}
        startIndex={startIndex}
        endIndex={endIndex}
        canCommentOnAnyLine={canCommentOnAnyLine}
        commentDisabledReason={commentDisabledReason}
        getManualLineComment={getManualLineComment}
        openLineCommentKey={openLineCommentKey}
        makeLineCommentKey={makeLineCommentKey}
        onOpenLineComment={onOpenLineComment}
      />
    ) : (
      <WalkthroughUnifiedPatchHunk
        key={key}
        lines={hunk.lines.slice(startIndex, endIndex)}
        path={path}
        syntaxTokens={syntaxTokens}
        canCommentOnAnyLine={canCommentOnAnyLine}
        commentDisabledReason={commentDisabledReason}
        getManualLineComment={getManualLineComment}
        openLineCommentKey={openLineCommentKey}
        makeLineCommentKey={makeLineCommentKey}
        onOpenLineComment={onOpenLineComment}
      />
    )
  );
  let cursor = 0;
  splits.forEach((anchorIdx, i) => {
    if (anchorIdx + 1 > cursor) {
      segments.push(renderDiffSegment(`seg-${i}-pre`, cursor, anchorIdx + 1));
    }
    const line = hunk.lines[anchorIdx];
    if (line) {
      const diffLine = toDiffLine(line);
      const lineNum = diffLine.newNum ?? diffLine.oldNum;
      const side = getManualLineCommentSide(line);
      segments.push(
        <InlineComments
          key={`ai-comments-${i}`}
          line={diffLine}
          commentsByLine={commentsByLine}
          dismissedComments={dismissedComments}
          collapsedComments={collapsedComments}
          getResolution={getResolvedOutcome}
          getPendingOutcome={getPendingOutcome}
          canComment={canCommentOnRecommendation}
          commentDisabledReason={commentDisabledReason}
          getComment={getRecommendationComment}
          onSaveComment={onSaveRecommendationComment}
          onClearComment={onClearRecommendationComment}
          onDismiss={onDismissInlineComment}
          onToggleCollapse={onToggleInlineCommentCollapse}
        />,
      );
      if (lineNum != null) {
        const commentText = getManualLineComment?.(path, lineNum, side) || '';
        const isComposerOpen = openLineCommentKey === makeLineCommentKey(lineNum, side);
        if (commentText.trim() || isComposerOpen) {
          segments.push(
            <ManualLineCommentCard
              key={`manual-comment-${i}`}
              path={path}
              line={lineNum}
              side={side}
              commentText={commentText}
              canEdit={canCommentOnAnyLine}
              isComposerOpen={isComposerOpen}
              onSave={onSaveManualLineComment}
              onClear={onClearManualLineComment}
              onRequestClose={() => onCloseLineComment(lineNum, side)}
            />,
          );
        }
      }
    }
    cursor = anchorIdx + 1;
  });
  if (cursor < hunk.lines.length) {
    segments.push(renderDiffSegment('seg-tail', cursor, hunk.lines.length));
  }

  return (
    <div data-atlas-walkthrough-hunk-anchor="true" style={{ padding: '12px 20px' }}>
      {hunkHeader}
      {segments}
    </div>
  );
}

function SplitPatchHunk({
  hunk,
  path,
  syntaxTokens,
  startIndex,
  endIndex,
  canCommentOnAnyLine,
  commentDisabledReason,
  getManualLineComment,
  openLineCommentKey,
  makeLineCommentKey,
  onOpenLineComment,
}: {
  hunk: ParsedPatchHunk;
  path: string;
  syntaxTokens: SyntaxTokenLookup;
  startIndex: number;
  endIndex: number;
  canCommentOnAnyLine: boolean;
  commentDisabledReason?: string | null;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  openLineCommentKey: string | null;
  makeLineCommentKey: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => string | null;
  onOpenLineComment: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => void;
}) {
  let oldNum = hunk.oldStart;
  let newNum = hunk.newStart;
  for (let i = 0; i < startIndex; i++) {
    const line = hunk.lines[i];
    if (!line) continue;
    if (line.kind === '-') oldNum += 1;
    else if (line.kind === '+') newNum += 1;
    else {
      oldNum += 1;
      newNum += 1;
    }
  }

  const rows: Array<{
    left: SplitPatchLineData | null;
    right: SplitPatchLineData | null;
  }> = [];

  for (let i = startIndex; i < endIndex; i++) {
    const line = hunk.lines[i];
    if (!line) continue;
    if (line.kind === '-') {
      rows.push({
        left: { kind: '-', n: oldNum, text: line.text },
        right: null,
      });
      oldNum += 1;
      continue;
    }
    if (line.kind === '+') {
      rows.push({
        left: null,
        right: { kind: '+', n: newNum, text: line.text },
      });
      newNum += 1;
      continue;
    }
    rows.push({
      left: { kind: ' ', n: oldNum, text: line.text },
      right: { kind: ' ', n: newNum, text: line.text },
    });
    oldNum += 1;
    newNum += 1;
  }

  return (
    <div
      data-atlas-diff-hunk=""
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12.5,
        lineHeight: 1.6,
        background: 'var(--bg-base)',
        borderRadius: 4,
        overflow: 'hidden',
        border: '1px solid var(--border-muted)',
      }}
    >
      {rows.map((row, idx) => (
        <div
          key={idx}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          }}
        >
          <SplitPatchCell
            line={row.left}
            path={path}
            side="left"
            syntaxTokens={syntaxTokens}
            canCommentOnAnyLine={canCommentOnAnyLine}
            commentDisabledReason={commentDisabledReason}
            getManualLineComment={getManualLineComment}
            openLineCommentKey={openLineCommentKey}
            makeLineCommentKey={makeLineCommentKey}
            onOpenLineComment={onOpenLineComment}
          />
          <SplitPatchCell
            line={row.right}
            path={path}
            side="right"
            syntaxTokens={syntaxTokens}
            canCommentOnAnyLine={canCommentOnAnyLine}
            commentDisabledReason={commentDisabledReason}
            getManualLineComment={getManualLineComment}
            openLineCommentKey={openLineCommentKey}
            makeLineCommentKey={makeLineCommentKey}
            onOpenLineComment={onOpenLineComment}
          />
        </div>
      ))}
    </div>
  );
}

type SplitPatchLineData = {
  kind: DiffHunkLine['kind'];
  n: number;
  text: string;
};

function SplitPatchCell({
  line,
  path,
  side,
  syntaxTokens,
  canCommentOnAnyLine,
  commentDisabledReason,
  getManualLineComment,
  openLineCommentKey,
  makeLineCommentKey,
  onOpenLineComment,
}: {
  line: SplitPatchLineData | null;
  path: string;
  side: 'left' | 'right';
  syntaxTokens: SyntaxTokenLookup;
  canCommentOnAnyLine: boolean;
  commentDisabledReason?: string | null;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  openLineCommentKey: string | null;
  makeLineCommentKey: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => string | null;
  onOpenLineComment: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => void;
}) {
  if (!line) {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '40px 18px 1fr',
          minWidth: 0,
          borderRight: side === 'left' ? '1px solid var(--border-muted)' : 'none',
          background: 'var(--bg-base)',
        }}
      >
        <span />
        <span />
        <span />
      </div>
    );
  }

  const diffLine = splitPatchLineToDiffLine(line, side);
  const commentSide: 'LEFT' | 'RIGHT' = side === 'left' ? 'LEFT' : 'RIGHT';
  const lineNumber = side === 'left' ? diffLine.oldNum : diffLine.newNum;
  const lineCommentKey = makeLineCommentKey(lineNumber, commentSide);
  const canLineComment = canCommentOnAnyLine
    && lineNumber != null
    && (side === 'right' || line.kind === '-');
  const hasLineComment = Boolean(
    lineNumber != null && getManualLineComment?.(path, lineNumber, commentSide)?.trim()
  );

  return (
    <div
      data-kind={line.kind}
      style={{
        minWidth: 0,
        borderRight: side === 'left' ? '1px solid var(--border-muted)' : 'none',
      }}
    >
      <SplitDiffLine
        line={diffLine}
        side={side}
        syntaxTokens={syntaxTokens}
        selectionMeta={{
          path,
          side: commentSide,
          lineNumber,
        }}
        commentControl={{
          enabled: canLineComment,
          visible: lineNumber != null && (canCommentOnAnyLine || Boolean(commentDisabledReason)),
          active: openLineCommentKey === lineCommentKey,
          hasComment: hasLineComment,
          disabledReason: !canLineComment ? (commentDisabledReason || undefined) : undefined,
          onClick: canLineComment ? () => onOpenLineComment(lineNumber, commentSide) : undefined,
        }}
      />
    </div>
  );
}

function WalkthroughUnifiedPatchHunk({
  lines,
  path,
  syntaxTokens,
  canCommentOnAnyLine,
  commentDisabledReason,
  getManualLineComment,
  openLineCommentKey,
  makeLineCommentKey,
  onOpenLineComment,
}: {
  lines: DiffHunkLine[];
  path: string;
  syntaxTokens: SyntaxTokenLookup;
  canCommentOnAnyLine: boolean;
  commentDisabledReason?: string | null;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  openLineCommentKey: string | null;
  makeLineCommentKey: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => string | null;
  onOpenLineComment: (line: number | null | undefined, side?: 'LEFT' | 'RIGHT') => void;
}) {
  return (
    <div
      data-atlas-diff-hunk=""
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12.5,
        lineHeight: 1.6,
        background: 'var(--bg-base)',
        borderRadius: 4,
        overflow: 'hidden',
        border: '1px solid var(--border-muted)',
      }}
    >
      {lines.map((line, idx) => {
        const diffLine = toDiffLine(line);
        const side = getManualLineCommentSide(line);
        const lineNumber = diffLine.newNum ?? diffLine.oldNum;
        const lineCommentKey = makeLineCommentKey(lineNumber, side);
        const canLineComment = canCommentOnAnyLine && lineNumber != null;
        const hasLineComment = Boolean(
          lineNumber != null && getManualLineComment?.(path, lineNumber, side)?.trim()
        );
        return (
          <UnifiedDiffLine
            key={idx}
            line={diffLine}
            syntaxTokens={syntaxTokens}
            selectionMeta={{
              path,
              side,
              lineNumber,
            }}
            commentControl={{
              enabled: canLineComment,
              visible: lineNumber != null && (canCommentOnAnyLine || Boolean(commentDisabledReason)),
              active: openLineCommentKey === lineCommentKey,
              hasComment: hasLineComment,
              disabledReason: !canLineComment ? (commentDisabledReason || undefined) : undefined,
              onClick: canLineComment ? () => onOpenLineComment(lineNumber, side) : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

function toDiffLine(line: DiffHunkLine): DiffLine {
  const n = Number.isFinite(Number(line.n)) && Number(line.n) > 0
    ? Math.floor(Number(line.n))
    : null;
  return {
    type: line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'context',
    content: line.text,
    oldNum: line.kind === '+' ? null : n,
    newNum: line.kind === '-' ? null : n,
  };
}

function splitPatchLineToDiffLine(line: SplitPatchLineData, side: 'left' | 'right'): DiffLine {
  const n = Number.isFinite(Number(line.n)) && Number(line.n) > 0
    ? Math.floor(Number(line.n))
    : null;
  return {
    type: line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'context',
    content: line.text,
    oldNum: side === 'left' ? n : null,
    newNum: side === 'right' ? n : null,
  };
}

function getManualLineCommentSide(line: DiffHunkLine): 'LEFT' | 'RIGHT' {
  return line.kind === '-' ? 'LEFT' : 'RIGHT';
}

function ManualLineCommentCard({
  path,
  line,
  side,
  commentText,
  canEdit,
  isComposerOpen,
  onSave,
  onClear,
  onRequestClose,
}: {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  commentText: string;
  canEdit: boolean;
  isComposerOpen?: boolean;
  onSave?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClear?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  onRequestClose?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(commentText);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const normalizedComment = commentText.trim();
  const effectiveEditing = canEdit && (editing || Boolean(isComposerOpen));

  useEffect(() => {
    if (!effectiveEditing) {
      setDraft(commentText);
    }
  }, [commentText, effectiveEditing]);

  useEffect(() => {
    if (!effectiveEditing) return;
    window.requestAnimationFrame(() => {
      const node = textareaRef.current;
      node?.focus();
      const valueLength = node?.value.length ?? 0;
      node?.setSelectionRange(valueLength, valueLength);
    });
  }, [effectiveEditing]);

  if (!normalizedComment && !effectiveEditing) return null;

  return (
    <div
      data-review-comment-anchor="true"
      data-review-comment-file={path}
      data-review-comment-line={line}
      style={{
        margin: '6px 0 6px 64px',
        padding: '10px 12px',
        background: 'var(--review-card-bg)',
        border: '1px solid var(--review-shell-divider)',
        borderRadius: 8,
      }}
    >
      {effectiveEditing ? (
        <>
          <ManualLineCommentAuthor line={line} />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            style={{
              width: '100%',
              minHeight: 92,
              resize: 'vertical',
              background: 'var(--review-code-bg)',
              color: 'var(--text-primary)',
              border: '1px solid var(--review-shell-divider)',
              borderRadius: 6,
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={() => {
                const trimmed = draft.trim();
                if (!trimmed) return;
                onSave?.(path, line, trimmed, side);
                setEditing(false);
                onRequestClose?.();
              }}
              style={manualCommentButtonStyle('primary')}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(commentText);
                setEditing(false);
                onRequestClose?.();
              }}
              style={manualCommentButtonStyle('ghost')}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <ManualLineCommentAuthor line={line} />
          <div style={{
            fontSize: 12,
            color: 'var(--text-primary)',
            lineHeight: 1.5,
            fontFamily: 'var(--font-sans)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: canEdit ? 'var(--space-2)' : 0,
          }}>
            {normalizedComment}
          </div>
          {canEdit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => {
                  setDraft(commentText);
                  setEditing(true);
                }}
                style={manualCommentButtonStyle('ghost')}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  onClear?.(path, line, side);
                  setEditing(false);
                  onRequestClose?.();
                }}
                style={manualCommentButtonStyle('ghost')}
              >
                Remove
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function manualCommentButtonStyle(variant: 'primary' | 'ghost'): CSSProperties {
  return {
    minHeight: 24,
    padding: '0 8px',
    borderRadius: 6,
    border: '1px solid var(--review-shell-divider)',
    background: variant === 'primary' ? 'var(--accent-blue)' : 'var(--bg-surface)',
    color: variant === 'primary' ? '#fff' : 'var(--text-secondary)',
    fontSize: 10,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
  };
}
