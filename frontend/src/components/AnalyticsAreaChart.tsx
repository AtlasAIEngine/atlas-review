import { useId, useMemo } from 'react';

export interface AnalyticsAreaChartPoint {
  value: number | null;
  label: string;
}

interface AnalyticsAreaChartProps {
  points: AnalyticsAreaChartPoint[];
  height?: number;
  formatValue?: (v: number) => string;
}

type Coord = { x: number; y: number; value: number };

function buildAreaPaths(
  points: AnalyticsAreaChartPoint[],
  chartLeft: number,
  chartRight: number,
  chartTop: number,
  chartBottom: number,
) {
  const numericValues = points.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (numericValues.length === 0) return { linePath: '', areaPath: '', dots: [] as Coord[] };

  const plotWidth = chartRight - chartLeft;
  const plotHeight = chartBottom - chartTop;
  const min = Math.min(...numericValues);
  const max = Math.max(...numericValues);
  const range = Math.max(1e-6, max - min);
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;

  // Build contiguous segments, breaking at null gaps
  const segments: Coord[][] = [];
  let current: Coord[] = [];
  const dots: Coord[] = [];

  points.forEach((p, i) => {
    if (p.value == null || !Number.isFinite(p.value)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      return;
    }
    const coord: Coord = {
      x: chartLeft + step * i,
      y: chartBottom - ((p.value - min) / range) * (plotHeight - 4) - 2,
      value: p.value,
    };
    current.push(coord);
    dots.push(coord);
  });
  if (current.length > 0) segments.push(current);

  // Build separate line + area paths per segment
  const lineParts: string[] = [];
  const areaParts: string[] = [];
  for (const seg of segments) {
    const segLine = seg.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ');
    lineParts.push(segLine);
    const first = seg[0];
    const last = seg[seg.length - 1];
    areaParts.push(`${segLine} L ${last.x.toFixed(2)} ${chartBottom} L ${first.x.toFixed(2)} ${chartBottom} Z`);
  }

  return { linePath: lineParts.join(' '), areaPath: areaParts.join(' '), dots };
}

export function AnalyticsAreaChart({ points, height = 100, formatValue }: AnalyticsAreaChartProps) {
  const gradientId = `areaGradient-${useId()}`;
  const paddingLeft = 14;
  const paddingRight = 10;
  const paddingBottom = 16;
  const paddingTop = 4;

  // Use a ref-based approach: render at a known viewBox and let SVG scale
  const viewWidth = 300;
  const chartLeft = paddingLeft;
  const chartRight = viewWidth - paddingRight;
  const chartTop = paddingTop;
  const chartBottom = height - paddingBottom;

  const { linePath, areaPath, dots } = useMemo(
    () => buildAreaPaths(points, chartLeft, chartRight, chartTop, chartBottom),
    [points, chartLeft, chartRight, chartTop, chartBottom],
  );

  const yLabels = useMemo(() => {
    const values = points.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
    if (values.length === 0) return [];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mid = (min + max) / 2;
    const fmt = formatValue || ((v: number) => String(Math.round(v)));
    const range = max - min;
    return [
      { value: max, y: chartTop + 8, label: fmt(max) },
      ...(range > 0 ? [{ value: mid, y: (chartTop + chartBottom) / 2 + 3, label: fmt(mid) }] : []),
      { value: min, y: chartBottom - 2, label: fmt(min) },
    ];
  }, [points, formatValue, chartTop, chartBottom]);

  const xLabels = useMemo(() => {
    if (points.length === 0) return [];
    const plotWidth = chartRight - chartLeft;
    const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
    if (points.length <= 6) {
      return points.map((p, i) => ({ x: chartLeft + step * i, label: p.label }));
    }
    const stride = Math.ceil(points.length / 6);
    return points
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => i % stride === 0 || i === points.length - 1)
      .map(({ p, i }) => ({ x: chartLeft + step * i, label: p.label }));
  }, [points, chartLeft, chartRight]);

  if (points.length === 0 || dots.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>No data</span>
      </div>
    );
  }

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${viewWidth} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#35c7ee" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#35c7ee" stopOpacity="0.03" />
        </linearGradient>
      </defs>

      {yLabels.map((yl, i) => (
        <text
          key={`${yl.value}-${i}`}
          x={chartLeft - 4}
          y={yl.y}
          textAnchor="end"
          style={{ fontSize: 9, fill: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}
        >
          {yl.label}
        </text>
      ))}

      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke="#35c7ee" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />

      {dots.map((d) => (
        <circle key={`${d.x}-${d.y}`} cx={d.x} cy={d.y} r="2.5" fill="var(--bg-surface)" stroke="#35c7ee" strokeWidth="1.75" />
      ))}

      {xLabels.map((xl) => (
        <text
          key={xl.x}
          x={xl.x}
          y={height - 3}
          textAnchor="middle"
          style={{ fontSize: 8, fill: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}
        >
          {xl.label}
        </text>
      ))}
    </svg>
  );
}
