import type { TrustAnalyticsTimeseries } from '@/types';
import { formatTrustAnalyticsDuration } from './review/reviewPanelUtils';

export type TrendMetric = 'ttfs_ms' | 'deep_coverage_rate' | 'grounded_issue_rate';
export type DashboardScope = 'all' | 'branches' | 'prs';

export function getDashboardScopeLabel(scope: DashboardScope): string {
  if (scope === 'branches') return 'Branches';
  if (scope === 'prs') return 'PRs';
  return 'All';
}

export function getTrendMetricLabel(metric: TrendMetric, timeseries: TrustAnalyticsTimeseries | null): string {
  if (timeseries?.metricLabel) return timeseries.metricLabel;
  if (metric === 'deep_coverage_rate') return 'Deep coverage';
  if (metric === 'grounded_issue_rate') return 'Grounded findings';
  return 'Review start';
}

export function getTrendMetricDescription(metric: TrendMetric, timeseries: TrustAnalyticsTimeseries | null): string {
  if (timeseries?.metricDescription) return timeseries.metricDescription;
  if (metric === 'deep_coverage_rate') return 'Share of changed files that received deep review coverage.';
  if (metric === 'grounded_issue_rate') return 'Share of actionable findings backed by grounded evidence.';
  return 'Time to first signal across completed reviews.';
}

export function buildSparklinePath(points: Array<number | null>, width = 180, height = 48): string {
  const numeric = points.filter((value): value is number => value != null && Number.isFinite(value));
  if (numeric.length === 0) return '';
  if (numeric.length === 1) {
    const y = height / 2;
    return `M 0 ${y} L ${width} ${y}`;
  }
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const range = Math.max(1e-6, max - min);
  const step = width / Math.max(1, numeric.length - 1);
  return numeric.map((value, index) => {
    const x = step * index;
    const y = height - (((value - min) / range) * height);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

export function buildSparklineAreaPath(points: Array<number | null>, width = 180, height = 48): string {
  const numeric = points.filter((value): value is number => value != null && Number.isFinite(value));
  if (numeric.length === 0) return '';
  if (numeric.length === 1) {
    const y = height / 2;
    return `M 0 ${height} L 0 ${y} L ${width} ${y} L ${width} ${height} Z`;
  }
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const range = Math.max(1e-6, max - min);
  const step = width / Math.max(1, numeric.length - 1);
  const line = numeric.map((value, index) => {
    const x = step * index;
    const y = height - (((value - min) / range) * height);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
  return `${line} L ${width} ${height} L 0 ${height} Z`;
}

export function formatTrendMetricValue(metric: TrendMetric, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (metric === 'ttfs_ms') return formatTrustAnalyticsDuration(value);
  return `${Math.round(value * 100)}%`;
}
