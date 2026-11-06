#!/usr/bin/env node
/**
 * Performance M0 — benchmark aggregator
 *
 * Reads captured review-result JSONs from
 * `backend/.artifacts/review-harness-benchmarks/performance-m0/<run-dir>/`
 * and emits a single rollup artifact with p50/p95 per metric, keyed by
 * (branch, strategy).
 *
 * Each input file is one review run, captured manually after a dev-server
 * review completes — copy the entire review JSON (the body the API returns
 * for a finished review) into a file named:
 *
 *   <runDir>/<branchSlot>__<strategy>__<runIndex>.json
 *
 *   e.g. b1__performance__1.json, b1__balanced__1.json, b2__balanced__2.json
 *
 *   branchSlot ∈ { b1, b2, b3, u1, u2, u3, u4 }   // b* = AtlasEngineMVP, u* = Project Black Unity
 *   strategy   ∈ { balanced, performance }
 *   runIndex   ≥ 1                    // 2-3 runs per (branch, strategy)
 *                                     // smooth provider variance
 *
 * Usage:
 *   node backend/scripts/performance-m0-aggregate.mjs <runDir>
 *
 * Output: <runDir>/__rollup.json + a printed summary table.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// Filename forms:
//   <slot>__<strategy>__<runIndex>.json                — pre-Track-2 (Claude only)
//   <slot>__<strategy>__<provider>__<runIndex>.json   — Track-2 (Codex etc.)
// Default provider for the 3-field form is `claude` so existing artifacts
// remain in the same group when re-aggregated.
const FILENAME_RE = /^(b[1-3]|u[1-4])__(balanced|performance)__(?:([a-z][a-z0-9_-]*)__)?(\d+)\.json$/i;

function parseFilename(name) {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  return {
    branch: m[1].toLowerCase(),
    strategy: m[2].toLowerCase(),
    provider: (m[3] || 'claude').toLowerCase(),
    runIndex: Number(m[4]),
  };
}

/**
 * Locate the review and stats objects in any of the recognized JSON shapes:
 *   - bare stats          : `{ executionMode, ... }`
 *   - bare review payload : `{ stats, recommendations, tokensUsed, ... }`
 *   - driver capture      : `{ triggerResponse: { review: { stats, ... } }, branchReview }`
 */
function pickReviewAndStats(json) {
  if (!json || typeof json !== 'object') return { review: null, stats: {} };
  if (json.triggerResponse?.review) {
    return { review: json.triggerResponse.review, stats: json.triggerResponse.review.stats || {} };
  }
  if (json.review?.stats) {
    return { review: json.review, stats: json.review.stats };
  }
  if (json.stats && typeof json.stats === 'object') {
    return { review: json, stats: json.stats };
  }
  return { review: null, stats: json };
}

function pickMetrics(json) {
  const { review, stats } = pickReviewAndStats(json);
  const perf = stats?.performance || {};
  const tt = perf.toolUseTelemetry || {};
  const tokensIn = Number(
    review?.tokensUsed?.input
      ?? stats?.tokensUsed?.input
      ?? stats?.agenticTokensUsed?.input
      ?? 0
  );
  const tokensOut = Number(
    review?.tokensUsed?.output
      ?? stats?.tokensUsed?.output
      ?? stats?.agenticTokensUsed?.output
      ?? 0
  );
  const costUsd = Number(
    review?.estimatedCost
      ?? stats?.agenticCostUsd
      ?? stats?.costUsd
      ?? 0
  );
  const recs = Array.isArray(review?.recommendations)
    ? review.recommendations
    : (Array.isArray(stats?.recommendations) ? stats.recommendations : null);
  return {
    durationMs: Number(stats?.agenticDurationMs ?? stats?.durationMs ?? 0),
    inputTokens: tokensIn,
    outputTokens: tokensOut,
    totalTokens: tokensIn + tokensOut,
    costUsd,
    turns: Number(stats?.agenticActualTurns ?? 0),
    toolCalls: Number(tt.toolCalls ?? stats?.agenticToolUseCount ?? 0),
    fullFileReads: Number(tt.fullFileReads ?? 0),
    partialFileReads: Number(tt.partialFileReads ?? 0),
    gitDiffCalls: Number(tt.gitDiffCalls ?? 0),
    repeatedReadsTotal: Number(tt.repeatedReadsTotal ?? 0),
    uniqueFilesRead: Number(tt.uniqueFilesRead ?? 0),
    classificationReliability: Number(tt.classificationReliability ?? NaN),
    findingsCount: recs ? recs.length : Number(stats?.findingsCount ?? 0),
    isPartial: Boolean(stats?.isPartial),
    parseRecovered: Boolean(stats?.parseRecovered),
    telemetryPresent: Boolean(stats?.performance?.toolUseTelemetry),
    // M1a fields — `null` when run was captured pre-M1a so aggregator can
    // distinguish "not measured" from "measured and the value is null".
    explorationMode: typeof perf.explorationMode === 'string' ? perf.explorationMode : null,
    explorationModeIntended: typeof perf.explorationModeIntended === 'string' ? perf.explorationModeIntended : null,
    explorationModeReconciled: typeof perf.explorationModeReconciled === 'boolean' ? perf.explorationModeReconciled : null,
    // M2 #67 stage 1: per-call runtime MCP telemetry. `null` when the run
    // predates stage 1 so we can tell "not measured" apart from "measured
    // and zero MCP calls" (the legitimate small-PR / Phase-A.0-fallback
    // outcome).
    runtimeMcpCalls: Array.isArray(tt.runtimeMcpCalls) ? tt.runtimeMcpCalls : null,
    runtimeMcpSummary: tt.runtimeMcpSummary && typeof tt.runtimeMcpSummary === 'object'
      ? tt.runtimeMcpSummary
      : null,
  };
}

function rollupExplorationModes(runs) {
  // Distinguish "M1a-instrumented run with explorationMode === null" from
  // "pre-M1a capture that simply doesn't have the field" by checking
  // whether explorationModeReconciled was emitted at all.
  const m1aRuns = runs.filter((r) => r.metrics.explorationModeReconciled !== null);
  if (m1aRuns.length === 0) {
    return { m1aRunCount: 0, observed: {}, intended: {}, reconciledCount: 0, driftCount: 0 };
  }
  const observed = {};
  const intended = {};
  let reconciledCount = 0;
  for (const r of m1aRuns) {
    const o = r.metrics.explorationMode;
    const i = r.metrics.explorationModeIntended;
    if (o) observed[o] = (observed[o] || 0) + 1;
    if (i) intended[i] = (intended[i] || 0) + 1;
    if (r.metrics.explorationModeReconciled === true) reconciledCount += 1;
  }
  return {
    m1aRunCount: m1aRuns.length,
    observed,
    intended,
    reconciledCount,
    driftCount: m1aRuns.length - reconciledCount,
    driftRate: m1aRuns.length > 0 ? Number(((m1aRuns.length - reconciledCount) / m1aRuns.length).toFixed(3)) : null,
  };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const w = rank - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

function summarize(values) {
  const numeric = values.map(Number).filter((n) => Number.isFinite(n));
  if (numeric.length === 0) return { n: 0, p50: null, p95: null, mean: null, min: null, max: null };
  const sorted = [...numeric].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    p50: Number(percentile(sorted, 50).toFixed(3)),
    p95: Number(percentile(sorted, 95).toFixed(3)),
    mean: Number((sum / sorted.length).toFixed(3)),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * M2 #67 stage 1: aggregate per-call runtime MCP telemetry across runs.
 * Returns null when no run in the group emitted Stage 1 fields (so older
 * captures don't pollute the rollup with zeros that could be confused
 * with "measured zero MCP calls").
 */
function rollupRuntimeMcp(runs) {
  const stage1Runs = runs.filter((r) => r.metrics.runtimeMcpSummary !== null);
  if (stage1Runs.length === 0) return null;
  const callCounts = stage1Runs.map((r) => Number(r.metrics.runtimeMcpSummary?.callCount || 0));
  const samePathMaxes = stage1Runs.map((r) => Number(r.metrics.runtimeMcpSummary?.samePathCallCountMax || 0));
  const overlapMaxes = stage1Runs.map((r) => Number(r.metrics.runtimeMcpSummary?.maxOverlapPct || 0));
  const containedTotals = stage1Runs.map((r) => Number(r.metrics.runtimeMcpSummary?.fullyContainedRedundantReads || 0));
  const perToolTotals = { read_file_slice: 0, get_hunk_context: 0, get_diff_for_file: 0 };
  const repeatedPathHits = new Map();
  for (const r of stage1Runs) {
    const s = r.metrics.runtimeMcpSummary || {};
    const pt = s.perToolCounts || {};
    for (const k of Object.keys(perToolTotals)) {
      perToolTotals[k] += Number(pt[k] || 0);
    }
    const top = Array.isArray(s.topRepeatedPaths) ? s.topRepeatedPaths : [];
    for (const entry of top) {
      if (!entry || typeof entry.path !== 'string') continue;
      const prior = repeatedPathHits.get(entry.path) || 0;
      repeatedPathHits.set(entry.path, prior + Number(entry.count || 0));
    }
  }
  const topRepeatedPaths = Array.from(repeatedPathHits.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    stage1RunCount: stage1Runs.length,
    callCount: summarize(callCounts),
    samePathCallCountMax: summarize(samePathMaxes),
    maxOverlapPct: summarize(overlapMaxes),
    fullyContainedRedundantReads: summarize(containedTotals),
    perToolTotals,
    topRepeatedPaths,
  };
}

function rollupGroup(runs) {
  const fields = [
    'durationMs', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd',
    'turns', 'toolCalls', 'fullFileReads', 'partialFileReads',
    'gitDiffCalls', 'repeatedReadsTotal', 'uniqueFilesRead',
    'classificationReliability', 'findingsCount',
  ];
  const summary = {};
  for (const field of fields) {
    summary[field] = summarize(runs.map((r) => r.metrics[field]));
  }
  const partialCount = runs.filter((r) => r.metrics.isPartial).length;
  const parseRecoveredCount = runs.filter((r) => r.metrics.parseRecovered).length;
  const telemetryMissingCount = runs.filter((r) => !r.metrics.telemetryPresent).length;
  return {
    runCount: runs.length,
    partialCount,
    parseRecoveredCount,
    telemetryMissingCount,
    explorationModes: rollupExplorationModes(runs),
    runtimeMcp: rollupRuntimeMcp(runs),
    summary,
  };
}

function deltaPct(performance, balanced) {
  if (!Number.isFinite(performance) || !Number.isFinite(balanced) || balanced === 0) return null;
  return Number((((performance - balanced) / balanced) * 100).toFixed(1));
}

function buildComparison(perfGroup, balGroup) {
  if (!perfGroup || !balGroup) return null;
  const fields = ['durationMs', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'turns', 'toolCalls', 'fullFileReads'];
  const out = {};
  for (const field of fields) {
    const p = perfGroup.summary[field]?.p50;
    const b = balGroup.summary[field]?.p50;
    out[field] = { performance_p50: p, balanced_p50: b, deltaPct: deltaPct(p, b) };
  }
  return out;
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('Usage: node performance-m0-aggregate.mjs <runDir>');
    process.exit(2);
  }
  const absRunDir = path.resolve(process.cwd(), runDir);
  const entries = await fs.readdir(absRunDir).catch((err) => {
    console.error(`Failed to read ${absRunDir}: ${err.message}`);
    process.exit(2);
  });

  const runs = [];
  const skipped = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry.startsWith('__')) continue;
    const parsed = parseFilename(entry);
    if (!parsed) {
      skipped.push({ file: entry, reason: 'filename does not match <branch>__<strategy>__<n>.json' });
      continue;
    }
    const filePath = path.join(absRunDir, entry);
    let json;
    try {
      json = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (err) {
      skipped.push({ file: entry, reason: `JSON parse error: ${err.message}` });
      continue;
    }
    const metrics = pickMetrics(json);
    if (!metrics.telemetryPresent) {
      skipped.push({
        file: entry,
        reason: 'review.stats.performance.toolUseTelemetry missing — was ATLAS_REVIEW_TELEMETRY_BALANCED=1 set for the Balanced run?',
      });
    }
    runs.push({ file: entry, ...parsed, metrics });
  }

  // Group by (branch, strategy)
  const groups = new Map();
  for (const run of runs) {
    // Group key includes provider so Track-2 Codex runs don't pool with
    // Claude runs. Pre-Track-2 captures default to provider=claude (set
    // in parseFilename), so existing rollup keys remain stable when
    // re-aggregated.
    const key = run.provider === 'claude'
      ? `${run.branch}__${run.strategy}`
      : `${run.branch}__${run.strategy}__${run.provider}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }

  const perGroup = {};
  for (const [key, groupRuns] of groups.entries()) {
    perGroup[key] = rollupGroup(groupRuns);
  }

  const comparison = {};
  for (const branch of ['b1', 'b2', 'b3', 'u1', 'u2', 'u3', 'u4']) {
    const perf = perGroup[`${branch}__performance`];
    const bal = perGroup[`${branch}__balanced`];
    if (perf && bal) {
      comparison[branch] = buildComparison(perf, bal);
    }
  }

  const rollup = {
    generatedAt: new Date().toISOString(),
    runDir: absRunDir,
    totalRuns: runs.length,
    skipped,
    perGroup,
    comparison,
  };

  const outPath = path.join(absRunDir, '__rollup.json');
  await fs.writeFile(outPath, JSON.stringify(rollup, null, 2));

  // Console summary
  console.log(`\nPerformance M0 rollup — ${runs.length} runs, ${Object.keys(perGroup).length} groups\n`);
  if (skipped.length > 0) {
    console.log(`Skipped/warned (${skipped.length}):`);
    for (const s of skipped) console.log(`  - ${s.file}: ${s.reason}`);
    console.log('');
  }
  for (const [key, g] of Object.entries(perGroup)) {
    console.log(`${key}: n=${g.runCount}  partial=${g.partialCount}  parseRecovered=${g.parseRecoveredCount}  telemetryMissing=${g.telemetryMissingCount}`);
    const s = g.summary;
    console.log(`  duration   p50=${s.durationMs.p50}ms  p95=${s.durationMs.p95}ms`);
    console.log(`  inTokens   p50=${s.inputTokens.p50}    p95=${s.inputTokens.p95}`);
    console.log(`  outTokens  p50=${s.outputTokens.p50}   p95=${s.outputTokens.p95}`);
    console.log(`  cost($)    p50=${s.costUsd.p50}        p95=${s.costUsd.p95}`);
    console.log(`  turns      p50=${s.turns.p50}          p95=${s.turns.p95}`);
    console.log(`  toolCalls  p50=${s.toolCalls.p50}      p95=${s.toolCalls.p95}`);
    console.log(`  fullReads  p50=${s.fullFileReads.p50}  p95=${s.fullFileReads.p95}`);
    console.log(`  classifReliability p50=${s.classificationReliability.p50}`);
    if (g.explorationModes.m1aRunCount > 0) {
      const m = g.explorationModes;
      const fmtMap = (obj) => Object.entries(obj).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`  exploration  observed={${fmtMap(m.observed)}}  intended={${fmtMap(m.intended)}}`);
      console.log(`  drift        reconciled=${m.reconciledCount}/${m.m1aRunCount}  rate=${m.driftRate}`);
    }
    if (g.runtimeMcp) {
      const r = g.runtimeMcp;
      const fmtMap = (obj) => Object.entries(obj).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`  rtMcp        n=${r.stage1RunCount}  callCount p50=${r.callCount.p50} max=${r.callCount.max}`);
      console.log(`  rtMcp        samePathMax p50=${r.samePathCallCountMax.p50} max=${r.samePathCallCountMax.max}`);
      console.log(`  rtMcp        maxOverlapPct p50=${r.maxOverlapPct.p50} max=${r.maxOverlapPct.max}`);
      console.log(`  rtMcp        contained-redundant total p50=${r.fullyContainedRedundantReads.p50} max=${r.fullyContainedRedundantReads.max}`);
      console.log(`  rtMcp        perTool {${fmtMap(r.perToolTotals)}}`);
      if (r.topRepeatedPaths.length > 0) {
        const top3 = r.topRepeatedPaths.slice(0, 3).map((e) => `${e.path}×${e.count}`).join(', ');
        console.log(`  rtMcp        topRepeated  ${top3}`);
      }
    }
    console.log('');
  }
  if (Object.keys(comparison).length > 0) {
    console.log('Performance vs Balanced (Δ% on p50; negative = Performance better):');
    for (const [branch, c] of Object.entries(comparison)) {
      console.log(`  ${branch}:`);
      for (const [field, v] of Object.entries(c)) {
        const sign = v.deltaPct == null ? 'n/a' : (v.deltaPct > 0 ? `+${v.deltaPct}%` : `${v.deltaPct}%`);
        console.log(`    ${field.padEnd(14)}  perf=${v.performance_p50}  bal=${v.balanced_p50}  Δ=${sign}`);
      }
    }
  }
  console.log(`\nRollup written: ${outPath}\n`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
