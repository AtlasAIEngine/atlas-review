/**
 * Review Constants
 * All environment-parsed configuration, error classes, validation sets,
 * regexes, schemas, and default configs for the review pipeline.
 */

import reviewEvidenceValidator from '../reviewEvidenceValidator.js';

// ── Env Parsers (internal, used only during constant initialization) ─────────

function parseEnvInteger(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(process.env[name]);
  const normalized = Number.isFinite(parsed) ? Math.trunc(parsed) : Math.trunc(fallback);
  return Math.min(max, Math.max(min, normalized));
}

function parseEnvBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseEnvFloat(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(process.env[name]);
  const normalized = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.min(max, Math.max(min, normalized));
}

// ── Diff Size Thresholds ─────────────────────────────────────────────────────

export const SMALL_DIFF_LIMIT = 15000;   // ~5K tokens → full diff in single prompt
export const MEDIUM_DIFF_LIMIT = 150000; // ~50K tokens → full diff, trimmed context

// ── Provider Timeouts ────────────────────────────────────────────────────────

export const PROVIDER_REQUEST_TIMEOUT_API_MS = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_TIMEOUT_API_MS',
  180000,
  { min: 60000 }
);
export const PROVIDER_REQUEST_TIMEOUT_CLAUDE_CLI_MS = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_TIMEOUT_CLAUDE_CLI_MS',
  300000,
  { min: 90000 }
);
export const PROVIDER_REQUEST_TIMEOUT_CODEX_CLI_MS = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_TIMEOUT_CODEX_CLI_MS',
  420000,
  { min: 120000 }
);
export const PROVIDER_REQUEST_TIMEOUT_GEMINI_CLI_MS = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_TIMEOUT_GEMINI_CLI_MS',
  360000,
  { min: 90000 }
);
export const PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_TIMEOUT_OPENCODE_CLI_MS',
  300000,
  { min: 90000 }
);

// ── CLI-Agentic Config ───────────────────────────────────────────────────────

export const PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_TIMEOUT_CLI_AGENTIC_MS',
  600000,
  { min: 120000 }
);
export const CLI_AGENTIC_MAX_TURNS = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_MAX_TURNS',
  25,
  { min: 1, max: 100 }
);
export const CLI_AGENTIC_MIN_TURNS = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_MIN_TURNS',
  6,
  { min: 1, max: CLI_AGENTIC_MAX_TURNS }
);
export const CLI_AGENTIC_TIMEOUT_PER_TURN_MS = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_TIMEOUT_PER_TURN_MS',
  30000,
  { min: 10000, max: 120000 }
);
export const CLI_AGENTIC_TIMEOUT_BASE_MS = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_TIMEOUT_BASE_MS',
  60000,
  { min: 30000, max: 300000 }
);

// ── CLI-Agentic Tiered Scaling ─────────────────────────────────────────────

export const CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT',
  31,
  { min: 2, max: 500 }
);
export const CLI_AGENTIC_TIER_LARGE_FILE_COUNT = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_TIER_LARGE_FILE_COUNT',
  49,
  { min: 10, max: 1000 }
);
export const CLI_AGENTIC_MAX_TURNS_MEDIUM = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_MAX_TURNS_MEDIUM',
  30,
  { min: 1, max: 200 }
);
export const CLI_AGENTIC_MAX_TURNS_LARGE = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_MAX_TURNS_LARGE',
  24,
  { min: 1, max: 200 }
);
export const CLI_AGENTIC_TIMEOUT_PER_TURN_MS_MEDIUM = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_TIMEOUT_PER_TURN_MS_MEDIUM',
  25000,
  { min: 5000, max: 120000 }
);
export const CLI_AGENTIC_TIMEOUT_PER_TURN_MS_LARGE = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_TIMEOUT_PER_TURN_MS_LARGE',
  20000,
  { min: 5000, max: 120000 }
);
// Per-shard timeouts now act as soft hints for resolveProviderRequestTimeoutMs;
// liveness watch in callCliAgentic is the real safety net.
export const PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_MEDIUM = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_TIMEOUT_CLI_AGENTIC_MS_MEDIUM',
  900000,
  { min: 120000 }
);
export const PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_LARGE = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_TIMEOUT_CLI_AGENTIC_MS_LARGE',
  900000,
  { min: 120000 }
);
export const REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_LARGE_MS = parseEnvInteger(
  'ATLAS_REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_LARGE_MS',
  1800000,
  { min: 120000 }
);

// ── CLI-Agentic Pre-Computed Diff ─────────────────────────────────────────

export const CLI_AGENTIC_PRE_COMPUTED_DIFF_HARD_LIMIT = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_DIFF_HARD_LIMIT',
  120000,
  { min: 10000, max: 500000 }
);

// ── CLI-Agentic Parallel Sharding ──────────────────────────────────────────

export const CLI_AGENTIC_PARALLEL_SHARD_CONCURRENCY = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_SHARD_CONCURRENCY',
  3,
  { min: 1, max: 8 }
);
export const CLI_AGENTIC_PARALLEL_MIN_FILES_PER_SHARD = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_MIN_FILES_PER_SHARD',
  10,
  { min: 3, max: 100 }
);
export const CLI_AGENTIC_PARALLEL_TARGET_FILES_PER_SHARD = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_TARGET_FILES_PER_SHARD',
  30,
  { min: 5, max: 100 }
);
export const CLI_AGENTIC_PARALLEL_MAX_SHARDS = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_MAX_SHARDS',
  16,
  { min: 2, max: 32 }
);

// ── Partial Review Mode ────────────────────────────────────────────────────
// When partial mode is requested (popup choice or MCP default), only review
// the top-N highest-risk files. Remaining files are listed as deferred so the
// user can run a second partial review on them.
export const PARTIAL_MODE_MAX_FILES = parseEnvInteger(
  'ATLAS_REVIEW_PARTIAL_MODE_MAX_FILES',
  90,
  { min: 10, max: 500 }
);
// File-count threshold above which the UI offers a partial-review popup.
export const PARTIAL_MODE_POPUP_THRESHOLD = parseEnvInteger(
  'ATLAS_REVIEW_PARTIAL_MODE_POPUP_THRESHOLD',
  100,
  { min: 50, max: 1000 }
);

// ── CLI-Agentic Liveness Watch ─────────────────────────────────────────────
// Replaces wall-clock per-shard timeout: kill only when stream goes silent.
export const CLI_AGENTIC_LIVENESS_THRESHOLD_MS = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_LIVENESS_THRESHOLD_MS',
  180000,
  { min: 30000, max: 1200000 }
);
export const CLI_AGENTIC_LIVENESS_CHECK_INTERVAL_MS = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_LIVENESS_CHECK_INTERVAL_MS',
  15000,
  { min: 1000, max: 120000 }
);
export const CLI_AGENTIC_ABSOLUTE_CEILING_MS = parseEnvInteger(
  'ATLAS_REVIEW_CLI_AGENTIC_ABSOLUTE_CEILING_MS',
  1800000,
  { min: 60000, max: 7200000 }
);

// ── Codex Config ─────────────────────────────────────────────────────────────

export const VALID_CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

// ── Prompt Hard Limits ───────────────────────────────────────────────────────

export const REVIEW_PROMPT_HARD_LIMIT_DEFAULT = MEDIUM_DIFF_LIMIT;
export const REVIEW_PROMPT_HARD_LIMIT_CLAUDE_CLI = 80000;
export const REVIEW_PROMPT_HARD_LIMIT_CODEX_CLI = 45000;
export const REVIEW_PROMPT_HARD_LIMIT_GEMINI_CLI = 60000;
export const REVIEW_PROMPT_HARD_LIMIT_OPENCODE_CLI = 60000;

// ── Single Review Diff Limits ────────────────────────────────────────────────

export const SINGLE_REVIEW_DIFF_LIMIT_DEFAULT = MEDIUM_DIFF_LIMIT;
export const SINGLE_REVIEW_DIFF_LIMIT_CLAUDE_CLI = Math.max(
  SMALL_DIFF_LIMIT,
  Number(process.env.ATLAS_REVIEW_SINGLE_LIMIT_CLAUDE_CLI || 15000)
);
export const SINGLE_REVIEW_DIFF_LIMIT_CODEX_CLI = Math.max(
  8000,
  Number(process.env.ATLAS_REVIEW_SINGLE_LIMIT_CODEX_CLI || 12000)
);
export const SINGLE_REVIEW_DIFF_LIMIT_GEMINI_CLI = Math.max(
  SMALL_DIFF_LIMIT,
  Number(process.env.ATLAS_REVIEW_SINGLE_LIMIT_GEMINI_CLI || 15000)
);
export const SINGLE_REVIEW_DIFF_LIMIT_OPENCODE_CLI = Math.max(
  SMALL_DIFF_LIMIT,
  Number(process.env.ATLAS_REVIEW_SINGLE_LIMIT_OPENCODE_CLI || 15000)
);
export const SINGLE_REVIEW_MAX_FILES_CLI = Math.max(
  1,
  Number(process.env.ATLAS_REVIEW_SINGLE_MAX_FILES_CLI || 10)
);

// ── Large File & Chunking ────────────────────────────────────────────────────

export const LARGE_REVIEW_FILE_COUNT = 40;

// File-count threshold above which the policy demotes `structural` review
// units to `skip` when defaults.largeReviewStructuralSkip is on (default).
// Mirrors LARGE_DIFF_PARTIAL_POPUP_THRESHOLD in the frontend so the
// pre-flight popup and the structural-skip kick in at the same size.
export const LARGE_REVIEW_STRUCTURAL_SKIP_THRESHOLD = parseEnvInteger(
  'ATLAS_REVIEW_LARGE_STRUCTURAL_SKIP_THRESHOLD',
  100,
  { min: 1, max: 10000 }
);
export const REVIEW_CHUNK_CHAR_LIMIT = parseEnvInteger(
  'ATLAS_REVIEW_CHUNK_CHAR_LIMIT',
  45000,
  { min: 8000, max: 400000 }
);
export const REVIEW_CHUNK_CHAR_LIMIT_CODEX_CLI = parseEnvInteger(
  'ATLAS_REVIEW_CHUNK_CHAR_LIMIT_CODEX_CLI',
  32000,
  { min: 8000, max: 400000 }
);
export const REVIEW_CHUNK_CHAR_LIMIT_CLAUDE_CLI = parseEnvInteger(
  'ATLAS_REVIEW_CHUNK_CHAR_LIMIT_CLAUDE_CLI',
  50000,
  { min: 8000, max: 400000 }
);
export const REVIEW_CHUNK_CHAR_LIMIT_GEMINI_CLI = parseEnvInteger(
  'ATLAS_REVIEW_CHUNK_CHAR_LIMIT_GEMINI_CLI',
  45000,
  { min: 8000, max: 400000 }
);
export const REVIEW_CHUNK_CHAR_LIMIT_OPENCODE_CLI = parseEnvInteger(
  'ATLAS_REVIEW_CHUNK_CHAR_LIMIT_OPENCODE_CLI',
  45000,
  { min: 8000, max: 400000 }
);
export const REVIEW_MAX_CHUNKS = parseEnvInteger(
  'ATLAS_REVIEW_MAX_CHUNKS',
  24,
  { min: 4, max: 64 }
);
export const REVIEW_CHUNK_CONCURRENCY = parseEnvInteger(
  'ATLAS_REVIEW_CHUNK_CONCURRENCY',
  3,
  { min: 1, max: 6 }
);
export const REVIEW_CHUNK_CONCURRENCY_CLI = parseEnvInteger(
  'ATLAS_REVIEW_CHUNK_CONCURRENCY_CLI',
  4,
  { min: 1, max: 8 }
);
export const REVIEW_CHUNK_CONCURRENCY_DYNAMIC_MAX = parseEnvInteger(
  'ATLAS_REVIEW_CHUNK_CONCURRENCY_DYNAMIC_MAX',
  8,
  { min: 2, max: 16 }
);
export const REVIEW_CHUNK_SPLIT_MAX_DEPTH = 3;
export const REVIEW_OPENCODE_CHUNK_STOP_REMAINING_MS = parseEnvInteger(
  'ATLAS_REVIEW_OPENCODE_CHUNK_STOP_REMAINING_MS',
  120000,
  { min: 30000, max: 300000 }
);
export const REVIEW_OPENCODE_CHUNK_STOP_FINALIZATION_BUFFER_MS = parseEnvInteger(
  'ATLAS_REVIEW_OPENCODE_CHUNK_STOP_FINALIZATION_BUFFER_MS',
  30000,
  { min: 5000, max: 120000 }
);

// ── Per-File Review ──────────────────────────────────────────────────────────

export const REVIEW_PER_FILE_ENABLED = process.env.ATLAS_REVIEW_PER_FILE_ENABLED === '1';
export const REVIEW_PER_FILE_TRIGGER_FILE_COUNT = process.env.ATLAS_REVIEW_PER_FILE_TRIGGER_FILE_COUNT
  ? Math.max(1, Number(process.env.ATLAS_REVIEW_PER_FILE_TRIGGER_FILE_COUNT))
  : LARGE_REVIEW_FILE_COUNT;
export const REVIEW_PER_FILE_CONCURRENCY = Math.min(10, Math.max(1, Number(process.env.ATLAS_REVIEW_PER_FILE_CONCURRENCY || 6)));
export const REVIEW_PER_FILE_CONCURRENCY_MAX = parseEnvInteger(
  'ATLAS_REVIEW_PER_FILE_CONCURRENCY_MAX',
  12,
  { min: 2, max: 24 }
);
export const REVIEW_PER_FILE_TRIVIAL_FILE_CHARS = Math.max(
  2000,
  Number(process.env.ATLAS_REVIEW_PER_FILE_TRIVIAL_FILE_CHARS || 8000)
);
export const REVIEW_PER_FILE_LARGE_FILE_CHARS = Math.max(
  12000,
  Number(process.env.ATLAS_REVIEW_PER_FILE_LARGE_FILE_CHARS || 60000)
);

// ── File Cache ───────────────────────────────────────────────────────────────

export const REVIEW_FILE_CACHE_ENABLED = process.env.ATLAS_REVIEW_FILE_CACHE_ENABLED !== '0';
export const REVIEW_FILE_CACHE_PROMPT_VERSION = String(
  process.env.ATLAS_REVIEW_FILE_CACHE_PROMPT_VERSION || '2026-02-19.v1'
).trim();

// ── Provider Retry & Failover ────────────────────────────────────────────────

export const REVIEW_PROVIDER_HEARTBEAT_MS = 5000;
export const PROVIDER_TRANSIENT_MAX_RETRIES = Math.max(
  0,
  Number(process.env.ATLAS_REVIEW_PROVIDER_TRANSIENT_RETRIES || 2)
);
export const PROVIDER_TRANSIENT_RETRY_BASE_MS = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_RETRY_BASE_MS',
  1200,
  { min: 250 }
);
export const PROVIDER_TRANSIENT_RETRY_MAX_MS = parseEnvInteger(
  'ATLAS_REVIEW_PROVIDER_RETRY_MAX_MS',
  12000,
  { min: PROVIDER_TRANSIENT_RETRY_BASE_MS }
);
export const REVIEW_PROVIDER_FAILOVER_MAX_CANDIDATES = Math.min(
  4,
  Math.max(1, Number(process.env.ATLAS_REVIEW_PROVIDER_FAILOVER_MAX_CANDIDATES || 2))
);

// ── Settings Keys & Cache TTLs ───────────────────────────────────────────────

export const REVIEW_IGNORE_PATTERNS_SETTING_KEY = 'review_ignore_patterns';
export const REVIEW_IGNORE_PATTERNS_SELECTED_PRESET_SETTING_KEY = 'review_ignore_patterns_selected_preset';
export const REVIEW_MODEL_STRATEGY_SETTING_KEY = 'review_model_strategy';
export const REVIEW_MODEL_CUSTOM_SETTING_KEY = 'review_model_custom';
export const REVIEW_MODEL_ADAPTIVE_SETTING_KEY = 'review_model_adaptive';
export const REVIEW_MODEL_ROLLOUT_SETTING_KEY = 'review_model_rollout';
export const REVIEW_EXECUTION_MODE_ORDER_SETTING_KEY = 'review_execution_mode_order';
export const REVIEW_IGNORE_PATTERNS_CACHE_TTL_MS = 30000;
export const REVIEW_MODEL_CONFIG_CACHE_TTL_MS = 30000;
export const REVIEW_EXECUTION_MODE_ORDER_CACHE_TTL_MS = 30000;

// ── Execution Mode Definitions ──────────────────────────────────────────────

export const VALID_EXECUTION_MODES = ['api', 'cli-agentic', 'cli-agent', 'cli-pipe'];

export const EXECUTION_MODE_METADATA = Object.freeze({
  'api': {
    id: 'api',
    label: 'API',
    description: 'Direct API call using your BYOK key. Fastest and most reliable.',
  },
  'cli-agentic': {
    id: 'cli-agentic',
    label: 'CLI Agentic',
    description: 'Multi-turn CLI mode — Claude explores the repo itself for deeper reviews.',
  },
  'cli-agent': {
    id: 'cli-agent',
    label: 'CLI Agent',
    description: 'Single-turn CLI agent with structured envelope prompt.',
  },
  'cli-pipe': {
    id: 'cli-pipe',
    label: 'CLI Pipe',
    description: 'Simple CLI pipe mode using your Claude/Codex subscription.',
  },
});

// ── Timing & Prep ────────────────────────────────────────────────────────────

export const REVIEW_TIMING_DEBUG = process.env.ATLAS_REVIEW_TIMING_DEBUG === '1';
export const REVIEW_FILE_PREP_CONCURRENCY = parseEnvInteger(
  'ATLAS_REVIEW_FILE_PREP_CONCURRENCY',
  6,
  { min: 1, max: 16 }
);
export const REVIEW_OMITTED_FILE_PROMPT_LIMIT = 12;

// ── Prompt Context Budget ────────────────────────────────────────────────────

export const REVIEW_PROMPT_CONTEXT_BUDGET_CHARS = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_BUDGET_CHARS',
  1200,
  { min: 180, max: 12000 }
);
export const REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES',
  6,
  { min: 1, max: 24 }
);
export const REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS',
  180,
  { min: 40, max: 600 }
);
export const REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_CHARS = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_CHARS',
  180,
  { min: 60, max: 800 }
);
export const REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_LINES = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_LINES',
  2,
  { min: 1, max: 4 }
);
export const REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT',
  4,
  { min: 1, max: 20 }
);
export const REVIEW_PROMPT_CONTEXT_RANGE_COMMIT_LIMIT = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_RANGE_COMMIT_LIMIT',
  6,
  { min: 1, max: 30 }
);
export const REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT',
  12,
  { min: 1, max: 80 }
);
export const REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES = parseEnvInteger(
  'ATLAS_REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES',
  4,
  { min: 1, max: 24 }
);
export const REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY = parseEnvBoolean(
  'ATLAS_REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY',
  true
);
export const REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS = parseEnvBoolean(
  'ATLAS_REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS',
  false
);
export const REVIEW_FILE_RISK_CONTEXT_MAX_FILES = parseEnvInteger(
  'ATLAS_REVIEW_FILE_RISK_CONTEXT_MAX_FILES',
  8,
  { min: 1, max: 24 }
);

// ── Two-Pass Verifier ────────────────────────────────────────────────────────

export const REVIEW_TWO_PASS_VERIFIER_ENABLED = parseEnvBoolean(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_ENABLED',
  false
);
export const REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS = parseEnvInteger(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS',
  3,
  { min: 0, max: 20 }
);
export const REVIEW_TWO_PASS_VERIFIER_INCLUDE_MEDIUM = parseEnvBoolean(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_INCLUDE_MEDIUM',
  false
);
export const REVIEW_TWO_PASS_VERIFIER_MAX_MEDIUM_FINDINGS = parseEnvInteger(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_MAX_MEDIUM_FINDINGS',
  2,
  { min: 0, max: 20 }
);
export const REVIEW_CANDIDATE_PROMOTION_ENABLED = parseEnvBoolean(
  'ATLAS_REVIEW_CANDIDATE_PROMOTION_ENABLED',
  true
);
export const REVIEW_CANDIDATE_PROMOTION_MAX_FINDINGS = parseEnvInteger(
  'ATLAS_REVIEW_CANDIDATE_PROMOTION_MAX_FINDINGS',
  3,
  { min: 0, max: 12 }
);
export const REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS = parseEnvInteger(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS',
  90000,
  { min: 1000, max: 3600000 }
);
export const REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS = parseEnvInteger(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS',
  240000,
  { min: 1000, max: 3600000 }
);
export const REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE = parseEnvFloat(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE',
  0.35,
  { min: 0, max: 1 }
);
export const REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES = parseEnvInteger(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES',
  6,
  { min: 0, max: 2000 }
);
export const REVIEW_TWO_PASS_VERIFIER_DIFF_HARD_LIMIT = parseEnvInteger(
  'ATLAS_REVIEW_TWO_PASS_VERIFIER_DIFF_HARD_LIMIT',
  22000,
  { min: 4000, max: 120000 }
);
export const REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY = ['demote', 'hide'].includes(
  String(process.env.ATLAS_REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY || 'demote').trim().toLowerCase()
)
  ? String(process.env.ATLAS_REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY || 'demote').trim().toLowerCase()
  : 'demote';

// ── Evidence & Corroboration ─────────────────────────────────────────────────

export const REVIEW_EVIDENCE_POLICY_DEFAULT = reviewEvidenceValidator.normalizeEvidencePolicy(
  process.env.ATLAS_REVIEW_EVIDENCE_POLICY,
  'demote'
);
export const REVIEW_CORROBORATION_ENABLED = parseEnvBoolean(
  'ATLAS_REVIEW_CORROBORATION_ENABLED',
  true
);
export const REVIEW_CORROBORATION_ALLOW_GROUNDED_FALLBACK = parseEnvBoolean(
  'ATLAS_REVIEW_CORROBORATION_ALLOW_GROUNDED_FALLBACK',
  true
);
export const REVIEW_CORROBORATION_DOWNGRADE_UNSUPPORTED = parseEnvBoolean(
  'ATLAS_REVIEW_CORROBORATION_DOWNGRADE_UNSUPPORTED',
  true
);
export const REVIEW_CORROBORATION_SOURCE_MODE = ['none', 'verification_logs'].includes(
  String(process.env.ATLAS_REVIEW_CORROBORATION_SOURCE_MODE || 'none').trim().toLowerCase()
)
  ? String(process.env.ATLAS_REVIEW_CORROBORATION_SOURCE_MODE || 'none').trim().toLowerCase()
  : 'none';
export const REVIEW_CORROBORATION_SOURCE_LOG_MAX_CHARS = parseEnvInteger(
  'ATLAS_REVIEW_CORROBORATION_SOURCE_LOG_MAX_CHARS',
  12000,
  { min: 800, max: 200000 }
);
export const REVIEW_CORROBORATION_SOURCE_TOKEN_MAX = parseEnvInteger(
  'ATLAS_REVIEW_CORROBORATION_SOURCE_TOKEN_MAX',
  6,
  { min: 2, max: 24 }
);

// ── Outcome Suppression ──────────────────────────────────────────────────────

export const REVIEW_OUTCOME_SUPPRESSION_ENABLED = parseEnvBoolean(
  'ATLAS_REVIEW_OUTCOME_SUPPRESSION_ENABLED',
  false
);
export const REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES = parseEnvInteger(
  'ATLAS_REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES',
  4,
  { min: 1, max: 200 }
);
export const REVIEW_OUTCOME_SUPPRESSION_MIN_DISMISSED_RATE = parseEnvFloat(
  'ATLAS_REVIEW_OUTCOME_SUPPRESSION_MIN_DISMISSED_RATE',
  0.8,
  { min: 0, max: 1 }
);
export const REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN = parseEnvInteger(
  'ATLAS_REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN',
  3,
  { min: 0, max: 50 }
);
export const REVIEW_OUTCOME_SUPPRESSION_MAX_KEYS = parseEnvInteger(
  'ATLAS_REVIEW_OUTCOME_SUPPRESSION_MAX_KEYS',
  80,
  { min: 1, max: 400 }
);
export const REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS = parseEnvInteger(
  'ATLAS_REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS',
  2500,
  { min: 100, max: 10000 }
);
export const REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS_PER_KEY = parseEnvInteger(
  'ATLAS_REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS_PER_KEY',
  20,
  { min: 1, max: 200 }
);

// ── Recommendation Budgets ───────────────────────────────────────────────────

export const SMALL_REVIEW_FILE_COUNT = 10;
export const MEDIUM_REVIEW_FILE_COUNT = 40;
export const RECOMMENDATION_BUDGET_SMALL = parseEnvInteger(
  'ATLAS_REVIEW_RECOMMENDATION_BUDGET_SMALL',
  2,
  { min: 0, max: 12 }
);
export const RECOMMENDATION_BUDGET_MEDIUM = parseEnvInteger(
  'ATLAS_REVIEW_RECOMMENDATION_BUDGET_MEDIUM',
  4,
  { min: 0, max: 16 }
);
export const RECOMMENDATION_BUDGET_LARGE = parseEnvInteger(
  'ATLAS_REVIEW_RECOMMENDATION_BUDGET_LARGE',
  6,
  { min: 0, max: 20 }
);
export const RECOMMENDATION_LOW_SIGNAL_CAP = parseEnvInteger(
  'ATLAS_REVIEW_RECOMMENDATION_LOW_SIGNAL_CAP',
  2,
  { min: 0, max: 8 }
);
export const RECOMMENDATION_SINGLE_ISSUE_CAP = parseEnvInteger(
  'ATLAS_REVIEW_RECOMMENDATION_SINGLE_ISSUE_CAP',
  3,
  { min: 1, max: 10 }
);

// ── Focused Review ───────────────────────────────────────────────────────────

export const FOCUSED_REVIEW_TRIGGER_FILE_COUNT = parseEnvInteger(
  'ATLAS_REVIEW_FOCUSED_TRIGGER_FILE_COUNT',
  80,
  { min: 1, max: 10000 }
);
export const FOCUSED_REVIEW_MAX_DEEP_FILES = parseEnvInteger(
  'ATLAS_REVIEW_FOCUSED_MAX_DEEP_FILES',
  96,
  { min: 1, max: 10000 }
);
export const FOCUSED_REVIEW_MIN_DEEP_FILES = parseEnvInteger(
  'ATLAS_REVIEW_FOCUSED_MIN_DEEP_FILES',
  12,
  { min: 1, max: 10000 }
);
export const FOCUSED_REVIEW_TRIGGER_DIFF_CHARS = parseEnvInteger(
  'ATLAS_REVIEW_FOCUSED_TRIGGER_DIFF_CHARS',
  600000,
  { min: 10000, max: 50000000 }
);
export const FOCUSED_REVIEW_TARGET_DIFF_CHARS = parseEnvInteger(
  'ATLAS_REVIEW_FOCUSED_TARGET_DIFF_CHARS',
  700000,
  { min: 40000, max: 50000000 }
);
export const FOCUSED_REVIEW_EXPANSION_TARGET_MULTIPLIER = parseEnvFloat(
  'ATLAS_REVIEW_FOCUSED_EXPANSION_TARGET_MULTIPLIER',
  1.18,
  { min: 1.0, max: 2.5 }
);
export const FOCUSED_REVIEW_ADAPTIVE_MAX_DEEP_FILES = parseEnvInteger(
  'ATLAS_REVIEW_FOCUSED_ADAPTIVE_MAX_DEEP_FILES',
  180,
  { min: 8, max: 10000 }
);
export const FOCUSED_REVIEW_ADAPTIVE_MIN_TRIGGER_FILE_COUNT = parseEnvInteger(
  'ATLAS_REVIEW_FOCUSED_ADAPTIVE_MIN_TRIGGER_FILE_COUNT',
  18,
  { min: 1, max: 10000 }
);
export const FOCUSED_REVIEW_ADAPTIVE_MIN_TRIGGER_DIFF_CHARS = parseEnvInteger(
  'ATLAS_REVIEW_FOCUSED_ADAPTIVE_MIN_TRIGGER_DIFF_CHARS',
  90000,
  { min: 10000, max: 50000000 }
);

// ── Deadline & Watchdog ──────────────────────────────────────────────────────

export const MAX_CHANGE_GROUPS = 120;
export const REVIEW_TOTAL_DEADLINE_MS = parseEnvInteger(
  'ATLAS_REVIEW_TOTAL_DEADLINE_MS',
  300000,
  { min: 60000 }
);
export const REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_MS = parseEnvInteger(
  'ATLAS_REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_MS',
  1800000,
  { min: 120000 }
);
export const REVIEW_DEADLINE_START_BUFFER_MS = parseEnvInteger(
  'ATLAS_REVIEW_DEADLINE_START_BUFFER_MS',
  8000,
  { min: 1000 }
);
export const REVIEW_DEADLINE_TIMEOUT_BUFFER_MS = parseEnvInteger(
  'ATLAS_REVIEW_DEADLINE_TIMEOUT_BUFFER_MS',
  2000,
  { min: 500 }
);
export const REVIEW_QUEUE_WATCHDOG_STALE_MS = parseEnvInteger(
  'ATLAS_REVIEW_QUEUE_WATCHDOG_STALE_MS',
  Math.max(90000, REVIEW_TOTAL_DEADLINE_MS + 15000),
  { min: 30000 }
);
export const REVIEW_QUEUE_WATCHDOG_POLL_MS = parseEnvInteger(
  'ATLAS_REVIEW_QUEUE_WATCHDOG_POLL_MS',
  2000,
  { min: 500 }
);
export const REVIEW_QUEUE_WATCHDOG_MAX_RETRIES = parseEnvInteger(
  'ATLAS_REVIEW_QUEUE_WATCHDOG_MAX_RETRIES',
  1,
  { min: 0, max: 3 }
);

// ── Error Classes ────────────────────────────────────────────────────────────

export class ReviewDeadlineError extends Error {
  constructor(deadlineMs, detail = '') {
    const baseMessage = `Review deadline exceeded (${Math.round(deadlineMs / 1000)}s)`;
    super(detail ? `${baseMessage}: ${detail}` : baseMessage);
    this.name = 'ReviewDeadlineError';
    this.isDeadline = true;
  }
}

export class ReviewWatchdogError extends Error {
  constructor(staleMs, detail = '') {
    const baseMessage = `Review watchdog detected stale runtime (${Math.round(staleMs / 1000)}s without heartbeat)`;
    super(detail ? `${baseMessage}: ${detail}` : baseMessage);
    this.name = 'ReviewWatchdogError';
    this.isWatchdog = true;
    this.runtimeCode = 'timeout';
  }
}

export class ReviewUserStopError extends Error {
  constructor(itemId = '') {
    super(itemId ? `Review stopped by user: ${itemId}` : 'Review stopped by user');
    this.name = 'ReviewUserStopError';
    this.isUserStop = true;
  }
}

// ── Validation Sets ──────────────────────────────────────────────────────────

export const VALID_RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
export const VALID_RECOMMENDATION_TYPES = ['issue', 'suggestion', 'praise'];
export const VALID_COMPLEXITIES = ['trivial', 'simple', 'moderate', 'complex'];
export const REVIEW_RESULT_TOP_LEVEL_KEYS = new Set([
  'summary',
  'riskLevel',
  'changeGroups',
  'recommendations',
  'candidateFindings',
  'stats',
]);
export const KNOWN_REVIEW_PROGRESS_PHASES = new Set([
  'queued',
  'reviewing',
  'running',
  'retrying',
  'preparing_files',
  'file_triage',
  'file_review_start',
  'file_review_inflight',
  'file_review_failed',
  'file_review_complete',
  'file_partial',
  'single_start',
  'single_inflight',
  'single_complete',
  'single_partial',
  'chunk_start',
  'chunk_inflight',
  'chunk_split',
  'chunk_complete',
  'chunk_partial',
  'provider_retry',
  'synthesizing',
  'agentic_exploration',
  'agentic_tool_use',
  'complete',
  'partial',
  'failed',
]);

// ── Recommendation Constants ─────────────────────────────────────────────────

export const RECOMMENDATION_TYPE_ALIASES = Object.freeze({
  nit: 'suggestion',
  question: 'suggestion',
});
export const RECOMMENDATION_TYPE_WEIGHT = { issue: 3, suggestion: 2, praise: 1 };
export const RECOMMENDATION_SEVERITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };

// ── Regexes ──────────────────────────────────────────────────────────────────

export const IMPACT_HINT_RE = /\b(security|auth|injection|xss|csrf|sqli?|data\s+loss|corrupt|outage|downtime|crash|panic|privilege|leak|exfiltrat|dos|deadlock|race|broken|failure|integrity|availability|correctness)\b/i;
export const IMPACT_APPENDIX = ' Impact: This may cause correctness, security, data integrity, or availability issues.';
export const OUTCOME_SUPPRESSION_SECURITY_RE = /\b(security|auth|authentication|authorization|token|secret|credential|injection|xss|csrf|ssrf|rce|privilege|encryption|decrypt|cipher|hash)\b/i;

export const SEVERITY_FLOOR_NON_SOURCE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.lock', '.config.js', '.config.ts', '.config.mjs',
]);

export const SEVERITY_FLOOR_IMPACT_PATTERNS = [
  /\bbreak/, /\bcrash/, /\bfail/, /\bloss/, /\bleak/, /\bcorrupt/,
  /\bvulnerab/, /\bexploit/, /\binjection/, /\bxss/, /\brace condition/,
  /\bdata loss/, /\bincorrect/, /\bwrong result/, /\bundefined behavior/,
  /\bout of bound/, /\bnull pointer/, /\bdeadlock/, /\binfinite/,
];

export const DOC_FILE_RE = /(^|\/)(readme|changelog|contributing|license)(\.[^/]+)?$|\.mdx?$/i;
export const TEST_FILE_RE = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$/i;

// ── Model Routing Config ─────────────────────────────────────────────────────

export const VALID_REVIEW_MODEL_STRATEGIES = ['smart', 'latency_first', 'max_quality', 'custom', 'adaptive', 'performance'];
export const VALID_REVIEW_MODEL_ROLLOUT_MODES = ['off', 'shadow', 'canary', 'on'];
export const VALID_REVIEW_MODEL_GATE_STATUSES = ['pass', 'warn', 'fail'];
export const REVIEW_MODEL_PHASES = ['triage', 'walkthrough', 'review', 'synthesis', 'verifier'];
export const REVIEW_MODEL_ROUTING_POLICY_VERSION = '2026-02-21.routing.v6';

export const REVIEW_MODEL_ADAPTIVE_FAST_PATH_MAX_FILES_DEFAULT = parseEnvInteger(
  'ATLAS_REVIEW_ADAPTIVE_FAST_PATH_MAX_FILES',
  12,
  { min: 1, max: 200 }
);
export const REVIEW_MODEL_ADAPTIVE_FAST_PATH_MAX_DIFF_CHARS_DEFAULT = parseEnvInteger(
  'ATLAS_REVIEW_ADAPTIVE_FAST_PATH_MAX_DIFF_CHARS',
  45000,
  { min: 2000, max: 1000000 }
);
export const REVIEW_MODEL_ADAPTIVE_PREFER_QUALITY_ON_HIGH_RISK_DEFAULT = parseEnvBoolean(
  'ATLAS_REVIEW_ADAPTIVE_PREFER_QUALITY_ON_HIGH_RISK',
  true
);

export const DEFAULT_REVIEW_MODEL_ADAPTIVE = Object.freeze({
  fastPathMaxFiles: REVIEW_MODEL_ADAPTIVE_FAST_PATH_MAX_FILES_DEFAULT,
  fastPathMaxDiffChars: REVIEW_MODEL_ADAPTIVE_FAST_PATH_MAX_DIFF_CHARS_DEFAULT,
  preferQualityOnHighRisk: REVIEW_MODEL_ADAPTIVE_PREFER_QUALITY_ON_HIGH_RISK_DEFAULT,
});

export const DEFAULT_REVIEW_MODEL_ROLLOUT = Object.freeze({
  mode: 'on',
  canaryPercent: 25,
  projectAllowlist: [],
  gate: {
    status: 'pass',
    reasonCodes: [],
    source: 'unset',
    evaluatedAt: null,
  },
});

// ── Run Gate Thresholds ──────────────────────────────────────────────────────

export const REVIEW_RUN_GATE_MIN_COVERAGE_FILE_COUNT = parseEnvInteger(
  'ATLAS_REVIEW_RUN_GATE_MIN_COVERAGE_FILE_COUNT',
  6,
  { min: 1, max: 5000 }
);
export const REVIEW_RUN_GATE_MIN_DEEP_COVERAGE_RATE = parseEnvFloat(
  'ATLAS_REVIEW_RUN_GATE_MIN_DEEP_COVERAGE_RATE',
  0.65,
  { min: 0, max: 1 }
);
export const REVIEW_RUN_GATE_WARN_OMITTED_RATE = parseEnvFloat(
  'ATLAS_REVIEW_RUN_GATE_WARN_OMITTED_RATE',
  0.4,
  { min: 0, max: 1 }
);
export const REVIEW_RUN_GATE_MAX_DURATION_MS = parseEnvInteger(
  'ATLAS_REVIEW_RUN_GATE_MAX_DURATION_MS',
  240000,
  { min: 1000, max: 3600000 }
);
export const REVIEW_RUN_GATE_MAX_DURATION_CLI_AGENTIC_MS = parseEnvInteger(
  'ATLAS_REVIEW_RUN_GATE_MAX_DURATION_CLI_AGENTIC_MS',
  660000,
  { min: 60000, max: 3600000 }
);
export const REVIEW_RUN_GATE_MAX_DURATION_CLI_AGENTIC_LARGE_MS = parseEnvInteger(
  'ATLAS_REVIEW_RUN_GATE_MAX_DURATION_CLI_AGENTIC_LARGE_MS',
  1260000,
  { min: 120000, max: 3600000 }
);
export const REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_MS = parseEnvInteger(
  'ATLAS_REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_MS',
  90000,
  { min: 1000, max: 3600000 }
);
export const REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_CLI_AGENTIC_MS = parseEnvInteger(
  'ATLAS_REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_CLI_AGENTIC_MS',
  180000,
  { min: 10000, max: 3600000 }
);
export const REVIEW_RUN_GATE_MAX_UNSUPPORTED_ISSUE_RATE = parseEnvFloat(
  'ATLAS_REVIEW_RUN_GATE_MAX_UNSUPPORTED_ISSUE_RATE',
  0.45,
  { min: 0, max: 1 }
);
export const REVIEW_RUN_GATE_MAX_LOW_EVIDENCE_ISSUE_RATE = parseEnvFloat(
  'ATLAS_REVIEW_RUN_GATE_MAX_LOW_EVIDENCE_ISSUE_RATE',
  0.55,
  { min: 0, max: 1 }
);
export const REVIEW_RUN_GATE_MAX_DISMISSED_ISSUE_RATE = parseEnvFloat(
  'ATLAS_REVIEW_RUN_GATE_MAX_DISMISSED_ISSUE_RATE',
  0.6,
  { min: 0, max: 1 }
);
export const REVIEW_RUN_GATE_MAX_UNCORROBORATED_HIGH_RISK_RATE = parseEnvFloat(
  'ATLAS_REVIEW_RUN_GATE_MAX_UNCORROBORATED_HIGH_RISK_RATE',
  0.5,
  { min: 0, max: 1 }
);
export const REVIEW_RUN_GATE_MAX_OUTCOME_SUPPRESSION_RATE = parseEnvFloat(
  'ATLAS_REVIEW_RUN_GATE_MAX_OUTCOME_SUPPRESSION_RATE',
  0.75,
  { min: 0, max: 1 }
);

export const DEFAULT_REVIEW_MODEL_CONFIG = {
  strategy: 'smart',
  customModels: {},
  adaptive: { ...DEFAULT_REVIEW_MODEL_ADAPTIVE },
  rollout: {
    ...DEFAULT_REVIEW_MODEL_ROLLOUT,
    gate: { ...DEFAULT_REVIEW_MODEL_ROLLOUT.gate },
  },
};
