/**
 * InlineComments — Shared inline AI comment component for diff views.
 * Renders recommendation annotations between diff lines.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffLine } from '@/utils/diff';
import type { ReviewRecommendation } from '@/types';
import {
  getRecommendationPatchFile,
  getRecommendationPatchLine,
  getRecommendationSourceFile,
  resolveRecommendationDisplayAnchor,
  type RecommendationDisplayAnchorMode,
} from '@/utils/reviewNavigation';
import { resolveCanonicalReviewPath } from '@/utils/reviewPathMatching';
import { Btn, SevChip } from './primitives';
import type { SevLevel } from './primitives';
import {
  buildRecommendationCopyText,
  copyTextToClipboard,
  normalizeRecommendationSeverity,
} from './reviewPanelUtils';

// ── Severity / tag helpers (Direction C visual language) ─────────────

const SEV_VAR: Record<SevLevel, string> = {
  HIGH: 'var(--sev-high)',
  MED: 'var(--sev-med)',
  LOW: 'var(--sev-low)',
};

function recSevLevel(rec: ReviewRecommendation): SevLevel {
  const s = normalizeRecommendationSeverity(rec);
  if (s === 'critical' || s === 'high') return 'HIGH';
  if (s === 'medium') return 'MED';
  return 'LOW';
}

function recCategoryTag(rec: ReviewRecommendation, sev: SevLevel): string {
  const explicit = String((rec as { category?: unknown }).category || '').trim();
  if (explicit) return explicit;
  return sev === 'HIGH' ? 'Risk' : sev === 'MED' ? 'Concern' : 'Note';
}

// ── Build commentsByLine map ────────────────────────────────────────

export function buildCommentsByLine(
  recommendations: ReviewRecommendation[] | undefined | null,
  filePath: string,
  renderedLineNumbers?: Iterable<number | null | undefined> | null,
  canonicalPathLookup?: Map<string, string> | null,
): Map<number, Array<{ rec: ReviewRecommendation; mode: RecommendationDisplayAnchorMode; sourceLine: number | null }>> {
  if (!recommendations || !filePath) return new Map();
  const canonicalFilePath = canonicalPathLookup
    ? (resolveCanonicalReviewPath(filePath, canonicalPathLookup) || filePath)
    : filePath;
  const fileRecs = recommendations.filter(
    (r) => {
      const anchoredFile = getRecommendationPatchFile(r) || getRecommendationSourceFile(r);
      if (!anchoredFile) return false;
      const canonicalAnchoredFile = canonicalPathLookup
        ? (resolveCanonicalReviewPath(anchoredFile, canonicalPathLookup) || anchoredFile)
        : anchoredFile;
      return canonicalAnchoredFile === canonicalFilePath;
    },
  );
  const map = new Map<number, Array<{ rec: ReviewRecommendation; mode: RecommendationDisplayAnchorMode; sourceLine: number | null }>>();
  for (const rec of fileRecs) {
    const displayAnchor = resolveRecommendationDisplayAnchor(rec, renderedLineNumbers);
    if (!displayAnchor?.line || displayAnchor.mode === 'source-only') continue;
    const existing = map.get(displayAnchor.line) || [];
    existing.push({
      rec,
      mode: displayAnchor.mode,
      sourceLine: displayAnchor.sourceLine,
    });
    map.set(displayAnchor.line, existing);
  }
  return map;
}

// ── InlineComments component ────────────────────────────────────────

export interface InlineCommentsProps {
  line: DiffLine;
  commentsByLine: Map<number, Array<{ rec: ReviewRecommendation; mode: RecommendationDisplayAnchorMode; sourceLine: number | null }>>;
  dismissedComments: Set<string>;
  collapsedComments: Set<string>;
  getResolution?: (rec: ReviewRecommendation) => 'addressed' | 'dismissed' | null | undefined;
  getPendingOutcome?: (rec: ReviewRecommendation) => 'addressed' | 'dismissed' | null | undefined;
  canComment?: boolean;
  commentDisabledReason?: string | null;
  getComment?: (rec: ReviewRecommendation) => string;
  onSaveComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearComment?: (rec: ReviewRecommendation) => void;
  canAddNote?: boolean;
  getNote?: (rec: ReviewRecommendation) => string;
  onSaveNote?: (rec: ReviewRecommendation, note: string) => void;
  onClearNote?: (rec: ReviewRecommendation) => void;
  onDismiss: (rec: ReviewRecommendation) => void;
  onToggleCollapse: (rec: ReviewRecommendation) => void;
  onAskAgent?: (rec: ReviewRecommendation) => void;
}

export interface InlineCommentCardProps {
  rec: ReviewRecommendation;
  mode: RecommendationDisplayAnchorMode;
  sourceLine: number | null;
  isCollapsed: boolean;
  resolvedAs?: 'addressed' | 'dismissed' | null;
  pendingOutcome?: 'addressed' | 'dismissed' | null;
  onDismiss: (rec: ReviewRecommendation) => void;
  onToggleCollapse: (rec: ReviewRecommendation) => void;
  canComment?: boolean;
  commentDisabledReason?: string | null;
  commentText?: string;
  onSaveComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearComment?: (rec: ReviewRecommendation) => void;
  canAddNote?: boolean;
  noteText?: string;
  onSaveNote?: (rec: ReviewRecommendation, note: string) => void;
  onClearNote?: (rec: ReviewRecommendation) => void;
  hideDismiss?: boolean;
  hideCollapse?: boolean;
  anchorHint?: string | null;
  onAskAgent?: (rec: ReviewRecommendation) => void;
}

export function getInlineCommentAnchorLine(line: Pick<DiffLine, 'newNum'> | null | undefined): number | null {
  const lineNum = Number(line?.newNum);
  return Number.isFinite(lineNum) && lineNum > 0 ? Math.floor(lineNum) : null;
}

export function InlineCommentCard({
  rec,
  mode: _mode,
  sourceLine,
  isCollapsed,
  resolvedAs = null,
  pendingOutcome = null,
  onDismiss,
  onToggleCollapse: _onToggleCollapse,
  canComment = false,
  commentDisabledReason,
  commentText,
  onSaveComment,
  onClearComment,
  canAddNote = false,
  noteText,
  onSaveNote,
  onClearNote,
  hideDismiss = false,
  hideCollapse: _hideCollapse = false,
  anchorHint: _anchorHint,
  onAskAgent,
}: InlineCommentCardProps) {
  const sev = recSevLevel(rec);
  const tag = recCategoryTag(rec, sev);
  const lineRef = getRecommendationPatchLine(rec) ?? sourceLine ?? null;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const timerId = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timerId);
  }, [copyState]);
  const outcomeLabel = resolvedAs === 'addressed'
    ? 'Addressed'
    : resolvedAs === 'dismissed'
      ? 'Dismissed'
      : pendingOutcome === 'addressed'
        ? 'Addressing...'
        : pendingOutcome === 'dismissed'
          ? 'Dismissing...'
          : null;
  const outcomeColor = resolvedAs === 'addressed' || pendingOutcome === 'addressed'
    ? 'var(--sev-ok)'
    : 'var(--text-tertiary)';

  const normalizedCommentText = typeof commentText === 'string' ? commentText.trim() : '';
  const hasComment = normalizedCommentText.length > 0;
  const [isEditingComment, setIsEditingComment] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const commentTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const normalizedNoteText = typeof noteText === 'string' ? noteText.trim() : '';
  const hasNote = normalizedNoteText.length > 0;
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isEditingComment) setCommentDraft(normalizedCommentText);
  }, [isEditingComment, normalizedCommentText]);

  useEffect(() => {
    if (!isEditingNote) setNoteDraft(normalizedNoteText);
  }, [isEditingNote, normalizedNoteText]);

  useEffect(() => {
    if (!isEditingComment) return;
    window.requestAnimationFrame(() => {
      const node = commentTextareaRef.current;
      node?.focus();
      const len = node?.value.length ?? 0;
      node?.setSelectionRange(len, len);
    });
  }, [isEditingComment]);

  useEffect(() => {
    if (!isEditingNote) return;
    window.requestAnimationFrame(() => {
      const node = noteTextareaRef.current;
      node?.focus();
      const len = node?.value.length ?? 0;
      node?.setSelectionRange(len, len);
    });
  }, [isEditingNote]);

  return (
    <div
      data-review-comment-anchor="true"
      data-ai-comment-card
      data-review-comment-file={getRecommendationSourceFile(rec) || ''}
      data-review-comment-line={getRecommendationPatchLine(rec) ?? sourceLine ?? undefined}
      style={{
        margin: '6px 0',
        background: 'var(--bg-surface)',
        border: '1px solid var(--review-shell-divider)',
        borderLeft: `2px solid ${SEV_VAR[sev]}`,
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {/* Header: AI sparkle · severity · tag · spacer · L{line} · close × */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '10px 14px 2px',
      }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10.5,
            fontWeight: 600,
            color: 'var(--accent-blue)',
            letterSpacing: 0.3,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 1 L9.2 5.5 L13.5 6.5 L10 9.3 L11 13.5 L8 11 L5 13.5 L6 9.3 L2.5 6.5 L6.8 5.5 Z" />
          </svg>
          AI
        </span>
        <SevChip level={sev} />
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 600,
          }}
        >
          {tag}
        </span>
        {outcomeLabel && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 7px',
              borderRadius: 999,
              border: `1px solid color-mix(in oklab, ${outcomeColor} 32%, transparent)`,
              background: `color-mix(in oklab, ${outcomeColor} 10%, transparent)`,
              color: outcomeColor,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.2,
            }}
          >
            {(resolvedAs || pendingOutcome) && (
              <span aria-hidden="true">{resolvedAs ? '\u2713' : '\u2022'}</span>
            )}
            {outcomeLabel}
          </span>
        )}
        {isCollapsed && (
          <span style={{
            fontSize: 11.5,
            color: 'var(--text-secondary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {rec.title}
          </span>
        )}
        {!isCollapsed && <div style={{ flex: 1 }} />}
        {lineRef != null && (
          <span
            style={{
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            L{lineRef}
          </span>
        )}
        {!hideDismiss && (
          <button
            type="button"
            onClick={() => onDismiss(rec)}
            title="Hide"
            aria-label="Hide finding"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              padding: 2,
              display: 'inline-flex',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        )}
      </div>

      {!isCollapsed && (
        <div style={{ padding: '6px 14px 12px' }}>
          <div style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text-primary)',
            marginBottom: rec.description ? 6 : 8,
            lineHeight: 1.4,
          }}>
            {rec.title}
          </div>
          {rec.description && (
            <div style={{
              fontSize: 11.5,
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
              marginBottom: rec.suggestedFix ? 8 : 10,
            }}>
              {rec.description}
            </div>
          )}
          {rec.suggestedFix && (
            <div style={{ marginBottom: 10 }}>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  color: 'var(--text-tertiary)',
                  marginBottom: 4,
                }}
              >
                Suggested fix
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  background: 'var(--review-code-bg)',
                  border: '1px solid var(--border-muted)',
                  borderRadius: 4,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10.5,
                  color: 'var(--text-secondary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  lineHeight: 1.5,
                  overflow: 'auto',
                  maxHeight: 200,
                }}
              >
                {rec.suggestedFix}
              </pre>
            </div>
          )}
          {hasComment && !isEditingComment && (
            <div style={{
              marginBottom: 10,
              padding: 10,
              borderRadius: 4,
              background: 'color-mix(in oklab, var(--accent-blue) 6%, transparent)',
              border: '1px solid color-mix(in oklab, var(--accent-blue) 30%, transparent)',
            }}>
              <div style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--accent-blue)',
                marginBottom: 4,
              }}>
                Your comment
              </div>
              <div style={{
                fontSize: 11.5,
                color: 'var(--text-primary)',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {normalizedCommentText}
              </div>
            </div>
          )}

          {hasNote && !isEditingNote && (
            <div style={{
              marginBottom: 10,
              padding: 10,
              borderRadius: 4,
              background: 'color-mix(in oklab, var(--sev-med) 6%, transparent)',
              border: '1px solid color-mix(in oklab, var(--sev-med) 30%, transparent)',
            }}>
              <div style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--sev-med)',
                marginBottom: 4,
              }}>
                Private note
              </div>
              <div style={{
                fontSize: 11.5,
                color: 'var(--text-primary)',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {normalizedNoteText}
              </div>
            </div>
          )}

          {isEditingComment && canComment && (
            <div style={{
              marginBottom: 10,
              padding: 10,
              borderRadius: 4,
              background: 'color-mix(in oklab, var(--accent-blue) 6%, transparent)',
              border: '1px solid color-mix(in oklab, var(--accent-blue) 30%, transparent)',
            }}>
              <div style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--accent-blue)',
                marginBottom: 6,
              }}>
                Your comment
              </div>
              <textarea
                ref={commentTextareaRef}
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Add your PR comment"
                rows={4}
                style={{
                  width: '100%',
                  resize: 'vertical',
                  minHeight: 80,
                  borderRadius: 4,
                  border: '1px solid var(--review-shell-divider)',
                  background: 'var(--review-code-bg)',
                  color: 'var(--text-primary)',
                  padding: '8px 10px',
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  fontFamily: 'var(--font-sans)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <Btn
                  variant="primary"
                  size="sm"
                  disabled={!commentDraft.trim()}
                  onClick={() => {
                    const trimmed = commentDraft.trim();
                    if (!trimmed) return;
                    onSaveComment?.(rec, trimmed);
                    setIsEditingComment(false);
                  }}
                >
                  Save comment
                </Btn>
                <Btn
                  variant="bare"
                  size="sm"
                  onClick={() => {
                    setCommentDraft(normalizedCommentText);
                    setIsEditingComment(false);
                  }}
                >
                  Cancel
                </Btn>
              </div>
            </div>
          )}

          {isEditingNote && canAddNote && (
            <div style={{
              marginBottom: 10,
              padding: 10,
              borderRadius: 4,
              background: 'color-mix(in oklab, var(--sev-med) 6%, transparent)',
              border: '1px solid color-mix(in oklab, var(--sev-med) 30%, transparent)',
            }}>
              <div style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--sev-med)',
                marginBottom: 6,
              }}>
                Private note
              </div>
              <textarea
                ref={noteTextareaRef}
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Add a private note for this finding"
                rows={4}
                style={{
                  width: '100%',
                  resize: 'vertical',
                  minHeight: 80,
                  borderRadius: 4,
                  border: '1px solid var(--review-shell-divider)',
                  background: 'var(--review-code-bg)',
                  color: 'var(--text-primary)',
                  padding: '8px 10px',
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  fontFamily: 'var(--font-sans)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <Btn
                  variant="primary"
                  size="sm"
                  accent="var(--sev-med)"
                  disabled={!noteDraft.trim()}
                  onClick={() => {
                    const trimmed = noteDraft.trim();
                    if (!trimmed) return;
                    onSaveNote?.(rec, trimmed);
                    setIsEditingNote(false);
                  }}
                >
                  Save note
                </Btn>
                <Btn
                  variant="bare"
                  size="sm"
                  onClick={() => {
                    setNoteDraft(normalizedNoteText);
                    setIsEditingNote(false);
                  }}
                >
                  Cancel
                </Btn>
              </div>
            </div>
          )}

          {/* TODO(apply-fix): restore an Apply-fix button once a per-finding
              endpoint exists. The fix pipeline is multi-finding socket
              orchestration today, so the inline button stays hidden until
              wiring lands. */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {onAskAgent && (
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => onAskAgent(rec)}
              >
                Ask Atlas
              </Btn>
            )}
            {onSaveComment && (
              <Btn
                variant="ghost"
                size="sm"
                disabled={!canComment}
                title={!canComment ? (commentDisabledReason || 'Comments are unavailable in this review.') : undefined}
                onClick={() => {
                  if (!canComment) return;
                  setCommentDraft(normalizedCommentText);
                  setIsEditingComment(true);
                }}
              >
                {hasComment ? 'Edit comment' : 'Comment'}
              </Btn>
            )}
            {hasComment && onClearComment && (
              <Btn
                variant="bare"
                size="sm"
                onClick={() => {
                  onClearComment(rec);
                  setCommentDraft('');
                  setIsEditingComment(false);
                }}
              >
                Remove comment
              </Btn>
            )}
            {onSaveNote && canAddNote && (
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNoteDraft(normalizedNoteText);
                  setIsEditingNote(true);
                }}
              >
                {hasNote ? 'Edit note' : 'Note'}
              </Btn>
            )}
            {hasNote && onClearNote && (
              <Btn
                variant="bare"
                size="sm"
                onClick={() => {
                  onClearNote(rec);
                  setNoteDraft('');
                  setIsEditingNote(false);
                }}
              >
                Remove note
              </Btn>
            )}
            <button
              type="button"
              onClick={async () => {
                const copied = await copyTextToClipboard(buildRecommendationCopyText(rec));
                setCopyState(copied ? 'copied' : 'failed');
              }}
              aria-label="Copy finding"
              title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy finding'}
              style={{
                background: 'transparent',
                border: 'none',
                color: copyState === 'copied'
                  ? 'var(--sev-ok)'
                  : copyState === 'failed'
                    ? 'var(--sev-high)'
                    : 'var(--text-tertiary)',
                cursor: 'pointer',
                padding: 4,
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 3,
                transition: 'color var(--transition-fast), background var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                if (copyState !== 'idle') return;
                e.currentTarget.style.color = 'var(--text-secondary)';
                e.currentTarget.style.background = 'var(--bg-surface-raised)';
              }}
              onMouseLeave={(e) => {
                if (copyState !== 'idle') return;
                e.currentTarget.style.color = 'var(--text-tertiary)';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {copyState === 'copied' ? (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="3 8 6 11 13 4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="5" y="5" width="9" height="9" rx="1.5" />
                  <path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" />
                </svg>
              )}
            </button>
          </div>

          {!canComment && commentDisabledReason && onSaveComment && (
            <div style={{
              marginTop: 10,
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              lineHeight: 1.5,
            }}>
              {commentDisabledReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function InlineComments({
  line,
  commentsByLine,
  dismissedComments,
  collapsedComments,
  canComment,
  commentDisabledReason,
  getComment,
  onSaveComment,
  onClearComment,
  getResolution,
  getPendingOutcome,
  canAddNote,
  getNote,
  onSaveNote,
  onClearNote,
  onDismiss,
  onToggleCollapse,
  onAskAgent,
}: InlineCommentsProps) {
  const lineNum = getInlineCommentAnchorLine(line);
  if (lineNum == null) return null;

  const comments = commentsByLine.get(lineNum);
  if (!comments || comments.length === 0) return null;

  return (
    <>
      {comments.map(({ rec, mode, sourceLine }, i) => {
        const key = rec.recommendationKey || `${getRecommendationSourceFile(rec)}-${sourceLine ?? 'none'}-${getRecommendationPatchLine(rec) ?? 'none'}-${rec.title}`;
        if (dismissedComments.has(key)) return null;
        const isCollapsed = collapsedComments.has(key);

        return (
          <div
            key={`comment-${lineNum}-${i}`}
            data-comment-line={lineNum}
            style={{
              margin: '0 0 0 calc(var(--line-num-width) * 2 + 4px)',
            }}
          >
            <InlineCommentCard
              rec={rec}
              mode={mode}
              sourceLine={sourceLine}
              isCollapsed={isCollapsed}
              resolvedAs={getResolution?.(rec) || null}
              pendingOutcome={getPendingOutcome?.(rec) || null}
              onDismiss={onDismiss}
              onToggleCollapse={onToggleCollapse}
              canComment={canComment && rec.type !== 'praise'}
              commentDisabledReason={rec.type !== 'praise' ? (commentDisabledReason || null) : null}
              commentText={getComment?.(rec)}
              onSaveComment={onSaveComment}
              onClearComment={onClearComment}
              canAddNote={canAddNote && rec.type !== 'praise'}
              noteText={getNote?.(rec)}
              onSaveNote={onSaveNote}
              onClearNote={onClearNote}
              onAskAgent={onAskAgent}
            />
          </div>
        );
      })}
    </>
  );
}

// ── Hook for building commentsByLine with useMemo ────────────────────

export function useCommentsByLine(
  recommendations: ReviewRecommendation[] | undefined | null,
  filePath: string | undefined | null,
  renderedLineNumbers?: Iterable<number | null | undefined> | null,
  canonicalPathLookup?: Map<string, string> | null,
): Map<number, Array<{ rec: ReviewRecommendation; mode: RecommendationDisplayAnchorMode; sourceLine: number | null }>> {
  return useMemo(
    () => buildCommentsByLine(recommendations, filePath || '', renderedLineNumbers, canonicalPathLookup),
    [recommendations, filePath, renderedLineNumbers, canonicalPathLookup],
  );
}
