import type { PRCardData } from './review/PRCard';

export type ProjectHomePrLaneKey = 'ready' | 'yours' | 'others' | 'completed';

export type ProjectHomePrLanes = Record<ProjectHomePrLaneKey, PRCardData[]>;

function normalizeLogin(login: string | null | undefined): string {
  return String(login || '').trim().toLowerCase();
}

export function selectPrimaryGitHubUserLogin(
  connectedGitHubUserLogins: string[],
  currentUserGitHubLogin: string | null | undefined,
): string {
  const connectedLogin = (Array.isArray(connectedGitHubUserLogins) ? connectedGitHubUserLogins : [])
    .map(normalizeLogin)
    .find(Boolean);
  return connectedLogin || normalizeLogin(currentUserGitHubLogin);
}

export function buildProjectHomePrLanes({
  prCards,
  primaryGitHubUserLogin,
  matchesPrSearch,
}: {
  prCards: PRCardData[];
  primaryGitHubUserLogin: string;
  matchesPrSearch: (pr: PRCardData) => boolean;
}): ProjectHomePrLanes {
  const ready: PRCardData[] = [];
  const yours: PRCardData[] = [];
  const others: PRCardData[] = [];
  const completed: PRCardData[] = [];
  const viewerLogin = normalizeLogin(primaryGitHubUserLogin);

  for (const pr of prCards) {
    if (!matchesPrSearch(pr)) continue;
    if (pr.status === 'closed' || pr.status === 'merged') {
      if (completed.length < 20) completed.push(pr);
      continue;
    }

    const requestedReviewerLogins = Array.isArray(pr.requestedReviewers)
      ? pr.requestedReviewers.map(normalizeLogin)
      : [];
    const reviewRequestedForViewer = Boolean(viewerLogin)
      && requestedReviewerLogins.includes(viewerLogin);
    const authoredByViewer = Boolean(viewerLogin)
      ? normalizeLogin(pr.author) === viewerLogin
      : Boolean(pr.isSelfAuthored);

    if (reviewRequestedForViewer) {
      ready.push(pr);
    } else if (authoredByViewer) {
      yours.push(pr);
    } else {
      others.push(pr);
    }
  }

  return { ready, yours, others, completed };
}
