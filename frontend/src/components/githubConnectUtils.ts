import type { GitHubInstallation } from '../services/githubApi';

function buildInstallationKey(installation: GitHubInstallation): string {
  return `${installation.installationId}:${installation.accountLogin.toLowerCase()}`;
}

export function findNewInstallations(
  previous: GitHubInstallation[],
  updated: GitHubInstallation[],
): GitHubInstallation[] {
  const previousKeys = new Set(previous.map((installation) => buildInstallationKey(installation)));

  return updated.filter((installation) => !previousKeys.has(buildInstallationKey(installation)));
}
