/**
 * PRCard — Direction C pull-request card for the Pull Requests swim lanes
 * (see `direction-c.jsx` `CPRCard`, lines 44–82).
 */

import type { CSSProperties } from 'react';
import { SevChip } from './primitives';

export interface PRCardData {
  id: string;
  /** Short identifier for the repo/project (for mono display). */
  repo: string;
  /** Human-facing repo label (e.g. project name) rendered in mono. */
  repoLabel: string;
  number: number;
  title: string;
  author: string;
  authorAvatarUrl?: string | null;
  additions: number;
  deletions: number;
  commentCount?: number;
  githubReviewDecision?: string | null;
  githubLatestReviewState?: string | null;
  githubReviewStateCounts?: Record<string, number>;
  relativeTime: string;
  high: number;
  med: number;
  low: number;
  status: 'open' | 'draft' | 'closed' | 'merged';
  isSelfAuthored?: boolean;
  requestedReviewers?: string[];
  generating?: boolean;
  clean?: boolean;
}

function SkeletonBar({
  width,
  height = 8,
  radius = 4,
  style,
}: {
  width: number | string;
  height?: number;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        width,
        height,
        borderRadius: radius,
        background: 'linear-gradient(90deg, var(--bg-hover) 0%, var(--bg-surface-raised) 45%, var(--bg-hover) 100%)',
        opacity: 0.62,
        animation: 'skeleton-pulse 1.5s ease-in-out infinite',
        animationDelay: 'inherit',
        ...style,
      }}
    />
  );
}

export function PRCardSkeleton({ delayMs = 0 }: { delayMs?: number }) {
  return (
    <div
      aria-hidden="true"
      data-pr-card-skeleton="true"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--review-shell-divider)',
        borderRadius: 5,
        padding: 12,
        marginBottom: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minHeight: 92,
        animationDelay: `${delayMs}ms`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <SkeletonBar width={12} height={12} radius={6} style={{ marginTop: 2, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <SkeletonBar width="34%" height={8} style={{ marginBottom: 8 }} />
          <SkeletonBar width="76%" height={12} />
        </div>
        <SkeletonBar width={24} height={8} style={{ flexShrink: 0 }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SkeletonBar width={18} height={18} radius={9} style={{ flexShrink: 0 }} />
        <SkeletonBar width="28%" height={9} />
        <div style={{ flex: 1 }} />
        <SkeletonBar width={56} height={9} style={{ flexShrink: 0 }} />
      </div>
      <SkeletonBar width="24%" height={9} />
    </div>
  );
}

function statusIconColor(status: PRCardData['status']): string {
  if (status === 'closed' || status === 'merged') return 'var(--text-tertiary)';
  if (status === 'draft') return 'var(--sev-med)';
  return 'var(--accent-blue)';
}

function reviewerAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=36`;
}

function normalizeReviewState(value: string | null | undefined): string {
  return String(value || '').trim().toUpperCase();
}

function getReviewStatusPill(pr: PRCardData): { label: string; color: string; bg: string } | null {
  const decision = normalizeReviewState(pr.githubReviewDecision);
  const latestState = normalizeReviewState(pr.githubLatestReviewState);
  const counts = pr.githubReviewStateCounts || {};
  if (decision === 'CHANGES_REQUESTED' || latestState === 'CHANGES_REQUESTED' || Number(counts.CHANGES_REQUESTED || 0) > 0) {
    return {
      label: 'Changes requested',
      color: 'var(--sev-high)',
      bg: 'color-mix(in oklab, var(--sev-high) 12%, transparent)',
    };
  }
  if (decision === 'APPROVED' || latestState === 'APPROVED' || Number(counts.APPROVED || 0) > 0) {
    return {
      label: 'Approved',
      color: 'var(--sev-ok)',
      bg: 'color-mix(in oklab, var(--sev-ok) 12%, transparent)',
    };
  }
  if (latestState === 'COMMENTED' || Number(counts.COMMENTED || 0) > 0) {
    return {
      label: 'Commented',
      color: 'var(--accent-blue)',
      bg: 'color-mix(in oklab, var(--accent-blue) 12%, transparent)',
    };
  }
  if (decision === 'REVIEW_REQUIRED') {
    return {
      label: 'Review pending',
      color: 'var(--sev-med)',
      bg: 'color-mix(in oklab, var(--sev-med) 12%, transparent)',
    };
  }
  return null;
}

interface PRCardProps {
  pr: PRCardData;
  onClick?: (pr: PRCardData) => void;
  selected?: boolean;
  laneKey?: string;
  onFocusPr?: (pr: PRCardData) => void;
  onNavigate?: (pr: PRCardData, delta: number) => void;
}

export function PRCard({ pr, onClick, selected = false, laneKey, onFocusPr, onNavigate }: PRCardProps) {
  const isClosed = pr.status === 'closed' || pr.status === 'merged';
  const reviewers = Array.isArray(pr.requestedReviewers)
    ? pr.requestedReviewers.map((login) => String(login || '').trim()).filter(Boolean)
    : [];
  const visibleReviewers = reviewers.slice(0, 3);
  const hiddenReviewerCount = Math.max(0, reviewers.length - visibleReviewers.length);
  const commentCount = Math.max(0, Math.trunc(Number(pr.commentCount) || 0));
  const reviewStatusPill = getReviewStatusPill(pr);
  const cardStyle: CSSProperties = {
    background: selected ? 'var(--bg-surface-raised)' : 'var(--bg-surface)',
    border: selected ? '1px solid var(--border-default)' : '1px solid var(--review-shell-divider)',
    borderRadius: 5,
    padding: 12,
    marginBottom: 8,
    cursor: onClick ? 'pointer' : 'default',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    fontFamily: 'var(--font-sans)',
    transition: 'border-color var(--transition-fast), background var(--transition-fast)',
  };

  return (
    <div
      role="button"
      tabIndex={onClick ? 0 : -1}
      data-pr-card-id={pr.id}
      data-pr-lane-key={laneKey}
      onClick={() => onClick?.(pr)}
      onFocus={() => onFocusPr?.(pr)}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(pr);
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') {
          e.preventDefault();
          onNavigate?.(pr, e.key === 'ArrowUp' || e.key.toLowerCase() === 'j' ? -1 : 1);
        }
      }}
      style={cardStyle}
      onMouseEnter={(e) => {
        if (!onClick) return;
        e.currentTarget.style.borderColor = 'var(--border-default)';
        e.currentTarget.style.background = 'var(--bg-surface-raised)';
      }}
      onMouseLeave={(e) => {
        if (!onClick) return;
        e.currentTarget.style.borderColor = selected ? 'var(--border-default)' : 'var(--review-shell-divider)';
        e.currentTarget.style.background = selected ? 'var(--bg-surface-raised)' : 'var(--bg-surface)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke={statusIconColor(pr.status)}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, marginTop: 2 }}
          aria-hidden="true"
        >
          <circle cx="4" cy="4" r="1.6" />
          <line x1="4" y1="5.6" x2="4" y2="10.4" />
          <circle cx="4" cy="12" r="1.6" />
          <path d="M12 6v-2a1.4 1.4 0 00-1.4-1.4H8" />
          <circle cx="12" cy="7" r="1.6" />
        </svg>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              marginBottom: 3,
            }}
          >
            {pr.repoLabel} <span style={{ color: 'var(--text-tertiary)' }}>#{pr.number}</span>
          </div>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              lineHeight: 1.35,
              color: isClosed ? 'var(--text-tertiary)' : 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {pr.title}
          </div>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {pr.generating && (
            <span
              style={{
                fontSize: 10.5,
                color: 'var(--accent-blue)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '2px 6px',
                border: '1px solid color-mix(in oklab, var(--accent-blue) 35%, transparent)',
                borderRadius: 3,
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 3,
                  background: 'var(--accent-blue)',
                  animation: 'atlas-pulse 1.2s ease-in-out infinite',
                }}
              />
              Reviewing
            </span>
          )}
          <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
            {pr.relativeTime}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {pr.authorAvatarUrl ? (
          <img
            src={pr.authorAvatarUrl}
            alt=""
            width={18}
            height={18}
            referrerPolicy="no-referrer"
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              flexShrink: 0,
              objectFit: 'cover',
              background: 'var(--bg-surface-raised)',
            }}
          />
        ) : (
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              background: 'var(--bg-surface-raised)',
              border: '1px solid var(--border-default)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              flexShrink: 0,
            }}
          >
            {String(pr.author || '?').slice(0, 1).toUpperCase()}
          </div>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pr.author}</span>
        <div style={{ flex: 1 }} />
        {visibleReviewers.length > 0 && (
          <div
            title={`Reviewers: ${reviewers.join(', ')}`}
            aria-label={`Reviewers: ${reviewers.join(', ')}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              flexShrink: 0,
              marginRight: 2,
            }}
          >
            {visibleReviewers.map((login, index) => (
              <img
                key={login}
                src={reviewerAvatarUrl(login)}
                alt=""
                title={login}
                width={18}
                height={18}
                referrerPolicy="no-referrer"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  objectFit: 'cover',
                  background: 'var(--bg-surface-raised)',
                  border: '1px solid var(--review-shell-divider)',
                  marginLeft: index === 0 ? 0 : -6,
                  boxShadow: '0 0 0 1px var(--bg-surface)',
                  flexShrink: 0,
                }}
              />
            ))}
            {hiddenReviewerCount > 0 && (
              <span
                title={`Additional reviewers: ${reviewers.slice(visibleReviewers.length).join(', ')}`}
                style={{
                  minWidth: 18,
                  height: 18,
                  padding: '0 4px',
                  borderRadius: 9,
                  marginLeft: -6,
                  border: '1px solid var(--review-shell-divider)',
                  background: 'var(--bg-surface-raised)',
                  color: 'var(--text-tertiary)',
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: '16px',
                  textAlign: 'center',
                  boxShadow: '0 0 0 1px var(--bg-surface)',
                  flexShrink: 0,
                }}
              >
                +{hiddenReviewerCount}
              </span>
            )}
          </div>
        )}
        <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
          <span style={{ color: 'var(--sev-ok)' }}>+{pr.additions}</span>{' '}
          <span style={{ color: 'var(--sev-high)' }}>{'\u2212'}{pr.deletions}</span>
        </span>
        {commentCount > 0 && (
          <span
            title={`${commentCount} GitHub ${commentCount === 1 ? 'comment' : 'comments'}`}
            aria-label={`${commentCount} GitHub ${commentCount === 1 ? 'comment' : 'comments'}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              flexShrink: 0,
              color: 'var(--text-tertiary)',
              fontSize: 10.5,
              fontFamily: 'var(--font-mono)',
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            >
              <path d="M3.5 4.2a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v3.6a2 2 0 0 1-2 2H7.2L4 12.7V9.8h-.5a2 2 0 0 1-2-2V4.2z" />
            </svg>
            {commentCount}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        {pr.high > 0 && <SevChip level="HIGH" count={pr.high} />}
        {pr.med > 0 && <SevChip level="MED" count={pr.med} />}
        {pr.low > 0 && <SevChip level="LOW" count={pr.low} />}
        {pr.clean && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--sev-ok)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {'\u2713'} Clean
          </span>
        )}
        {reviewStatusPill && !isClosed && (
          <span
            style={{
              fontSize: 10.5,
              color: reviewStatusPill.color,
              padding: '2px 6px',
              border: `1px solid ${reviewStatusPill.color}`,
              borderRadius: 3,
              background: reviewStatusPill.bg,
              fontWeight: 700,
            }}
          >
            {reviewStatusPill.label}
          </span>
        )}
        {(pr.status === 'merged' || pr.status === 'closed') && (
          <span
            style={{
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              padding: '2px 6px',
              border: '1px solid var(--border-default)',
              borderRadius: 3,
            }}
          >
            {pr.status === 'merged' ? 'Merged' : 'Closed'}
          </span>
        )}
      </div>
    </div>
  );
}
