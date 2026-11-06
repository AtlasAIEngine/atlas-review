/**
 * Walkthrough Generation
 *
 * Phase 11 — generates a walkthrough as an independent artifact, separate
 * from the main review pipeline. Uses the cheap-tier model by default
 * (provider's `walkthrough` phase, which aliases to `triage`); callers can
 * opt into the full review-tier model via `useCheapModel: false`.
 *
 * The walkthrough prompt is structural narration ONLY — it asks the model to
 * group changed files into logical steps and write step titles + descriptions.
 * It deliberately does NOT request `recommendations` or any findings logic —
 * those live on the review row.
 *
 * Persists to the `walkthroughs` table keyed on (projectId, baseSha, headSha)
 * so subsequent reads are cache hits.
 */

import walkthroughService from '../walkthroughService.js';
import providerService from '../providerService.js';
import usageService from '../usageService.js';
import walkthroughFileCacheService, { computeFileCacheKey } from '../walkthroughFileCacheService.js';
import {
  splitDiffByFile,
  extractImportEdgesFromDiff,
  computeAnchorScores,
  clusterFiles,
  buildClusterDiff,
} from './walkthroughClustering.js';

const PROMPT_MAX_DIFF_CHARS = 60_000;
const MIN_PROVIDER_COVERAGE_RATIO_FOR_FALLBACK = 0.75;
const MIN_PROVIDER_COVERAGE_FILE_COUNT_FOR_RATIO = 4;
const EXHAUSTIVE_MANIFEST_MAX_FILES = 250;
const EXHAUSTIVE_MANIFEST_MAX_CHARS = 28_000;
const SUMMARIZED_MANIFEST_FILE_LIMIT = 160;
const SUMMARIZED_MANIFEST_AREA_LIMIT = 12;
const FALLBACK_GROUP_MAX_FILES = 250;

// Map-reduce thresholds: above this file count we partition the diff into
// clusters, narrate each in parallel with a cheap-tier model, run a
// synthesis pass to consolidate, then merge. Single-pass narration handles
// up to ~40 files comfortably at the cheap tier; below that, single-pass
// produces tighter thematic groupings (3-7 steps) than map-reduce + synthesis.
const MAP_REDUCE_FILE_THRESHOLD = parseEnvInteger('ATLAS_WALKTHROUGH_MAP_REDUCE_FILE_THRESHOLD', 40, 5, 500);
// Cluster concurrency. Adaptive at call time: small diffs use the floor, large
// diffs scale up to the cap. The cap is intentionally well under any provider
// rate-limit (Anthropic Tier 1 haiku is 50 RPM, OpenAI tier 1 is 500 RPM); the
// real ceiling is local resource pressure for CLI providers, not provider RPM.
const MAP_REDUCE_CONCURRENCY = parseEnvInteger('ATLAS_WALKTHROUGH_MAP_REDUCE_CONCURRENCY', 5, 1, 12);
const MAP_REDUCE_CONCURRENCY_FLOOR = parseEnvInteger('ATLAS_WALKTHROUGH_MAP_REDUCE_CONCURRENCY_FLOOR', 3, 1, 8);
const MAP_REDUCE_MAX_FILES_PER_CLUSTER = parseEnvInteger('ATLAS_WALKTHROUGH_MAP_REDUCE_MAX_FILES_PER_CLUSTER', 25, 5, 100);
const MAP_REDUCE_MAX_CLUSTERS = parseEnvInteger('ATLAS_WALKTHROUGH_MAP_REDUCE_MAX_CLUSTERS', 12, 2, 32);
// Per-cluster tier escalation in map-reduce mode is OFF by default. Each
// escalation doubles a cluster's wall time (cheap call, then frontier call),
// and the augment pass + synthesis already cover quality at the consolidated
// level. Set ATLAS_WALKTHROUGH_CLUSTER_TIER_ESCALATION=1 to opt back in.
const MAP_REDUCE_CLUSTER_TIER_ESCALATION = parseEnvBoolean('ATLAS_WALKTHROUGH_CLUSTER_TIER_ESCALATION', false);
// Synthesis always runs on cheap-tier. Synthesis is structural consolidation
// of fragments that already carry per-cluster narration — Haiku-class models
// reorganize labels and regroup files just fine, and a single synthesis call
// on a frontier model for a 24+ fragment branch can take 10-15 minutes (vs
// ~5 min on Haiku) which dominates total wall time.
// Synthesis tier escalation is OFF by default. With cheap-tier synthesis on
// large branches (300+ files) the model often emits truncated output → fails
// the coverage quality check → escalates to frontier → loses the speed win
// from running cheap. The augment pass deterministically backfills any files
// the synthesis dropped, so escalation duplicates work that augment already
// handles. Set ATLAS_WALKTHROUGH_SYNTHESIS_TIER_ESCALATION=1 to opt back in.
const SYNTHESIS_TIER_ESCALATION = parseEnvBoolean('ATLAS_WALKTHROUGH_SYNTHESIS_TIER_ESCALATION', false);
const CLUSTER_PROMPT_MAX_DIFF_CHARS = parseEnvInteger('ATLAS_WALKTHROUGH_CLUSTER_PROMPT_MAX_DIFF_CHARS', 24_000, 4_000, 120_000);
// Target group count for the synthesis pass. Mirrors the single-pass prompt
// guideline ("3-7 steps for a typical PR") so map-reduce output looks the
// same shape as single-pass output.
const SYNTHESIS_TARGET_MAX_GROUPS = parseEnvInteger('ATLAS_WALKTHROUGH_SYNTHESIS_TARGET_MAX_GROUPS', 7, 3, 15);
const TIER_ESCALATION_ENABLED = parseEnvBoolean('ATLAS_WALKTHROUGH_TIER_ESCALATION', true);
const FILE_CACHE_ENABLED = parseEnvBoolean('ATLAS_WALKTHROUGH_FILE_CACHE', true);
// Coverage ratio below this triggers escalation to the frontier model. Lower
// than the post-merge `MIN_PROVIDER_COVERAGE_RATIO_FOR_FALLBACK` because the
// augment pass will still backfill gaps; we only escalate when the cheap
// output is materially lacking.
const TIER_ESCALATION_MIN_COVERAGE = 0.5;

function parseEnvInteger(name, defaultValue, min, max) {
  const raw = process.env?.[name];
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Pick a cluster concurrency level that scales with cluster count. For small
 * diffs (a handful of clusters) the floor keeps spawn / connection overhead
 * sane; for large diffs we want as many parallel calls as the env cap allows
 * so wall time scales with cluster_count / concurrency, not just cluster_count.
 */
function resolveAdaptiveClusterConcurrency(clusterCount) {
  if (!Number.isFinite(clusterCount) || clusterCount <= 0) return MAP_REDUCE_CONCURRENCY_FLOOR;
  // 5-clusters-per-worker rule: a queue depth of ~5 keeps each worker busy
  // through the run without leaving early-finishers idle for long.
  const target = Math.ceil(clusterCount / 5);
  return Math.min(MAP_REDUCE_CONCURRENCY, Math.max(MAP_REDUCE_CONCURRENCY_FLOOR, target));
}

function parseEnvBoolean(name, defaultValue) {
  const raw = String(process.env?.[name] ?? '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return defaultValue;
}

function normalizeTokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function normalizeOptionalCost(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createWalkthroughTelemetry() {
  const calls = [];
  return {
    calls,
    async track(req, providerCall) {
      const startedAt = Date.now();
      const result = await providerCall(req);
      const tokensUsed = result?.tokensUsed && typeof result.tokensUsed === 'object'
        ? result.tokensUsed
        : {};
      calls.push({
        model: result?.modelUsed || req?.model || null,
        requestedModel: req?.model || null,
        executionMode: result?.executionMode || null,
        durationMs: Math.max(0, Date.now() - startedAt),
        inputTokens: normalizeTokenCount(tokensUsed.input ?? tokensUsed.promptTokens ?? tokensUsed.prompt_tokens),
        outputTokens: normalizeTokenCount(tokensUsed.output ?? tokensUsed.completionTokens ?? tokensUsed.completion_tokens),
        providerNativeCost: normalizeOptionalCost(result?.agenticMeta?.costUsd ?? result?.costUsd),
      });
      return result;
    },
  };
}

function summarizeWalkthroughTelemetry({ providerType, modelId, telemetry }) {
  const calls = Array.isArray(telemetry?.calls) ? telemetry.calls : [];
  const inputTokens = calls.reduce((sum, call) => sum + normalizeTokenCount(call.inputTokens), 0);
  const outputTokens = calls.reduce((sum, call) => sum + normalizeTokenCount(call.outputTokens), 0);
  const nativeCosts = calls
    .map((call) => normalizeOptionalCost(call.providerNativeCost))
    .filter((value) => value != null && value > 0);
  const providerNativeCost = nativeCosts.length > 0
    ? nativeCosts.reduce((sum, value) => sum + value, 0)
    : null;
  return usageService.buildCostSnapshot({
    providerType,
    model: modelId,
    inputTokens,
    outputTokens,
    providerNativeCost,
  });
}

function buildWalkthroughRunMetadata({
  providerType,
  modelId,
  transport,
  useCheapModel,
  generationMode,
  generationStats,
  incremental = false,
  resolvedFileSummaries,
  llmFiles,
  deterministicFiles,
  telemetry,
  durationMs,
}) {
  const costSnapshot = summarizeWalkthroughTelemetry({ providerType, modelId, telemetry });
  const calls = Array.isArray(telemetry?.calls) ? telemetry.calls : [];
  const executionModes = Array.from(new Set(
    calls
      .map((call) => (typeof call?.executionMode === 'string' ? call.executionMode.trim() : ''))
      .filter(Boolean)
  ));
  return {
    schemaVersion: 1,
    strategy: useCheapModel === false ? 'review tier' : 'walkthrough cheap tier',
    budget: useCheapModel === false ? 'quality' : 'cheap',
    mode: generationMode,
    incremental: Boolean(incremental),
    transport: transport || null,
    providerType: providerType || null,
    modelId: modelId || null,
    executionMode: executionModes[0] || null,
    executionModes,
    durationMs: Math.max(0, Math.trunc(Number(durationMs) || 0)),
    fileCount: Array.isArray(resolvedFileSummaries) ? resolvedFileSummaries.length : 0,
    llmFileCount: Array.isArray(llmFiles) ? llmFiles.length : 0,
    deterministicFileCount: Array.isArray(deterministicFiles) ? deterministicFiles.length : 0,
    providerCallCount: Array.isArray(telemetry?.calls) ? telemetry.calls.length : 0,
    inputTokens: costSnapshot.inputTokens,
    outputTokens: costSnapshot.outputTokens,
    totalTokens: costSnapshot.totalTokens,
    estimatedCost: costSnapshot.estimatedCost,
    providerNativeCost: costSnapshot.providerNativeCost,
    costSource: costSnapshot.costSource,
    costIsApproximate: costSnapshot.costIsApproximate,
    pricingKey: costSnapshot.pricingKey,
    ...(generationStats && typeof generationStats === 'object' ? generationStats : {}),
  };
}

/**
 * Deterministic quality check on a parsed walkthrough output. Returns
 * `{ ok, reason }` where `reason` is one of: 'no_groups', 'low_coverage',
 * 'truncated'. Used to decide whether to escalate from the cheap-tier
 * model to the frontier model. The check is intentionally lenient — the
 * post-merge augment pass will backfill missing files, so we only escalate
 * when the cheap output is genuinely unusable, not just imperfect.
 */
function evaluateWalkthroughQuality(groups, expectedFiles) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return { ok: false, reason: 'no_groups' };
  }
  const expectedPaths = new Set(
    Array.isArray(expectedFiles) ? expectedFiles.map((f) => f?.path).filter(Boolean) : [],
  );
  const coveredPaths = new Set();
  for (const group of groups) {
    for (const file of Array.isArray(group?.files) ? group.files : []) {
      const path = String(file?.path || '');
      if (expectedPaths.has(path)) coveredPaths.add(path);
      // Trailing-ellipsis is the cheap-model's tell when it ran out of room.
      if (typeof file?.description === 'string' && /\.\.\.\s*$/.test(file.description)) {
        return { ok: false, reason: 'truncated' };
      }
    }
  }
  if (expectedPaths.size === 0) return { ok: true };
  const ratio = coveredPaths.size / expectedPaths.size;
  if (ratio < TIER_ESCALATION_MIN_COVERAGE) {
    return { ok: false, reason: 'low_coverage' };
  }
  return { ok: true };
}

/**
 * Run a walkthrough LLM call with optional tier escalation. When the cheap
 * model's output fails the deterministic quality check, retry once with the
 * frontier (review-tier) model. Skipped when the user already opted into
 * the frontier (`useCheapModel === false`) or when escalation is disabled
 * via env.
 *
 * @returns {Promise<{ groups: Array, model: string|null, escalated: boolean, escalationReason: string|null }>}
 */
async function runWithTierEscalation({
  buildPrompt,
  expectedFiles,
  providerType,
  transport,
  providerCall,
  useCheapModel,
  // Caller-controlled escalation gate. The cluster pass in map-reduce sets
  // this to false because per-cluster escalation doubles wall time for weak
  // clusters that synthesis + augment pass already cover. Synthesis itself
  // and the single-pass path both keep escalation enabled.
  allowEscalation = true,
}) {
  const cheapModel = resolveWalkthroughModel(providerType, true, { transport });
  const frontierModel = resolveWalkthroughModel(providerType, false, { transport });

  const initialUseCheap = useCheapModel !== false;
  const initialModel = initialUseCheap ? cheapModel : frontierModel;
  const initialResp = await providerCall({
    prompt: buildPrompt(),
    model: initialModel,
    providerType,
    transport,
  });
  const initialGroups = normalizeChangeGroups(
    parseWalkthroughResponse(typeof initialResp?.text === 'string' ? initialResp.text : '')?.changeGroups,
  );

  const canEscalate = allowEscalation
    && initialUseCheap
    && TIER_ESCALATION_ENABLED
    && frontierModel
    && frontierModel !== cheapModel;
  if (!canEscalate) {
    return { groups: initialGroups, model: initialModel, escalated: false, escalationReason: null };
  }

  const evaluation = evaluateWalkthroughQuality(initialGroups, expectedFiles);
  if (evaluation.ok) {
    return { groups: initialGroups, model: initialModel, escalated: false, escalationReason: null };
  }

  // Cheap output was unusable — retry once with the frontier model.
  const frontierResp = await providerCall({
    prompt: buildPrompt(),
    model: frontierModel,
    providerType,
    transport,
  });
  const frontierGroups = normalizeChangeGroups(
    parseWalkthroughResponse(typeof frontierResp?.text === 'string' ? frontierResp.text : '')?.changeGroups,
  );
  return {
    groups: frontierGroups,
    model: frontierModel,
    escalated: true,
    escalationReason: evaluation.reason,
  };
}

function normalizeFileSummaries(files) {
  return Array.isArray(files)
    ? files
        .filter((file) => file && typeof file === 'object' && !Array.isArray(file))
        .map((file) => ({
          path: typeof file.path === 'string' ? file.path.trim() : '',
          additions: Number.isFinite(Number(file.additions)) ? Math.max(0, Math.trunc(Number(file.additions))) : 0,
          deletions: Number.isFinite(Number(file.deletions)) ? Math.max(0, Math.trunc(Number(file.deletions))) : 0,
          status: typeof file.status === 'string' ? file.status.trim().toUpperCase().charAt(0) : '',
          oldPath: typeof file.oldPath === 'string' ? file.oldPath.trim() : '',
          description: '',
        }))
        .filter((file) => file.path)
    : [];
}

function getManifestStatusLabel(file) {
  switch (file.status) {
    case 'D':
      return ' [deleted]';
    case 'A':
      return ' [new]';
    case 'R':
      return file.oldPath ? ` [renamed from ${file.oldPath}]` : ' [renamed]';
    default:
      return '';
  }
}

function getDefaultFileDescription(file) {
  if (file.status === 'D') return 'Deleted in this diff.';
  if (file.additions > 0 && file.deletions > 0) return 'Modified in this diff.';
  if (file.additions > 0) return 'Added in this diff.';
  return 'Removed or simplified in this diff.';
}

function buildManifestLines(files) {
  return normalizeFileSummaries(files)
    .map((file) => `- ${file.path}${getManifestStatusLabel(file)} (+${file.additions} -${file.deletions})`);
}

function shouldUseExhaustiveManifest(files) {
  const normalized = normalizeFileSummaries(files);
  if (normalized.length > EXHAUSTIVE_MANIFEST_MAX_FILES) return false;
  return buildManifestLines(normalized).join('\n').length <= EXHAUSTIVE_MANIFEST_MAX_CHARS;
}

function getManifestArea(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '(root)';
  if (parts.length === 1) return '(root)';
  if (parts[0].startsWith('.')) return parts[0];
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

function summarizeManifestAreas(files) {
  const areas = new Map();
  for (const file of normalizeFileSummaries(files)) {
    const area = getManifestArea(file.path);
    const current = areas.get(area) || { area, files: 0, additions: 0, deletions: 0 };
    current.files += 1;
    current.additions += file.additions;
    current.deletions += file.deletions;
    areas.set(area, current);
  }
  return Array.from(areas.values())
    .sort((a, b) => (b.files - a.files) || ((b.additions + b.deletions) - (a.additions + a.deletions)))
    .slice(0, SUMMARIZED_MANIFEST_AREA_LIMIT);
}

function buildWalkthroughManifestSection(files) {
  const normalized = normalizeFileSummaries(files);
  if (normalized.length === 0) return { text: '', exhaustive: true };

  if (shouldUseExhaustiveManifest(normalized)) {
    return {
      exhaustive: true,
      text: `Changed file manifest (authoritative; every path must appear exactly once in changeGroups[].files):\n${buildManifestLines(normalized).join('\n')}\n\n`,
    };
  }

  const totalAdditions = normalized.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = normalized.reduce((sum, file) => sum + file.deletions, 0);
  const topAreas = summarizeManifestAreas(normalized)
    .map((area) => `- ${area.area}: ${area.files} files (+${area.additions} -${area.deletions})`)
    .join('\n');
  const representativeFiles = [...normalized]
    .sort((a, b) => ((b.additions + b.deletions) - (a.additions + a.deletions)) || a.path.localeCompare(b.path))
    .slice(0, SUMMARIZED_MANIFEST_FILE_LIMIT);

  return {
    exhaustive: false,
    text: `Changed file summary (authoritative counts; representative paths only because this diff is large):\n`
      + `Total changed files: ${normalized.length} (+${totalAdditions} -${totalDeletions})\n`
      + `Top changed areas:\n${topAreas || '- (none)'}\n\n`
      + `Representative changed files:\n${buildManifestLines(representativeFiles).join('\n')}\n\n`,
  };
}

/**
 * Build the walkthrough-only prompt. Structural narration only — no findings.
 *
 * @param {{ diff: string, title?: string, fileSummaries?: Array<{ path: string, additions: number, deletions: number }> }} params
 * @returns {string}
 */
export function buildWalkthroughPrompt({ diff = '', title = '', fileSummaries = null } = {}) {
  // Truncate over-large diffs so the prompt stays within budget. The
  // walkthrough is narration-level, so a tail-truncation is acceptable.
  const safeDiff = String(diff || '');
  const truncated = safeDiff.length > PROMPT_MAX_DIFF_CHARS
    ? `${safeDiff.slice(0, PROMPT_MAX_DIFF_CHARS)}\n\n... (diff truncated for walkthrough generation)`
    : safeDiff;

  const titleLine = title ? `Title: ${title}\n\n` : '';
  const files = Array.isArray(fileSummaries) ? normalizeFileSummaries(fileSummaries) : parseDiffFileSummaries(diff);
  const manifest = buildWalkthroughManifestSection(files);

  return `You are a senior code reviewer writing a STRUCTURAL WALKTHROUGH for a developer reading a diff.

Your job is to group changed files into logical steps and narrate what changed in each. You are NOT writing findings, issues, or risk ratings — those are produced separately. Focus on grouping and clear, plain-English narration.

Return a JSON object with this exact structure:

{
  "changeGroups": [
    {
      "label": "Short name for this logical group of changes",
      "description": "What this group does, in plain English (1-3 sentences)",
      "risk": "low | medium | high | critical",
      "files": [
        {
          "path": "exact file path from the diff",
          "additions": <number>,
          "deletions": <number>,
          "description": "What changed in this file (one short line)"
        }
      ]
    }
  ]
}

Guidelines:
- Group changes by LOGICAL CONCERN, not by file. Files that serve the same purpose belong in one step.
- Aim for 3-7 steps for a typical PR; fewer for tiny diffs, more if the diff is genuinely multi-themed.
- For exhaustive manifests, include EVERY file from the changed file manifest exactly once. ONLY include files that appear in the manifest. Never invent file paths.
- For large summarized manifests, group the representative files you can reason about; Atlas will attach the remaining files deterministically from the authoritative counts.
- The "risk" field is a coarse signal of how much careful reading the step deserves; default to "low" for routine refactors and "medium" or higher only when the step touches sensitive flow (auth, persistence, payments, etc.).
- Return ONLY the JSON object — no markdown fences, no preamble, no commentary.

${titleLine}${manifest.text}Diff excerpt:
${truncated}`;
}

/**
 * Strip markdown fences and whitespace around a JSON candidate.
 * Walkthrough output should be JSON-only, but some providers wrap it.
 */
function stripFences(text) {
  const trimmed = String(text || '').trim();
  // ```json\n...\n```  OR  ```\n...\n```
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

/**
 * Try to extract the first balanced `{...}` block from raw text.
 * Walkthrough output is small so a one-pass scan is fine.
 */
function extractFirstJsonObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse-recovery seam for walkthrough output. Mirrors the review parser's
 * fall-through:
 *   1. strict JSON
 *   2. fence-stripped JSON
 *   3. balanced-brace extraction
 *
 * Returns `{ changeGroups }` if any candidate yields a valid object, else null.
 */
function parseWalkthroughResponse(text) {
  const candidates = [];
  const raw = String(text || '').trim();
  if (raw) candidates.push(raw);
  const stripped = stripFences(raw);
  if (stripped && stripped !== raw) candidates.push(stripped);
  const extracted = extractFirstJsonObject(raw);
  if (extracted && !candidates.includes(extracted)) candidates.push(extracted);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

const VALID_RISK = new Set(['low', 'medium', 'high', 'critical']);

function normalizeChangeGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];
  const out = [];
  for (const group of rawGroups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    const label = typeof group.label === 'string' ? group.label.trim() : '';
    const description = typeof group.description === 'string' ? group.description.trim() : '';
    const riskRaw = typeof group.risk === 'string' ? group.risk.trim().toLowerCase() : '';
    const risk = VALID_RISK.has(riskRaw) ? riskRaw : 'low';
    const files = Array.isArray(group.files)
      ? group.files
        .filter((file) => file && typeof file === 'object' && !Array.isArray(file))
        .map((file) => ({
          path: typeof file.path === 'string' ? file.path : '',
          additions: Number.isFinite(Number(file.additions)) ? Math.max(0, Math.trunc(Number(file.additions))) : 0,
          deletions: Number.isFinite(Number(file.deletions)) ? Math.max(0, Math.trunc(Number(file.deletions))) : 0,
          description: typeof file.description === 'string' ? file.description.trim() : '',
        }))
        .filter((file) => file.path)
      : [];
    if (!label && files.length === 0) continue;
    out.push({ label: label || 'Step', description, risk, files });
  }
  return out;
}

function parseDiffFileSummaries(diff) {
  const lines = String(diff || '').split(/\r?\n/);
  const files = [];
  let current = null;

  const finishCurrent = () => {
    if (current?.path) {
      files.push({
        path: current.path,
        additions: current.additions,
        deletions: current.deletions,
        description: '',
      });
    }
    current = null;
  };

  for (const line of lines) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      finishCurrent();
      // Match the deletion-sentinel handling in walkthroughClustering.splitDiffByFile.
      const isDeletedTarget = header[2] === '/dev/null' || header[2] === 'dev/null';
      current = {
        path: isDeletedTarget ? header[1] : header[2],
        additions: 0,
        deletions: 0,
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) current.additions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
  }

  finishCurrent();
  return files;
}

function isAssetLikeWalkthroughFile(path) {
  const lower = String(path || '').toLowerCase();
  return /\.(meta|asset|mat|prefab|unity|controller|anim|overridecontroller|playable|png|jpg|jpeg|gif|svg|ico|icns|webp|tga|psd|exr|fbx|obj|blend|wav|mp3|ogg|mp4|mov|ttf|otf|shadergraph|vfx)$/i.test(lower);
}

function shouldUseDeterministicWalkthroughGroup(file) {
  if (!file?.path) return false;
  if (file.status === 'D') return true;
  return isAssetLikeWalkthroughFile(file.path);
}

function partitionWalkthroughFiles(files) {
  const llmFiles = [];
  const deterministicFiles = [];
  for (const file of normalizeFileSummaries(files)) {
    if (shouldUseDeterministicWalkthroughGroup(file)) {
      deterministicFiles.push(file);
    } else {
      llmFiles.push(file);
    }
  }
  return { llmFiles, deterministicFiles };
}

function buildDiffForFiles(diff, files) {
  const fileDiffs = splitDiffByFile(diff);
  return buildClusterDiff(files, fileDiffs);
}

function getFallbackGroupForFile(file) {
  const lower = String(file?.path || '').toLowerCase();
  if (file?.status === 'D') {
    return {
      key: 'deleted',
      label: 'Deleted files',
      description: 'Removes files that are no longer part of the branch output.',
      risk: 'low',
    };
  }
  if (isAssetLikeWalkthroughFile(lower)) {
    return {
      key: 'assets',
      label: 'Assets and generated files',
      description: 'Updates bundled assets, metadata, or generated project artifacts.',
      risk: 'low',
    };
  }
  if (lower.includes('__tests__') || lower.includes('/test') || lower.endsWith('.test.ts') || lower.endsWith('.test.tsx') || lower.endsWith('.test.js')) {
    return {
      key: 'tests',
      label: 'Tests and validation',
      description: 'Updates test coverage and validation paths related to this diff.',
      risk: 'low',
    };
  }
  if (lower.startsWith('backend/') || lower.includes('/routes/') || lower.includes('/services/') || lower.includes('/db/') || lower.includes('/migrations/')) {
    return {
      key: 'backend',
      label: 'Backend flow',
      description: 'Changes server-side routes, services, persistence, or runtime behavior.',
      risk: lower.includes('/migrations/') || lower.includes('/auth') || lower.includes('/routes/') ? 'medium' : 'low',
    };
  }
  if (lower.startsWith('frontend/') || lower.endsWith('.tsx') || lower.endsWith('.ts') || lower.endsWith('.css')) {
    return {
      key: 'frontend',
      label: 'Frontend experience',
      description: 'Changes client-side UI, state, or styling behavior.',
      risk: 'low',
    };
  }
  if (lower.endsWith('.md') || lower.startsWith('docs/') || lower.startsWith('.planning/')) {
    return {
      key: 'docs',
      label: 'Docs and planning',
      description: 'Updates documentation, notes, or planning artifacts.',
      risk: 'low',
    };
  }
  return {
    key: 'other',
    label: 'Supporting changes',
    description: 'Collects supporting file changes that do not fit the main implementation groups.',
    risk: 'low',
  };
}

function chunkFiles(files, size) {
  const chunks = [];
  for (let index = 0; index < files.length; index += size) {
    chunks.push(files.slice(index, index + size));
  }
  return chunks;
}

function buildFallbackChangeGroupsFromFiles(files) {
  if (files.length === 0) return [];

  const groups = new Map();
  for (const file of normalizeFileSummaries(files)) {
    const meta = getFallbackGroupForFile(file);
    if (!groups.has(meta.key)) {
      groups.set(meta.key, {
        key: meta.key,
        label: meta.label,
        description: meta.description,
        risk: meta.risk,
        files: [],
      });
    }
    groups.get(meta.key).files.push({
      ...file,
      description: getDefaultFileDescription(file),
    });
  }

  const out = [];
  for (const group of groups.values()) {
    const chunks = chunkFiles(group.files, FALLBACK_GROUP_MAX_FILES);
    chunks.forEach((filesChunk, index) => {
      const chunkSuffix = chunks.length > 1 ? ` ${index + 1}/${chunks.length}` : '';
      out.push({
        label: `${group.label}${chunkSuffix}`,
        description: chunks.length > 1
          ? `${group.description} Part ${index + 1} of ${chunks.length}.`
          : group.description,
        risk: group.risk,
        files: filesChunk,
      });
    });
  }

  return out.filter((group) => group.files.length > 0);
}

function orderDeterministicWalkthroughGroups(groups) {
  const rank = (group) => {
    const label = String(group?.label || '').toLowerCase();
    if (label === 'assets and generated files') return 1;
    if (label === 'deleted files') return 2;
    return 0;
  };
  return [...groups].sort((a, b) => rank(a) - rank(b));
}

function buildFallbackChangeGroups(diff) {
  return buildFallbackChangeGroupsFromFiles(parseDiffFileSummaries(diff));
}

function augmentChangeGroupsForFullCoverage(changeGroups, fileSummaries) {
  if (!Array.isArray(fileSummaries) || fileSummaries.length === 0) {
    return {
      changeGroups: Array.isArray(changeGroups) ? changeGroups : [],
      providerCoveredFileCount: Array.isArray(changeGroups)
        ? changeGroups.reduce((sum, group) => sum + (Array.isArray(group.files) ? group.files.length : 0), 0)
        : 0,
      totalFileCount: 0,
    };
  }

  const canonicalByPath = new Map(fileSummaries.map((file) => [file.path, file]));
  const seen = new Set();
  const normalizedGroups = [];
  let providerCoveredFileCount = 0;

  for (const group of Array.isArray(changeGroups) ? changeGroups : []) {
    const files = [];
    for (const file of Array.isArray(group.files) ? group.files : []) {
      const canonical = canonicalByPath.get(file.path);
      if (!canonical || seen.has(canonical.path)) continue;
      seen.add(canonical.path);
      providerCoveredFileCount += 1;
      files.push({
        ...file,
        path: canonical.path,
        additions: canonical.additions,
        deletions: canonical.deletions,
        description: file.description || getDefaultFileDescription(canonical),
      });
    }
    if (files.length > 0) {
      normalizedGroups.push({ ...group, files });
    }
  }

  const missingFiles = fileSummaries.filter((file) => !seen.has(file.path));
  if (missingFiles.length > 0) {
    normalizedGroups.push(...buildFallbackChangeGroupsFromFiles(missingFiles));
  }

  return {
    changeGroups: normalizedGroups,
    providerCoveredFileCount,
    totalFileCount: fileSummaries.length,
  };
}

function assertProviderCoverageBeforeSaving({
  diff,
  providerCoveredFileCount,
  totalFileCount,
  allowDeterministicFallback = false,
}) {
  if (!String(diff || '').trim() || totalFileCount <= 0) return;
  if (allowDeterministicFallback) return;
  if (providerCoveredFileCount <= 0) {
    throw new Error('Walkthrough provider returned no valid diff files; no walkthrough was saved');
  }
  if (totalFileCount < MIN_PROVIDER_COVERAGE_FILE_COUNT_FOR_RATIO) return;

  const coverageRatio = providerCoveredFileCount / totalFileCount;
  if (coverageRatio < MIN_PROVIDER_COVERAGE_RATIO_FOR_FALLBACK) {
    throw new Error(
      `Walkthrough provider covered too few diff files (${providerCoveredFileCount}/${totalFileCount}); no walkthrough was saved`
    );
  }
}

/**
 * Resolve the model id to use for walkthrough generation.
 * - useCheapModel=true (default) → provider's walkthrough phase (aliases to triage)
 * - useCheapModel=false          → provider's review phase (full model)
 *
 * @param {string} providerType
 * @param {boolean} useCheapModel
 * @param {object} [options] forwarded to getSmartReviewModel (e.g. transport)
 * @returns {string|null}
 */
export function resolveWalkthroughModel(providerType, useCheapModel, options = {}) {
  const phase = useCheapModel === false ? 'review' : 'walkthrough';
  return providerService.getSmartReviewModel(providerType, phase, options);
}

/**
 * Run a single bounded-concurrency pass over a list of work items. Inspired
 * by the standard p-map pattern; we keep it inline so we don't pull in a
 * dependency for one call site.
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { status: 'rejected', reason: error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Build a cluster-scoped walkthrough prompt: same schema, but the manifest
 * and diff are restricted to a single cluster so the model can stay focused
 * and the prompt fits comfortably in the cheap-tier budget.
 */
function buildClusterPrompt({ clusterIndex, clusterCount, clusterKey, files, clusterDiff, title }) {
  const safeDiff = String(clusterDiff || '');
  const truncated = safeDiff.length > CLUSTER_PROMPT_MAX_DIFF_CHARS
    ? `${safeDiff.slice(0, CLUSTER_PROMPT_MAX_DIFF_CHARS)}\n\n... (cluster diff truncated)`
    : safeDiff;
  const manifestLines = buildManifestLines(files).join('\n');
  const titleLine = title ? `Title: ${title}\n` : '';

  return `You are a senior code reviewer writing a STRUCTURAL WALKTHROUGH for a developer reading a diff. This call is for a SINGLE CLUSTER (${clusterIndex + 1} of ${clusterCount}, area: ${clusterKey}). Atlas will run a SECOND synthesis pass to merge cluster fragments into the final walkthrough — your job here is just to narrate this cluster.

Return a JSON object with this exact structure:

{
  "changeGroups": [
    {
      "label": "Short name for this cluster",
      "description": "What this cluster does, in plain English (1-3 sentences)",
      "risk": "low | medium | high | critical",
      "files": [
        {
          "path": "exact file path from the cluster manifest",
          "additions": <number>,
          "deletions": <number>,
          "description": "What changed in this file (one short line)"
        }
      ]
    }
  ]
}

Guidelines:
- Produce EXACTLY ONE changeGroup for this cluster. Atlas will merge it with the others.
- Include EVERY file from the cluster manifest below exactly once. ONLY include files from this cluster.
- Use "risk" as a coarse signal (default "low"; bump to "medium"/"high" only for sensitive flow).
- Return ONLY the JSON object — no fences, no preamble.

${titleLine}Cluster manifest:
${manifestLines}

Cluster diff:
${truncated}`;
}

/**
 * Map-reduce walkthrough: cluster the changed files, narrate each cluster
 * with a cheap-tier model in parallel, merge the resulting changeGroups,
 * and order them by the cluster's top anchor score (in-degree among
 * changed files). Ensures every file ends up in a group via the existing
 * coverage-augment seam — clusters that the LLM dropped get filled in
 * deterministically by area.
 */
/**
 * Build the synthesis prompt that consolidates per-cluster fragment groups
 * into a final 3-7 step thematic walkthrough. The synthesis sees only the
 * fragment metadata (label, description, risk, file list) — no diff text —
 * so the prompt stays tight and the call is fast/cheap.
 */
function buildSynthesisPrompt({ fragments, manifest, title }) {
  const titleLine = title ? `Title: ${title}\n\n` : '';
  const fragmentLines = fragments.map((fragment, index) => {
    const fileList = fragment.files.length > 8
      ? `${fragment.files.slice(0, 8).map((f) => f.path).join(', ')}, … (+${fragment.files.length - 8} more)`
      : fragment.files.map((f) => f.path).join(', ');
    return `Fragment ${index + 1} — "${fragment.label}" (risk: ${fragment.risk}, ${fragment.files.length} file${fragment.files.length === 1 ? '' : 's'})
${fragment.description}
Files: ${fileList}`;
  }).join('\n\n');

  return `You are a senior code reviewer writing the FINAL STRUCTURAL WALKTHROUGH for a developer reading a diff. Atlas already broke the diff into ${fragments.length} per-cluster fragment narrations below. Your job is to CONSOLIDATE them into ${SYNTHESIS_TARGET_MAX_GROUPS - 4}-${SYNTHESIS_TARGET_MAX_GROUPS} thematic walkthrough steps that read like a coherent story, not a per-cluster recap.

Return a JSON object with this exact structure:

{
  "changeGroups": [
    {
      "label": "Short thematic name",
      "description": "What this step does, in plain English (1-3 sentences)",
      "risk": "low | medium | high | critical",
      "files": [
        { "path": "exact file path from the manifest below", "additions": <number>, "deletions": <number>, "description": "what changed (one short line)" }
      ]
    }
  ]
}

Guidelines:
- Produce ${SYNTHESIS_TARGET_MAX_GROUPS - 4}-${SYNTHESIS_TARGET_MAX_GROUPS} changeGroups, ordered by reading priority (high-risk first).
- Group by LOGICAL THEME across fragments. Move files between fragments as needed.
- Include EVERY file from the manifest below exactly once. ONLY use paths from the manifest.
- Carry forward the per-file descriptions from the fragments verbatim when you can.
- Use "risk" as a coarse signal (default "low"; bump to "medium"/"high" only for sensitive flow).
- Return ONLY the JSON object — no fences, no preamble.

${titleLine}Authoritative file manifest (every path must appear exactly once in changeGroups[].files):
${manifest}

Per-cluster fragments to consolidate:
${fragmentLines}`;
}

/**
 * Run the synthesis pass to consolidate per-cluster fragments into the final
 * walkthrough. Returns `{ groups, model, escalated }`; on any failure, falls
 * back to the input fragments so the user always gets a walkthrough.
 */
async function runSynthesis({
  fragmentGroups,
  resolvedFileSummaries,
  providerType,
  useCheapModel,
  title,
  transport,
  providerCall,
  cachedDescriptions,
}) {
  if (!Array.isArray(fragmentGroups) || fragmentGroups.length <= SYNTHESIS_TARGET_MAX_GROUPS) {
    return { groups: fragmentGroups, model: null, escalated: false };
  }

  const fragments = fragmentGroups.map((group) => ({
    label: group.label || 'Step',
    description: group.description || '',
    risk: group.risk || 'low',
    files: Array.isArray(group.files) ? group.files : [],
  }));
  const manifest = buildManifestLines(resolvedFileSummaries).join('\n');
  const buildPrompt = () => buildSynthesisPrompt({ fragments, manifest, title });

  try {
    const result = await runWithTierEscalation({
      buildPrompt,
      expectedFiles: resolvedFileSummaries,
      providerType,
      transport,
      providerCall,
      useCheapModel,
      allowEscalation: SYNTHESIS_TIER_ESCALATION,
    });
    if (!Array.isArray(result.groups) || result.groups.length === 0) {
      console.warn('[walkthrough] synthesis returned empty output; using fragment groups directly');
      return { groups: fragmentGroups, model: null, escalated: false };
    }
    // Carry per-file descriptions from the fragments through synthesis. The
    // synthesis prompt asks the model to keep them, but it doesn't always —
    // overlay deterministically as a safety net.
    const descriptionByPath = new Map();
    for (const group of fragmentGroups) {
      for (const file of Array.isArray(group.files) ? group.files : []) {
        if (file.path && file.description && !descriptionByPath.has(file.path)) {
          descriptionByPath.set(file.path, file.description);
        }
      }
    }
    if (cachedDescriptions instanceof Map) {
      for (const [path, desc] of cachedDescriptions.entries()) {
        if (!descriptionByPath.has(path)) descriptionByPath.set(path, desc);
      }
    }
    for (const group of result.groups) {
      for (const file of Array.isArray(group.files) ? group.files : []) {
        if (file.path && !file.description && descriptionByPath.has(file.path)) {
          file.description = descriptionByPath.get(file.path);
        }
      }
    }
    if (result.escalated) {
      console.info(`[walkthrough] synthesis escalated to frontier model (reason: ${result.escalationReason})`);
    }
    return { groups: result.groups, model: result.model, escalated: result.escalated };
  } catch (error) {
    console.warn('[walkthrough] synthesis call failed; using fragment groups directly:', error.message);
    return { groups: fragmentGroups, model: null, escalated: false };
  }
}

/**
 * Compute per-file content hashes for the cache lookup. Returns a map from
 * path → hash. Files with no diff body are skipped.
 */
function computeFileHashes(fileDiffs) {
  const map = new Map();
  if (!(fileDiffs instanceof Map)) return map;
  for (const [path, body] of fileDiffs.entries()) {
    if (!body) continue;
    map.set(path, computeFileCacheKey({ diffText: body }));
  }
  return map;
}

/**
 * Build a deterministic group from cached file summaries when every file in
 * a cluster has a cache hit. Reuses the area-based label/description from
 * the deterministic fallback grouper, then overlays cached descriptions and
 * picks the highest cached risk as the group risk.
 */
function buildCachedClusterGroups({ clusterFilesList, hashesByPath, cacheHits }) {
  const groups = buildFallbackChangeGroupsFromFiles(clusterFilesList);
  const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
  for (const group of groups) {
    let maxRisk = 'low';
    for (const file of group.files) {
      const hash = hashesByPath.get(file.path);
      const cached = hash ? cacheHits.get(hash) : null;
      if (!cached) continue;
      file.description = cached.description;
      if ((RISK_RANK[cached.risk] || 0) > (RISK_RANK[maxRisk] || 0)) {
        maxRisk = cached.risk;
      }
    }
    group.risk = maxRisk;
  }
  return groups;
}

/**
 * Extract per-file cache write-back entries from the LLM's parsed groups.
 * Skips files outside the cluster manifest and files with empty descriptions.
 */
function collectCacheEntriesFromGroups({ groups, clusterFilesList, hashesByPath }) {
  const clusterPaths = new Set(clusterFilesList.map((f) => f.path));
  const seen = new Set();
  const entries = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const groupRisk = typeof group?.risk === 'string' ? group.risk : 'low';
    for (const file of Array.isArray(group?.files) ? group.files : []) {
      const path = String(file?.path || '');
      const description = typeof file?.description === 'string' ? file.description.trim() : '';
      if (!description || !clusterPaths.has(path) || seen.has(path)) continue;
      const hash = hashesByPath.get(path);
      if (!hash) continue;
      seen.add(path);
      entries.push({
        contentHash: hash,
        summary: { description, risk: groupRisk },
      });
    }
  }
  return entries;
}

async function runMapReduceWalkthrough({
  diff,
  resolvedFileSummaries,
  providerType,
  useCheapModel,
  title,
  transport,
  bypassFileCache = false,
  providerCall,
}) {
  const fileDiffs = splitDiffByFile(diff);
  const edges = extractImportEdgesFromDiff(fileDiffs);
  const anchorScores = computeAnchorScores(resolvedFileSummaries, edges);
  const clusters = clusterFiles(resolvedFileSummaries, edges, anchorScores, {
    maxFilesPerCluster: MAP_REDUCE_MAX_FILES_PER_CLUSTER,
    maxClusters: MAP_REDUCE_MAX_CLUSTERS,
  });

  if (clusters.length === 0) {
    return { changeGroups: [], model: null, clusterCount: 0, clusterFailures: 0, clusterEscalations: 0, clusterCacheHits: 0 };
  }

  const hashesByPath = computeFileHashes(fileDiffs);
  const cacheHits = FILE_CACHE_ENABLED && !bypassFileCache && hashesByPath.size > 0
    ? await walkthroughFileCacheService.getMany(Array.from(hashesByPath.values())).catch((err) => {
        console.warn('[walkthrough] cache lookup failed; proceeding without cache:', err.message);
        return new Map();
      })
    : new Map();

  const concurrency = resolveAdaptiveClusterConcurrency(clusters.length);
  const clusterPassStartedAt = Date.now();
  console.info(
    `[walkthrough] map-reduce: ${clusters.length} cluster(s), concurrency=${concurrency}, escalation=${MAP_REDUCE_CLUSTER_TIER_ESCALATION ? 'on' : 'off'}`
  );

  const settled = await runWithConcurrency(clusters, concurrency, async (cluster, index) => {
    const clusterStartedAt = Date.now();
    // Full cache hit: skip the LLM entirely for this cluster.
    const allCached = cluster.files.every((f) => {
      const hash = hashesByPath.get(f.path);
      return hash && cacheHits.has(hash);
    });
    if (allCached) {
      const groups = buildCachedClusterGroups({ clusterFilesList: cluster.files, hashesByPath, cacheHits });
      console.info(
        `[walkthrough] cluster ${index + 1}/${clusters.length} (${cluster.key}, ${cluster.files.length} file${cluster.files.length === 1 ? '' : 's'}): ${Date.now() - clusterStartedAt}ms cached`
      );
      return { cluster, groups, escalated: false, escalationReason: null, cached: true, model: null };
    }

    const clusterDiff = buildClusterDiff(cluster.files, fileDiffs);
    const buildPrompt = () => buildClusterPrompt({
      clusterIndex: index,
      clusterCount: clusters.length,
      clusterKey: cluster.key,
      files: cluster.files,
      clusterDiff,
      title,
    });
    const result = await runWithTierEscalation({
      buildPrompt,
      expectedFiles: cluster.files,
      providerType,
      transport,
      providerCall,
      useCheapModel,
      allowEscalation: MAP_REDUCE_CLUSTER_TIER_ESCALATION,
    });
    console.info(
      `[walkthrough] cluster ${index + 1}/${clusters.length} (${cluster.key}, ${cluster.files.length} file${cluster.files.length === 1 ? '' : 's'}): ${Date.now() - clusterStartedAt}ms model=${result.model || 'unknown'}${result.escalated ? ` escalated(${result.escalationReason})` : ''}`
    );
    return { cluster, ...result, cached: false };
  });

  console.info(
    `[walkthrough] cluster pass: ${Date.now() - clusterPassStartedAt}ms total`
  );

  const mergedGroups = [];
  let clusterFailures = 0;
  let clusterEscalations = 0;
  let clusterCacheHits = 0;
  // Track the most-escalated cluster model so we can persist the actual model
  // used (not just the up-front cheap-tier resolve). Frontier wins over cheap.
  let clusterEscalatedModel = null;
  let clusterCheapModel = null;
  const writebackEntries = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) {
      clusterFailures += 1;
      continue;
    }
    const { cluster, groups, escalated, cached, model } = result.value;
    if (escalated) clusterEscalations += 1;
    if (cached) clusterCacheHits += 1;
    if (!Array.isArray(groups) || groups.length === 0) {
      clusterFailures += 1;
      continue;
    }
    if (model) {
      if (escalated && !clusterEscalatedModel) clusterEscalatedModel = model;
      if (!escalated && !clusterCheapModel) clusterCheapModel = model;
    }
    for (const group of groups) {
      mergedGroups.push({ ...group, _clusterAnchor: cluster.topAnchor });
    }
    if (!cached && FILE_CACHE_ENABLED) {
      const entries = collectCacheEntriesFromGroups({ groups, clusterFilesList: cluster.files, hashesByPath });
      for (const entry of entries) {
        writebackEntries.push({ ...entry, modelId: model || null });
      }
    }
  }

  // Order groups by the cluster's anchor score so reviewer attention lands
  // on hubs first; preserve original cluster ordering as a tiebreak.
  mergedGroups.sort((a, b) => (b._clusterAnchor || 0) - (a._clusterAnchor || 0));
  for (const group of mergedGroups) delete group._clusterAnchor;

  // Synthesis pass: when too many fragment groups, consolidate into 3-7
  // thematic walkthrough steps. Without this, large diffs would produce one
  // step per cluster (often one step per file when import edges are sparse,
  // e.g., on Unity/C# repos) — a regression vs single-pass quality.
  let cachedDescriptions = null;
  if (cacheHits.size > 0) {
    cachedDescriptions = new Map();
    for (const [path, hash] of hashesByPath.entries()) {
      const cached = cacheHits.get(hash);
      if (cached?.description) cachedDescriptions.set(path, cached.description);
    }
  }
  const synthesisStartedAt = Date.now();
  // Synthesis always runs on cheap-tier even when cluster narration ran on
  // frontier. The cluster fragments already carry the user's chosen tier;
  // synthesis is just structural consolidation.
  const synthesisResult = await runSynthesis({
    fragmentGroups: mergedGroups,
    resolvedFileSummaries,
    providerType,
    useCheapModel: true,
    title,
    transport,
    providerCall,
    cachedDescriptions,
  });
  const synthesizedGroups = synthesisResult.groups;
  console.info(
    `[walkthrough] synthesis: ${Date.now() - synthesisStartedAt}ms model=${synthesisResult.model || 'skipped'}${synthesisResult.escalated ? ' escalated' : ''}`
  );

  if (clusterEscalations > 0) {
    console.info(
      `[walkthrough] map-reduce: ${clusterEscalations}/${clusters.length} cluster(s) escalated to frontier model`
    );
  }
  if (clusterCacheHits > 0) {
    console.info(
      `[walkthrough] map-reduce: ${clusterCacheHits}/${clusters.length} cluster(s) served from file cache`
    );
  }

  // Best-effort cache write-back; never block the walkthrough on it.
  if (writebackEntries.length > 0) {
    void walkthroughFileCacheService.putMany(writebackEntries).catch((err) => {
      console.warn('[walkthrough] cache write-back failed:', err.message);
    });
  }

  // Resolve the model to persist. Synthesis is the last LLM call and runs over
  // the whole walkthrough, so its model best represents the artifact saved.
  // Fall back to any cluster-level escalation, then a cluster cheap model,
  // then null (e.g. all-cached path).
  const effectiveModel = synthesisResult.model
    || clusterEscalatedModel
    || clusterCheapModel
    || null;

  return {
    changeGroups: synthesizedGroups,
    model: effectiveModel,
    clusterCount: clusters.length,
    clusterFailures,
    clusterEscalations,
    clusterCacheHits,
  };
}

/**
 * Single-pass walkthrough: one LLM call over the full diff + manifest.
 * Used for diffs below the map-reduce threshold. Escalates from cheap to
 * frontier model on weak output via runWithTierEscalation. Honors the
 * per-file cache: when every file in the diff has a cached summary, skips
 * the LLM and builds groups deterministically; otherwise runs the LLM and
 * writes per-file results back to the cache.
 */
async function runSinglePassWalkthrough({
  diff,
  resolvedFileSummaries,
  providerType,
  useCheapModel,
  title,
  transport,
  bypassFileCache = false,
  providerCall,
}) {
  const fileDiffs = splitDiffByFile(diff);
  const hashesByPath = computeFileHashes(fileDiffs);
  const cacheHits = FILE_CACHE_ENABLED && !bypassFileCache && hashesByPath.size > 0
    ? await walkthroughFileCacheService.getMany(Array.from(hashesByPath.values())).catch((err) => {
        console.warn('[walkthrough] cache lookup failed; proceeding without cache:', err.message);
        return new Map();
      })
    : new Map();

  const allFilesCached = resolvedFileSummaries.length > 0
    && resolvedFileSummaries.every((f) => {
      const hash = hashesByPath.get(f.path);
      return hash && cacheHits.has(hash);
    });

  if (allFilesCached) {
    const groups = buildCachedClusterGroups({
      clusterFilesList: resolvedFileSummaries,
      hashesByPath,
      cacheHits,
    });
    console.info('[walkthrough] single-pass served entirely from file cache');
    return { changeGroups: groups, model: null, escalated: false, cached: true };
  }

  const buildPrompt = () => buildWalkthroughPrompt({ diff, title, fileSummaries: resolvedFileSummaries });
  const result = await runWithTierEscalation({
    buildPrompt,
    expectedFiles: resolvedFileSummaries,
    providerType,
    transport,
    providerCall,
    useCheapModel,
  });
  if (result.escalated) {
    console.info(`[walkthrough] single-pass escalated to frontier model (reason: ${result.escalationReason})`);
  }

  if (FILE_CACHE_ENABLED && result.groups.length > 0) {
    const entries = collectCacheEntriesFromGroups({
      groups: result.groups,
      clusterFilesList: resolvedFileSummaries,
      hashesByPath,
    });
    if (entries.length > 0) {
      const withModel = entries.map((entry) => ({ ...entry, modelId: result.model || null }));
      void walkthroughFileCacheService.putMany(withModel).catch((err) => {
        console.warn('[walkthrough] cache write-back failed:', err.message);
      });
    }
  }

  return {
    changeGroups: result.groups,
    model: result.model,
    escalated: result.escalated,
    cached: false,
  };
}

/**
 * Generate and persist a walkthrough.
 *
 * @param {{
 *   projectId: string,
 *   baseSha: string,
 *   headSha: string,
 *   diff: string,
 *   providerType: string,
 *   useCheapModel?: boolean,
 *   bypassFileCache?: boolean,
 *   title?: string,
 *   transport?: string,
 *   providerCall: (req: { prompt: string, model: string, providerType: string, transport?: string }) => Promise<{ text: string }>,
 * }} params
 * @returns {Promise<Array>} The persisted change groups.
 */
export async function generateWalkthrough({
  projectId,
  baseSha,
  headSha,
  diff,
  fileSummaries = null,
  providerType,
  useCheapModel = true,
  bypassFileCache = false,
  incremental = false,
  title = '',
  transport = '',
  providerCall,
} = {}) {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('generateWalkthrough: projectId is required');
  }
  if (!baseSha || typeof baseSha !== 'string') {
    throw new Error('generateWalkthrough: baseSha is required');
  }
  if (!headSha || typeof headSha !== 'string') {
    throw new Error('generateWalkthrough: headSha is required');
  }
  if (typeof providerCall !== 'function') {
    throw new Error('generateWalkthrough: providerCall is required (caller wires the active provider)');
  }

  const generateStartedAt = Date.now();

  const resolvedFileSummaries = Array.isArray(fileSummaries)
    ? normalizeFileSummaries(fileSummaries)
    : parseDiffFileSummaries(diff);
  const { llmFiles, deterministicFiles } = partitionWalkthroughFiles(resolvedFileSummaries);
  const llmDiff = deterministicFiles.length > 0
    ? buildDiffForFiles(diff, llmFiles)
    : diff;
  const allowDeterministicFallback = resolvedFileSummaries.length > 0
    && !shouldUseExhaustiveManifest(resolvedFileSummaries);

  const useMapReduce = llmFiles.length >= MAP_REDUCE_FILE_THRESHOLD;
  const generationMode = useMapReduce ? 'map-reduce' : 'single-pass';
  const telemetry = createWalkthroughTelemetry();
  const trackedProviderCall = (req) => telemetry.track(req, providerCall);
  console.info(
    `[walkthrough] generation start: ${resolvedFileSummaries.length} file(s), mode=${generationMode}, provider=${providerType || 'unknown'}, cheap=${useCheapModel !== false}, llmFiles=${llmFiles.length}, deterministicFiles=${deterministicFiles.length}`
  );
  // In map-reduce mode, partial cluster failures are expected and the augment
  // pass deterministically fills missing files. Allow fallback so a few failed
  // clusters don't error the whole walkthrough — the user asked us to never
  // fail on big diffs.
  const effectiveAllowDeterministicFallback = allowDeterministicFallback || useMapReduce;
  // Up-front resolve of the cheap-tier model. Used as a provenance fallback
  // when the dispatch path cannot report a more precise model (e.g. all-cached
  // path, deterministic fallback after total cluster failure). When the cheap
  // model escalates to frontier, the dispatch path reports the actual model.
  const fallbackModel = resolveWalkthroughModel(providerType, useCheapModel, { transport });

  let generatedGroups;
  let effectiveModel = null;
  let generationStats = {
    escalated: false,
    cached: false,
    clusterCount: 0,
    clusterFailures: 0,
    clusterEscalations: 0,
    clusterCacheHits: 0,
  };
  let mapReduceAllFailed = false;
  if (llmFiles.length === 0) {
    generatedGroups = [];
  } else if (useMapReduce) {
    const mr = await runMapReduceWalkthrough({
      diff: llmDiff,
      resolvedFileSummaries: llmFiles,
      providerType,
      useCheapModel,
      title,
      transport,
      bypassFileCache,
      providerCall: trackedProviderCall,
    });
    generatedGroups = mr.changeGroups;
    effectiveModel = mr.model;
    generationStats = {
      clusterCount: mr.clusterCount || 0,
      clusterFailures: mr.clusterFailures || 0,
      clusterEscalations: mr.clusterEscalations || 0,
      clusterCacheHits: mr.clusterCacheHits || 0,
      escalated: (mr.clusterEscalations || 0) > 0,
      cached: (mr.clusterCount || 0) > 0 && (mr.clusterCacheHits || 0) >= (mr.clusterCount || 0),
    };
    if (mr.clusterCount > 0 && mr.clusterFailures >= mr.clusterCount) {
      mapReduceAllFailed = true;
      generatedGroups = [];
    }
  } else {
    const sp = await runSinglePassWalkthrough({
      diff: llmDiff,
      resolvedFileSummaries: llmFiles,
      providerType,
      useCheapModel,
      title,
      transport,
      bypassFileCache,
      providerCall: trackedProviderCall,
    });
    generatedGroups = sp.changeGroups;
    effectiveModel = sp.model;
    generationStats = {
      escalated: sp.escalated === true,
      cached: sp.cached === true,
      clusterCount: 0,
      clusterFailures: 0,
      clusterEscalations: sp.escalated === true ? 1 : 0,
      clusterCacheHits: sp.cached === true ? 1 : 0,
    };
  }
  const persistModel = effectiveModel || fallbackModel || null;
  const deterministicGroups = orderDeterministicWalkthroughGroups(
    buildFallbackChangeGroupsFromFiles(deterministicFiles)
  );

  if (generatedGroups.length === 0 && String(llmDiff || '').trim()) {
    // Map-reduce diffs always allow deterministic fallback: the user explicitly
    // asked us to never fail on big diffs, and the area-based grouper still
    // produces a meaningful (if less detailed) walkthrough.
    if (effectiveAllowDeterministicFallback || mapReduceAllFailed) {
      const changeGroups = [
        ...buildFallbackChangeGroupsFromFiles(llmFiles),
        ...deterministicGroups,
      ];
      const runMetadata = buildWalkthroughRunMetadata({
        providerType,
        modelId: persistModel,
        transport,
        useCheapModel,
        generationMode,
        generationStats: {
          ...generationStats,
          deterministicFallback: true,
          mapReduceAllFailed,
        },
        incremental,
        resolvedFileSummaries,
        llmFiles,
        deterministicFiles,
        telemetry,
        durationMs: Date.now() - generateStartedAt,
      });
      await walkthroughService.saveWalkthrough({
        projectId,
        baseSha,
        headSha,
        changeGroups,
        modelId: persistModel,
        providerType: providerType || null,
        runMetadata,
      });
      console.info(
        `[walkthrough] generation complete: ${Date.now() - generateStartedAt}ms (deterministic fallback, ${changeGroups.length} group(s))`
      );
      return changeGroups;
    }
    throw new Error('Walkthrough provider returned unusable output; no walkthrough was saved');
  }

  const coverage = augmentChangeGroupsForFullCoverage(generatedGroups, llmFiles);
  assertProviderCoverageBeforeSaving({
    diff: llmDiff,
    providerCoveredFileCount: coverage.providerCoveredFileCount,
    totalFileCount: coverage.totalFileCount,
    allowDeterministicFallback: effectiveAllowDeterministicFallback,
  });
  let changeGroups = [...coverage.changeGroups, ...deterministicGroups];

  // Non-empty diffs should never cache an empty walkthrough. Some cheap/CLI
  // providers occasionally return review-shaped or otherwise unusable output;
  // surface that as a failed generation instead of saving a fake walkthrough.
  if (changeGroups.length === 0 && String(diff || '').trim()) {
    throw new Error('Walkthrough provider returned no valid diff files; no walkthrough was saved');
  }

  const runMetadata = buildWalkthroughRunMetadata({
    providerType,
    modelId: persistModel,
    transport,
    useCheapModel,
    generationMode,
    generationStats: {
      ...generationStats,
      deterministicFallback: false,
      providerCoveredFileCount: coverage.providerCoveredFileCount,
      totalFileCount: coverage.totalFileCount,
    },
    incremental,
    resolvedFileSummaries,
    llmFiles,
    deterministicFiles,
    telemetry,
    durationMs: Date.now() - generateStartedAt,
  });

  await walkthroughService.saveWalkthrough({
    projectId,
    baseSha,
    headSha,
    changeGroups,
    modelId: persistModel,
    providerType: providerType || null,
    runMetadata,
  });

  console.info(
    `[walkthrough] generation complete: ${Date.now() - generateStartedAt}ms (${changeGroups.length} group(s), provider-covered ${coverage.providerCoveredFileCount}/${coverage.totalFileCount}, deterministic ${deterministicFiles.length})`
  );
  return changeGroups;
}

export default {
  generateWalkthrough,
  buildWalkthroughPrompt,
  resolveWalkthroughModel,
};
