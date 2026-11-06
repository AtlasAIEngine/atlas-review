/**
 * Shared ProjectCard component
 * Renders a project card with trust status, risk indicators, and quick actions.
 * Used by both TrustDashboard and HomePage for a consistent card appearance.
 *
 * Context-aware behavior:
 * - context="review": No secondary action icon. Click opens review view.
 * - context="build": Shows "Open in Builder" arrow for builder projects,
 *   or "Review" link for local/github review-only projects.
 */

import type { Project, BranchReview } from '@/types';
import { BranchIcon, WatchIcon } from './icons';
import { formatRelativeTime } from './utils';

/** Per-project trust summary — passed in by the parent that fetches it */
export interface ProjectTrustSummary {
  /** Changeset fields — only populated in the Builder context */
  totalChangesets?: number;
  reviewedCount?: number;
  unreviewedCount?: number;
  highRiskCount?: number;
  latestRisk?: string | null;
  branch: string | null;
  watching: boolean;
  // Branch review fields
  branchReviewCount?: number;
  branchReviewsUnreviewed?: number;
  branchReviewsHighRisk?: number;
  currentBranchReview?: BranchReview | null;
}

export type RiskColor = 'green' | 'yellow' | 'red' | 'gray';

export interface RiskStyleEntry {
  dot: string;
  bg: string;
  text: string;
  border: string;
  label: string;
}

function parseProjectCreatedAt(value: string | null | undefined): number | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const normalizedWithTimezone = hasExplicitTimezone ? normalized : `${normalized}Z`;
  const normalizedTs = new Date(normalizedWithTimezone).getTime();
  return Number.isFinite(normalizedTs) ? normalizedTs : null;
}

function hasMeaningfulCardSummary(summary: ProjectTrustSummary | undefined): boolean {
  if (!summary) return false;
  return Boolean(
    summary.branch
    || summary.watching
    || summary.currentBranchReview
    || (summary.totalChangesets ?? 0) > 0
    || (summary.reviewedCount ?? 0) > 0
    || (summary.unreviewedCount ?? 0) > 0
    || (summary.highRiskCount ?? 0) > 0
    || summary.latestRisk
    || (summary.branchReviewCount ?? 0) > 0
    || (summary.branchReviewsUnreviewed ?? 0) > 0
    || (summary.branchReviewsHighRisk ?? 0) > 0
  );
}

/** Map of risk color to visual properties */
export const riskStyles: Record<RiskColor, RiskStyleEntry> = {
  green: {
    dot: 'var(--accent-green)',
    bg: 'var(--chip-success-bg)',
    text: 'var(--accent-green)',
    border: 'var(--chip-success-border)',
    label: 'Clear',
  },
  yellow: {
    dot: 'var(--accent-yellow)',
    bg: 'var(--chip-warning-bg)',
    text: 'var(--accent-yellow)',
    border: 'var(--chip-warning-border)',
    label: 'Pending',
  },
  red: {
    dot: 'var(--accent-red)',
    bg: 'var(--chip-error-bg)',
    text: 'var(--accent-red)',
    border: 'var(--chip-error-border)',
    label: 'Risk',
  },
  gray: {
    dot: 'var(--text-tertiary)',
    bg: 'var(--review-chip-neutral-bg)',
    text: 'var(--text-tertiary)',
    border: 'var(--review-chip-neutral-border)',
    label: 'New',
  },
};

/** Compute risk color from a trust summary */
export function getRiskColor(summary: ProjectTrustSummary | undefined): RiskColor {
  if (!summary || ((summary.totalChangesets ?? 0) === 0 && !summary.branchReviewCount)) return 'gray';
  if ((summary.highRiskCount ?? 0) > 0 || (summary.branchReviewsHighRisk ?? 0) > 0) return 'red';
  if ((summary.unreviewedCount ?? 0) > 0 || (summary.branchReviewsUnreviewed ?? 0) > 0) return 'yellow';
  return 'green';
}

interface ProjectCardProps {
  project: Project;
  summary?: ProjectTrustSummary;
  /** True while summaries are being loaded (shows skeleton pill) */
  loadingSummary?: boolean;
  /** Which tab context this card is rendered in */
  context: 'review' | 'build';
  /** Project source origin — derived from project.source */
  projectSource?: 'builder' | 'local' | 'github';
  onClick: () => void;
  onSecondaryAction?: {
    label: string;
    onClick: () => void;
  };
  /** Called on right-click to open context menu */
  onRemove?: (e: React.MouseEvent) => void;
}

export function ProjectCard({
  project,
  summary,
  loadingSummary = false,
  context,
  projectSource,
  onClick,
  onSecondaryAction,
  onRemove,
}: ProjectCardProps) {
  const riskColor = getRiskColor(summary);
  const style = riskStyles[riskColor];

  // Determine the effective source for rendering decisions
  const source = projectSource || project.source || 'builder';
  const hasBuilderWorkspace = source === 'builder' || source === 'github';
  const metaTags = [project.framework, project.language, source === 'github' ? 'GitHub' : source === 'builder' ? 'Builder' : 'Local']
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const projectCreatedAtMs = parseProjectCreatedAt(project.createdAt);
  const isFreshProject = projectCreatedAtMs !== null && (Date.now() - projectCreatedAtMs) < 15000;
  const showSummaryLoadingState = (loadingSummary && !summary)
    || (!hasMeaningfulCardSummary(summary) && isFreshProject);

  // In build context, non-builder projects get a subtle border distinction
  const isReviewOnly = context === 'build' && !hasBuilderWorkspace;
  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        if (onRemove) {
          e.preventDefault();
          onRemove(e);
        }
      }}
      style={{
        background: 'var(--review-card-bg)',
        border: `1px solid ${isReviewOnly ? 'var(--review-shell-border)' : 'var(--review-shell-border)'}`,
        borderRadius: 14,
        padding: 'var(--space-4)',
        cursor: 'pointer',
        boxShadow: 'var(--review-panel-shadow)',
        transition: 'border-color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)';
        e.currentTarget.style.background = 'var(--review-card-hover)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--review-shell-border)';
        e.currentTarget.style.background = 'var(--review-card-bg)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Top row: name + risk pill */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{
            fontSize: 'var(--text-md)',
            fontWeight: 700,
            color: 'var(--text-primary)',
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {project.name}
          </h3>
          {summary?.branch && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginTop: 'var(--space-1)' }}>
              <BranchIcon />
              <span style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {summary.branch}
                {(summary.unreviewedCount ?? 0) > 0 ? (
                  <span style={{ color: 'var(--accent-yellow)', fontFamily: 'var(--font-sans)' }}>
                    {' \u00B7 '}{summary.unreviewedCount} unreviewed
                  </span>
                ) : ((summary.totalChangesets ?? 0) - (summary.reviewedCount ?? 0)) > 0 ? (
                  <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>
                    {' \u00B7 '}{(summary.totalChangesets ?? 0) - (summary.reviewedCount ?? 0)} pending
                  </span>
                ) : null}
              </span>
            </div>
          )}
          {showSummaryLoadingState && (
            <div style={{ display: 'grid', gap: 6, marginTop: 'var(--space-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                <BranchIcon />
                <div style={{
                  width: '54%',
                  height: 10,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-overlay)',
                  animation: 'skeleton-pulse 1.5s ease-in-out infinite',
                }} />
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: '0.02em' }}>
                Loading branch and review status...
              </span>
            </div>
          )}
          {summary?.currentBranchReview && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginTop: 2 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <path d="M6 21V9a9 9 0 009 9" />
              </svg>
              <span style={{
                fontSize: 10,
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {summary.currentBranchReview.branchName}
                {summary.currentBranchReview.reviewStatus === 'reviewed' ? (
                  <span style={{
                    fontFamily: 'var(--font-sans)',
                    color: summary.currentBranchReview.reviewRiskLevel === 'high' || summary.currentBranchReview.reviewRiskLevel === 'critical'
                      ? 'var(--accent-red)'
                      : summary.currentBranchReview.reviewRiskLevel === 'medium'
                        ? 'var(--accent-yellow)'
                        : 'var(--accent-green)',
                  }}>
                    {' \u00B7 '}{summary.currentBranchReview.reviewRiskLevel || 'reviewed'}
                  </span>
                ) : summary.currentBranchReview.reviewStatus === 'reviewing' || summary.currentBranchReview.reviewStatus === 'queued' ? (
                  <span style={{ fontFamily: 'var(--font-sans)', color: 'var(--accent-blue)' }}>
                    {' \u00B7 reviewing...'}
                  </span>
                ) : (
                  <span style={{ fontFamily: 'var(--font-sans)', color: 'var(--accent-yellow)' }}>
                    {' \u00B7 pending review'}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        {/* Risk indicator pill */}
        {loadingSummary && !summary ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            padding: '2px var(--space-2)',
            borderRadius: 'var(--radius-full)',
            background: riskStyles.gray.bg,
            border: `1px solid ${riskStyles.gray.border}`,
            flexShrink: 0,
            marginLeft: 'var(--space-3)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-tertiary)', opacity: 0.5 }} />
            <span style={{ width: 32, height: 12, background: 'var(--bg-overlay)', borderRadius: 'var(--radius-sm)' }} />
          </div>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            padding: '3px var(--space-2)',
            borderRadius: 'var(--radius-full)',
            background: style.bg,
            border: `1px solid ${style.border}`,
            flexShrink: 0,
            marginLeft: 'var(--space-3)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: style.dot }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: style.text }}>
              {style.label}
            </span>
          </div>
        )}
      </div>

      {/* Stats row */}
      {summary && ((summary.totalChangesets ?? 0) > 0 || (summary.branchReviewCount ?? 0) > 0) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-secondary)',
          marginBottom: 'var(--space-3)',
        }}>
          {(summary.totalChangesets ?? 0) > 0 && (
            <span>{summary.totalChangesets} CS{summary.totalChangesets !== 1 ? 's' : ''}</span>
          )}
          {(summary.branchReviewCount ?? 0) > 0 && (
            <span>{summary.branchReviewCount} BR{(summary.branchReviewCount ?? 0) !== 1 ? 's' : ''}</span>
          )}
          {((summary.unreviewedCount ?? 0) + (summary.branchReviewsUnreviewed ?? 0)) > 0 && (
            <span style={{ color: 'var(--accent-yellow)' }}>
              {(summary.unreviewedCount ?? 0) + (summary.branchReviewsUnreviewed ?? 0)} pending
            </span>
          )}
          {((summary.highRiskCount ?? 0) + (summary.branchReviewsHighRisk ?? 0)) > 0 && (
            <span style={{ color: 'var(--accent-red)' }}>
              {(summary.highRiskCount ?? 0) + (summary.branchReviewsHighRisk ?? 0)} high risk
            </span>
          )}
        </div>
      )}
      {showSummaryLoadingState && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-3)',
        }}>
          <div style={{
            width: 52,
            height: 10,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-overlay)',
            animation: 'skeleton-pulse 1.5s ease-in-out infinite',
          }} />
          <div style={{
            width: 44,
            height: 10,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-overlay)',
            animation: 'skeleton-pulse 1.5s ease-in-out infinite',
          }} />
        </div>
      )}

      {/* Bottom row: activity + badges + action */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', minWidth: 0 }}>
          {metaTags.length > 0 ? metaTags.map((tag) => (
            <span
              key={tag}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '1px 6px',
                borderRadius: 999,
                background: 'var(--review-chip-neutral-bg)',
                border: '1px solid var(--review-chip-neutral-border)',
                fontSize: 9,
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              {tag}
            </span>
          )) : (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              {formatRelativeTime(project.lastModified || project.lastAccessed || project.updatedAt)}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {!metaTags.length && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              {formatRelativeTime(project.lastModified || project.lastAccessed || project.updatedAt)}
            </span>
          )}
          {summary?.watching && (
            <span
              title="Auto-review on"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
                background: 'var(--chip-info-bg)',
                border: `1px solid var(--chip-info-border)`,
                borderRadius: 999,
                fontSize: 10,
                color: 'var(--accent-blue)',
                fontWeight: 700,
              }}
            >
              <WatchIcon />
              <span>Auto</span>
            </span>
          )}
          {showSummaryLoadingState && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
                background: 'var(--review-chip-neutral-bg)',
                border: '1px solid var(--review-chip-neutral-border)',
                borderRadius: 999,
                fontSize: 10,
                color: 'var(--text-tertiary)',
                fontWeight: 700,
              }}
            >
              Syncing
            </span>
          )}

          {/* Context-aware secondary action */}
          {context === 'review' ? (
            // Review tab: no secondary action — card click opens review
            null
          ) : context === 'build' && !hasBuilderWorkspace ? (
            // Build tab, review-only project: "Review" text link
            <span
              title="This project was imported for review. Open in Review tab."
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                transition: 'color var(--transition-fast)',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
            >
              Review &rarr;
            </span>
          ) : onSecondaryAction ? (
            // Build tab, builder project: arrow icon to open in Builder
            <button
              type="button"
              title={onSecondaryAction.label}
              onClick={(e) => {
                e.stopPropagation();
                onSecondaryAction.onClick();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                borderRadius: 'var(--radius-sm)',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                transition: 'color var(--transition-fast)',
                padding: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6" />
                <path d="M10 14L21 3" />
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
