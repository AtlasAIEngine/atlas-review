import { normalizePathForMatch } from './reviewPromptBuilder.js';

const HISTORICAL_BUG_CLASS_RULES = Object.freeze([
  {
    id: 'missing_unsubscribe',
    label: 'Missing unsubscribe or teardown cleanup',
    patterns: [
      /\bunsubscribe\b/i,
      /\bmissing unsubscribe\b/i,
      /\bcleanup symmetry\b/i,
      /\bteardown\b/i,
      /\bon(?:destroy|disable)\b/i,
      /\bsubscription is never removed\b/i,
      /\bevent subscription\b/i,
    ],
  },
  {
    id: 'row_alignment_mismatch',
    label: 'Row alignment or flattened-index mismatch',
    patterns: [
      /\brow(?: |-)?alignment\b/i,
      /\bwrong item row\b/i,
      /\brow mapping\b/i,
      /\bflattened asset\b/i,
      /\bdifferently-shaped asset list\b/i,
      /\bpreserve(?:d)? order\b/i,
      /\bapplied to the wrong .*row\b/i,
      /\bindex(?:ed)? against\b/i,
    ],
  },
  {
    id: 'pooled_state_not_reset',
    label: 'Pooled object state is not fully reset',
    patterns: [
      /\bpool(?:ed)?\b/i,
      /\breturned to pool\b/i,
      /\breset visual state\b/i,
      /\bnot fully reset\b/i,
      /\bstate not reset\b/i,
      /\breset fire warning\b/i,
      /\bonreturnedtopool\b/i,
    ],
  },
  {
    id: 'editor_api_in_runtime_path',
    label: 'Editor-only API referenced in runtime path',
    patterns: [
      /\bunityeditor\b/i,
      /\beditorutility\b/i,
      /\bassetdatabase\b/i,
      /\beditor-only\b/i,
      /\bruntime path\b/i,
      /\bruntime assembly\b/i,
    ],
  },
  {
    id: 'uninitialized_service_dependency',
    label: 'Service or dependency used before initialization',
    patterns: [
      /\bused before (?:they are |it is )?initialized\b/i,
      /\bnever initialized\b/i,
      /\bnullreferenceexception\b/i,
      /\bservice fields are used before/i,
      /\bdependency\b.*\bnot initialized\b/i,
      /\bnull reference\b/i,
    ],
  },
  {
    id: 'lifecycle_signal_handoff',
    label: 'Lifecycle or signal handoff can miss the first event',
    patterns: [
      /\bmiss(?:ed|ing)? the first dispatch\b/i,
      /\bsignal can fire before\b/i,
      /\bsignal\b.*\bmiss(?:ed|ing)?\b/i,
      /\binit(?:ialization)? can be missed\b/i,
      /\bone(?: |-)?shot (?:initialization )?signal\b/i,
      /\bsubscription moved .* start\b/i,
      /\bcharacteradded\b.*\balready fired\b/i,
      /\bevent ordering\b/i,
      /\blate registration\b/i,
      /\bretroactive registration\b/i,
      /\bbackfill path\b/i,
      /\bbackfill\b/i,
      /\bexisting fake bots\b.*\bskip(?:ped)?\b/i,
      /\bregister existing characters\b/i,
      /\bexisting bots\b.*\bmiss(?:ed|ing)?\b/i,
      /\bretroactively register\b/i,
      /\bsubscrib(?:e|er).*\bafter setup\b/i,
      /\binit(?:ialization)? .* depends on subscription timing\b/i,
    ],
  },
  {
    id: 'math_edge_divide_by_zero',
    label: 'Math edge case can divide by zero or produce infinity',
    patterns: [
      /\bdivide by zero\b/i,
      /\binfinity\b/i,
      /\brelativepos\.magnitude\b/i,
      /\bmagnitude\s*==\s*0\b/i,
      /\bdistance correction\b/i,
      /\bminimap center\b/i,
    ],
  },
  {
    id: 'context_service_readiness_gap',
    label: 'Context service data source or readiness check is wrong',
    patterns: [
      /\bmatchdataservice\b/i,
      /\bhasdata\b/i,
      /\bbefore backend parsing completes\b/i,
      /\breadiness check\b/i,
      /\bincomplete data\b/i,
      /\bwrong data source\b/i,
      /\bnon combat\b/i,
      /\bcombat-only\b/i,
    ],
  },
]);

function normalizeHistoricalSignalText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildHistoricalSignalCorpus(value = null) {
  if (!value) return '';
  if (typeof value === 'string') return normalizeHistoricalSignalText(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeHistoricalSignalText([
      value.title,
      value.description,
      value.suggestedFix,
      value.summary,
      value.reason,
      value.relevance,
    ].filter(Boolean).join(' '));
  }
  return normalizeHistoricalSignalText(String(value));
}

export function detectHistoricalBugClass(value = null) {
  return classifyHistoricalBugClasses(value).find(Boolean) || null;
}

export function normalizeBugClassKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split('.').filter(Boolean);
  return (parts.at(-1) || raw).trim().toLowerCase();
}

export function classifyHistoricalBugClasses(value = null, options = {}) {
  const corpus = buildHistoricalSignalCorpus(value);
  if (!corpus) return [];

  const namespace = String(options?.namespace || '').trim().toLowerCase();
  return HISTORICAL_BUG_CLASS_RULES
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(corpus)))
    .map((rule) => (namespace ? `${namespace}.${rule.id}` : rule.id));
}

export function signalMatchesHistoricalBugClass(value = null, expectedClasses = []) {
  const requested = Array.from(new Set(
    (Array.isArray(expectedClasses) ? expectedClasses : [expectedClasses])
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter(Boolean)
  ));
  if (requested.length === 0) return false;

  const namespaces = Array.from(new Set(
    requested
      .map((entry) => entry.includes('.') ? entry.split('.').slice(0, -1).join('.') : '')
      .filter(Boolean)
  ));
  const candidates = new Set([
    ...classifyHistoricalBugClasses(value),
    ...namespaces.flatMap((namespace) => classifyHistoricalBugClasses(value, { namespace })),
  ].map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));

  return requested.some((entry) => candidates.has(entry));
}

export function buildHistoricalSignalRecord(value = null, options = {}) {
  const bugClass = detectHistoricalBugClass(value);
  const file = normalizePathForMatch(options?.file || value?.file || '') || null;
  return {
    bugClass,
    file,
  };
}

export function summarizeHistoricalSignalsForVerifier(historicalSignals = [], {
  maxItems = 3,
  maxChars = 180,
} = {}) {
  const seen = new Set();
  const lines = [];
  for (const signal of Array.isArray(historicalSignals) ? historicalSignals : []) {
    if (!signal || typeof signal !== 'object') continue;
    const bugClass = String(signal.bugClass || '').trim();
    const file = normalizePathForMatch(signal.file || '') || null;
    const title = normalizeHistoricalSignalText(signal.title || signal.summary || signal.relevance || '');
    if (!bugClass || !title) continue;
    const line = `${bugClass}${file ? ` @ ${file}` : ''}: ${title}`;
    const normalized = line.length <= maxChars ? line : `${line.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(normalized);
    if (lines.length >= Math.max(1, Math.trunc(Number(maxItems) || 3))) break;
  }
  return lines;
}

export default {
  detectHistoricalBugClass,
  normalizeBugClassKey,
  classifyHistoricalBugClasses,
  signalMatchesHistoricalBugClass,
  buildHistoricalSignalRecord,
  summarizeHistoricalSignalsForVerifier,
};
