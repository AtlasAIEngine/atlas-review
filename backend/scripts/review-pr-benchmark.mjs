#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import reviewQualityHarness from '../src/services/reviewQualityHarness.js';
import providerService from '../src/services/providerService.js';
import db from '../src/db/connection.js';
import {
  DEFAULT_OUT_DIR,
  buildBenchmarkScorecard,
  loadVariantConfig,
  parseArgs,
} from '../src/scripts/reviewPrBenchmarkRunner.js';

function printHelp() {
  console.log(`PR review benchmark runner

Usage:
  node scripts/review-pr-benchmark.mjs [options]

Options:
  --dry-run                        Build prompts only (no provider calls)
  --fixtures <id1,id2>             Run only selected fixture IDs
  --fixture-set <name>             Fixture collection (default: pr_review)
  --surface <surface>              Review surface (default: pr_review)
  --baseline-config <path>         JSON file for baseline variant config
  --candidate-config <path>        JSON file for candidate variant config
  --baseline-label <label>         Baseline label override (default: control)
  --candidate-label <label>        Candidate label override (default: candidate)
  --out-dir <path>                 Output directory (default: ${DEFAULT_OUT_DIR})
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
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const startedAt = Date.now();
  const [baselineVariant, candidateVariant] = await Promise.all([
    loadVariantConfig(args.baselineConfigPath, {
      cwd: process.cwd(),
      fallbackLabel: args.baselineLabel,
    }),
    loadVariantConfig(args.candidateConfigPath, {
      cwd: process.cwd(),
      fallbackLabel: args.candidateLabel,
    }),
  ]);

  if (!baselineVariant.config.label) baselineVariant.config.label = args.baselineLabel;
  if (!candidateVariant.config.label) candidateVariant.config.label = args.candidateLabel;

  const comparison = await reviewQualityHarness.compareBenchmarkVariants({
    fixtureIds: args.fixtureIds,
    fixtureSet: args.fixtureSet,
    surface: args.surface,
    dryRun: args.dryRun,
    baseline: baselineVariant.config,
    candidate: candidateVariant.config,
  });

  const [providerSnapshot, reviewModelSnapshot] = await Promise.all([
    loadProviderSnapshot(),
    loadReviewModelSnapshot(),
  ]);

  const scorecard = buildBenchmarkScorecard(comparison);
  const artifact = {
    version: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    options: {
      dryRun: args.dryRun,
      fixtureIds: args.fixtureIds,
      fixtureSet: args.fixtureSet,
      surface: args.surface,
      baselineConfigPath: baselineVariant.path,
      candidateConfigPath: candidateVariant.path,
      baselineLabel: baselineVariant.config.label,
      candidateLabel: candidateVariant.config.label,
    },
    snapshot: {
      nodeEnv: process.env.NODE_ENV || 'development',
      dbType: typeof db.getDbType === 'function' ? db.getDbType() : 'unknown',
      provider: providerSnapshot,
      reviewModelConfig: reviewModelSnapshot,
    },
    benchmark: {
      scorecard,
    },
    comparison,
  };

  const outputDir = path.resolve(process.cwd(), args.outDir || DEFAULT_OUT_DIR);
  await fs.mkdir(outputDir, { recursive: true });
  const fileSafeTimestamp = artifact.generatedAt.replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `pr-benchmark-${fileSafeTimestamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8');

  console.log(`PR benchmark complete (${args.dryRun ? 'dry-run' : 'live'}).`);
  console.log(`Artifact: ${outputPath}`);
  console.log(`Variants: ${comparison.baseline.mode} -> ${comparison.improved.mode}`);
  console.log(`Fixtures: ${scorecard.totalFixtures}`);
  console.log(`Pass rate delta: ${(comparison.delta.passRate * 100).toFixed(1)}%`);
  console.log(`Average score delta: ${(comparison.delta.avgScore * 100).toFixed(1)} pts`);
  console.log(`Average prompt chars delta: ${comparison.delta.avgPromptChars >= 0 ? '+' : ''}${Math.round(comparison.delta.avgPromptChars)}`);
  console.log(`Average prompt-context chars delta: ${comparison.delta.avgPromptContextUsedChars >= 0 ? '+' : ''}${Math.round(comparison.delta.avgPromptContextUsedChars)}`);
  console.log(`Prompt truncation rate delta: ${(comparison.delta.promptContextTruncatedRate * 100).toFixed(1)}%`);
  console.log(`Fixture score changes: +${scorecard.scoreImprovedFixtures} / -${scorecard.scoreRegressedFixtures}`);
  console.log(`Fixture pass-state changes: +${scorecard.passImprovedFixtures} / -${scorecard.passRegressedFixtures}`);
}

try {
  await main();
} catch (error) {
  console.error(`PR benchmark failed: ${error.message || String(error)}`);
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
