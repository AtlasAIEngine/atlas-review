/**
 * Linter Review Integration
 * Helper functions for integrating the linter pre-pass into the review pipeline.
 * Used by reviewService.js to keep the main orchestrator clean.
 */

import { runLinterPrePass } from './linterRunner.js';
import { mergeDeterministicFindingsIntoReview } from './linterMerge.js';
import {
  getReviewLinterEnabled,
  getReviewLinterDeadlineMs,
  getReviewLinterCorroborationLineWindow,
} from './linterConstants.js';
import { reviewPathsMatch } from './linterFindingSimilarity.js';
import { runUnitySemanticVerifier } from '../unitySemanticVerifier.js';

function mergeCountMaps(countMaps = []) {
  const merged = {};
  for (const value of countMaps) {
    const source = value && typeof value === 'object' ? value : {};
    for (const [key, rawCount] of Object.entries(source)) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) continue;
      merged[normalizedKey] = (merged[normalizedKey] || 0) + Math.max(0, Math.trunc(Number(rawCount) || 0));
    }
  }
  return merged;
}

function combinePrePassResults(results = []) {
  const normalizedResults = (Array.isArray(results) ? results : []).filter(Boolean);
  if (normalizedResults.length === 0) return emptyPrePassResult('no_results');

  const findings = normalizedResults.flatMap((result) => Array.isArray(result.findings) ? result.findings : []);
  const anchoredFindings = normalizedResults.flatMap((result) => Array.isArray(result.anchoredFindings) ? result.anchoredFindings : []);
  const promptFindings = normalizedResults.flatMap((result) => Array.isArray(result.promptFindings) ? result.promptFindings : []);
  const statsList = normalizedResults.map((result) => result.stats && typeof result.stats === 'object' ? result.stats : {});
  const enabled = statsList.some((stats) => stats.enabled === true);
  const skippedReasons = statsList.map((stats) => String(stats.skippedReason || '').trim()).filter(Boolean);

  return {
    findings,
    anchoredFindings,
    promptFindings,
    stats: {
      enabled,
      skippedReason: enabled ? null : (skippedReasons[0] || null),
      toolsAttempted: [...new Set(statsList.flatMap((stats) => Array.isArray(stats.toolsAttempted) ? stats.toolsAttempted : []))],
      toolsSucceeded: [...new Set(statsList.flatMap((stats) => Array.isArray(stats.toolsSucceeded) ? stats.toolsSucceeded : []))],
      toolsSkipped: [...new Set(statsList.flatMap((stats) => Array.isArray(stats.toolsSkipped) ? stats.toolsSkipped : []))],
      toolsFailed: [...new Set(statsList.flatMap((stats) => Array.isArray(stats.toolsFailed) ? stats.toolsFailed : []))],
      totalFindings: findings.length,
      anchoredFindings: anchoredFindings.length,
      unanchoredFindings: Math.max(0, findings.length - anchoredFindings.length),
      findingsBySeverity: mergeCountMaps(statsList.map((stats) => stats.findingsBySeverity)),
      findingsBySource: mergeCountMaps(statsList.map((stats) => stats.findingsBySource)),
      findingsByRule: mergeCountMaps(statsList.map((stats) => stats.findingsByRule)),
      durationMs: statsList.reduce((sum, stats) => sum + Math.max(0, Math.trunc(Number(stats.durationMs) || 0)), 0),
    },
  };
}

/**
 * Run the linter pre-pass for a review. Safe to call from any review flow.
 * Returns a result object that is always safe to destructure, even when disabled.
 *
 * @param {string} projectPath - Project root
 * @param {Array<{path: string}>} reviewFiles - Files under review (with .path property)
 * @param {string} diffText - Unified diff text
 * @param {object} [options]
 * @param {object} [options.reviewPolicy] - Review policy (may contain .linters)
 * @param {object} [options.reviewProfile] - Resolved review profile for the current review scope
 * @param {AbortSignal} [options.externalSignal] - External cancellation
 * @returns {Promise<LinterPrePassResult>}
 */
export async function runReviewLinterPrePass(projectPath, reviewFiles, diffText, options = {}) {
  const filePaths = Array.isArray(reviewFiles)
    ? reviewFiles.map((f) => typeof f === 'string' ? f : (f?.path || '')).filter(Boolean)
    : [];

  if (filePaths.length === 0) {
    return emptyPrePassResult('no_files');
  }

  const linterPolicy = options.reviewPolicy?.linters || null;
  const linterEnabled = getReviewLinterEnabled();

  const [linterResult, unitySemanticResult] = await Promise.all([
    (async () => {
      if (!linterEnabled) return emptyPrePassResult('feature_disabled');
      try {
        const result = await runLinterPrePass(projectPath, filePaths, diffText, {
          linterPolicy,
          reviewProfile: options.reviewProfile || null,
          deadlineMs: getReviewLinterDeadlineMs(),
          externalSignal: options.externalSignal || null,
        });
        return {
          findings: result.findings || [],
          anchoredFindings: result.anchoredFindings || [],
          promptFindings: result.promptFindings || [],
          stats: result.stats || emptyPrePassResult().stats,
        };
      } catch (err) {
        return emptyPrePassResult(`error: ${err?.message || 'unknown'}`);
      }
    })(),
    runUnitySemanticVerifier(projectPath, Array.isArray(reviewFiles) ? reviewFiles : [], diffText, {
      reviewProfile: options.reviewProfile || null,
      unitySemanticVerifier: options.unitySemanticVerifier || null,
    }).catch((err) => emptyPrePassResult(`unity_semantic_error: ${err?.message || 'unknown'}`)),
  ]);

  return combinePrePassResults([linterResult, unitySemanticResult]);
}

/**
 * Apply linter findings to the corroboration evaluator options.
 * Returns the linterFindings array to pass to createCorroborationSourceEvaluator.
 */
export function getLinterCorroborationFindings(prePassResult) {
  return Array.isArray(prePassResult?.anchoredFindings) ? prePassResult.anchoredFindings : [];
}

/**
 * Merge standalone deterministic findings into the review result.
 */
export function mergePrePassFindingsIntoReview(reviewResult, prePassResult) {
  const anchoredFindings = Array.isArray(prePassResult?.anchoredFindings) ? prePassResult.anchoredFindings : [];
  if (anchoredFindings.length === 0) return reviewResult;
  return mergeDeterministicFindingsIntoReview(reviewResult, anchoredFindings, {
    lineWindow: getReviewLinterCorroborationLineWindow(),
  });
}

/**
 * Get prompt-ready linter findings for metadata injection.
 */
export function getPromptLinterFindings(prePassResult) {
  return Array.isArray(prePassResult?.promptFindings) ? prePassResult.promptFindings : [];
}

export function filterPromptLinterFindingsForFileHints(promptFindings, fileHints) {
  if (!Array.isArray(promptFindings) || promptFindings.length === 0) return [];
  if (!Array.isArray(fileHints) || fileHints.length === 0) return promptFindings;

  const scopedPaths = fileHints.flatMap((hint) => ([
    hint?.path || null,
    hint?.oldPath || null,
    ...(Array.isArray(hint?.memberPaths) ? hint.memberPaths : []),
  ])).filter(Boolean);

  if (scopedPaths.length === 0) return promptFindings;

  return promptFindings.filter((finding) => scopedPaths.some((candidatePath) => (
    reviewPathsMatch(finding?.file, candidatePath)
  )));
}

function emptyPrePassResult(reason) {
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
      unanchoredFindings: 0,
      findingsBySeverity: {},
      findingsBySource: {},
      findingsByRule: {},
      durationMs: 0,
    },
  };
}
