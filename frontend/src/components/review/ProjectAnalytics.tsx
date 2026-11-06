/**
 * ProjectAnalytics — Direction C analytics block under the Branches
 * table (see `direction-c.jsx` lines 125–184). 4 metric cards + findings-
 * over-time SVG + path hotspots.
 *
 * Most numbers here are backend stubs pending a real analytics endpoint;
 * each stub is marked with `// TODO(analytics):` and tracked in
 * `.planning/STATE.md` Deferred Issues.
 */

import { useMemo, useState } from 'react';

export interface ProjectAnalyticsMetrics {
  reviews: number;
  branchReviews: number;
  prReviews: number;
  findings: number;
  avgFindingsPerReview: number;
  addressedCount: number;
  addressedPct: number;
  dismissedCount: number;
  pendingCount: number;
  pendingAcrossBranches: number;
}

interface ProjectAnalyticsProps {
  metrics: ProjectAnalyticsMetrics;
  /** Optional path-hotspot data. When omitted, renders a stubbed placeholder. */
  hotspots?: Array<{ path: string; count: number }>;
}

const DEFAULT_HOTSPOTS: Array<{ path: string; count: number }> = [
  // TODO(analytics): derive from real review history; these are stubs.
  { path: 'backend/', count: 12 },
  { path: 'frontend/', count: 8 },
  { path: 'apps/dashboard/', count: 3 },
  { path: 'scripts/', count: 2 },
];

const SERIES_24H = '0,80 20,75 40,78 60,62 80,68 100,58 120,65 140,50 160,62 180,48 200,55 220,60 240,45 260,58 280,42 300,50 320,38 340,48 360,40 380,52 400,45';
// TODO(analytics): replace with real findings-over-time series.
const SERIES_7D = '0,80 20,60 40,75 60,40 80,55 100,20 120,45 140,30 160,55 180,35 200,50 220,65 240,40 260,70 280,50 300,80 320,60 340,45 360,65 380,50 400,70';
const SERIES_30D = '0,85 20,70 40,72 60,55 80,60 100,35 120,50 140,42 160,58 180,48 200,55 220,62 240,50 260,68 280,55 300,78 320,65 340,58 360,70 380,62 400,75';

const AXIS_TICKS: Record<'24h' | '7d' | '30d', string[]> = {
  '24h': ['24h ago', '18h', '12h', '6h', 'now'],
  '7d':  ['7d ago', '5d', '3d', '1d', 'today'],
  '30d': ['30d ago', '22d', '15d', '7d', 'today'],
};

export function ProjectAnalytics({ metrics, hotspots = DEFAULT_HOTSPOTS }: ProjectAnalyticsProps) {
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('30d');

  const rangeAreaPath = useMemo(() => {
    const series = range === '24h' ? SERIES_24H : range === '7d' ? SERIES_7D : SERIES_30D;
    const points = series.split(' ').map((p) => p).join(' L');
    return `M${points} L400,120 L0,120 Z`;
  }, [range]);

  const rangeLinePath = useMemo(() => {
    const series = range === '24h' ? SERIES_24H : range === '7d' ? SERIES_7D : SERIES_30D;
    const points = series.split(' ').map((p) => p).join(' L');
    return `M${points}`;
  }, [range]);

  const metricTiles = [
    {
      key: 'reviews',
      label: 'Reviews',
      value: String(metrics.reviews),
      sub: `${metrics.branchReviews} branch · ${metrics.prReviews} PR`,
    },
    {
      key: 'findings',
      label: 'Findings',
      value: String(metrics.findings),
      sub: `${metrics.avgFindingsPerReview.toFixed(1)} per review`,
    },
    {
      key: 'addressed',
      label: 'Addressed',
      value: `${metrics.addressedPct}%`,
      sub: `${metrics.addressedCount} fixed · ${metrics.dismissedCount} dismissed`,
    },
    {
      key: 'pending',
      label: 'Pending',
      value: String(metrics.pendingCount),
      sub: `across ${metrics.pendingAcrossBranches} branch${metrics.pendingAcrossBranches === 1 ? '' : 'es'}`,
    },
  ];

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.2, color: 'var(--text-primary)' }}>
            Review Analytics
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
            Project-level review speed, coverage, and trust signals
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: 2,
            background: 'var(--bg-surface)',
            border: '1px solid var(--review-shell-divider)',
            borderRadius: 5,
            fontSize: 11,
          }}
        >
          {(['24h', '7d', '30d'] as const).map((r) => {
            const active = r === range;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                style={{
                  padding: '3px 10px',
                  borderRadius: 3,
                  fontWeight: 500,
                  background: active ? 'var(--bg-surface-raised)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-ui)',
                }}
              >
                {r}
              </button>
            );
          })}
        </div>
      </div>

      {/* Metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10 }}>
        {metricTiles.map((m) => (
          <div
            key={m.key}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--review-shell-divider)',
              borderRadius: 6,
              padding: '12px 14px',
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--text-tertiary)',
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                fontWeight: 500,
              }}
            >
              {m.label}
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                marginTop: 4,
                letterSpacing: -0.5,
                color: 'var(--text-primary)',
              }}
            >
              {m.value}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Findings-over-time chart + hotspots */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 10 }}>
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--review-shell-divider)',
            borderRadius: 6,
            padding: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginBottom: 8,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            Findings over time
          </div>
          {/* TODO(analytics): stub series — swap for real backend data. */}
          <svg
            viewBox="0 0 400 120"
            preserveAspectRatio="none"
            style={{ width: '100%', height: 120, display: 'block' }}
          >
            {[0, 30, 60, 90, 120].map((y) => (
              <line key={y} x1="0" x2="400" y1={y} y2={y} stroke="var(--border-muted)" />
            ))}
            {/* vertical guides every quarter of the range */}
            {[100, 200, 300].map((x) => (
              <line key={x} x1={x} x2={x} y1="0" y2="120" stroke="var(--border-muted)" strokeOpacity="0.4" />
            ))}
            <path
              d={rangeAreaPath}
              fill="var(--accent-blue)"
              fillOpacity="0.10"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={rangeLinePath}
              fill="none"
              stroke="var(--accent-blue)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 10,
              color: 'var(--text-tertiary)',
              marginTop: 4,
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {AXIS_TICKS[range].map((label, i) => (
              <span key={i}>{label}</span>
            ))}
          </div>
        </div>
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--review-shell-divider)',
            borderRadius: 6,
            padding: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginBottom: 10,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            Path hotspots
          </div>
          {hotspots.slice(0, 4).map((h) => (
            <div
              key={h.path}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                alignItems: 'center',
                gap: 10,
                padding: '6px 0',
                fontSize: 11.5,
              }}
            >
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 3, color: 'var(--text-secondary)' }}>
                  {h.path}
                </div>
                <div style={{ height: 3, background: 'var(--border-muted)', borderRadius: 2, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.min(100, h.count * 5)}%`,
                      height: '100%',
                      background: 'var(--accent-blue)',
                      opacity: 0.8,
                    }}
                  />
                </div>
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--text-primary)',
                  fontWeight: 500,
                }}
              >
                {h.count}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
