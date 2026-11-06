import { useEffect, useState } from 'react';
import { trustAnalyticsApi } from '@/services/api';
import { subscribeProjectSocket } from '@/services/projectSocket';
import type { TrustAnalyticsBreakdown, TrustAnalyticsSummary, TrustAnalyticsTimeseries } from '@/types';
import type { TrendMetric } from './trustAnalyticsDashboardUtils';
import {
  TrustAnalyticsDashboardContent,
  type BreakdownSeriesMap,
  type DashboardWindow,
  type TrendSeriesMap,
} from './trustAnalyticsDashboardContent';
import { AnalyticsOverviewTab } from './AnalyticsOverviewTab';

type DashboardTab = 'overview' | 'advanced';

const EMPTY_ANALYTICS_MESSAGE = 'No review analytics yet for this project. Completed reviews will appear here once available.';

const TREND_METRICS: Array<{ metric: TrendMetric }> = [
  { metric: 'ttfs_ms' },
  { metric: 'deep_coverage_rate' },
  { metric: 'grounded_issue_rate' },
];

const OVERVIEW_TIMESERIES_METRICS = ['review_count', 'findings_found'] as const;
const ANALYTICS_REFRESH_EVENTS = [
  'branch-review-reviewed',
  'pr-review-reviewed',
  'branch-review-updated',
  'branch-review-created',
  'pr-sync-completed',
] as const;

const BREAKDOWN_REQUESTS: Array<{
  key: keyof BreakdownSeriesMap;
  by: TrustAnalyticsBreakdown['by'];
  metric: TrustAnalyticsBreakdown['metric'];
}> = [
  { key: 'provider_model', by: 'provider_model', metric: 'grounded_issue_rate' },
  { key: 'language', by: 'language', metric: 'issue_addressed_rate' },
  { key: 'path_pattern', by: 'path_pattern', metric: 'issues_found' },
];

function shouldShowEmptyAnalyticsState(error: unknown): boolean {
  const status = Number((error as any)?.response?.status);
  const message = String(
    (error as any)?.response?.data?.error
    || (error as Error | null)?.message
    || ''
  ).trim().toLowerCase();

  if (message === 'project not found') {
    return false;
  }

  return status === 404 || message === 'not found';
}

const TAB_OPTIONS: Array<{ value: DashboardTab; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'advanced', label: 'Advanced' },
];

const WINDOW_OPTIONS: Array<{ value: DashboardWindow; label: string }> = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

function TrustAnalyticsDashboard({ projectId, refreshKey = 0 }: { projectId: string; refreshKey?: number }) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [windowKey, setWindowKey] = useState<DashboardWindow>('7d');
  const [summary, setSummary] = useState<TrustAnalyticsSummary | null>(null);
  const [trends, setTrends] = useState<TrendSeriesMap>({
    ttfs_ms: null,
    deep_coverage_rate: null,
    grounded_issue_rate: null,
  });
  const [overviewSeries, setOverviewSeries] = useState<{
    review_count: TrustAnalyticsTimeseries | null;
    findings_found: TrustAnalyticsTimeseries | null;
  }>({ review_count: null, findings_found: null });
  const [breakdowns, setBreakdowns] = useState<BreakdownSeriesMap>({
    provider_model: null,
    language: null,
    path_pattern: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [liveRefreshKey, setLiveRefreshKey] = useState(0);

  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isNewProject = loadedProjectId !== projectId;
    const load = async () => {
      // Only show full loading skeleton on first load or project change; window changes keep stale data visible
      if (isNewProject) setIsLoading(true);
      setLoadError(null);
      setEmptyMessage(null);
      try {
        const interval = windowKey === '24h' ? 'hour' : 'day';
        const [
          summaryResponse,
          timeseriesResponses,
          overviewTimeseriesResponses,
          breakdownResponses,
        ] = await Promise.all([
          trustAnalyticsApi.getSummary(projectId, { window: windowKey, scope: 'all' }),
          Promise.all(TREND_METRICS.map(({ metric }) => trustAnalyticsApi.getTimeseries(projectId, {
            metric,
            window: windowKey,
            interval,
            scope: 'all',
          }))),
          Promise.all(OVERVIEW_TIMESERIES_METRICS.map((metric) => trustAnalyticsApi.getTimeseries(projectId, {
            metric,
            window: windowKey,
            interval,
            scope: 'all',
          }))),
          Promise.all(BREAKDOWN_REQUESTS.map(({ by, metric }) => trustAnalyticsApi.getBreakdown(projectId, {
            by,
            metric,
            window: windowKey,
            limit: 5,
            scope: 'all',
          }))),
        ]);
        if (cancelled) return;
        setSummary(summaryResponse.summary);
        setTrends({
          ttfs_ms: timeseriesResponses[0].timeseries,
          deep_coverage_rate: timeseriesResponses[1].timeseries,
          grounded_issue_rate: timeseriesResponses[2].timeseries,
        });
        setOverviewSeries({
          review_count: overviewTimeseriesResponses[0].timeseries,
          findings_found: overviewTimeseriesResponses[1].timeseries,
        });
        setBreakdowns({
          provider_model: breakdownResponses[0].breakdown,
          language: breakdownResponses[1].breakdown,
          path_pattern: breakdownResponses[2].breakdown,
        });
      } catch (error) {
        if (cancelled) return;
        if (shouldShowEmptyAnalyticsState(error)) {
          setSummary(null);
          setTrends({
            ttfs_ms: null,
            deep_coverage_rate: null,
            grounded_issue_rate: null,
          });
          setOverviewSeries({ review_count: null, findings_found: null });
          setBreakdowns({
            provider_model: null,
            language: null,
            path_pattern: null,
          });
          setEmptyMessage(EMPTY_ANALYTICS_MESSAGE);
        } else {
          setLoadError(error instanceof Error ? error.message : 'Failed to load Review Analytics');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          setLoadedProjectId(projectId);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, windowKey, liveRefreshKey]);

  useEffect(() => {
    const refreshAnalytics = () => setLiveRefreshKey((prev) => prev + 1);
    const handleWindowRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      refreshAnalytics();
    };
    const socketHandlers = Object.fromEntries(
      ANALYTICS_REFRESH_EVENTS.map((eventName) => [eventName, refreshAnalytics])
    ) as Record<string, () => void>;

    window.addEventListener('atlas-trust-analytics-refresh', handleWindowRefresh as EventListener);
    const unsubscribeSocket = subscribeProjectSocket(projectId, socketHandlers);

    return () => {
      window.removeEventListener('atlas-trust-analytics-refresh', handleWindowRefresh as EventListener);
      unsubscribeSocket();
    };
  }, [projectId]);

  const pillStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px var(--space-2)',
    borderRadius: 'var(--radius-full)',
    border: `1px solid ${active ? 'var(--review-segment-active-border)' : 'var(--review-shell-border)'}`,
    background: active ? 'var(--review-segment-active-bg)' : 'transparent',
    color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
  });

  if (activeTab === 'advanced') {
    return (
      <TrustAnalyticsDashboardContent
        scopeKey={'all'}
        windowKey={windowKey}
        onWindowChange={setWindowKey}
        isLoading={isLoading}
        loadError={loadError}
        emptyMessage={emptyMessage}
        summary={summary}
        trends={trends}
        breakdowns={breakdowns}
        tabSwitcher={
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
            {TAB_OPTIONS.map((tab) => (
              <button key={tab.value} type="button" onClick={() => setActiveTab(tab.value)} style={pillStyle(activeTab === tab.value)}>
                {tab.label}
              </button>
            ))}
          </div>
        }
      />
    );
  }

  // Overview tab
  return (
    <div style={{
      background: 'var(--review-panel-bg)',
      borderTop: '1px solid var(--review-shell-divider)',
      padding: 'var(--space-3)',
      display: 'grid',
      gap: 'var(--space-3)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          {TAB_OPTIONS.map((tab) => (
            <button key={tab.value} type="button" onClick={() => setActiveTab(tab.value)} style={pillStyle(activeTab === tab.value)}>
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          {WINDOW_OPTIONS.map((option) => (
            <button key={option.value} type="button" onClick={() => setWindowKey(option.value)} style={pillStyle(windowKey === option.value)}>
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
        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{emptyMessage}</div>
      )}

      {!isLoading && !loadError && summary && summary.reviewCount === 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          No completed reviews in this window yet.
        </div>
      )}

      {!isLoading && !loadError && summary && summary.reviewCount > 0 && (
        <AnalyticsOverviewTab
          summary={summary}
          reviewCountSeries={overviewSeries.review_count}
          issuesFoundSeries={overviewSeries.findings_found}
          breakdowns={breakdowns}
        />
      )}
    </div>
  );
}

export default TrustAnalyticsDashboard;
