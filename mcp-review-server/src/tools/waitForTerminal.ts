import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { ToolExecutionResult, WaitForTerminalToolData } from '../types.js';
import { runLatestTool } from './latest.js';
import { loadStatusSnapshot, type StatusSnapshot } from './statusShared.js';
import type { ToolContextInput } from './projectContext.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_HOST_TOOL_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 10;
const SAFE_WAIT_WINDOW_RATIO = 0.75;
const MIN_SAFE_WAIT_WINDOW_MS = 250;

export interface WaitForTerminalToolArgs extends ToolContextInput {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function runWaitForTerminalTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: WaitForTerminalToolArgs
): Promise<ToolExecutionResult<WaitForTerminalToolData>> {
  const timeoutMs = clampInteger(args.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const pollIntervalMs = clampInteger(args.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, timeoutMs);
  const hostToolTimeoutMs = clampInteger(
    config.toolCallTimeoutMs,
    DEFAULT_HOST_TOOL_TIMEOUT_MS,
    MIN_SAFE_WAIT_WINDOW_MS,
    MAX_TIMEOUT_MS
  );
  const effectiveWaitWindowMs = Math.min(
    timeoutMs,
    Math.max(MIN_SAFE_WAIT_WINDOW_MS, Math.floor(hostToolTimeoutMs * SAFE_WAIT_WINDOW_RATIO))
  );
  const deadline = Date.now() + effectiveWaitWindowMs;
  const hostWindowLimited = effectiveWaitWindowMs < timeoutMs;

  let snapshot = await loadStatusSnapshot(client, config, cwd, args);

  while (snapshot.data.activeExecution?.isActive && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    snapshot = await loadStatusSnapshot(client, config, cwd, args).catch(() => snapshot);
  }

  const terminal = Boolean(snapshot.data.activeExecution?.isTerminal);
  const timedOut = Boolean(snapshot.data.activeExecution?.isActive) && Date.now() >= deadline;
  const continuationRecommended = Boolean(snapshot.data.activeExecution?.isActive);
  const latest = terminal && snapshot.data.review
    ? await runLatestTool(client, config, cwd, args).then((result) => result.data).catch(() => null)
    : null;

  const data: WaitForTerminalToolData = {
    project: snapshot.data.project,
    review: snapshot.data.review,
    branchReview: snapshot.data.branchReview,
    prReview: snapshot.data.prReview,
    status: snapshot.data,
    terminal,
    timedOut,
    continuationRecommended,
    hostWindowLimited,
    latest,
    timeoutMs,
    pollIntervalMs,
    hostToolTimeoutMs,
    effectiveWaitWindowMs,
  };

  return {
    summary: buildSummary(snapshot, terminal, timedOut, timeoutMs, effectiveWaitWindowMs, hostWindowLimited),
    data,
    nextActions: buildNextActions(terminal, timedOut, continuationRecommended, snapshot.data.activeExecution?.isStale === true),
  };
}

function buildSummary(
  snapshot: StatusSnapshot,
  terminal: boolean,
  timedOut: boolean,
  timeoutMs: number,
  effectiveWaitWindowMs: number,
  hostWindowLimited: boolean
): string {
  const label = snapshot.data.review?.label || 'review';
  if (terminal) {
    return `Review ${label} reached terminal state (${snapshot.data.lifecycleStatus}).`;
  }
  if (timedOut) {
    if (hostWindowLimited) {
      return `Reached the local wait window (${effectiveWaitWindowMs}ms) for ${label}; review is still active (${snapshot.data.lifecycleStatus}). Call wait_for_terminal again to continue waiting.`;
    }
    const freshness = snapshot.data.activeExecution?.isStale ? 'stale' : 'still active';
    return `Timed out after ${timeoutMs}ms waiting for ${label}; review is ${freshness} (${snapshot.data.lifecycleStatus}).`;
  }
  if (!snapshot.data.review) {
    return 'No review found to wait on.';
  }
  return `Review ${label} is not currently active (${snapshot.data.lifecycleStatus}).`;
}

function buildNextActions(
  terminal: boolean,
  timedOut: boolean,
  continuationRecommended: boolean,
  isStale: boolean
): string[] {
  if (terminal) {
    return [`Run ${TOOL_NAMES.latest} to inspect findings.`];
  }
  if (timedOut) {
    if (continuationRecommended && !isStale) {
      return [
        `Run ${TOOL_NAMES.waitForTerminal} again to continue waiting for a terminal review outcome.`,
        `Run ${TOOL_NAMES.latest} after the review completes to inspect findings.`,
      ];
    }
    return [
      `Run ${TOOL_NAMES.status} to inspect freshness and progress.`,
      `Run ${TOOL_NAMES.queueCancel} only if the review remains stale and the user wants to stop it.`,
    ];
  }
  return [
    `Run ${TOOL_NAMES.status} to inspect queue/lifecycle state.`,
    `Run ${TOOL_NAMES.runCurrent} to start a review if none is active.`,
  ];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
