import { useMemo } from 'react';
import type {
  TrustAnalyticsSummary,
  TrustAnalyticsTimeseries,
} from '@/types';
import { AnalyticsAreaChart, type AnalyticsAreaChartPoint } from './AnalyticsAreaChart';
import type { BreakdownSeriesMap } from './trustAnalyticsDashboardContent';
import { buildBreakdownCards } from './trustAnalyticsDashboardContent';

function formatBucketLabel(iso: string, interval: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (interval === 'hour') {
    return `${d.getUTCHours()}:00`;
  }
  const month = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `${month} ${d.getUTCDate()}`;
}

function toAreaPoints(series: TrustAnalyticsTimeseries | null): AnalyticsAreaChartPoint[] {
  if (!series?.points?.length) return [];
  return series.points.map((p) => ({
    value: p.value,
    label: formatBucketLabel(p.bucketStart, series.interval),
  }));
}

const cardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 'var(--space-2)',
  padding: 'var(--space-3)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--review-shell-border)',
  background: 'var(--review-card-bg)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

const bigNumberStyle: React.CSSProperties = {
  fontSize: 'var(--text-xl)',
  fontWeight: 700,
  color: 'var(--text-primary)',
  lineHeight: 1.1,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--text-secondary)',
};

interface AnalyticsOverviewTabProps {
  summary: TrustAnalyticsSummary;
  reviewCountSeries: TrustAnalyticsTimeseries | null;
  issuesFoundSeries: TrustAnalyticsTimeseries | null;
  breakdowns: BreakdownSeriesMap;
}

export function AnalyticsOverviewTab({
  summary,
  reviewCountSeries,
  issuesFoundSeries,
  breakdowns,
}: AnalyticsOverviewTabProps) {
  const reviewCountPoints = useMemo(() => toAreaPoints(reviewCountSeries), [reviewCountSeries]);
  const issuesFoundPoints = useMemo(() => toAreaPoints(issuesFoundSeries), [issuesFoundSeries]);
  const pathCards = useMemo(() => buildBreakdownCards(breakdowns.path_pattern), [breakdowns.path_pattern]);

  const branchCount = summary.scopeBreakdown.branchScopedCount;
  const prCount = summary.scopeBreakdown.prReviewCount;
  const findingsMetric = summary.hero.findingsFoundPerReview ?? summary.hero.issuesFoundPerReview;
  const totalFindings = findingsMetric.numerator;
  const findingsPerReview = findingsMetric.value;

  const addressedCount = summary.outcome.addressedCount;
  const dismissedCount = summary.outcome.dismissedCount;
  const pendingCount = Math.max(0, totalFindings - addressedCount - dismissedCount);
  const hasFindings = totalFindings > 0;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2, 1fr)',
      gap: 'var(--space-2)',
    }}>
      {/* Reviews Done */}
      <div style={cardStyle}>
        <span style={labelStyle}>Total Reviews</span>
        <span style={bigNumberStyle}>{summary.reviewCount}</span>
        <span style={subtitleStyle}>
          {branchCount} branch &middot; {prCount} PR review{prCount !== 1 ? 's' : ''}
        </span>
        <AnalyticsAreaChart points={reviewCountPoints} height={100} />
      </div>

      {/* Total Findings */}
      <div style={cardStyle}>
        <span style={labelStyle}>Total Findings</span>
        <span style={bigNumberStyle}>{totalFindings}</span>
        <span style={subtitleStyle}>
          ~{findingsPerReview != null ? findingsPerReview.toFixed(1) : '0'} per review
        </span>
        <AnalyticsAreaChart points={issuesFoundPoints} height={100} />
      </div>

      {/* Accept / Dismiss Ratio */}
      <div style={cardStyle}>
        <span style={labelStyle}>Accept / Dismiss</span>
        {hasFindings ? (
          <>
            <span style={bigNumberStyle}>
              {addressedCount} <span style={{ fontSize: 'var(--text-sm)', fontWeight: 400, color: 'var(--text-secondary)' }}>addressed</span>
              {' '}&middot;{' '}
              {dismissedCount} <span style={{ fontSize: 'var(--text-sm)', fontWeight: 400, color: 'var(--text-secondary)' }}>dismissed</span>
            </span>
            <span style={subtitleStyle}>{pendingCount} pending</span>
            {/* Stacked bar */}
            <div style={{ display: 'flex', height: 8, borderRadius: 'var(--radius-full)', overflow: 'hidden', background: 'var(--bg-surface)' }}>
              {addressedCount > 0 && (
                <div style={{
                  flex: addressedCount,
                  background: 'var(--accent-green)',
                  borderRadius: dismissedCount === 0 && pendingCount === 0 ? 'var(--radius-full)' : '4px 0 0 4px',
                }} />
              )}
              {dismissedCount > 0 && (
                <div style={{
                  flex: dismissedCount,
                  background: 'var(--accent-red)',
                }} />
              )}
              {pendingCount > 0 && (
                <div style={{
                  flex: pendingCount,
                  background: 'var(--border-muted)',
                  borderRadius: addressedCount === 0 && dismissedCount === 0 ? 'var(--radius-full)' : '0 4px 4px 0',
                }} />
              )}
            </div>
          </>
        ) : (
          <span style={{ ...subtitleStyle, paddingTop: 'var(--space-2)' }}>
            No findings yet
          </span>
        )}
      </div>

      {/* Path Hotspots */}
      <div style={cardStyle}>
        <span style={labelStyle}>Path Hotspots</span>
        {pathCards.length === 0 ? (
          <span style={subtitleStyle}>No path segments yet.</span>
        ) : (
          pathCards.slice(0, 4).map((card) => (
            <div key={card.label} style={{ display: 'grid', gap: 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', alignItems: 'baseline' }}>
                <span style={{ fontSize: 10, color: 'var(--text-primary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {card.label}
                </span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 700, flexShrink: 0 }}>
                  {card.value}
                </span>
              </div>
              <div style={{ width: '100%', height: 5, borderRadius: 'var(--radius-full)', background: 'var(--bg-surface)' }}>
                <div style={{
                  width: `${card.widthPercent}%`,
                  height: '100%',
                  borderRadius: 'var(--radius-full)',
                  background: '#35c7ee',
                }} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
