/**
 * Linter Runner — Core orchestrator for the deterministic linter pre-pass.
 * Runs enabled adapters in parallel under a shared deadline,
 * normalizes findings, and filters by diff-line anchoring.
 */

import {
  getReviewLinterEnabled,
  getReviewLinterDeadlineMs,
  getReviewLinterMaxFiles,
  getReviewLinterMaxTotalFindings,
  compareSeverity,
} from './linterConstants.js';
import { buildChangedLineIndex, filterAnchoredFindings, resolveCanonicalDiffPath } from './linterDiffAnchors.js';
import * as eslintAdapter from './eslintAdapter.js';
import * as tscAdapter from './tscAdapter.js';
import * as dotnetAdapter from './dotnetAdapter.js';
import * as dotnetFormatAdapter from './dotnetFormatAdapter.js';
import * as semgrepAdapter from './semgrepAdapter.js';

// ── Adapter registry ─────────────────────────────────────────────────────────

const ALL_ADAPTERS = [eslintAdapter, tscAdapter, dotnetAdapter, dotnetFormatAdapter, semgrepAdapter];

// ── Policy resolution ────────────────────────────────────────────────────────

function isAdapterEnabledByPolicy(adapterId, linterPolicy) {
  if (!linterPolicy) return true;
  if (linterPolicy.enabled === false) return false;
  const adapterPolicy = linterPolicy[adapterId];
  if (adapterPolicy && adapterPolicy.enabled === false) return false;
  return true;
}

function resolveLinterMode(linterPolicy) {
  return linterPolicy?.mode === 'fallback_if_missing' ? 'fallback_if_missing' : 'project_only';
}

function allowAtlasManagedFallbackForAdapter(adapterId, linterPolicy) {
  if (resolveLinterMode(linterPolicy) !== 'fallback_if_missing') {
    return false;
  }
  const adapterPolicy = linterPolicy?.[adapterId];
  if (adapterPolicy && Object.prototype.hasOwnProperty.call(adapterPolicy, 'allowAtlasManagedFallback')) {
    return adapterPolicy.allowAtlasManagedFallback !== false;
  }
  return adapterId === semgrepAdapter.id;
}

// ── Empty result ─────────────────────────────────────────────────────────────

function emptyResult(reason) {
  return {
    findings: [],
    anchoredFindings: [],
    promptFindings: [],
    stats: {
      enabled: false,
      skippedReason: reason || null,
      toolsAttempted: [],
      toolsSucceeded: [],
      toolsSkipped: [],
      toolsFailed: [],
      totalFindings: 0,
      anchoredFindings: 0,
      findingsBySeverity: {},
      findingsBySource: {},
      durationMs: 0,
    },
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the deterministic linter pre-pass.
 *
 * @param {string} projectPath - Absolute path to the project root
 * @param {string[]} reviewFiles - Relative paths of changed files
 * @param {string} diffText - Unified diff text for anchoring
 * @param {object} [options]
 * @param {object} [options.linterPolicy] - Policy from .atlas/review-policy.json
 * @param {object} [options.reviewProfile] - Resolved review profile for the current review scope
 * @param {number} [options.deadlineMs] - Override for deadline
 * @param {AbortSignal} [options.externalSignal] - External cancellation signal
 * @returns {Promise<LinterRunResult>}
 */
export async function runLinterPrePass(projectPath, reviewFiles, diffText, options = {}) {
  const startMs = Date.now();

  if (!getReviewLinterEnabled()) {
    return emptyResult('feature_disabled');
  }

  if (!projectPath || !Array.isArray(reviewFiles) || reviewFiles.length === 0) {
    return emptyResult('no_files');
  }

  const linterPolicy = options.linterPolicy || null;
  const reviewProfile = options.reviewProfile || null;
  if (linterPolicy && linterPolicy.enabled === false) {
    return emptyResult('policy_disabled');
  }

  const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
    ? options.deadlineMs
    : getReviewLinterDeadlineMs();

  // Limit file count
  const targetFiles = reviewFiles.slice(0, getReviewLinterMaxFiles());

  // Build diff anchor index
  const diffIndex = buildChangedLineIndex(diffText);

  // Resolve which adapters to run
  const adaptersToRun = [];
  const toolsSkipped = [];

  for (const adapter of ALL_ADAPTERS) {
    if (!isAdapterEnabledByPolicy(adapter.id, linterPolicy)) {
      toolsSkipped.push({ id: adapter.id, reason: 'policy_disabled' });
      continue;
    }
    try {
      const allowAtlasManagedFallback = allowAtlasManagedFallbackForAdapter(adapter.id, linterPolicy);
      if (adapter.detect(projectPath, targetFiles, { allowAtlasManagedFallback, reviewProfile })) {
        adaptersToRun.push({ adapter, allowAtlasManagedFallback });
      } else {
        toolsSkipped.push({ id: adapter.id, reason: 'not_detected' });
      }
    } catch {
      toolsSkipped.push({ id: adapter.id, reason: 'detect_error' });
    }
  }

  if (adaptersToRun.length === 0) {
    return {
      ...emptyResult('no_applicable_tools'),
      stats: {
        ...emptyResult('no_applicable_tools').stats,
        enabled: true,
        toolsSkipped: toolsSkipped.map((s) => s.id),
        durationMs: Date.now() - startMs,
      },
    };
  }

  // Run adapters in parallel under shared deadline
  const controller = new AbortController();
  const combinedSignal = options.externalSignal
    ? combineSignals(controller.signal, options.externalSignal)
    : controller.signal;

  const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);

  const adapterResults = await Promise.allSettled(
    adaptersToRun.map(async ({ adapter, allowAtlasManagedFallback }) => {
      try {
        const findings = await adapter.run(projectPath, targetFiles, {
          signal: combinedSignal,
          allowAtlasManagedFallback,
          reviewProfile,
        });
        return { id: adapter.id, findings: Array.isArray(findings) ? findings : [], error: null };
      } catch (err) {
        return { id: adapter.id, findings: [], error: err };
      }
    })
  );

  clearTimeout(deadlineTimer);

  // Collect results
  const toolsAttempted = adaptersToRun.map(({ adapter }) => adapter.id);
  const toolsSucceeded = [];
  const toolsFailed = [];
  let allFindings = [];

  for (let i = 0; i < adapterResults.length; i++) {
    const result = adapterResults[i];
    const value = result.status === 'fulfilled'
      ? result.value
      : { id: adaptersToRun[i]?.adapter?.id || 'unknown', findings: [], error: result.reason };
    if (value.error) {
      toolsFailed.push(value.id);
    } else {
      toolsSucceeded.push(value.id);
    }
    allFindings.push(...value.findings);
  }

  // Canonicalize file paths against diff index
  for (const finding of allFindings) {
    finding.file = resolveCanonicalDiffPath(finding.file, diffIndex) || finding.file;
  }

  // Sort by severity (highest first), then by file/line
  allFindings.sort((a, b) => {
    const sevCmp = compareSeverity(a.severity, b.severity);
    if (sevCmp !== 0) return sevCmp;
    const fileCmp = String(a.file || '').localeCompare(String(b.file || ''));
    if (fileCmp !== 0) return fileCmp;
    return (a.line || 0) - (b.line || 0);
  });

  // Cap total findings
  const maxTotalFindings = getReviewLinterMaxTotalFindings();
  if (allFindings.length > maxTotalFindings) {
    allFindings = allFindings.slice(0, maxTotalFindings);
  }

  // Separate anchored vs unanchored
  const { anchored, unanchored } = filterAnchoredFindings(allFindings, diffIndex);

  // Build stats
  const findingsBySeverity = {};
  const findingsBySource = {};
  for (const f of allFindings) {
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
    findingsBySource[f.source] = (findingsBySource[f.source] || 0) + 1;
  }

  return {
    findings: allFindings,
    anchoredFindings: anchored,
    promptFindings: allFindings, // All findings go into prompt context (anchored or not, as hints)
    stats: {
      enabled: true,
      skippedReason: null,
      toolsAttempted,
      toolsSucceeded,
      toolsSkipped: toolsSkipped.map((s) => s.id),
      toolsFailed,
      totalFindings: allFindings.length,
      anchoredFindings: anchored.length,
      unanchoredFindings: unanchored.length,
      findingsBySeverity,
      findingsBySource,
      durationMs: Date.now() - startMs,
    },
  };
}

// ── Signal combination helper ────────────────────────────────────────────────

function combineSignals(signal1, signal2) {
  if (!signal2) return signal1;
  const controller = new AbortController();
  if (signal1.aborted || signal2.aborted) {
    controller.abort();
    return controller.signal;
  }
  const onAbort = () => controller.abort();
  signal1.addEventListener('abort', onAbort, { once: true });
  signal2.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
