/**
 * CodeGraph API client.
 *
 * Thin wrapper around the 4 backend endpoints registered by
 * `backend/src/routes/codegraph.js`. The response shape matches
 * `serializeStatus()` in that file — keep the types in sync if the
 * server-side shape changes.
 */

import { api } from './api';

export type CodegraphIndexState = 'indexing' | 'ready' | 'error' | 'stale';

export interface CodegraphIndexRow {
  id: string;
  state: CodegraphIndexState;
  codegraphVersion: string | null;
  worktreeSha: string | null;
  startedAt: string | null;
  readyAt: string | null;
  filesIndexed: number;
  totalFiles: number;
  nodes: number | null;
  edges: number | null;
  sizeBytes: number | null;
  errorMessage: string | null;
}

export interface CodegraphLogEntry {
  /** Unix ms when the line was captured. */
  ts: number;
  /** Origin stream — `stdout`/`stderr` from codegraph, or `system` for our own annotations. */
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

export interface CodegraphStatus {
  enabled: boolean;
  cliAvailable: boolean;
  effectiveReadyForReview: boolean;
  index: CodegraphIndexRow | null;
  /** Newest-last; up to 80 entries. Cleared at the start of every init. */
  recentLogs: CodegraphLogEntry[];
}

export interface CodegraphMutationResponse extends CodegraphStatus {
  success: true;
}

export const codegraphApi = {
  /** Current enablement + latest index row for a project. */
  getStatus: async (projectId: string): Promise<CodegraphStatus> => {
    const response = await api.get<CodegraphStatus>(`/projects/${projectId}/codegraph/status`);
    return response.data;
  },

  /**
   * Flip the user's desired enablement. Does NOT start indexing — the
   * UI decides whether to chain `init()` when turning on with no ready
   * index, matching the two-state model in §3.5 of the plan.
   */
  setEnabled: async (projectId: string, enabled: boolean): Promise<CodegraphMutationResponse> => {
    const response = await api.put<CodegraphMutationResponse>(
      `/projects/${projectId}/codegraph/enabled`,
      { enabled }
    );
    return response.data;
  },

  /**
   * Start indexing. Returns immediately with the freshly-inserted
   * `indexing` row so the UI can flip state without waiting for the
   * next poll. Callers should then poll `getStatus` until `ready` or
   * `error`.
   */
  init: async (projectId: string): Promise<CodegraphMutationResponse> => {
    const response = await api.post<CodegraphMutationResponse>(
      `/projects/${projectId}/codegraph/init`
    );
    return response.data;
  },

  /**
   * Remove the on-disk index and mark the latest row stale. Does NOT
   * touch `codegraph_enabled` (user intent persists per T7 of the
   * acceptance tests).
   */
  uninit: async (projectId: string): Promise<CodegraphMutationResponse> => {
    const response = await api.post<CodegraphMutationResponse>(
      `/projects/${projectId}/codegraph/uninit`
    );
    return response.data;
  },
};
