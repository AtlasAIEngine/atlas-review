import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { formatStatusSummary } from '../formatters/statusFormatter.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { StatusToolData, ToolExecutionResult } from '../types.js';
import { loadStatusSnapshot, type StatusSnapshot } from './statusShared.js';
import type { ToolContextInput } from './projectContext.js';

export interface StatusToolArgs extends ToolContextInput {}

export async function runStatusTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: StatusToolArgs
): Promise<ToolExecutionResult<StatusToolData>> {
  const snapshot = await loadStatusSnapshot(client, config, cwd, args);

  return {
    summary: formatStatusSummary(snapshot.data),
    data: snapshot.data,
    nextActions: buildNextActions(snapshot),
  };
}

function buildNextActions(snapshot: StatusSnapshot): string[] {
  if (!snapshot.data.review) {
    return [`Create a review in Atlas, then rerun ${TOOL_NAMES.status}.`];
  }

  if (snapshot.data.activeExecution?.isActive) {
    if (snapshot.data.activeExecution.isStale) {
      return [
        `Run ${TOOL_NAMES.waitForTerminal} with a longer timeout before assuming the review is hung.`,
        `Run ${TOOL_NAMES.queueCancel} only if no new activity appears and the user wants to stop the review.`,
      ];
    }

    return [
      `Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`,
      `Run ${TOOL_NAMES.latest} after the review completes to inspect findings.`,
    ];
  }

  if (snapshot.data.activeExecution?.isTerminal) {
    return [
      `Run ${TOOL_NAMES.latest} to inspect the terminal review findings.`,
      `Run ${TOOL_NAMES.runCurrent} to trigger a new review if the branch or PR changed.`,
    ];
  }

  if (snapshot.data.queueState === 'queued_or_running') {
    return [
      `Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`,
      `Run ${TOOL_NAMES.latest} after the review completes to inspect findings.`,
    ];
  }

  return [
    `Run ${TOOL_NAMES.runCurrent} to start a review run.`,
    `Run ${TOOL_NAMES.latest} to inspect the latest completed findings.`,
  ];
}
