import fs from 'fs/promises';
import path from 'path';

import {
  DEFAULT_OUT_DIR,
  buildBenchmarkScorecard,
  loadVariantConfig,
} from './reviewPrBenchmarkRunner.js';

export const DEFAULT_MANIFEST_PATH = 'config/review-harness-benchmarks/pr-review/manifest.json';
export const DEFAULT_MATRIX_OUT_DIR = `${DEFAULT_OUT_DIR}/matrix`;

function normalizeRepeatCount(value, fallback = 1) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseCsvList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readArgValue(argv, index, argName) {
  const next = argv[index + 1];
  if (next == null || next.startsWith('--')) {
    throw new Error(`Missing value for ${argName}`);
  }
  return next;
}

export function parseMatrixArgs(argv = []) {
  const args = {
    dryRun: false,
    fixtureIds: null,
    fixtureSet: 'pr_review',
    surface: 'pr_review',
    manifestPath: DEFAULT_MANIFEST_PATH,
    candidateIds: null,
    outDir: DEFAULT_MATRIX_OUT_DIR,
    baselineConfigPath: null,
    baselineLabel: 'control',
    preferredProviderId: null,
    repeat: 1,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--fixtures':
        args.fixtureIds = parseCsvList(readArgValue(argv, index, arg));
        index += 1;
        break;
      case '--fixture-set':
        args.fixtureSet = String(readArgValue(argv, index, arg) || '').trim().toLowerCase() || 'pr_review';
        index += 1;
        break;
      case '--surface':
        args.surface = String(readArgValue(argv, index, arg) || '').trim().toLowerCase() || 'pr_review';
        index += 1;
        break;
      case '--manifest':
        args.manifestPath = readArgValue(argv, index, arg).trim() || DEFAULT_MANIFEST_PATH;
        index += 1;
        break;
      case '--candidate-ids':
        args.candidateIds = parseCsvList(readArgValue(argv, index, arg));
        index += 1;
        break;
      case '--out-dir':
        args.outDir = readArgValue(argv, index, arg).trim() || DEFAULT_MATRIX_OUT_DIR;
        index += 1;
        break;
      case '--baseline-config':
        args.baselineConfigPath = readArgValue(argv, index, arg).trim();
        index += 1;
        break;
      case '--baseline-label':
        args.baselineLabel = readArgValue(argv, index, arg).trim() || 'control';
        index += 1;
        break;
      case '--provider-id':
        args.preferredProviderId = readArgValue(argv, index, arg).trim() || null;
        index += 1;
        break;
      case '--repeat':
        args.repeat = normalizeRepeatCount(readArgValue(argv, index, arg), 1);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Array.isArray(args.fixtureIds) || args.fixtureIds.length === 0) args.fixtureIds = null;
  if (!Array.isArray(args.candidateIds) || args.candidateIds.length === 0) args.candidateIds = null;

  return args;
}

export async function loadBenchmarkManifest(manifestPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const resolvedPath = path.resolve(cwd, manifestPath || DEFAULT_MANIFEST_PATH);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse benchmark manifest at ${resolvedPath}: ${error.message}`);
  }

  const entries = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const manifestDir = path.dirname(resolvedPath);
  return {
    path: resolvedPath,
    candidates: entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Benchmark manifest entry ${index} must be an object.`);
      }
      const id = String(entry.id || '').trim();
      if (!id) {
        throw new Error(`Benchmark manifest entry ${index} is missing an id.`);
      }
      const configFile = String(entry.config || `${id}.json`).trim();
      return {
        id,
        label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id,
        description: typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : null,
        source: typeof entry.source === 'string' && entry.source.trim() ? entry.source.trim() : null,
        configPath: path.resolve(manifestDir, configFile),
      };
    }),
  };
}

export function filterManifestCandidates(candidates = [], candidateIds = null) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    return Array.isArray(candidates) ? candidates : [];
  }
  const allowlist = new Set(candidateIds.map((value) => String(value || '').trim()).filter(Boolean));
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => allowlist.has(candidate.id));
}

function rankingTuple(entry = null) {
  const scorecard = entry?.scorecard || {};
  return [
    Number(scorecard.scoreImprovedFixtures || 0),
    -Number(scorecard.scoreRegressedFixtures || 0),
    Number(scorecard.passImprovedFixtures || 0),
    -Number(scorecard.passRegressedFixtures || 0),
    -Number(scorecard.truncationIntroducedFixtures || 0),
    -Number(scorecard.avgPromptCharsDelta || 0),
  ];
}

export function rankMatrixCandidates(entries = []) {
  return [...(Array.isArray(entries) ? entries : [])].sort((left, right) => {
    const leftTuple = rankingTuple(left);
    const rightTuple = rankingTuple(right);
    for (let index = 0; index < leftTuple.length; index += 1) {
      if (leftTuple[index] === rightTuple[index]) continue;
      return rightTuple[index] - leftTuple[index];
    }
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });
}

export function buildMatrixSummary(entries = []) {
  const ranked = rankMatrixCandidates(entries);
  const leader = ranked[0] || null;
  const lowestPromptDelta = ranked
    .filter((entry) => Number.isFinite(Number(entry?.scorecard?.avgPromptCharsDelta)))
    .sort((left, right) => Number(left.scorecard.avgPromptCharsDelta) - Number(right.scorecard.avgPromptCharsDelta))[0] || null;
  const bugClassSummary = Object.fromEntries(
    ranked.map((entry) => [entry.id, entry?.scorecard?.bugClassSummary || {}])
  );

  return {
    candidateCount: entries.length,
    leader: leader
      ? {
          id: leader.id,
          label: leader.label,
          scorecard: leader.scorecard,
        }
      : null,
    lowestPromptDelta: lowestPromptDelta
      ? {
          id: lowestPromptDelta.id,
          label: lowestPromptDelta.label,
          avgPromptCharsDelta: Number(lowestPromptDelta.scorecard.avgPromptCharsDelta || 0),
          repeatCount: Number(lowestPromptDelta.scorecard.repeatCount || 1),
        }
      : null,
    bugClassSummary,
    budgetStatusCounts: {
      within_budget: ranked.filter((entry) => entry?.scorecard?.promptBudgetStatus === 'within_budget').length,
      over_budget: ranked.filter((entry) => entry?.scorecard?.promptBudgetStatus === 'over_budget').length,
    },
    rankedCandidateIds: ranked.map((entry) => entry.id),
  };
}

function averageScorecardMetric(scorecards = [], field) {
  if (!Array.isArray(scorecards) || scorecards.length === 0) return 0;
  const total = scorecards.reduce((sum, scorecard) => sum + Number(scorecard?.[field] || 0), 0);
  return total / scorecards.length;
}

function summarizeRepeatedBugClassRuns(scorecards = []) {
  const bugClasses = new Set();
  for (const scorecard of scorecards) {
    for (const bugClass of Object.keys(scorecard?.bugClassSummary || {})) {
      bugClasses.add(bugClass);
    }
  }

  return Object.fromEntries(
    [...bugClasses].sort().map((bugClass) => {
      const summaries = scorecards.map((scorecard) => scorecard?.bugClassSummary?.[bugClass] || {});
      return [bugClass, {
        totalFixtures: Math.max(0, ...summaries.map((summary) => Number(summary.totalFixtures || 0))),
        totalRuns: scorecards.length,
        improvedRuns: summaries.filter((summary) => Number(summary.scoreImproved || 0) > 0 || Number(summary.passImproved || 0) > 0).length,
        regressedRuns: summaries.filter((summary) => Number(summary.scoreRegressed || 0) > 0 || Number(summary.passRegressed || 0) > 0).length,
        avgScoreImproved: averageScorecardMetric(summaries, 'scoreImproved'),
        avgScoreRegressed: averageScorecardMetric(summaries, 'scoreRegressed'),
        avgPassImproved: averageScorecardMetric(summaries, 'passImproved'),
        avgPassRegressed: averageScorecardMetric(summaries, 'passRegressed'),
      }];
    })
  );
}

export function buildRepeatedMatrixEntry({ candidate, runs = [] }) {
  const safeRuns = Array.isArray(runs) ? runs : [];
  const scorecards = safeRuns.map((entry) => entry?.scorecard || {});
  const repeatCount = Math.max(1, safeRuns.length);

  return {
    id: candidate.id,
    label: candidate.label,
    description: candidate.description,
    source: candidate.source,
    configPath: candidate.configPath,
    scorecard: {
      repeatCount,
      totalFixtures: averageScorecardMetric(scorecards, 'totalFixtures'),
      scoreImprovedFixtures: averageScorecardMetric(scorecards, 'scoreImprovedFixtures'),
      scoreRegressedFixtures: averageScorecardMetric(scorecards, 'scoreRegressedFixtures'),
      passImprovedFixtures: averageScorecardMetric(scorecards, 'passImprovedFixtures'),
      passRegressedFixtures: averageScorecardMetric(scorecards, 'passRegressedFixtures'),
      findingCountIncreasedFixtures: averageScorecardMetric(scorecards, 'findingCountIncreasedFixtures'),
      findingCountDecreasedFixtures: averageScorecardMetric(scorecards, 'findingCountDecreasedFixtures'),
      promptCharsIncreasedFixtures: averageScorecardMetric(scorecards, 'promptCharsIncreasedFixtures'),
      promptCharsDecreasedFixtures: averageScorecardMetric(scorecards, 'promptCharsDecreasedFixtures'),
      truncationIntroducedFixtures: averageScorecardMetric(scorecards, 'truncationIntroducedFixtures'),
      truncationResolvedFixtures: averageScorecardMetric(scorecards, 'truncationResolvedFixtures'),
      avgPromptCharsDelta: averageScorecardMetric(scorecards, 'avgPromptCharsDelta'),
      avgPromptContextUsedCharsDelta: averageScorecardMetric(scorecards, 'avgPromptContextUsedCharsDelta'),
      promptContextTruncatedRateDelta: averageScorecardMetric(scorecards, 'promptContextTruncatedRateDelta'),
      localVerificationCoverageRateDelta: averageScorecardMetric(scorecards, 'localVerificationCoverageRateDelta'),
      localVerificationSuppressionRateDelta: averageScorecardMetric(scorecards, 'localVerificationSuppressionRateDelta'),
      localVerificationProductionPathRateDelta: averageScorecardMetric(scorecards, 'localVerificationProductionPathRateDelta'),
      promptBudgetMaxDeltaChars: Math.max(0, ...scorecards.map((scorecard) => Number(scorecard?.promptBudgetMaxDeltaChars || 0))),
      promptBudgetStatus: scorecards.every((scorecard) => scorecard?.promptBudgetStatus === 'within_budget')
        ? 'within_budget'
        : 'over_budget',
      noRegressionRuns: scorecards.filter((scorecard) => (
        Number(scorecard?.scoreRegressedFixtures || 0) === 0
        && Number(scorecard?.passRegressedFixtures || 0) === 0
      )).length,
      improvementRuns: scorecards.filter((scorecard) => (
        Number(scorecard?.scoreImprovedFixtures || 0) > 0
        || Number(scorecard?.passImprovedFixtures || 0) > 0
      )).length,
      bugClassSummary: summarizeRepeatedBugClassRuns(scorecards),
    },
    runs: safeRuns,
  };
}

export async function loadCandidateVariantEntries({ manifestPath, candidateIds = null, cwd = process.cwd() } = {}) {
  const manifest = await loadBenchmarkManifest(manifestPath, { cwd });
  const selectedCandidates = filterManifestCandidates(manifest.candidates, candidateIds);
  const entries = [];

  for (const candidate of selectedCandidates) {
    const variant = await loadVariantConfig(candidate.configPath, {
      cwd,
      fallbackLabel: candidate.label,
    });
    entries.push({
      ...candidate,
      configPath: candidate.configPath,
      variant,
    });
  }

  return {
    manifestPath: manifest.path,
    candidates: entries,
  };
}

export function buildMatrixEntry({ candidate, comparison }) {
  return {
    id: candidate.id,
    label: candidate.label,
    description: candidate.description,
    source: candidate.source,
    configPath: candidate.configPath,
    scorecard: buildBenchmarkScorecard(comparison),
    comparison,
  };
}
