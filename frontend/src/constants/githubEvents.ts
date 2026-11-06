export const GITHUB_CONNECTION_CHANGED_EVENT = 'atlas-github-connection-changed';

export type GitHubConnectionChangedReason =
  | 'device_flow'
  | 'account_added'
  | 'account_disconnected'
  | 'org_installed'
  | 'project_linked';

export interface GitHubConnectionChangedDetail {
  reason: GitHubConnectionChangedReason;
  accountLogin?: string;
  installationId?: number;
  projectId?: string;
}

export function dispatchGitHubConnectionChanged(detail: GitHubConnectionChangedDetail): void {
  window.dispatchEvent(new CustomEvent(GITHUB_CONNECTION_CHANGED_EVENT, { detail }));
}
