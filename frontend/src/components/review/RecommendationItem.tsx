/**
 * RecommendationItem — Direction C spec. Accent left-bar on selection
 * (no fill). Action row: Addressed · Dismiss · Copy (icon).
 * Apply-fix and Note actions live on the inline AI-comment callout
 * beside the diff. Comment-in-diff is removed; clicking the card body
 * navigates to the diff.
 */

import { useEffect, useState } from 'react';
import type { ReviewFixRecommendationStatus, ReviewRecommendation } from '@/types';
import type { DiffNavigationTarget } from '@/utils/reviewNavigation';
import {
  formatRecommendationSourceLocation,
  getRecommendationDiffNavigationTarget,
} from '@/utils/reviewNavigation';
import {
  normalizeRecommendationSeverity,
  copyTextToClipboard,
  buildRecommendationCopyText,
  sanitizeRecommendationDescription,
  getVisibleRecommendationFixStatusLabel,
} from './reviewPanelUtils';
import type {
  RecommendationNoteDraft,
  RecommendationResolutionState,
  RecommendationResolutionEntry,
  RecommendationVerificationState,
} from './reviewPanelUtils';
import { SevChip } from './primitives';
import type { SevLevel } from './primitives';

const SEV_TO_LEVEL: Record<'critical' | 'high' | 'medium' | 'low', SevLevel> = {
  critical: 'HIGH',
  high:     'HIGH',
  medium:   'MED',
  low:      'LOW',
};

// TODO(walkthrough): Apply fix on inline callout — remove from card when
// the inline AI-comment callout ships in the Walkthrough phase.

export function RecommendationItem({
  index,
  rec,
  resolution,
  fixStatus,
  verificationState: _verificationState,
  note: _note,
  canManageNote: _canManageNote = false,
  isExpanded: _isExpanded,
  isSelected,
  onSetResolution,
  onClearResolution,
  onEditNote: _onEditNote,
  onClearNote: _onClearNote,
  onMarkStillOpen: _onMarkStillOpen,
  onRunVerificationReview: _onRunVerificationReview,
  onAskAgent,
  onSelect,
  onJump,
  onToggle: _onToggle,
}: {
  index: number;
  rec: ReviewRecommendation;
  resolution: RecommendationResolutionEntry | null;
  fixStatus?: ReviewFixRecommendationStatus | null;
  verificationState?: RecommendationVerificationState | null;
  note?: RecommendationNoteDraft | null;
  canManageNote?: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  onSetResolution: (rec: ReviewRecommendation, state: RecommendationResolutionState, note?: string) => void;
  onClearResolution: (rec: ReviewRecommendation) => void;
  onEditNote?: (rec: ReviewRecommendation) => void;
  onClearNote?: (rec: ReviewRecommendation) => void;
  onMarkStillOpen?: (rec: ReviewRecommendation) => void;
  onRunVerificationReview?: (rec: ReviewRecommendation) => void;
  onAskAgent?: (rec: ReviewRecommendation) => void;
  onSelect: () => void;
  onJump: (target: DiffNavigationTarget | null) => void;
  onToggle: () => void;
}) {
  const displaySeverity = normalizeRecommendationSeverity(rec);
  const sevLevel = SEV_TO_LEVEL[displaySeverity];
  const hasDescription = Boolean(sanitizeRecommendationDescription(rec.description));
  const hasSuggestedFix = Boolean(rec.suggestedFix);
  const locationTarget = getRecommendationDiffNavigationTarget(rec);
  const sourceLocationLabel = formatRecommendationSourceLocation(rec);
  const compactSourceLocationLabel = formatCompactLocationLabel(sourceLocationLabel);

  const [recCopyState, setRecCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const isAddressed = resolution?.state === 'addressed';
  const isDismissed = resolution?.state === 'dismissed';
  const fixStatusLabel = String(fixStatus || '').trim();
  const visibleFixStatusLabel = getVisibleRecommendationFixStatusLabel(fixStatus);
  const findingId = String(rec.findingId || '').trim();

  useEffect(() => {
    if (recCopyState === 'idle') return;
    const timerId = window.setTimeout(() => setRecCopyState('idle'), 2000);
    return () => window.clearTimeout(timerId);
  }, [recCopyState]);

  return (
    <div
      data-review-rec-index={index}
      onClick={() => {
        onSelect();
        if (locationTarget) onJump(locationTarget);
      }}
      style={{
        padding: '10px 14px 12px',
        borderLeft: `2px solid ${isSelected ? 'var(--accent-blue)' : 'transparent'}`,
        borderBottom: '1px solid var(--review-shell-divider)',
        background: 'transparent',
        cursor: 'pointer',
        transition: 'border-left-color var(--transition-fast)',
      }}
    >
      {/* Header: finding id, severity chip, proposed-fix chip, fix-status chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        {findingId && (
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-tertiary)',
              padding: '2px 6px',
              borderRadius: 3,
              background: 'var(--review-chip-neutral-bg)',
              border: '1px solid var(--review-chip-neutral-border)',
            }}
          >
            {findingId}
          </span>
        )}
        <SevChip level={sevLevel} />
        {hasSuggestedFix && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.3,
              color: 'var(--accent-blue)',
              padding: '2px 6px',
              borderRadius: 3,
              background: 'color-mix(in oklab, var(--accent-blue) 14%, transparent)',
              border: '1px solid color-mix(in oklab, var(--accent-blue) 30%, transparent)',
              textTransform: 'uppercase',
            }}
          >
            Proposed fix
          </span>
        )}
        {fixStatusLabel && visibleFixStatusLabel && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.3,
              color: fixStatusLabel === 'failed'
                ? 'var(--sev-high)'
                : fixStatusLabel === 'still_open'
                  ? 'var(--sev-med)'
                  : 'var(--accent-blue)',
              padding: '2px 6px',
              borderRadius: 3,
              background: 'var(--review-chip-neutral-bg)',
              border: '1px solid var(--review-chip-neutral-border)',
              textTransform: 'uppercase',
            }}
          >
            {visibleFixStatusLabel}
          </span>
        )}
        {resolution && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.3,
              color: resolution.state === 'addressed' ? 'var(--sev-ok)' : 'var(--sev-med)',
              padding: '2px 6px',
              borderRadius: 3,
              background: resolution.state === 'addressed'
                ? 'color-mix(in oklab, var(--sev-ok) 14%, transparent)'
                : 'color-mix(in oklab, var(--sev-med) 14%, transparent)',
              border: `1px solid color-mix(in oklab, ${resolution.state === 'addressed' ? 'var(--sev-ok)' : 'var(--sev-med)'} 30%, transparent)`,
              textTransform: 'uppercase',
            }}
          >
            {resolution.state}
          </span>
        )}
      </div>

      {/* Title */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          lineHeight: 1.4,
          marginBottom: hasDescription || rec.file ? 4 : 2,
        }}
      >
        {rec.title}
      </div>

      {sourceLocationLabel && (
        <div
          title={sourceLocationLabel}
          style={{
            fontSize: 10.5,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)',
            lineHeight: 1.35,
            marginBottom: isSelected ? 2 : 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {compactSourceLocationLabel}
        </div>
      )}

      {isSelected && (
        <>
        {/* Action row: Addressed · Dismiss · spacer · Copy (icon) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          marginTop: 'var(--space-2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <MiniBtn
          onClick={() => {
            if (isAddressed) {
              onClearResolution(rec);
            } else {
              onSetResolution(rec, 'addressed', resolution?.note);
            }
          }}
          variant="subtle"
          active={isAddressed}
          accent={isAddressed ? 'var(--sev-ok)' : undefined}
        >
          {isAddressed ? '\u2713 Addressed' : 'Addressed'}
        </MiniBtn>
        <MiniBtn
          onClick={() => {
            if (isDismissed) {
              onClearResolution(rec);
            } else {
              onSetResolution(rec, 'dismissed', resolution?.note);
            }
          }}
          variant="bare"
          active={isDismissed}
        >
          {isDismissed ? '\u2713 Dismissed' : 'Dismiss'}
        </MiniBtn>
        <div style={{ flex: 1 }} />
        {onAskAgent && (
          <button
            type="button"
            onClick={() => onAskAgent(rec)}
            aria-label="Ask Atlas about finding"
            title="Ask Atlas about this finding"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-muted)',
              color: 'var(--accent-blue)',
              cursor: 'pointer',
              padding: '3px 7px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 650,
            }}
          >
            Ask Atlas
          </button>
        )}
        <button
          type="button"
          onClick={async () => {
            const copied = await copyTextToClipboard(buildRecommendationCopyText(rec));
            setRecCopyState(copied ? 'copied' : 'failed');
          }}
          aria-label="Copy finding"
          title={recCopyState === 'copied' ? 'Copied' : recCopyState === 'failed' ? 'Copy failed' : 'Copy finding'}
          style={{
            background: 'transparent',
            border: 'none',
            color: recCopyState === 'copied'
              ? 'var(--sev-ok)'
              : recCopyState === 'failed'
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
            if (recCopyState !== 'idle') return;
            e.currentTarget.style.color = 'var(--text-secondary)';
            e.currentTarget.style.background = 'var(--bg-surface-raised)';
          }}
          onMouseLeave={(e) => {
            if (recCopyState !== 'idle') return;
            e.currentTarget.style.color = 'var(--text-tertiary)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          {recCopyState === 'copied' ? (
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

        </>
      )}
    </div>
  );
}

function formatCompactLocationLabel(location: string): string {
  const normalized = String(location || '').trim();
  if (!normalized) return '';

  const lineMatch = normalized.match(/^(.*?)(:\d+(?:-\d+)?)$/);
  const pathPart = lineMatch ? lineMatch[1] : normalized;
  const linePart = lineMatch ? lineMatch[2] : '';
  const pathSegments = pathPart.split('/').filter(Boolean);

  if (pathSegments.length <= 2) return normalized;

  const root = pathSegments[0];
  const fileName = pathSegments[pathSegments.length - 1];
  return `${root}/.../${fileName}${linePart}`;
}

/** Compact button matching Btn primitive dimensions but without forcing a fill on the selected state. */
function MiniBtn({
  children,
  onClick,
  variant = 'bare',
  active = false,
  disabled = false,
  accent,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: 'ghost' | 'subtle' | 'bare';
  active?: boolean;
  disabled?: boolean;
  accent?: string;
  title?: string;
}) {
  const base = {
    height: 24,
    padding: '0 8px',
    borderRadius: 4,
    fontFamily: 'var(--font-ui)',
    fontSize: 11,
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    border: '1px solid transparent',
    transition: 'background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
  } as const;

  const variants = {
    ghost: {
      background: 'transparent',
      color: active ? (accent || 'var(--accent-blue)') : 'var(--text-primary)',
      borderColor: 'var(--border-default)',
    },
    subtle: {
      background: active ? 'color-mix(in oklab, var(--sev-ok) 14%, transparent)' : 'var(--bg-surface-raised)',
      color: active ? (accent || 'var(--sev-ok)') : 'var(--text-primary)',
      borderColor: active ? `color-mix(in oklab, ${accent || 'var(--sev-ok)'} 30%, transparent)` : 'transparent',
    },
    bare: {
      background: 'transparent',
      color: active ? (accent || 'var(--sev-med)') : 'var(--text-secondary)',
      borderColor: 'transparent',
    },
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ ...base, ...variants[variant] }}
    >
      {children}
    </button>
  );
}
