#!/usr/bin/env node
/**
 * Performance M0 — benchmark driver
 *
 * Drives 3 branches × 2 strategies through the local dev backend API,
 * captures each review result JSON, and writes one file per run into
 * the run-stamp directory consumed by performance-m0-aggregate.mjs.
 *
 * Pre-requisites:
 *   - dev backend running on http://localhost:3000 with the new telemetry
 *     code (commit 2d50fc6a or later)
 *   - ATLAS_REVIEW_TELEMETRY_BALANCED=1 in the backend's env (so Balanced
 *     runs also emit the telemetry namespace)
 *   - JWT in $ATLAS_BENCH_TOKEN, project in $ATLAS_BENCH_PROJECT_ID
 *   - Local branches bench/b1-pr186, bench/b2-pr173, bench/b3-pr194
 *     pointing at the pinned head SHAs
 *
 * Usage:
 *   ATLAS_BENCH_TOKEN=... ATLAS_BENCH_PROJECT_ID=... \
 *     node backend/scripts/performance-m0-driver.mjs <run-stamp>
 *
 * Each review is run sequentially. The trigger endpoint blocks until the
 * review completes, so wall-clock per run ≈ review wall-clock. Expect
 * 30–60 min total for 6 runs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// node's built-in fetch (undici under the hood) defaults to a 5-min
// headersTimeout. Reviews that span that boundary trip a `fetch failed`
// error even though the backend keeps running. We don't change the
// global dispatcher here (undici isn't a direct dep); instead the
// trigger wrapper below catches the dropped fetch and polls the row to
// recover.

const API = process.env.ATLAS_BENCH_API || 'http://localhost:3000';
const TOKEN = process.env.ATLAS_BENCH_TOKEN;
const PROJECT_ID = process.env.ATLAS_BENCH_PROJECT_ID;

if (!TOKEN || !PROJECT_ID) {
  console.error('Missing ATLAS_BENCH_TOKEN or ATLAS_BENCH_PROJECT_ID env');
  process.exit(2);
}

const RUN_STAMP = process.argv[2];
if (!RUN_STAMP) {
  console.error('Usage: performance-m0-driver.mjs <run-stamp>');
  process.exit(2);
}

// Slot table. `projectId` is optional — when omitted the driver falls back to
// `ATLAS_BENCH_PROJECT_ID` from env. This lets a single driver run target
// multiple projects (e.g. AtlasEngineMVP for b1/b2/b3, Project Black for
// u1/u2/u3/u4) by listing slots with their own projectId entries.
const PROJECT_BLACK_ID = '5a42b504-3329-4c77-866f-cbe7ab329f96';
const ALL_BRANCHES = [
  // AtlasEngineMVP slots — use ATLAS_BENCH_PROJECT_ID env default.
  { slot: 'b1', branchName: 'bench/b1-pr186', label: 'PR #186 follow-up cli (small)' },
  { slot: 'b2', branchName: 'bench/b2-pr173', label: 'PR #173 opencode timeout (medium-large)' },
  { slot: 'b3', branchName: 'bench/b3-pr194', label: 'PR #194 review update (mixed)' },
  // Project Black Unity slots — explicit projectId, last_commit scope on the
  // pinned merge commit. Diversity: tiny .cs / medium .cs / scene-asset / refactor.
  { slot: 'u1', branchName: 'bench/u1-pr9245', label: 'PB #9245 cooldown wave (tiny .cs)', projectId: PROJECT_BLACK_ID },
  { slot: 'u2', branchName: 'bench/u2-pr9247', label: 'PB #9247 Blitz dynamic height (medium .cs)', projectId: PROJECT_BLACK_ID },
  { slot: 'u3', branchName: 'bench/u3-pr9252', label: 'PB #9252 NavMesh agent type (scene/asset)', projectId: PROJECT_BLACK_ID },
  { slot: 'u4', branchName: 'bench/u4-pr9217', label: 'PB #9217 removed roll count (delete-heavy)', projectId: PROJECT_BLACK_ID },
];

// Optional slot filter — `ATLAS_BENCH_SLOTS=b1,b3` for targeted repeats.
const SLOT_FILTER = (process.env.ATLAS_BENCH_SLOTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const BRANCHES = SLOT_FILTER.length > 0
  ? ALL_BRANCHES.filter((b) => SLOT_FILTER.includes(b.slot))
  : ALL_BRANCHES;
if (SLOT_FILTER.length > 0 && BRANCHES.length === 0) {
  console.error(`ATLAS_BENCH_SLOTS=${process.env.ATLAS_BENCH_SLOTS} matched no slots; valid: ${ALL_BRANCHES.map((b) => b.slot).join(', ')}`);
  process.exit(2);
}

const ALL_STRATEGIES = [
  { id: 'balanced', settingsValue: 'smart' },
  { id: 'performance', settingsValue: 'performance' },
];

// Optional strategy filter — `ATLAS_BENCH_STRATEGIES=performance` for
// focused validation of a prompt change without spending tokens on the
// Balanced runs that didn't change.
const STRATEGY_FILTER = (process.env.ATLAS_BENCH_STRATEGIES || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const STRATEGIES = STRATEGY_FILTER.length > 0
  ? ALL_STRATEGIES.filter((s) => STRATEGY_FILTER.includes(s.id))
  : ALL_STRATEGIES;
if (STRATEGY_FILTER.length > 0 && STRATEGIES.length === 0) {
  console.error(`ATLAS_BENCH_STRATEGIES=${process.env.ATLAS_BENCH_STRATEGIES} matched none; valid: ${ALL_STRATEGIES.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

// Provider table — adds a third dimension to the matrix for the Track 2
// Codex-vs-Claude benchmark. Each entry sets `review_active_provider`
// before runs are dispatched. Default is `claude`, which preserves the
// pre-Track-2 behavior (Anthropic CLI). `codex` switches to OpenAI's
// gpt-5.3-codex via the cli_openai provider id. The captured filename
// embeds the provider id so 3-dimensional cells (slot × strategy ×
// provider) don't collide.
const ALL_PROVIDERS = [
  { id: 'claude', settingsValue: { providerId: 'cli_anthropic', model: 'claude-sonnet-4-6' } },
  { id: 'codex',  settingsValue: { providerId: 'cli_openai',    model: 'gpt-5.3-codex'    } },
];
const PROVIDER_FILTER = (process.env.ATLAS_BENCH_PROVIDERS || 'claude')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const PROVIDERS = ALL_PROVIDERS.filter((p) => PROVIDER_FILTER.includes(p.id));
if (PROVIDERS.length === 0) {
  console.error(`ATLAS_BENCH_PROVIDERS=${process.env.ATLAS_BENCH_PROVIDERS} matched none; valid: ${ALL_PROVIDERS.map((p) => p.id).join(', ')}`);
  process.exit(2);
}

// Run-index suffix for capture filenames; bumped per repeat so
// `b3__balanced__2.json`, `b3__balanced__3.json` etc. land alongside the
// original `__1.json` and the aggregator pools them into one (slot,strategy)
// cell.
const RUN_INDEX = (() => {
  const raw = process.env.ATLAS_BENCH_RUN_INDEX;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`ATLAS_BENCH_RUN_INDEX must be a positive integer, got: ${raw}`);
    process.exit(2);
  }
  return n;
})();

async function http(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: res.status, ok: res.ok, body: parsed };
}

async function setStrategy(value) {
  const r = await http('PUT', `/api/settings/review_model_strategy`, { value });
  if (!r.ok) throw new Error(`setStrategy(${value}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/**
 * Track 2: switch the active review provider (Claude CLI ↔ Codex CLI) by
 * writing the JSON payload `review_active_provider` expects. The settings
 * route stringifies the JSON value, so the call wraps the descriptor in
 * `JSON.stringify` to match the on-disk shape used elsewhere.
 */
async function setActiveProvider(descriptor) {
  const r = await http('PUT', `/api/settings/review_active_provider`, { value: JSON.stringify(descriptor) });
  if (!r.ok) throw new Error(`setActiveProvider(${descriptor.providerId}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createBranchReview(projectId, branchName) {
  const r = await http('POST', `/api/projects/${projectId}/branches/review`, {
    branchName,
    diffScope: 'last_commit',
  });
  if (!r.ok) throw new Error(`createBranchReview(${branchName}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function triggerReview(projectId, brId) {
  // Recovery wrapper: if the synchronous trigger fetch fails for any reason
  // (network blip, timeout despite our long-timeout dispatcher, etc.), the
  // backend may still be processing the review. Re-poll the row until it
  // reaches a terminal status before giving up. This makes the driver
  // resilient to client-side disconnects mid-review.
  try {
    const r = await http('POST', `/api/projects/${projectId}/branch-reviews/${brId}/review`, {});
    if (!r.ok) throw new Error(`triggerReview(${brId}) failed: ${r.status} ${JSON.stringify(r.body).slice(0, 800)}`);
    return r.body;
  } catch (err) {
    console.warn(`triggerReview fetch dropped (${err.message}); polling for completion…`);
    return await pollForCompletion(projectId, brId);
  }
}

async function pollForCompletion(projectId, brId, maxWaitMs = 15 * 60 * 1000, intervalMs = 5000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`pollForCompletion(${brId}): timed out after ${maxWaitMs}ms`);
    }
    let row;
    try {
      const r = await http('GET', `/api/projects/${projectId}/branch-reviews/${brId}`);
      if (!r.ok) {
        await new Promise((res) => setTimeout(res, intervalMs));
        continue;
      }
      row = r.body?.branchReview;
    } catch {
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }
    const status = row?.reviewStatus;
    if (status === 'reviewed' || status === 'failed') {
      // Reconstruct a trigger-shaped response from the persisted row so the
      // capture file looks identical to the synchronous-success path.
      return {
        success: status === 'reviewed',
        review: row.reviewJson || null,
        branchReview: row,
        recoveredFromFetchTimeout: true,
      };
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

async function fetchBranchReview(projectId, brId) {
  const r = await http('GET', `/api/projects/${projectId}/branch-reviews/${brId}`);
  if (!r.ok) throw new Error(`fetchBranchReview(${brId}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function deleteBranchReview(projectId, brId) {
  const r = await http('DELETE', `/api/projects/${projectId}/branch-reviews/${brId}`);
  if (!r.ok) console.warn(`deleteBranchReview(${brId}) failed (non-fatal): ${r.status}`);
}

function fmtElapsed(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m${r}s` : `${s}s`;
}

async function main() {
  const outDir = path.resolve(
    process.cwd(),
    `.artifacts/review-harness-benchmarks/performance-m0/${RUN_STAMP}`,
  );
  await fs.mkdir(outDir, { recursive: true });
  console.log(`Output dir: ${outDir}`);

  const startedAt = Date.now();
  const summary = [];

  // Mutating the active provider and strategy is global state on the user's
  // local app; we MUST restore them even on failure (createBranchReview /
  // triggerReview / fetchBranchReview / capture writes can throw mid-matrix).
  // The earlier post-loop restore was skipped on any thrown error, leaving
  // review_active_provider stuck on cli_openai/gpt-5.3-codex for the user's
  // normal review runs. Wrap the loop body in try/finally.
  try {
  for (const branch of BRANCHES) {
    for (const provider of PROVIDERS) {
      for (const strategy of STRATEGIES) {
      const runStartMs = Date.now();
      const label = `${branch.slot} ${strategy.id} ${provider.id}`;
      // Capture filename now embeds the provider id when provider !== claude.
      // Pre-Track-2 Claude-only runs keep the original 3-field filename
      // (`<slot>__<strategy>__<idx>.json`) so existing artifacts and the
      // aggregator's filename regex stay backward compatible. Codex runs
      // get a 4-field filename so the dimensions don't collide.
      const captureFilename = provider.id === 'claude'
        ? `${branch.slot}__${strategy.id}__${RUN_INDEX}.json`
        : `${branch.slot}__${strategy.id}__${provider.id}__${RUN_INDEX}.json`;
      const captureFile = path.join(outDir, captureFilename);
      // Resume support: if a capture for this (slot, strategy, provider)
      // already exists and is non-empty, skip the run. The driver can crash
      // mid-matrix (e.g. backend SIGTERM); resume by re-running with the
      // same run-stamp.
      try {
        const existing = await fs.stat(captureFile);
        if (existing.size > 0) {
          console.log(`\n[${label}] Skipping — existing capture ${captureFile}`);
          continue;
        }
      } catch { /* no existing capture; proceed */ }
      // Per-slot project (Project Black slots set their own; AtlasEngineMVP
      // slots fall back to the env default).
      const slotProjectId = branch.projectId || PROJECT_ID;

      console.log(`\n[${label}] Setting active provider → ${provider.settingsValue.providerId}/${provider.settingsValue.model}`);
      await setActiveProvider(provider.settingsValue);

      console.log(`[${label}] Setting strategy → ${strategy.settingsValue}`);
      await setStrategy(strategy.settingsValue);

      console.log(`[${label}] Creating branch review for ${branch.branchName} (project ${slotProjectId.slice(0, 8)})`);
      const created = await createBranchReview(slotProjectId, branch.branchName);
      const brId = created?.branchReview?.id || created?.id;
      if (!brId) {
        throw new Error(`No branchReview.id in response: ${JSON.stringify(created).slice(0, 400)}`);
      }
      console.log(`[${label}] brId=${brId} headSha=${created?.branchReview?.headSha || ''}`);

      {
        console.log(`[${label}] Triggering review (will block until complete)…`);
        const reviewResp = await triggerReview(slotProjectId, brId);

        const elapsedMs = Date.now() - runStartMs;
        console.log(`[${label}] Done in ${fmtElapsed(elapsedMs)}.`);

        // Re-fetch to get the persisted branch_review with full reviewData.
        const refetched = await fetchBranchReview(slotProjectId, brId);

        await fs.writeFile(captureFile, JSON.stringify({
          slot: branch.slot,
          strategy: strategy.id,
          provider: provider.id,
          runIndex: RUN_INDEX,
          branchName: branch.branchName,
          elapsedMs,
          triggerResponse: reviewResp,
          branchReview: refetched?.branchReview || refetched,
        }, null, 2));
        console.log(`[${label}] Wrote ${captureFile}`);

        const stats = (reviewResp?.review?.stats) || (refetched?.branchReview?.reviewData?.stats) || {};
        const tt = stats?.performance?.toolUseTelemetry || null;
        summary.push({
          slot: branch.slot,
          strategy: strategy.id,
          provider: provider.id,
          elapsedMs,
          telemetryPresent: Boolean(tt),
          toolCalls: tt?.toolCalls,
          fullFileReads: tt?.fullFileReads,
          gitDiffCalls: tt?.gitDiffCalls,
          turns: stats?.agenticActualTurns,
          inputTokens: stats?.tokensUsed?.input,
          outputTokens: stats?.tokensUsed?.output,
          findingsCount: Array.isArray(reviewResp?.review?.recommendations)
            ? reviewResp.review.recommendations.length
            : null,
        });
      }
      // Note: do NOT deleteBranchReview between iterations. The route reuses
      // the existing row by branch name, so deleting and recreating just
      // returns the same brId anyway, and a 409 from a still-active row
      // creates a misleading log entry. Bench rows are cleaned up at the
      // end of the run (and at session start by the cloning step).
      }
    }
  }
  } finally {
    // Restore strategy and provider to defaults so the user's settings aren't
    // left as performance/codex after the matrix completes (or partially fails).
    await setStrategy('smart').catch((err) => {
      console.warn(`restore strategy failed: ${err.message}`);
    });
    await setActiveProvider({ providerId: 'cli_anthropic', model: 'claude-sonnet-4-6' }).catch((err) => {
      console.warn(`restore active provider failed: ${err.message}`);
    });
  }

  await fs.writeFile(path.join(outDir, '__summary.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalElapsedMs: Date.now() - startedAt,
    runs: summary,
  }, null, 2));

  // The total run count depends on slot filter + strategies (default 3×2=6,
  // but ATLAS_BENCH_SLOTS=b3 → 1×2=2, etc.). Report the actual count from
  // the summary array, which holds one entry per completed (non-skipped) run.
  const ranCount = summary.length;
  const plannedCount = BRANCHES.length * STRATEGIES.length * PROVIDERS.length;
  const skipped = plannedCount - ranCount;
  const runDescriptor = skipped > 0
    ? `${ranCount} of ${plannedCount} runs (${skipped} skipped)`
    : `${ranCount} run${ranCount === 1 ? '' : 's'}`;
  console.log(`\nAll ${runDescriptor} complete in ${fmtElapsed(Date.now() - startedAt)}.`);
  console.log(`Summary written to ${path.join(outDir, '__summary.json')}.`);
  console.log(`Aggregate with: node backend/scripts/performance-m0-aggregate.mjs ${outDir}`);
}

main().catch((err) => {
  console.error('\nDriver failed:', err.stack || err.message);
  process.exit(1);
});
