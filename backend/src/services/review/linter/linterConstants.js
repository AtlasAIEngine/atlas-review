/**
 * Linter Pre-Pass Constants
 * Environment-parsed configuration for the deterministic linter subsystem.
 */

// ── Env Parsers ──────────────────────────────────────────────────────────────

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

// ── Feature Gate ─────────────────────────────────────────────────────────────

export function getReviewLinterEnabled() {
  return parseEnvBoolean('ATLAS_REVIEW_LINTER_ENABLED', false);
}

export const REVIEW_LINTER_ENABLED = getReviewLinterEnabled();

// ── Execution Limits ─────────────────────────────────────────────────────────

export function getReviewLinterDeadlineMs() {
  return parseEnvInteger(
    'ATLAS_REVIEW_LINTER_DEADLINE_MS',
    15000,
    { min: 3000, max: 60000 }
  );
}

export const REVIEW_LINTER_DEADLINE_MS = getReviewLinterDeadlineMs();

export function getReviewLinterMaxFiles() {
  return parseEnvInteger(
    'ATLAS_REVIEW_LINTER_MAX_FILES',
    100,
    { min: 1, max: 500 }
  );
}

export const REVIEW_LINTER_MAX_FILES = getReviewLinterMaxFiles();

export const REVIEW_LINTER_MAX_FINDINGS_PER_TOOL = parseEnvInteger(
  'ATLAS_REVIEW_LINTER_MAX_FINDINGS_PER_TOOL',
  50,
  { min: 1, max: 200 }
);

export function getReviewLinterMaxTotalFindings() {
  return parseEnvInteger(
    'ATLAS_REVIEW_LINTER_MAX_TOTAL_FINDINGS',
    100,
    { min: 1, max: 500 }
  );
}

export const REVIEW_LINTER_MAX_TOTAL_FINDINGS = getReviewLinterMaxTotalFindings();

// ── Prompt Context ───────────────────────────────────────────────────────────

export const REVIEW_LINTER_PROMPT_CONTEXT_MAX_LINES = parseEnvInteger(
  'ATLAS_REVIEW_LINTER_PROMPT_CONTEXT_MAX_LINES',
  20,
  { min: 1, max: 100 }
);

// ── Line Anchor Fuzzy Window ─────────────────────────────────────────────────

export function getReviewLinterCorroborationLineWindow() {
  return parseEnvInteger(
    'ATLAS_REVIEW_LINTER_CORROBORATION_LINE_WINDOW',
    3,
    { min: 0, max: 10 }
  );
}

export const REVIEW_LINTER_CORROBORATION_LINE_WINDOW = getReviewLinterCorroborationLineWindow();

// ── Severity Mapping ─────────────────────────────────────────────────────────

const SEVERITY_ORDER = Object.freeze({ critical: 3, high: 2, medium: 1, low: 0 });

export function normalizeLinterSeverity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized in SEVERITY_ORDER) return normalized;
  return 'low';
}

export function compareSeverity(a, b) {
  return (SEVERITY_ORDER[b] || 0) - (SEVERITY_ORDER[a] || 0);
}

// ── Category Classification ──────────────────────────────────────────────────

const SECURITY_RULE_PATTERNS = [
  /security/i,
  /injection/i,
  /\bxss\b/i,
  /\bcsrf\b/i,
  /\bssrf\b/i,
  /\brce\b/i,
  /\bsqli?\b/i,
  /\bpath[-_]?traversal\b/i,
  /\bopen[-_]?redirect\b/i,
  /\bprototype[-_]?pollut/i,
  /\binsecure\b/i,
  /\bvuln/i,
  /\bsecret\b/i,
  /\beval\b/i,
  /\bcredential/i,
  /\bhardcoded/i,
];

export function isSecurityRule(ruleId) {
  const id = String(ruleId || '');
  return SECURITY_RULE_PATTERNS.some((re) => re.test(id));
}

export function classifyCategory(ruleId, source) {
  if (isSecurityRule(ruleId)) return 'security';
  const id = String(ruleId || '').toLowerCase();
  if (id.includes('unused') || id.includes('no-unused') || id.includes('dead-code')) return 'correctness';
  if (id.includes('style') || id.includes('format') || id.includes('indent') || id.includes('spacing')) return 'style';
  if (id.includes('perf') || id.includes('complexity')) return 'performance';
  return 'correctness';
}

// ── Unity Analyzer IDs ───────────────────────────────────────────────────────

const UNITY_ANALYZER_RE = /^UNT\d{4}$/;

export function isUnityAnalyzerRule(ruleId) {
  return UNITY_ANALYZER_RE.test(String(ruleId || ''));
}

// ── Adapter IDs ──────────────────────────────────────────────────────────────

export const LINTER_IDS = Object.freeze({
  ESLINT: 'eslint',
  TSC: 'tsc',
  DOTNET: 'dotnet',
  DOTNET_FORMAT: 'dotnetFormat',
  SEMGREP: 'semgrep',
});
