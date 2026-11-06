#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import reviewQualityHarness from '../src/services/reviewQualityHarness.js';
import providerService from '../src/services/providerService.js';
import db from '../src/db/connection.js';

const DEFAULT_OUT_DIR = '.artifacts/review-harness-calibration';

function parseCsvList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback, min = null, max = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  let result = Math.round(parsed);
  if (Number.isFinite(min)) result = Math.max(min, result);
  if (Number.isFinite(max)) result = Math.min(max, result);
  return result;
}

function parseFloatBounded(value, fallback, min = null, max = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  let result = parsed;
  if (Number.isFinite(min)) result = Math.max(min, result);
  if (Number.isFinite(max)) result = Math.min(max, result);
  return result;
}

function readArgValue(argv, index, argName) {
  const next = argv[index + 1];
  if (next == null || next.startsWith('--')) {
    throw new Error(`Missing value for ${argName}`);
  }
  return next;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    iterations: 1,
    fixtureIds: null,
    outDir: DEFAULT_OUT_DIR,
    strategyMatrix: ['latency_first', 'smart', 'max_quality'],
    strategyQualityMode: 'v2',
    gateThresholds: {},
    adaptiveConfig: {},
    tuningTargets: {},
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--iterations':
      case '-n':
        args.iterations = parseInteger(readArgValue(argv, i, arg), args.iterations, 1, 50);
        i += 1;
        break;
      case '--fixtures':
        args.fixtureIds = parseCsvList(readArgValue(argv, i, arg));
        i += 1;
        break;
      case '--out-dir':
        args.outDir = readArgValue(argv, i, arg).trim() || DEFAULT_OUT_DIR;
        i += 1;
        break;
      case '--strategy-matrix': {
        const parsed = parseCsvList(readArgValue(argv, i, arg));
        args.strategyMatrix = parsed;
        i += 1;
        break;
      }
      case '--strategy-quality-mode': {
        const rawMode = String(readArgValue(argv, i, arg) || '').trim().toLowerCase();
        if (!['v1', 'v2', 'auto'].includes(rawMode)) {
          throw new Error(`Invalid --strategy-quality-mode: ${rawMode}`);
        }
        args.strategyQualityMode = rawMode;
        i += 1;
        break;
      }
      case '--min-completed-fixtures':
        args.gateThresholds.minCompletedFixtures = parseInteger(readArgValue(argv, i, arg), 5, 1, 1000);
        i += 1;
        break;
      case '--min-pass-rate-delta':
        args.gateThresholds.minPassRateDelta = parseFloatBounded(readArgValue(argv, i, arg), 0, -1, 1);
        i += 1;
        break;
      case '--min-avg-score-delta':
        args.gateThresholds.minAvgScoreDelta = parseFloatBounded(readArgValue(argv, i, arg), 0, -1, 1);
        i += 1;
        break;
      case '--max-timeout-rate':
        args.gateThresholds.maxTimeoutOrDeadlineErrorRate = parseFloatBounded(readArgValue(argv, i, arg), 0.1, 0, 1);
        i += 1;
        break;
      case '--max-partial-rate':
        args.gateThresholds.maxPartialRate = parseFloatBounded(readArgValue(argv, i, arg), 0.2, 0, 1);
        i += 1;
        break;
      case '--max-error-regression':
        args.gateThresholds.maxErrorRateRegression = parseFloatBounded(readArgValue(argv, i, arg), 0.02, 0, 1);
        i += 1;
        break;
      case '--min-first-signal-data-rate':
        args.gateThresholds.minFirstSignalDataRate = parseFloatBounded(readArgValue(argv, i, arg), 0.25, 0, 1);
        i += 1;
        break;
      case '--max-first-signal-p95-ms':
        args.gateThresholds.maxFirstSignalP95Ms = parseInteger(readArgValue(argv, i, arg), 90000, 1000, 1_800_000);
        i += 1;
        break;
      case '--min-chunk-cadence-per-minute':
        args.gateThresholds.minChunkCadencePerMinute = parseFloatBounded(readArgValue(argv, i, arg), 0.5, 0, 1000);
        i += 1;
        break;
      case '--fast-path-max-files':
        args.adaptiveConfig.fastPathMaxFiles = parseInteger(readArgValue(argv, i, arg), 12, 1, 200);
        i += 1;
        break;
      case '--fast-path-max-diff-chars':
        args.adaptiveConfig.fastPathMaxDiffChars = parseInteger(readArgValue(argv, i, arg), 20000, 2000, 1000000);
        i += 1;
        break;
      case '--prefer-quality-on-high-risk':
        args.adaptiveConfig.preferQualityOnHighRisk = parseBoolean(readArgValue(argv, i, arg), true);
        i += 1;
        break;
      case '--min-fast-path-coverage-rate':
        args.tuningTargets.minFastPathCoverageRate = parseFloatBounded(readArgValue(argv, i, arg), 0.35, 0, 1);
        i += 1;
        break;
      case '--max-fast-path-coverage-rate':
        args.tuningTargets.maxFastPathCoverageRate = parseFloatBounded(readArgValue(argv, i, arg), 0.75, 0, 1);
        i += 1;
        break;
      case '--max-deep-scope-pressure-rate':
        args.tuningTargets.maxDeepScopePressureRate = parseFloatBounded(readArgValue(argv, i, arg), 0.65, 0, 1);
        i += 1;
        break;
      case '--max-recommendation-budget-pressure-rate':
        args.tuningTargets.maxRecommendationBudgetPressureRate = parseFloatBounded(readArgValue(argv, i, arg), 0.45, 0, 1);
        i += 1;
        break;
      case '--min-high-risk-issue-coverage-rate':
        args.tuningTargets.minHighRiskIssueCoverageRate = parseFloatBounded(readArgValue(argv, i, arg), 0.75, 0, 1);
        args.gateThresholds.minHighRiskIssueCoverageRate = args.tuningTargets.minHighRiskIssueCoverageRate;
        i += 1;
        break;
      case '--min-first-signal-data-rate-target':
        args.tuningTargets.minFirstSignalDataRate = parseFloatBounded(readArgValue(argv, i, arg), 0.25, 0, 1);
        i += 1;
        break;
      case '--max-first-signal-p95-ms-target':
        args.tuningTargets.maxFirstSignalP95Ms = parseInteger(readArgValue(argv, i, arg), 90000, 1000, 1_800_000);
        i += 1;
        break;
      case '--min-chunk-cadence-per-minute-target':
        args.tuningTargets.minChunkCadencePerMinute = parseFloatBounded(readArgValue(argv, i, arg), 0.5, 0, 1000);
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Array.isArray(args.fixtureIds) || args.fixtureIds.length === 0) {
    args.fixtureIds = null;
  }
  if (!Array.isArray(args.strategyMatrix) || args.strategyMatrix.length === 0) {
    args.strategyMatrix = null;
  } else {
    args.strategyMatrix = args.strategyMatrix
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    if (
      args.strategyMatrix.length === 1
      && ['none', 'off', 'disable', 'disabled'].includes(args.strategyMatrix[0])
    ) {
      args.strategyMatrix = null;
    }
  }
  if (Object.keys(args.gateThresholds).length === 0) {
    args.gateThresholds = null;
  }
  if (Object.keys(args.adaptiveConfig).length === 0) {
    args.adaptiveConfig = null;
  }
  if (Object.keys(args.tuningTargets).length === 0) {
    args.tuningTargets = null;
  }

  return args;
}

function printHelp() {
  console.log(`Review harness calibration runner

Usage:
  node scripts/review-harness-calibration.mjs [options]

Options:
  --dry-run                                  Build prompts only (no provider calls)
  -n, --iterations <count>                   Number of compare runs (default: 1, max: 50)
  --fixtures <id1,id2>                       Run only selected fixture IDs
  --out-dir <path>                           Output directory (default: ${DEFAULT_OUT_DIR})
  --strategy-matrix <a,b,c>                  Strategy matrix (default: latency_first,smart,max_quality)
  --strategy-quality-mode <v1|v2|auto>       Quality mode for strategy matrix runs (default: v2)
  --min-completed-fixtures <n>               Rollout gate override
  --min-pass-rate-delta <n>
  --min-avg-score-delta <n>
  --max-timeout-rate <n>
  --max-partial-rate <n>
  --max-error-regression <n>
  --min-first-signal-data-rate <n>
  --max-first-signal-p95-ms <n>
  --min-chunk-cadence-per-minute <n>
  --fast-path-max-files <n>                  Adaptive threshold override for analysis
  --fast-path-max-diff-chars <n>             Adaptive threshold override for analysis
  --prefer-quality-on-high-risk <true|false> Adaptive threshold override for analysis
  --min-fast-path-coverage-rate <n>          Tuning signal target override
  --max-fast-path-coverage-rate <n>          Tuning signal target override
  --max-deep-scope-pressure-rate <n>         Tuning signal target override
  --max-recommendation-budget-pressure-rate <n>
  --min-high-risk-issue-coverage-rate <n>
  --min-first-signal-data-rate-target <n>
  --max-first-signal-p95-ms-target <n>
  --min-chunk-cadence-per-minute-target <n>
  -h, --help                                 Show this help
`);
}

function summarizeRuns(runs = []) {
  const successfulRuns = runs.filter((run) => run.comparison && !run.error);
  const failedRuns = runs.filter((run) => run.error);

  const aggregate = {
    totalRuns: runs.length,
    successfulRuns: successfulRuns.length,
    failedRuns: failedRuns.length,
    rolloutGatePassCount: successfulRuns.filter((run) => run.comparison.rolloutGate?.passed).length,
    rolloutGateFailCount: successfulRuns.filter((run) => !run.comparison.rolloutGate?.passed).length,
    avgImprovedPassRate: null,
    avgImprovedScore: null,
    avgImprovedDurationP95Ms: null,
    avgImprovedFirstSignalP95Ms: null,
    avgImprovedChunkCadencePerMinute: null,
    avgDeltaPassRate: null,
    avgDeltaScore: null,
    strategyMatrix: {
      strategyCount: 0,
      recommendationFrequency: {},
      strategies: {},
    },
  };

  if (successfulRuns.length === 0) {
    return aggregate;
  }

  const avg = (values) => {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const numberValues = (selector) => successfulRuns
    .map(selector)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  aggregate.avgImprovedPassRate = avg(numberValues((run) => run.comparison.improved?.metrics?.passRate));
  aggregate.avgImprovedScore = avg(numberValues((run) => run.comparison.improved?.metrics?.avgScore));
  aggregate.avgImprovedDurationP95Ms = avg(numberValues((run) => run.comparison.improved?.metrics?.durationP95Ms));
  aggregate.avgImprovedFirstSignalP95Ms = avg(numberValues((run) => run.comparison.improved?.metrics?.firstSignalP95Ms));
  aggregate.avgImprovedChunkCadencePerMinute = avg(numberValues((run) => run.comparison.improved?.metrics?.chunkCadencePerMinute));
  aggregate.avgDeltaPassRate = avg(numberValues((run) => run.comparison.delta?.passRate));
  aggregate.avgDeltaScore = avg(numberValues((run) => run.comparison.delta?.avgScore));

  const strategyRows = [];
  for (const run of successfulRuns) {
    const matrix = run.strategyMatrix;
    if (!matrix || !Array.isArray(matrix.strategies)) continue;
    for (const entry of matrix.strategies) {
      strategyRows.push(entry);
    }
    const recommendation = matrix.recommendation?.strategy;
    if (typeof recommendation === 'string' && recommendation.trim()) {
      const key = recommendation.trim().toLowerCase();
      aggregate.strategyMatrix.recommendationFrequency[key] =
        (aggregate.strategyMatrix.recommendationFrequency[key] || 0) + 1;
    }
  }

  if (strategyRows.length > 0) {
    const byStrategy = new Map();
    for (const row of strategyRows) {
      const key = String(row.strategy || 'unknown').trim().toLowerCase();
      if (!byStrategy.has(key)) {
        byStrategy.set(key, {
          count: 0,
          passRate: [],
          avgScore: [],
          durationP95Ms: [],
          recommendationBudgetPressureRate: [],
          highRiskIssueCoverageRate: [],
        });
      }
      const bucket = byStrategy.get(key);
      bucket.count += 1;
      const metrics = row.metrics || {};
      const pushIfFinite = (arr, value) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) arr.push(parsed);
      };
      pushIfFinite(bucket.passRate, metrics.passRate);
      pushIfFinite(bucket.avgScore, metrics.avgScore);
      pushIfFinite(bucket.durationP95Ms, metrics.durationP95Ms);
      pushIfFinite(bucket.recommendationBudgetPressureRate, metrics.recommendationBudgetPressureRate);
      pushIfFinite(bucket.highRiskIssueCoverageRate, metrics.highRiskIssueCoverageRate);
    }

    const strategyAggregate = {};
    for (const [key, bucket] of byStrategy.entries()) {
      strategyAggregate[key] = {
        runs: bucket.count,
        avgPassRate: avg(bucket.passRate),
        avgScore: avg(bucket.avgScore),
        avgDurationP95Ms: avg(bucket.durationP95Ms),
        avgRecommendationBudgetPressureRate: avg(bucket.recommendationBudgetPressureRate),
        avgHighRiskIssueCoverageRate: avg(bucket.highRiskIssueCoverageRate),
      };
    }
    aggregate.strategyMatrix.strategyCount = Object.keys(strategyAggregate).length;
    aggregate.strategyMatrix.strategies = strategyAggregate;
  }

  return aggregate;
}

async function loadReviewModelSnapshot() {
  try {
    const dbType = typeof db.getDbType === 'function' ? db.getDbType() : 'unknown';
    const hasDbConfig = (
      dbType === 'sqlite'
      || Boolean(process.env.DATABASE_URL)
      || Boolean(process.env.DB_HOST)
      || Boolean(process.env.ATLAS_DB_PATH)
    );
    if (!hasDbConfig) {
      return {
        strategy: 'unknown',
        customModels: {},
        adaptive: null,
        note: 'Skipped settings snapshot (no database configuration detected).',
      };
    }

    const result = await db.query(
      'SELECT id, value FROM settings WHERE id IN ($1, $2, $3)',
      ['review_model_strategy', 'review_model_custom', 'review_model_adaptive']
    );
    const byKey = new Map((result.rows || []).map((row) => [row.id, row.value]));
    const strategyRaw = byKey.get('review_model_strategy') || null;
    const customRaw = byKey.get('review_model_custom') || null;
    const adaptiveRaw = byKey.get('review_model_adaptive') || null;

    const custom = (() => {
      if (!customRaw) return {};
      try {
        const parsed = JSON.parse(customRaw);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
      } catch {
        return {};
      }
    })();

    const adaptive = (() => {
      if (!adaptiveRaw) return null;
      try {
        const parsed = JSON.parse(adaptiveRaw);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
      } catch {
        return null;
      }
    })();

    return {
      strategy: typeof strategyRaw === 'string' && strategyRaw.trim()
        ? strategyRaw.trim()
        : 'smart',
      customModels: custom,
      adaptive,
    };
  } catch (error) {
    return {
      error: error.message,
      strategy: 'unknown',
      customModels: {},
      adaptive: null,
    };
  }
}

async function loadProviderSnapshot() {
  try {
    const config = await providerService.loadGlobalConfig();
    const providers = Array.isArray(config?.providers) ? config.providers : [];
    const activeProviderId = config?.activeProviderId || null;
    const activeProvider = providers.find((provider) => provider.id === activeProviderId) || null;

    return {
      activeProviderId,
      activeProvider: activeProvider
        ? {
            id: activeProvider.id || null,
            type: activeProvider.type || null,
            source: activeProvider.source || null,
            model: activeProvider.model || null,
            status: activeProvider.status || null,
            authType: activeProvider._authType || null,
          }
        : null,
      providerCount: providers.length,
      connectedProviderCount: providers.filter((provider) => provider.status === 'connected').length,
    };
  } catch (error) {
    return {
      error: error.message,
      activeProviderId: null,
      activeProvider: null,
      providerCount: 0,
      connectedProviderCount: 0,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const startedAt = Date.now();
  const runs = [];
  for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
    const runStartedAt = Date.now();
    try {
      const comparison = await reviewQualityHarness.compareQualityModes({
        fixtureIds: args.fixtureIds,
        dryRun: args.dryRun,
        gateThresholds: args.gateThresholds,
        adaptiveConfig: args.adaptiveConfig,
        tuningTargets: args.tuningTargets,
      });
      const strategyMatrix = args.strategyMatrix && args.strategyMatrix.length > 0
        ? await reviewQualityHarness.compareRoutingStrategies({
          fixtureIds: args.fixtureIds,
          dryRun: args.dryRun,
          qualityMode: args.strategyQualityMode,
          adaptiveConfig: args.adaptiveConfig,
          strategies: args.strategyMatrix,
        })
        : null;
      runs.push({
        iteration,
        startedAt: new Date(runStartedAt).toISOString(),
        durationMs: Date.now() - runStartedAt,
        comparison,
        strategyMatrix,
      });
    } catch (error) {
      runs.push({
        iteration,
        startedAt: new Date(runStartedAt).toISOString(),
        durationMs: Date.now() - runStartedAt,
        error: error.message || String(error),
      });
    }
  }

  const [providerSnapshot, reviewModelSnapshot] = await Promise.all([
    loadProviderSnapshot(),
    loadReviewModelSnapshot(),
  ]);

  const artifact = {
    version: 2,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    options: {
      dryRun: args.dryRun,
      iterations: args.iterations,
      fixtureIds: args.fixtureIds,
      strategyMatrix: args.strategyMatrix,
      strategyQualityMode: args.strategyQualityMode,
      gateThresholds: args.gateThresholds,
      adaptiveConfig: args.adaptiveConfig,
      tuningTargets: args.tuningTargets,
    },
    snapshot: {
      nodeEnv: process.env.NODE_ENV || 'development',
      dbType: typeof db.getDbType === 'function' ? db.getDbType() : 'unknown',
      provider: providerSnapshot,
      reviewModelConfig: reviewModelSnapshot,
    },
    aggregate: summarizeRuns(runs),
    runs,
  };

  const outputDir = path.resolve(process.cwd(), args.outDir || DEFAULT_OUT_DIR);
  await fs.mkdir(outputDir, { recursive: true });
  const fileSafeTimestamp = artifact.generatedAt.replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `calibration-${fileSafeTimestamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8');

  const passRate = artifact.aggregate.avgImprovedPassRate;
  const score = artifact.aggregate.avgImprovedScore;
  const gatePass = artifact.aggregate.rolloutGatePassCount;
  const gateTotal = artifact.aggregate.successfulRuns;

  console.log(`Calibration complete (${artifact.aggregate.successfulRuns}/${artifact.aggregate.totalRuns} successful runs).`);
  console.log(`Artifact: ${outputPath}`);
  if (passRate != null) {
    console.log(`Average improved pass rate: ${(passRate * 100).toFixed(1)}%`);
  }
  if (score != null) {
    console.log(`Average improved score: ${(score * 100).toFixed(1)} pts`);
  }
  if (gateTotal > 0) {
    console.log(`Rollout gate pass: ${gatePass}/${gateTotal}`);
  }
  const strategyAggregate = artifact.aggregate?.strategyMatrix;
  if (strategyAggregate?.strategyCount > 0) {
    const recommendationEntries = Object.entries(strategyAggregate.recommendationFrequency || {})
      .sort((a, b) => b[1] - a[1]);
    if (recommendationEntries.length > 0) {
      const [topStrategy, count] = recommendationEntries[0];
      console.log(`Top strategy recommendation: ${topStrategy} (${count}/${artifact.aggregate.successfulRuns} runs)`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`Calibration failed: ${error.message || String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    if (typeof db.close === 'function') {
      await db.close();
    }
  } catch {
    // noop
  }
}
