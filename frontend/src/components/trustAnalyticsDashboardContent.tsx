import { useMemo } from 'react';
import type {
  TrustAnalyticsBreakdown,
  TrustAnalyticsSummary,
  TrustAnalyticsTimeseries,
  TrustAnalyticsTimeseriesPoint,
} from '@/types';
import { AnalyticsMetricCard, AnalyticsMetricGrid } from './review/ReviewWidgets';
import { formatTrustAnalyticsDuration, formatTrustAnalyticsRate } from './review/reviewPanelUtils';
import {
  buildSparklineAreaPath,
  buildSparklinePath,
  formatTrendMetricValue,
  getDashboardScopeLabel,
  getTrendMetricDescription,
  getTrendMetricLabel,
  type DashboardScope,
  type TrendMetric,
} from './trustAnalyticsDashboardUtils';

export type DashboardWindow = '24h' | '7d' | '30d';
export type TrendSeriesMap = Record<TrendMetric, TrustAnalyticsTimeseries | null>;
export type BreakdownSeriesMap = {
  provider_model: TrustAnalyticsBreakdown | null;
  language: TrustAnalyticsBreakdown | null;
  path_pattern: TrustAnalyticsBreakdown | null;
};

type DashboardCardTone = 'default' | 'good' | 'warn' | 'critical' | 'info';
export type DashboardCard = { label: string; value: string; detail: string; tone: DashboardCardTone };
export type BreakdownCard = { label: string; value: string; detail: string; tone: DashboardCardTone; widthPercent: number };

const WINDOW_OPTIONS: Array<{ value: DashboardWindow; label: string }> = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];


const TREND_METRICS: Array<{ metric: TrendMetric; fallbackLabel: string }> = [
  { metric: 'ttfs_ms', fallbackLabel: 'Review start' },
  { metric: 'deep_coverage_rate', fallbackLabel: 'Deep coverage' },
  { metric: 'grounded_issue_rate', fallbackLabel: 'Grounded findings' },
];

const BREAKDOWN_SECTIONS: Array<{
  key: keyof BreakdownSeriesMap;
  title: string;
  description: string;
  empty: string;
}> = [
  {
    key: 'provider_model',
    title: 'Provider quality',
    description: 'Grounded issue rate by provider model.',
    empty: 'No provider segments yet.',
  },
  {
    key: 'language',
    title: 'Language follow-through',
    description: 'Issue addressed rate by language.',
    empty: 'No language segments yet.',
  },
  {
    key: 'path_pattern',
    title: 'Path hotspots',
    description: 'Issue volume by repo path pattern.',
    empty: 'No path segments yet.',
  },
];

export type TrustAnalyticsDashboardContentProps = {
  scopeKey: DashboardScope;
  windowKey: DashboardWindow;
  onWindowChange: (window: DashboardWindow) => void;
  isLoading: boolean;
  loadError: string | null;
  emptyMessage?: string | null;
  summary: TrustAnalyticsSummary | null;
  trends: TrendSeriesMap;
  breakdowns: BreakdownSeriesMap;
  tabSwitcher?: React.ReactNode;
};

function latestPoint(points: TrustAnalyticsTimeseriesPoint[] = []): TrustAnalyticsTimeseriesPoint | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  return points[points.length - 1] || null;
}

function resolveActiveScope(summary: TrustAnalyticsSummary | null, scopeKey: DashboardScope): DashboardScope {
  const summaryScope = summary?.scope;
  if (summaryScope === 'branches' || summaryScope === 'prs') return summaryScope;
  return scopeKey;
}

function getHeroCardMeta(summary: TrustAnalyticsSummary | null, key: string, fallbackLabel: string) {
  const match = summary?.heroCards.find((card) => card.key === key);
  return {
    label: match?.label || fallbackLabel,
    description: match?.description || '',
  };
}

function formatDecimalMetric(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function buildScopeSummaryMessage(summary: TrustAnalyticsSummary | null, scopeKey: DashboardScope): string {
  const activeScope = resolveActiveScope(summary, scopeKey);
  if (!summary) {
    return `${getDashboardScopeLabel(activeScope)} scope`;
  }
  const prReviewLabel = `${summary.scopeBreakdown.prReviewCount} PR review${summary.scopeBreakdown.prReviewCount === 1 ? '' : 's'}`;
  if (activeScope === 'all') {
    const baseMessage = `All combines ${summary.scopeBreakdown.branchScopedCount} branch-scoped reviews and ${prReviewLabel}.`;
    if (summary.comparison.dominantScope === 'branches') {
      return `${baseMessage} Branches currently drive ${Math.round(summary.comparison.branchShare * 100)}% of samples.`;
    }
    if (summary.comparison.dominantScope === 'prs') {
      return `${baseMessage} PRs currently drive ${Math.round(summary.comparison.prShare * 100)}% of samples.`;
    }
    return `${baseMessage} Samples are evenly split between branch and PR history.`;
  }
  if (activeScope === 'branches') {
    return `Branches includes ${summary.scopeBreakdown.branchReviewCount} branch reviews and ${summary.scopeBreakdown.changesetCount} changesets.`;
  }
  return `PR scope isolates ${summary.scopeBreakdown.prReviewCount} PR reviews without mixing branch-scoped samples.`;
}

export function buildMetricAvailabilityMessage(summary: TrustAnalyticsSummary | null, scopeKey: DashboardScope): string {
  const activeScope = resolveActiveScope(summary, scopeKey);
  if (activeScope === 'prs') {
    // Metric availability stays scope-aware so PR-native cards can land later
    // without reusing branch-only copy or mixing incompatible samples.
    return 'PR-native metrics such as comment-ready findings and verification/check context will layer onto this scope without reusing branch-only wording.';
  }
  if (activeScope === 'branches') {
    return 'Branch scope keeps branch reviews and changesets together so codebase-level trends stay comparable.';
  }
  return 'Showing combined review history across all branches and PR reviews.';
}

function formatGuardedRate(metric: TrustAnalyticsSummary['hero']['groundedIssueRate']): string {
  if (!metric || metric.isInsufficientSample) return 'n/a';
  return formatTrustAnalyticsRate(metric);
}

function describeGuardedSample(metric: TrustAnalyticsSummary['hero']['groundedIssueRate'], resolvedLabel: string): string {
  if (!metric || metric.denominator <= 0) return `No ${resolvedLabel} sample yet`;
  if (metric.isInsufficientSample) {
    return `Insufficient sample (n=${metric.sampleSize}, min ${metric.minimumSampleSize})`;
  }
  return `${metric.numerator}/${metric.denominator} ${resolvedLabel}`;
}

export function hasGuardedSummary(summary: TrustAnalyticsSummary | null): boolean {
  if (!summary) return false;
  return [
    summary.hero.groundedIssueRate,
    summary.quality.unsupportedIssueRate,
    summary.quality.lowEvidenceIssueRate,
    summary.quality.uncorroboratedHighRiskRate,
    summary.quality.outcomeSuppressionRate,
    summary.outcome.issueAddressedRate,
    summary.outcome.issueDismissedRate,
  ].some((metric) => metric.isInsufficientSample);
}

export function getDashboardGuardrailMessage(summary: TrustAnalyticsSummary | null): string | null {
  if (!hasGuardedSummary(summary)) return null;
  return 'Sample guardrails are active in this window. Rate metrics stay hidden until enough reviews or findings exist.';
}

export function buildDashboardHeroCards(summary: TrustAnalyticsSummary | null): DashboardCard[] {
  if (!summary) return [];
  if (summary.scope === 'prs') {
    const commentReadyMeta = getHeroCardMeta(summary, 'comment_ready_findings', 'Comment-ready findings');
    const prSizeMeta = getHeroCardMeta(summary, 'median_pr_size', 'Median PR size reviewed');
    const verificationMeta = getHeroCardMeta(summary, 'verification_context', 'Verification context');
    const reliabilityMeta = getHeroCardMeta(summary, 'review_reliability', 'Review reliability');

    return [
      {
        label: commentReadyMeta.label,
        value: formatDecimalMetric(summary.hero.commentReadyFindingsPerReview.value),
        detail: `${summary.hero.commentReadyFindingsPerReview.numerator} findings across ${summary.hero.commentReadyFindingsPerReview.denominator} PR review${summary.hero.commentReadyFindingsPerReview.denominator === 1 ? '' : 's'}`,
        tone: summary.hero.commentReadyFindingsPerReview.value != null && summary.hero.commentReadyFindingsPerReview.value >= 2 ? 'good' : 'info',
      },
      {
        label: prSizeMeta.label,
        value: summary.hero.medianChangedFiles.value != null ? `${Math.round(summary.hero.medianChangedFiles.value)} files` : 'n/a',
        detail: summary.hero.medianChangedFiles.sampleSize > 0
          ? `Median changed files across ${summary.hero.medianChangedFiles.sampleSize} PR review${summary.hero.medianChangedFiles.sampleSize === 1 ? '' : 's'}`
          : (prSizeMeta.description || 'No PR size sample yet'),
        tone: 'info',
      },
      {
        label: verificationMeta.label,
        value: formatTrustAnalyticsRate(summary.hero.verificationContextRate),
        detail: summary.hero.verificationContextRate.denominator > 0
          ? `${summary.hero.verificationContextRate.numerator}/${summary.hero.verificationContextRate.denominator} PR reviews with verifier/check context`
          : (verificationMeta.description || 'No verification-context sample yet'),
        tone: summary.hero.verificationContextRate.value != null && summary.hero.verificationContextRate.value >= 0.75 ? 'good' : 'info',
      },
      {
        label: reliabilityMeta.label,
        value: `${summary.reliability.fullCount} full`,
        detail: `${summary.reliability.partialCount} partial • ${summary.reliability.failedCount} failed`,
        tone: summary.reliability.failedCount > 0 ? 'warn' : 'info',
      },
    ];
  }

  const ttfsMeta = getHeroCardMeta(summary, 'median_ttfs', 'Median TTFS');
  const coverageMeta = getHeroCardMeta(summary, 'deep_coverage', 'Deep coverage');
  const groundedMeta = getHeroCardMeta(summary, 'grounded_issues', 'Grounded issues');
  const reliabilityMeta = getHeroCardMeta(summary, 'reliability_mix', 'Reliability mix');
  const groundedTone: DashboardCardTone = summary.hero.groundedIssueRate.isInsufficientSample
    ? 'info'
    : summary.hero.groundedIssueRate.value != null && summary.hero.groundedIssueRate.value >= 0.8
      ? 'good'
      : summary.hero.groundedIssueRate.value != null && summary.hero.groundedIssueRate.value >= 0.5
        ? 'warn'
        : 'critical';
  return [
    {
      label: ttfsMeta.label,
      value: formatTrustAnalyticsDuration(summary.hero.medianTtfsMs.value),
      detail: `${summary.hero.medianTtfsMs.sampleSize} review samples`,
      tone: summary.hero.medianTtfsMs.value != null && summary.hero.medianTtfsMs.value <= 10000 ? 'good' : 'info',
    },
    {
      label: coverageMeta.label,
      value: formatTrustAnalyticsRate(summary.hero.deepCoverageRate),
      detail: summary.hero.deepCoverageRate.denominator > 0
        ? `${summary.hero.deepCoverageRate.numerator}/${summary.hero.deepCoverageRate.denominator} files`
        : 'No changed-file denominator',
      tone: summary.hero.deepCoverageRate.value != null && summary.hero.deepCoverageRate.value >= 0.85
        ? 'good'
        : summary.hero.deepCoverageRate.value != null && summary.hero.deepCoverageRate.value >= 0.6
          ? 'warn'
          : 'critical',
    },
    {
      label: groundedMeta.label,
      value: formatGuardedRate(summary.hero.groundedIssueRate),
      detail: describeGuardedSample(summary.hero.groundedIssueRate, 'grounded'),
      tone: groundedTone,
    },
    {
      label: reliabilityMeta.label,
      value: `${summary.reliability.fullCount} full`,
      detail: `${summary.reliability.partialCount} partial • ${summary.reliability.failedCount} failed`,
      tone: summary.reliability.failedCount > 0 ? 'warn' : 'info',
    },
  ];
}

export function formatBreakdownMetricValue(breakdown: TrustAnalyticsBreakdown | null, group: TrustAnalyticsBreakdown['groups'][number]): string {
  if (!breakdown) return 'n/a';
  if (breakdown.metric === 'review_count' || breakdown.metric === 'issues_found' || breakdown.metric === 'high_risk_findings') {
    return String(group.metric.numerator);
  }
  if (group.metric.isInsufficientSample) return 'n/a';
  return formatTrustAnalyticsRate(group.metric);
}

export function describeBreakdownMetricSample(breakdown: TrustAnalyticsBreakdown | null, group: TrustAnalyticsBreakdown['groups'][number]): string {
  if (!breakdown) return 'No segment data';
  if (breakdown.metric === 'review_count') {
    return `${group.reviewCount} review${group.reviewCount !== 1 ? 's' : ''}`;
  }
  if (breakdown.metric === 'issues_found' || breakdown.metric === 'high_risk_findings') {
    return `${group.metric.numerator} findings across ${group.reviewCount} review${group.reviewCount !== 1 ? 's' : ''}`;
  }
  if (group.metric.denominator == null || group.metric.denominator <= 0) {
    return `No ${breakdown.metric.replace(/_/g, ' ')} sample yet`;
  }
  if (group.metric.isInsufficientSample) {
    return `Insufficient sample (n=${group.metric.sampleSize}, min ${group.metric.minimumSampleSize})`;
  }
  return `${group.metric.numerator}/${group.metric.denominator} across ${group.reviewCount} review${group.reviewCount !== 1 ? 's' : ''}`;
}

function getBreakdownTone(breakdown: TrustAnalyticsBreakdown | null, group: TrustAnalyticsBreakdown['groups'][number]): DashboardCardTone {
  if (!breakdown) return 'default';
  if (breakdown.metric === 'issues_found' || breakdown.metric === 'high_risk_findings' || breakdown.metric === 'review_count') {
    return 'info';
  }
  if (group.metric.isInsufficientSample || group.metric.value == null) return 'info';
  if (group.metric.value >= 0.8) return 'good';
  if (group.metric.value >= 0.5) return 'warn';
  return 'critical';
}

export function buildBreakdownCards(breakdown: TrustAnalyticsBreakdown | null): BreakdownCard[] {
  if (!breakdown) return [];
  const maxCount = Math.max(1, ...breakdown.groups.map((group) => {
    if (breakdown.metric === 'issues_found' || breakdown.metric === 'high_risk_findings' || breakdown.metric === 'review_count') {
      return group.metric.numerator;
    }
    return Math.round((group.metric.value || 0) * 100);
  }));

  return breakdown.groups.map((group) => {
    const rawWidth = breakdown.metric === 'issues_found' || breakdown.metric === 'high_risk_findings' || breakdown.metric === 'review_count'
      ? group.metric.numerator
      : Math.round((group.metric.value || 0) * 100);
    return {
      label: group.label,
      value: formatBreakdownMetricValue(breakdown, group),
      detail: describeBreakdownMetricSample(breakdown, group),
      tone: getBreakdownTone(breakdown, group),
      widthPercent: Math.max(12, Math.round((rawWidth / maxCount) * 100)),
    };
  });
}

export function TrustAnalyticsDashboardContent({
  scopeKey,
  windowKey,
  onWindowChange,
  isLoading,
  loadError,
  emptyMessage,
  summary,
  trends,
  breakdowns,
  tabSwitcher,
}: TrustAnalyticsDashboardContentProps) {
  const heroCards = useMemo<DashboardCard[]>(() => buildDashboardHeroCards(summary), [summary]);
  const guardrailMessage = useMemo(() => getDashboardGuardrailMessage(summary), [summary]);
  const scopeSummaryMessage = useMemo(() => buildScopeSummaryMessage(summary, scopeKey), [summary, scopeKey]);
  const metricAvailabilityMessage = useMemo(() => buildMetricAvailabilityMessage(summary, scopeKey), [summary, scopeKey]);
  const breakdownCards = useMemo<Record<keyof BreakdownSeriesMap, BreakdownCard[]>>(() => ({
    provider_model: buildBreakdownCards(breakdowns.provider_model),
    language: buildBreakdownCards(breakdowns.language),
    path_pattern: buildBreakdownCards(breakdowns.path_pattern),
  }), [breakdowns]);

  return (
    <div style={{
      borderBottom: '1px solid var(--border-default)',
      background: 'var(--bg-surface)',
      padding: 'var(--space-3)',
      display: 'grid',
      gap: 'var(--space-3)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
          {tabSwitcher}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          {WINDOW_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onWindowChange(option.value)}
              style={{
                padding: '2px var(--space-2)',
                borderRadius: 'var(--radius-full)',
                border: `1px solid ${windowKey === option.value ? 'var(--accent-blue)' : 'var(--border-muted)'}`,
                background: windowKey === option.value ? 'var(--chip-info-bg)' : 'transparent',
                color: windowKey === option.value ? 'var(--accent-blue)' : 'var(--text-secondary)',
                fontSize: 10,
                fontFamily: 'var(--font-sans)',
                cursor: 'pointer',
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Loading Review Analytics...</div>
      )}

      {!isLoading && loadError && (
        <div style={{ fontSize: 10, color: 'var(--accent-red)' }}>{loadError}</div>
      )}

      {!isLoading && !loadError && emptyMessage && (
        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          {emptyMessage}
        </div>
      )}

      {!isLoading && !loadError && summary && summary.reviewCount === 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          No completed reviews in this window yet.
        </div>
      )}

      {!isLoading && !loadError && summary && summary.reviewCount > 0 && (
        <>
          <div style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase' }}>
              {getDashboardScopeLabel(resolveActiveScope(summary, scopeKey))} scope
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {scopeSummaryMessage}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {metricAvailabilityMessage}
            </span>
          </div>
          {guardrailMessage && (
            <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {guardrailMessage}
            </div>
          )}
          <AnalyticsMetricGrid>
            {heroCards.map((card) => (
              <AnalyticsMetricCard
                key={card.label}
                label={card.label}
                value={card.value}
                detail={card.detail}
                tone={card.tone}
              />
            ))}
          </AnalyticsMetricGrid>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-2)' }}>
            {TREND_METRICS.map(({ metric, fallbackLabel }) => {
              const series = trends[metric];
              const point = latestPoint(series?.points || []);
              const trendValues = (series?.points || []).map((entry) => entry.value);
              const sparkline = buildSparklinePath(trendValues);
              const sparklineArea = buildSparklineAreaPath(trendValues);
              const trendLabel = getTrendMetricLabel(metric, series);
              const trendDescription = getTrendMetricDescription(metric, series);
              const gradientId = `trust-analytics-spark-${metric}`;
              return (
                <div
                  key={metric}
                  style={{
                    display: 'grid',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-2)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-muted)',
                    background: 'var(--bg-overlay)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase' }}>
                      {trendLabel || fallbackLabel}
                    </span>
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {formatTrendMetricValue(metric, point?.value ?? null)}
                    </span>
                  </div>
                  <svg width="100%" height="48" viewBox="0 0 180 48" preserveAspectRatio="none" role="img" aria-label={trendLabel || fallbackLabel}>
                    <defs>
                      <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(53, 199, 238, 0.26)" />
                        <stop offset="100%" stopColor="rgba(53, 199, 238, 0.04)" />
                      </linearGradient>
                    </defs>
                    {sparklineArea && <path d={sparklineArea} fill={`url(#${gradientId})`} />}
                    <path d={sparkline} fill="none" stroke="#35c7ee" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {trendDescription}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {point ? `${point.reviewCount} review${point.reviewCount !== 1 ? 's' : ''} in latest bucket` : 'No buckets yet'}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-2)' }}>
            {BREAKDOWN_SECTIONS.map((section) => {
              const cards = breakdownCards[section.key];
              return (
                <div
                  key={section.key}
                  style={{
                    display: 'grid',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-2)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-muted)',
                    background: 'var(--bg-overlay)',
                  }}
                >
                  <div style={{ display: 'grid', gap: 2 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase' }}>
                      {section.title}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                      {section.description}
                    </span>
                  </div>

                  {cards.length === 0 && (
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                      {section.empty}
                    </span>
                  )}

                  {cards.map((card) => (
                    <div key={card.label} style={{ display: 'grid', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', alignItems: 'baseline' }}>
                        <span style={{ fontSize: 10, color: 'var(--text-primary)', fontWeight: 600 }}>
                          {card.label}
                        </span>
                        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 700 }}>
                          {card.value}
                        </span>
                      </div>
                      <div style={{ width: '100%', height: 6, borderRadius: 'var(--radius-full)', background: 'var(--bg-surface)' }}>
                        <div
                          style={{
                            width: `${card.widthPercent}%`,
                            height: '100%',
                            borderRadius: 'var(--radius-full)',
                            background: card.tone === 'good'
                              ? 'var(--accent-green)'
                              : card.tone === 'warn'
                                ? 'var(--accent-yellow)'
                                : card.tone === 'critical'
                                  ? 'var(--accent-red)'
                                  : '#35c7ee',
                          }}
                        />
                      </div>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                        {card.detail}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
