#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

import reviewQualityHarness from '../src/services/reviewQualityHarness.js';
import providerService from '../src/services/providerService.js';
import db from '../src/db/connection.js';
import { loadVariantConfig } from '../src/scripts/reviewPrBenchmarkRunner.js';
import {
  DEFAULT_MATRIX_OUT_DIR,
  buildMatrixEntry,
  buildMatrixSummary,
  buildRepeatedMatrixEntry,
  loadCandidateVariantEntries,
  parseMatrixArgs,
} from '../src/scripts/reviewPrBenchmarkMatrix.js';

const TEARDOWN_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeDbWithTimeout() {
  if (typeof db.close !== 'function') return { status: 'skipped' };
  try {
    return await Promise.race([
      db.close().then(() => ({ status: 'closed' })),
      sleep(TEARDOWN_TIMEOUT_MS).then(() => ({ status: 'timeout' })),
    ]);
  } catch (error) {
    return {
      status: 'error',
      error: error?.message || String(error),
    };
  }
}

function printHelp() {
  console.log(`PR review benchmark matrix runner

Usage:
  node scripts/review-pr-benchmark-matrix.mjs [options]

Options:
  --dry-run                        Build prompts only (no provider calls)
  --fixtures <id1,id2>             Run only selected fixture IDs
  --fixture-set <name>             Fixture collection (default: pr_review)
  --surface <surface>              Review surface (default: pr_review)
  --manifest <path>                Candidate manifest path
  --candidate-ids <id1,id2>        Run only selected candidate ids from the manifest
  --baseline-config <path>         JSON file for baseline variant config
  --baseline-label <label>         Baseline label override (default: control)
  --provider-id <id>               Preferred connected provider id for this benchmark run
  --repeat <count>                 Run each candidate comparison multiple times and aggregate the scorecard
  --out-dir <path>                 Output directory (default: ${DEFAULT_MATRIX_OUT_DIR})
  -h, --help                       Show this help
`);
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
  const args = parseMatrixArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const startedAt = Date.now();
  const baselineVariant = await loadVariantConfig(args.baselineConfigPath, {
    cwd: process.cwd(),
    fallbackLabel: args.baselineLabel,
  });
  const manifest = await loadCandidateVariantEntries({
    manifestPath: args.manifestPath,
    candidateIds: args.candidateIds,
    cwd: process.cwd(),
  });

  const entries = [];
  for (const candidate of manifest.candidates) {
    const runEntries = [];
    for (let repeatIndex = 0; repeatIndex < Math.max(1, Number(args.repeat || 1)); repeatIndex += 1) {
      const comparison = await reviewQualityHarness.compareBenchmarkVariants({
        fixtureIds: args.fixtureIds,
        fixtureSet: args.fixtureSet,
        surface: args.surface,
        dryRun: args.dryRun,
        preferredProviderId: args.preferredProviderId,
        baseline: baselineVariant.config,
        candidate: candidate.variant.config,
      });
      runEntries.push(buildMatrixEntry({ candidate, comparison }));
    }
    entries.push(runEntries.length === 1
      ? runEntries[0]
      : buildRepeatedMatrixEntry({ candidate, runs: runEntries }));
  }

  const [providerSnapshot, reviewModelSnapshot] = await Promise.all([
    loadProviderSnapshot(),
    loadReviewModelSnapshot(),
  ]);

  const artifact = {
    version: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    options: {
      dryRun: args.dryRun,
      fixtureIds: args.fixtureIds,
      fixtureSet: args.fixtureSet,
      surface: args.surface,
      manifestPath: manifest.manifestPath,
      candidateIds: args.candidateIds,
      baselineConfigPath: baselineVariant.path,
      baselineLabel: baselineVariant.config.label,
      preferredProviderId: args.preferredProviderId,
      repeat: args.repeat,
    },
    snapshot: {
      nodeEnv: process.env.NODE_ENV || 'development',
      dbType: typeof db.getDbType === 'function' ? db.getDbType() : 'unknown',
      provider: providerSnapshot,
      reviewModelConfig: reviewModelSnapshot,
    },
    summary: buildMatrixSummary(entries),
    candidates: entries,
  };

  const outputDir = path.resolve(process.cwd(), args.outDir || DEFAULT_MATRIX_OUT_DIR);
  await fs.mkdir(outputDir, { recursive: true });
  const fileSafeTimestamp = artifact.generatedAt.replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `pr-benchmark-matrix-${fileSafeTimestamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8');

  console.log(`PR benchmark matrix complete (${args.dryRun ? 'dry-run' : 'live'}).`);
  console.log(`Artifact: ${outputPath}`);
  console.log(`Candidates: ${entries.length}`);
  if (artifact.summary?.leader) {
    console.log(`Leader: ${artifact.summary.leader.id}`);
  }
  if (artifact.summary?.budgetStatusCounts) {
    console.log(`Budget status: within ${artifact.summary.budgetStatusCounts.within_budget || 0} | over ${artifact.summary.budgetStatusCounts.over_budget || 0}`);
  }
  for (const entry of entries) {
    console.log([
      `- ${entry.id}`,
      `repeat ${entry.scorecard.repeatCount || 1}`,
      `score +${entry.scorecard.scoreImprovedFixtures}/-${entry.scorecard.scoreRegressedFixtures}`,
      `pass +${entry.scorecard.passImprovedFixtures}/-${entry.scorecard.passRegressedFixtures}`,
      `prompt ${entry.scorecard.avgPromptCharsDelta >= 0 ? '+' : ''}${Math.round(entry.scorecard.avgPromptCharsDelta)}`,
      `budget ${entry.scorecard.promptBudgetStatus || 'unknown'}`,
      `trunc ${entry.scorecard.promptContextTruncatedRateDelta >= 0 ? '+' : ''}${(entry.scorecard.promptContextTruncatedRateDelta * 100).toFixed(1)}%`,
    ].join(' | '));
    const bugClassSummary = entry.scorecard?.bugClassSummary || {};
    for (const [bugClass, summary] of Object.entries(bugClassSummary)) {
      const totalRuns = Number(summary.totalRuns || 0);
      if (totalRuns > 0) {
        console.log(`  bugClass ${bugClass}: improved runs ${summary.improvedRuns || 0}/${totalRuns} | regressed runs ${summary.regressedRuns || 0}/${totalRuns} | avg score +${(summary.avgScoreImproved || 0).toFixed(2)}/-${(summary.avgScoreRegressed || 0).toFixed(2)} | fixtures ${summary.totalFixtures || 0}`);
        continue;
      }
      console.log(`  bugClass ${bugClass}: score +${summary.scoreImproved || 0}/-${summary.scoreRegressed || 0} | pass +${summary.passImproved || 0}/-${summary.passRegressed || 0} | fixtures ${summary.totalFixtures || 0}`);
    }
  }

  return { outputPath, artifact };
}

let exitCode = 0;
let teardownStatus = { status: 'skipped' };

try {
  await main();
} catch (error) {
  console.error(`PR benchmark matrix failed: ${error.message || String(error)}`);
  exitCode = 1;
} finally {
  teardownStatus = await closeDbWithTimeout();
  if (teardownStatus.status === 'timeout') {
    console.warn(`PR benchmark matrix teardown timed out after ${TEARDOWN_TIMEOUT_MS}ms while closing database resources.`);
  } else if (teardownStatus.status === 'error') {
    console.warn(`PR benchmark matrix teardown error: ${teardownStatus.error}`);
  }
  process.exit(exitCode);
}
