import fs from 'fs/promises';
import path from 'path';

export const DEFAULT_OUT_DIR = '.artifacts/review-harness-benchmarks/pr-review';
export const DEFAULT_PROMPT_BUDGET_MAX_DELTA_CHARS = 60;

const ALLOWED_SURFACES = new Set(['changeset', 'pr_review', 'branch_review', 'workspace_review']);
const ALLOWED_QUALITY_MODES = new Set(['auto', 'v1', 'v2']);

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

function normalizeSurface(value, fallback = 'pr_review') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (!ALLOWED_SURFACES.has(normalized)) {
    throw new Error(`Invalid --surface: ${value}`);
  }
  return normalized;
}

function normalizeFixtureSet(value, fallback = 'pr_review') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function normalizeVariantConfig(rawConfig = null, fallbackLabel = 'candidate') {
  if (rawConfig == null) {
    return { label: fallbackLabel };
  }
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('Variant config must be a JSON object.');
  }

  const config = {
    label: typeof rawConfig.label === 'string' && rawConfig.label.trim()
      ? rawConfig.label.trim()
      : fallbackLabel,
  };

  if (rawConfig.qualityMode != null) {
    const qualityMode = String(rawConfig.qualityMode || '').trim().toLowerCase();
    if (!ALLOWED_QUALITY_MODES.has(qualityMode)) {
      throw new Error(`Invalid variant qualityMode: ${rawConfig.qualityMode}`);
    }
    config.qualityMode = qualityMode;
  }

  if (typeof rawConfig.reviewModelStrategy === 'string' && rawConfig.reviewModelStrategy.trim()) {
    config.reviewModelStrategy = rawConfig.reviewModelStrategy.trim();
  }

  if (typeof rawConfig.prReviewMode === 'string' && rawConfig.prReviewMode.trim()) {
    const mode = rawConfig.prReviewMode.trim().toLowerCase();
    if (mode !== 'standard' && mode !== 'agentic_discovery') {
      throw new Error(`Invalid variant prReviewMode: ${rawConfig.prReviewMode}`);
    }
    config.prReviewMode = mode;
  }

  for (const field of ['promptMetadataOverrides', 'reviewModelAdaptive', 'reviewModelRollout', 'reviewModelCustom']) {
    const value = rawConfig[field];
    if (value == null) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Variant config field "${field}" must be an object.`);
    }
    config[field] = value;
  }

  if (rawConfig.pipelineFeatures != null) {
    const value = rawConfig.pipelineFeatures;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Variant config field "pipelineFeatures" must be an object.');
    }
    config.pipelineFeatures = value;
  }

  if (rawConfig.promptContext != null) {
    const value = rawConfig.promptContext;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Variant config field "promptContext" must be an object.');
    }
    config.promptContext = value;
  }

  return config;
}

export async function loadVariantConfig(configPath, options = {}) {
  const fallbackLabel = options.fallbackLabel || 'candidate';
  if (!configPath) {
    return {
      path: null,
      config: normalizeVariantConfig(null, fallbackLabel),
    };
  }

  const resolvedPath = path.resolve(options.cwd || process.cwd(), configPath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse JSON config at ${resolvedPath}: ${error.message}`);
  }

  return {
    path: resolvedPath,
    config: normalizeVariantConfig(parsed, fallbackLabel),
  };
}

export function parseArgs(argv = []) {
  const args = {
    dryRun: false,
    fixtureIds: null,
    fixtureSet: 'pr_review',
    surface: 'pr_review',
    outDir: DEFAULT_OUT_DIR,
    baselineConfigPath: null,
    candidateConfigPath: null,
    baselineLabel: 'control',
    candidateLabel: 'candidate',
    preferredProviderId: null,
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
        args.fixtureSet = normalizeFixtureSet(readArgValue(argv, index, arg));
        index += 1;
        break;
      case '--surface':
        args.surface = normalizeSurface(readArgValue(argv, index, arg));
        index += 1;
        break;
      case '--out-dir':
        args.outDir = readArgValue(argv, index, arg).trim() || DEFAULT_OUT_DIR;
        index += 1;
        break;
      case '--baseline-config':
        args.baselineConfigPath = readArgValue(argv, index, arg).trim();
        index += 1;
        break;
      case '--candidate-config':
        args.candidateConfigPath = readArgValue(argv, index, arg).trim();
        index += 1;
        break;
      case '--baseline-label':
        args.baselineLabel = readArgValue(argv, index, arg).trim() || 'control';
        index += 1;
        break;
      case '--candidate-label':
        args.candidateLabel = readArgValue(argv, index, arg).trim() || 'candidate';
        index += 1;
        break;
      case '--provider-id':
        args.preferredProviderId = readArgValue(argv, index, arg).trim() || null;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Array.isArray(args.fixtureIds) || args.fixtureIds.length === 0) {
    args.fixtureIds = null;
  }

  return args;
}

export function buildBenchmarkScorecard(comparison = null) {
  const fixtureComparisonSummary = comparison?.fixtureComparisonSummary || {};
  const promptDelta = comparison?.delta || {};
  const bugClassSummary = comparison?.fixtureComparisonDimensions?.bugClass || {};
  const evaluationFocusSummary = comparison?.fixtureComparisonDimensions?.evaluationFocus || {};
  const candidateGenerationSummary = evaluationFocusSummary.candidate_generation || {
    totalFixtures: 0,
    scoreImproved: 0,
    scoreRegressed: 0,
  };
  const avgPromptCharsDelta = Number(promptDelta.avgPromptChars || 0);
  const avgPromptContextUsedCharsDelta = Number(promptDelta.avgPromptContextUsedChars || 0);
  const promptContextTruncatedRateDelta = Number(promptDelta.promptContextTruncatedRate || 0);
  const localVerificationCoverageRateDelta = Number(promptDelta.localVerificationCoverageRate || 0);
  const localVerificationSuppressionRateDelta = Number(promptDelta.localVerificationSuppressionRate || 0);
  const localVerificationProductionPathRateDelta = Number(promptDelta.localVerificationProductionPathRate || 0);

  return {
    totalFixtures: Number(fixtureComparisonSummary.totalFixtures || 0),
    scoreImprovedFixtures: Number(fixtureComparisonSummary.scoreImproved || 0),
    scoreRegressedFixtures: Number(fixtureComparisonSummary.scoreRegressed || 0),
    passImprovedFixtures: Number(fixtureComparisonSummary.passImproved || 0),
    passRegressedFixtures: Number(fixtureComparisonSummary.passRegressed || 0),
    findingCountIncreasedFixtures: Number(fixtureComparisonSummary.findingCountIncreased || 0),
    findingCountDecreasedFixtures: Number(fixtureComparisonSummary.findingCountDecreased || 0),
    candidateCountIncreasedFixtures: Number(fixtureComparisonSummary.candidateCountIncreased || 0),
    candidateCountDecreasedFixtures: Number(fixtureComparisonSummary.candidateCountDecreased || 0),
    promotedCandidateCountIncreasedFixtures: Number(fixtureComparisonSummary.promotedCandidateCountIncreased || 0),
    promotedCandidateCountDecreasedFixtures: Number(fixtureComparisonSummary.promotedCandidateCountDecreased || 0),
    promptCharsIncreasedFixtures: Number(fixtureComparisonSummary.promptCharsIncreased || 0),
    promptCharsDecreasedFixtures: Number(fixtureComparisonSummary.promptCharsDecreased || 0),
    truncationIntroducedFixtures: Number(fixtureComparisonSummary.truncationIntroduced || 0),
    truncationResolvedFixtures: Number(fixtureComparisonSummary.truncationResolved || 0),
    avgPromptCharsDelta,
    avgPromptContextUsedCharsDelta,
    promptContextTruncatedRateDelta,
    localVerificationCoverageRateDelta,
    localVerificationSuppressionRateDelta,
    localVerificationProductionPathRateDelta,
    promptBudgetMaxDeltaChars: DEFAULT_PROMPT_BUDGET_MAX_DELTA_CHARS,
    promptBudgetStatus: avgPromptCharsDelta <= DEFAULT_PROMPT_BUDGET_MAX_DELTA_CHARS ? 'within_budget' : 'over_budget',
    bugClassSummary,
    evaluationFocusSummary,
    candidateGenerationSummary,
  };
}
