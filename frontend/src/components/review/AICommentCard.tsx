/**
 * AICommentCard — inline AI-finding callout anchored into a diff hunk
 * stream, matching direction-c.jsx:1127-1162. Renders a 2px severity
 * left-bar, AI/sparkle + severity chip + category tag + line badge
 * header, bold title + dim description body, and an action row:
 * Apply fix · Comment · Dismiss · "Attached to line {n}".
 *
 * Apply-fix remains display-only for this phase (`TODO(apply-fix)`);
 * the existing fix-run pipeline is multi-finding orchestration routed
 * through a socket event in `TrustReviewPanel`, not a per-finding
 * endpoint, so wiring is deferred.
 */

import { useState } from 'react';
import type { ReviewRecommendation } from '@/types';
import { Btn, SevChip } from './primitives';
import type { SevLevel } from './primitives';
import { normalizeRecommendationSeverity, sanitizeRecommendationDescription } from './reviewPanelUtils';

const SEV_VAR: Record<SevLevel, string> = {
  HIGH: 'var(--sev-high)',
  MED: 'var(--sev-med)',
  LOW: 'var(--sev-low)',
};

export interface AICommentCardProps {
  finding: ReviewRecommendation;
  /** True when the card sits inside a split hunk; false for unanchored findings rendered at the end of a file section. */
  anchored?: boolean;
  /** Persisted outcome from the parent (controlled). When supplied, overrides the optimistic in-progress state. */
  resolvedAs?: 'addressed' | 'dismissed' | null;
  /** True while a persistOutcome call is in-flight for this finding. Disables both buttons but does not lock either label. */
  pendingOutcome?: 'addressed' | 'dismissed' | null;
  onApplyFix?: (rec: ReviewRecommendation) => void;
  onComment?: (rec: ReviewRecommendation) => void;
  onDismiss?: (rec: ReviewRecommendation) => void;
  onAddressed?: (rec: ReviewRecommendation) => void;
}

function toSevLevel(rec: ReviewRecommendation): SevLevel {
  const s = normalizeRecommendationSeverity(rec);
  if (s === 'critical' || s === 'high') return 'HIGH';
  if (s === 'medium') return 'MED';
  return 'LOW';
}

function deriveTag(rec: ReviewRecommendation, sev: SevLevel): string {
  const t = String((rec as { category?: unknown }).category || '').trim();
  if (t) return t;
  return sev === 'HIGH' ? 'Risk' : sev === 'MED' ? 'Concern' : 'Note';
}

export function AICommentCard({
  finding,
  anchored = true,
  resolvedAs = null,
  pendingOutcome = null,
  onApplyFix: _onApplyFix,
  onComment,
  onDismiss,
  onAddressed,
}: AICommentCardProps) {
  const [localCollapsed, setLocalCollapsed] = useState(false);
  // Persisted state from the parent wins; in-flight pending state is shown as a
  // disabled button without committing the ✓ label until the parent confirms.
  const isDismissed = resolvedAs === 'dismissed';
  const isAddressed = resolvedAs === 'addressed';
  const dismissPending = pendingOutcome === 'dismissed' && !isDismissed;
  const addressPending = pendingOutcome === 'addressed' && !isAddressed;
  const outcomeLabel = isAddressed
    ? 'Addressed'
    : isDismissed
      ? 'Dismissed'
      : addressPending
        ? 'Addressing...'
        : dismissPending
          ? 'Dismissing...'
          : null;
  const outcomeColor = isAddressed || addressPending ? 'var(--sev-ok)' : 'var(--text-tertiary)';

  if (localCollapsed) return null;

  const sev = toSevLevel(finding);
  const tag = deriveTag(finding, sev);
  const line = typeof finding.line === 'number' ? finding.line : null;
  const body = sanitizeRecommendationDescription(finding.description) || finding.description || '';

  const containerStyle: React.CSSProperties = {
    margin: anchored ? '6px 0' : '0',
    border: '1px solid var(--review-shell-divider)',
    borderLeft: `2px solid ${SEV_VAR[sev]}`,
    background: 'var(--bg-surface)',
    borderRadius: 4,
  };

  return (
    <div data-ai-comment-card style={containerStyle}>
      {/* Header row: AI · severity · tag · spacer · L{line} · dismiss × */}
      <div
        style={{
          padding: '10px 14px 2px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
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
            <span aria-hidden="true">{resolvedAs ? '\u2713' : '\u2022'}</span>
            {outcomeLabel}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {line != null && (
          <span
            style={{
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            L{line}
          </span>
        )}
        <button
          type="button"
          aria-label="Collapse finding"
          title="Collapse finding"
          onClick={() => setLocalCollapsed(true)}
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
      </div>

      {/* Body */}
      <div style={{ padding: '6px 14px 10px' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4, marginBottom: 6, color: 'var(--text-primary)' }}>
          {finding.title}
        </div>
        {body && (
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
            {body}
          </div>
        )}
        {/* TODO(apply-fix): restore an Apply-fix button once a per-finding
            endpoint exists. The fix pipeline is multi-finding socket
            orchestration today, so the inline button stays hidden until
            wiring lands. */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn variant="ghost" size="sm" onClick={() => onComment?.(finding)} disabled={!onComment}>
            Comment
          </Btn>
          <Btn
            variant="bare"
            size="sm"
            onClick={() => onDismiss?.(finding)}
            disabled={!onDismiss || isDismissed || dismissPending}
            title={isDismissed ? 'Dismissed' : dismissPending ? 'Saving…' : undefined}
          >
            {isDismissed ? '\u2713 Dismissed' : dismissPending ? 'Dismissing…' : 'Dismiss'}
          </Btn>
          <Btn
            variant="bare"
            size="sm"
            onClick={() => onAddressed?.(finding)}
            disabled={!onAddressed || isAddressed || addressPending}
            title={isAddressed ? 'Addressed' : addressPending ? 'Saving…' : undefined}
          >
            {isAddressed ? '\u2713 Addressed' : addressPending ? 'Saving…' : 'Addressed'}
          </Btn>
          <div style={{ flex: 1 }} />
          {line != null && (
            <span
              style={{
                fontSize: 10.5,
                color: 'var(--text-tertiary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="3 8 6 11 13 4" />
              </svg>
              {anchored ? `Attached to line ${line}` : `Line ${line} (outside diff)`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
