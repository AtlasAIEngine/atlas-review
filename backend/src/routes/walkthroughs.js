/**
 * Walkthrough Routes
 *
 * Phase 11 — walkthrough generation is decoupled from review. These
 * endpoints sit alongside `branchReviews` and `prReviews` and operate on a
 * standalone (projectId, baseSha, headSha) cache key.
 *
 *   GET  /api/projects/:projectId/walkthroughs?baseSha=&headSha=
 *   POST /api/projects/:projectId/walkthroughs   { baseSha, headSha }
 */

import express from 'express';
import { getProjectById } from '../db/queries.js';
import walkthroughService from '../services/walkthroughService.js';
import gitService from '../services/gitService.js';
import prReviewService from '../services/prReviewService.js';
import providerService from '../services/providerService.js';
import reviewSyncService from '../services/reviewSyncService.js';
import { generateWalkthrough } from '../services/review/walkthroughGeneration.js';
import { callProviderForReviewWithFailover } from '../services/review/reviewProviderExecution.js';
import { enforceQuotas } from '../middleware/quotas.js';

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
// Diff char budget for map-reduce walkthroughs. The previous 60 KB default
// (DEFAULT_WALKTHROUGH_DIFF_MAX_CHARS in gitService) was tuned for the
// single-pass path; it silently truncated the upstream diff to ~80-120
// files for huge branches, leaving downstream clustering with empty file
// bodies. Map-reduce already does its own per-cluster budgeting via
// CLUSTER_PROMPT_MAX_DIFF_CHARS, so we want the full diff here. Use the
// route-level cap (1 MB, the parseBoundedInteger upper bound) and let the
// generation pipeline decide what to send to each LLM call.
const WALKTHROUGH_DIFF_MAX_CHARS = Math.max(
  60_000,
  Math.min(1_000_000, Number.parseInt(process.env.ATLAS_WALKTHROUGH_DIFF_MAX_CHARS, 10) || 1_000_000),
);
const WALKTHROUGH_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Math.min(55_000, Number.parseInt(process.env.ATLAS_WALKTHROUGH_HEARTBEAT_INTERVAL_MS, 10) || 25_000),
);

function buildRouteWalkthroughRunMetadata({
  providerType = null,
  modelId = null,
  mode = 'single-pass',
  incremental = false,
  noChanges = false,
  empty = false,
  durationMs = 0,
  fileCount = 0,
} = {}) {
  return {
    schemaVersion: 1,
    strategy: 'walkthrough cheap tier',
    budget: 'cheap',
    mode,
    incremental: Boolean(incremental),
    noChanges: Boolean(noChanges),
    empty: Boolean(empty),
    providerType: providerType || null,
    modelId: modelId || null,
    durationMs: Math.max(0, Math.trunc(Number(durationMs) || 0)),
    fileCount: Math.max(0, Math.trunc(Number(fileCount) || 0)),
    llmFileCount: 0,
    deterministicFileCount: 0,
    providerCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    providerNativeCost: null,
    costSource: 'pricing_table',
    costIsApproximate: false,
    clusterCount: 0,
    clusterFailures: 0,
    clusterEscalations: 0,
    clusterCacheHits: 0,
    cached: false,
    escalated: false,
    deterministicFallback: false,
  };
}

function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

function queueWalkthroughGenerated({ project, baseSha, headSha, persisted, reviewType, reviewId, providerType, incremental, noChanges }) {
  void (async () => {
    try {
      let repoRemoteUrl = null;
      try { repoRemoteUrl = await gitService.getRemoteUrl(project.path); } catch { /* no git remote */ }
      const groups = Array.isArray(persisted?.changeGroups) ? persisted.changeGroups : [];
      const fileCount = groups.reduce((acc, g) => acc + (Array.isArray(g?.files) ? g.files.length : 0), 0);
      await reviewSyncService.queueEvent(
        reviewSyncService.buildWalkthroughGeneratedEvent({
          userId: project.user_id,
          projectId: project.id,
          projectName: project.name || null,
          projectPath: project.path || null,
          baseSha,
          headSha,
          reviewType: reviewType || null,
          reviewId: reviewId || null,
          providerType: providerType || persisted?.providerType || null,
          providerModel: persisted?.modelId || null,
          stepCount: groups.length,
          fileCount,
          incremental: Boolean(incremental),
          noChanges: Boolean(noChanges),
          repoRemoteUrl,
        })
      );
    } catch (syncError) {
      console.error('[WalkthroughAnalytics] Failed to queue walkthrough_generated:', syncError.message);
    }
  })();
}

function normalizeShaParam(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  // Allow git SHAs (40-char hex), shortened SHAs, or 'HEAD' / branch names.
  // The walkthrough cache key is opaque — we don't enforce hex-only — but we
  // do reject empty / clearly invalid values.
  return trimmed;
}

function normalizeKeyParam(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createWalkthroughHeartbeatResponse(res) {
  const canStream = typeof res.setHeader === 'function'
    && typeof res.write === 'function'
    && typeof res.end === 'function';
  let streaming = false;
  let heartbeatTimer = null;

  const stop = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const writeHeartbeat = () => {
    if (!streaming || res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    try {
      res.write(' ');
    } catch {
      stop();
    }
  };

  const start = () => {
    if (streaming || !canStream || res.headersSent || res.writableEnded || res.destroyed) {
      return;
    }
    streaming = true;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    writeHeartbeat();
    heartbeatTimer = setInterval(writeHeartbeat, WALKTHROUGH_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
    if (typeof res.once === 'function') {
      res.once('close', stop);
      res.once('finish', stop);
    }
  };

  const json = (payload) => {
    stop();
    if (!streaming) {
      return res.json(payload);
    }
    if (!res.writableEnded && !res.destroyed) {
      res.write(JSON.stringify(payload));
      res.end();
    }
    return res;
  };

  return {
    start,
    json,
    get streaming() {
      return streaming;
    },
  };
}

/**
 * GET /api/projects/:projectId/walkthroughs?baseSha=&headSha=
 *
 * Cache lookup. Returns 404 when no walkthrough has been generated for the
 * given (projectId, baseSha, headSha) tuple.
 */
router.get('/:projectId/walkthroughs', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const baseSha = normalizeShaParam(req.query.baseSha);
    const headSha = normalizeShaParam(req.query.headSha);
    if (!baseSha || !headSha) {
      return res.status(400).json({ error: 'baseSha and headSha query params are required' });
    }

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const walkthrough = await walkthroughService.getWalkthrough({ projectId, baseSha, headSha });
    if (!walkthrough) {
      if (String(req.query.includeStale || '').trim() === '1') {
        const staleWalkthrough = await walkthroughService.getLatestWalkthroughForBase({
          projectId,
          baseSha,
          excludeHeadSha: headSha,
        });
        if (staleWalkthrough && Array.isArray(staleWalkthrough.changeGroups) && staleWalkthrough.changeGroups.length > 0) {
          return res.json({
            success: true,
            walkthrough: staleWalkthrough,
            stale: true,
            currentBaseSha: baseSha,
            currentHeadSha: headSha,
          });
        }
      }
      return res.status(404).json({ error: 'No walkthrough generated for this diff' });
    }

    return res.json({ success: true, walkthrough, stale: false });
  } catch (error) {
    console.error('Error reading walkthrough:', error);
    return res.status(500).json({ error: 'Failed to read walkthrough' });
  }
});

/**
 * POST /api/projects/:projectId/walkthroughs
 * Body: { baseSha, headSha }
 *
 * Generates a walkthrough using the provider's cheap-tier model for cluster
 * narration. The previous `use_cheap_model_for_walkthrough` user setting was
 * removed; cluster work always runs cheap (synthesis is forced cheap inside
 * walkthroughGeneration via SYNTHESIS_USE_CHEAP_MODEL).
 * Persists to the walkthroughs table and returns the resulting changeGroups.
 */
router.post('/:projectId/walkthroughs', enforceQuotas, async (req, res) => {
  const heartbeatResponse = createWalkthroughHeartbeatResponse(res);
  const requestStartedAt = Date.now();
  try {
    const { projectId } = req.params;
    const baseSha = normalizeShaParam(req.body?.baseSha);
    const headSha = normalizeShaParam(req.body?.headSha);
    if (!baseSha || !headSha) {
      return res.status(400).json({ error: 'baseSha and headSha are required' });
    }

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });
    if (!project.path) {
      return res.status(400).json({ error: 'Project has no on-disk path; cannot diff' });
    }

    // Cache hit short-circuits regeneration. Caller may pass `?force=1` to
    // bypass and force a full regeneration, or `bypassCache=true` to re-run
    // the same incremental update without disabling incremental mode.
    const force = String(req.query.force || req.body?.force || '').trim() === '1'
      || req.body?.force === true;
    const bypassCache = String(req.query.bypassCache || req.body?.bypassCache || '').trim() === '1'
      || req.body?.bypassCache === true;
    if (!force && !bypassCache) {
      const cached = await walkthroughService.getWalkthrough({ projectId, baseSha, headSha });
      if (cached) {
        return res.json({ success: true, walkthrough: cached, cached: true });
      }
    }

    const reviewType = normalizeKeyParam(req.body?.reviewType);
    const reviewId = normalizeKeyParam(req.body?.reviewId || req.body?.prReviewId);
    const diffOptions = { rangeMode: 'two-dot', maxChars: WALKTHROUGH_DIFF_MAX_CHARS };
    if (reviewType === 'pr_review') {
      if (reviewId) {
        const prReview = await prReviewService.getById(reviewId);
        if (!prReview || prReview.projectId !== projectId) {
          return res.status(404).json({ error: 'PR review not found' });
        }
        if (normalizeShaParam(prReview.baseSha || '') !== baseSha || normalizeShaParam(prReview.headSha || '') !== headSha) {
          return res.status(400).json({ error: 'PR review SHAs do not match requested walkthrough diff' });
        }
      }
      diffOptions.rangeMode = 'three-dot';
    }

    // Incremental mode: when not forced, look up the most recent walkthrough
    // for the same base. If found, narrate only commits since its head and
    // save the new artifact as that delta only. Skips the expensive synthesis
    // re-pass on large branches where only a few new files changed.
    //
    // Two conditions disable incremental:
    //   1. force=true (explicit "full walkthrough" request)
    //   2. no previous walkthrough exists for this base
    //
    // PR review IS supported: the prior walkthrough was generated from the
    // three-dot merge-base diff, but the new commits sit linearly on top of
    // the previous head, so a two-dot `previousHead..newHead` delta is
    // exactly the right input for the update. We override rangeMode below.
    let previousWalkthrough = null;
    if (!force) {
      previousWalkthrough = await walkthroughService.getLatestWalkthroughForBase({
        projectId,
        baseSha,
        excludeHeadSha: headSha,
      });
    }
    const useIncremental = Boolean(previousWalkthrough);
    const diffFromRef = useIncremental ? previousWalkthrough.headSha : baseSha;
    if (useIncremental) {
      // For the delta we always want two-dot semantics regardless of
      // reviewType — the new commits are linear from previousHead to newHead
      // and three-dot would silently re-include unrelated base movement.
      diffOptions.rangeMode = 'two-dot';
    }

    // Resolve diff between the supplied SHAs (or previousHead..head for
    // incremental). If the SHAs aren't reachable, gitService throws — we
    // surface that as 400.
    let diff = '';
    let fileSummaries = null;
    try {
      const diffPayload = await gitService.getDiffForWalkthrough(project.path, diffFromRef, headSha, diffOptions);
      if (diffPayload && typeof diffPayload === 'object') {
        diff = typeof diffPayload.diff === 'string' ? diffPayload.diff : '';
        fileSummaries = Array.isArray(diffPayload.fileSummaries) ? diffPayload.fileSummaries : null;
      } else {
        diff = typeof diffPayload === 'string' ? diffPayload : '';
      }
    } catch (err) {
      return res.status(400).json({
        error: `Failed to compute diff between ${diffFromRef}..${headSha}: ${err.message}`,
      });
    }

    // Incremental + empty delta: nothing changed since the previous
    // walkthrough's head. Persist a copy at the new headSha so subsequent
    // lookups are direct cache hits, then return noChanges so the UI can
    // offer a full regeneration.
    if (useIncremental && (!diff || !String(diff).trim()) && (!Array.isArray(fileSummaries) || fileSummaries.length === 0)) {
      const carried = await walkthroughService.saveWalkthrough({
        projectId,
        baseSha,
        headSha,
        changeGroups: previousWalkthrough.changeGroups || [],
        modelId: previousWalkthrough.modelId || null,
        providerType: previousWalkthrough.providerType || null,
        runMetadata: buildRouteWalkthroughRunMetadata({
          providerType: previousWalkthrough.providerType,
          modelId: previousWalkthrough.modelId,
          mode: 'incremental-no-changes',
          incremental: true,
          noChanges: true,
          durationMs: Date.now() - requestStartedAt,
          fileCount: 0,
        }),
      });
      queueWalkthroughGenerated({
        project, baseSha, headSha,
        persisted: carried,
        reviewType, reviewId,
        providerType: previousWalkthrough.providerType,
        incremental: true, noChanges: true,
      });
      return res.json({
        success: true,
        walkthrough: carried,
        noChanges: true,
        previousHeadSha: previousWalkthrough.headSha,
      });
    }
    if ((!diff || !String(diff).trim()) && (!Array.isArray(fileSummaries) || fileSummaries.length === 0)) {
      // Empty diff is still a valid walkthrough (empty changeGroups). Persist
      // an empty record so subsequent reads are cache hits.
      const persisted = await walkthroughService.saveWalkthrough({
        projectId,
        baseSha,
        headSha,
        changeGroups: [],
        modelId: null,
        providerType: null,
        runMetadata: buildRouteWalkthroughRunMetadata({
          mode: 'empty-diff',
          empty: true,
          durationMs: Date.now() - requestStartedAt,
          fileCount: 0,
        }),
      });
      queueWalkthroughGenerated({
        project, baseSha, headSha,
        persisted,
        reviewType, reviewId,
        providerType: null,
        incremental: false, noChanges: false,
      });
      return res.json({ success: true, walkthrough: persisted, empty: true });
    }

    // Resolve active provider for review-tier work. Reuses the same failover
    // chain the review pipeline does — that way OpenCode/Codex/Claude users
    // all hit a single code path.
    const providerCandidates = typeof providerService.getReviewProviderCandidatesWithKeys === 'function'
      ? await providerService.getReviewProviderCandidatesWithKeys({ maxCandidates: 3 })
      : [];
    const activeProvider = providerCandidates[0]
      || await providerService.getActiveProviderWithKey();
    if (!activeProvider) {
      return res.status(400).json({
        error: 'No active AI provider configured. Add a provider in Settings → AI Provider.',
      });
    }
    const providerType = activeProvider.provider?.type;

    // Tauri/WKWebView can close an otherwise healthy XHR after ~60s with no
    // response bytes. Start a JSON-compatible whitespace heartbeat before the
    // long LLM generation section so large walkthroughs stay connected.
    heartbeatResponse.start();

    // No top-level deadline. The previous 90s budget was tuned for the
    // single-shot narration path and is too tight for the map-reduce path
    // (which fans out to many LLM calls + a synthesis pass). When the
    // deadline fired mid-flight it aborted in-flight provider calls and
    // dropped the walkthrough back to the deterministic area-based grouper,
    // wasting tokens and degrading quality on exactly the large branches
    // that benefit most from LLM narration. Per-call timeouts in
    // reviewConstants (PROVIDER_REQUEST_TIMEOUT_API_MS = 180s, CLI variants
    // 300-420s) still protect against hung individual calls.

    // Wrap the failover executor so the walkthrough generator stays
    // provider-agnostic. The executor handles retries, timeouts, and
    // CLI/api fallbacks; we just hand it the prompt + resolved model.
    const providerCall = async ({ prompt, model }) => {
      const failoverState = providerCandidates.length > 0
        ? { candidates: providerCandidates, currentIndex: 0 }
        : { candidates: [activeProvider], currentIndex: 0 };
      const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
      const result = await callProviderForReviewWithFailover(failoverState, prompt, {
        modelPhase: 'walkthrough',
        reviewModelConfig: requestedModel
          ? {
            strategy: 'custom',
            customModels: { walkthrough: requestedModel },
          }
          : undefined,
        modelDecisionContext: {
          reviewSurface: 'walkthrough',
          projectPath: project.path,
        },
      });
      // Normalize: callProviderForReviewWithFailover returns { content, ... }
      // or similar — accept either `text` or `content`.
      const text = typeof result?.text === 'string'
        ? result.text
        : typeof result?.content === 'string'
          ? result.content
          : '';
      return { ...result, text };
    };

    const deltaChangeGroups = await generateWalkthrough({
      projectId,
      baseSha,
      headSha,
      diff,
      fileSummaries,
      providerType,
      // useCheapModel is no longer user-configurable; cluster narration
      // always runs on the cheap tier (synthesis is forced cheap inside
      // walkthroughGeneration).
      useCheapModel: true,
      // Explicit full regeneration should re-ask the model. The per-file
      // cache may still be refreshed after generation, but it must not
      // short-circuit a user-requested full walkthrough.
      bypassFileCache: force,
      incremental: useIncremental,
      title: project.name || '',
      providerCall,
    });

    // Incremental mode generates previousHead..head only. Keep the saved
    // artifact delta-only; the client handles read-state migration across
    // artifacts without reintroducing old steps into the updated walkthrough.

    const persisted = await walkthroughService.getWalkthrough({ projectId, baseSha, headSha });
    queueWalkthroughGenerated({
      project, baseSha, headSha,
      persisted: persisted || { changeGroups: deltaChangeGroups, providerType, modelId: null },
      reviewType, reviewId,
      providerType,
      incremental: useIncremental, noChanges: false,
    });
    return heartbeatResponse.json({
      success: true,
      walkthrough: persisted || {
        projectId,
        baseSha,
        headSha,
        changeGroups: deltaChangeGroups,
        modelId: null,
        providerType: providerType || null,
      },
      ...(useIncremental ? { incremental: true, previousHeadSha: previousWalkthrough.headSha } : {}),
    });
  } catch (error) {
    console.error('Error generating walkthrough:', error);
    if (heartbeatResponse.streaming) {
      return heartbeatResponse.json({
        success: false,
        error: error.message || 'Failed to generate walkthrough',
      });
    }
    return res.status(500).json({ error: error.message || 'Failed to generate walkthrough' });
  }
});

/**
 * POST /api/projects/:projectId/walkthroughs/step-read
 * Body: { baseSha, headSha, stepIndex }
 *
 * Lightweight beacon — fires when the user marks a walkthrough step as read.
 * Records a single (project, base, head, stepIndex) event for engagement
 * analytics. Idempotent: re-toggling the same step doesn't inflate counts.
 */
router.post('/:projectId/walkthroughs/step-read', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const baseSha = String(req.body?.baseSha || '').trim();
    const headSha = String(req.body?.headSha || '').trim();
    const stepIndex = Number.parseInt(req.body?.stepIndex, 10);
    if (!baseSha || !headSha || !Number.isFinite(stepIndex) || stepIndex < 0) {
      return res.status(400).json({ error: 'baseSha, headSha, and a non-negative stepIndex are required' });
    }
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    let repoRemoteUrl = null;
    try { repoRemoteUrl = await gitService.getRemoteUrl(project.path); } catch { /* no git remote */ }
    await reviewSyncService.queueEvent(
      reviewSyncService.buildWalkthroughStepReadEvent({
        userId: project.user_id,
        projectId: project.id,
        projectName: project.name || null,
        projectPath: project.path || null,
        baseSha,
        headSha,
        stepIndex,
        repoRemoteUrl,
      })
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Error recording walkthrough step read:', error);
    return res.status(500).json({ error: error.message || 'Failed to record step read' });
  }
});

export default router;
