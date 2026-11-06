/**
 * walkthroughReadState — localStorage helper for step read/unread
 * flags, keyed by review id. Swallows storage errors so quota / private
 * browsing don't leak into callers.
 */

const KEY_PREFIX = 'atlas.walkthrough.read:';

function storageKey(reviewId: string): string {
  return `${KEY_PREFIX}${reviewId}`;
}

export function getReadSteps(reviewId: string): Set<number> {
  if (!reviewId) return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(reviewId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const result = new Set<number>();
    for (const entry of parsed) {
      const n = Number(entry);
      if (Number.isFinite(n) && n >= 0) result.add(Math.trunc(n));
    }
    return result;
  } catch {
    return new Set();
  }
}

export function setStepRead(reviewId: string, stepIndex: number, read: boolean): Set<number> {
  const current = getReadSteps(reviewId);
  if (read) current.add(stepIndex);
  else current.delete(stepIndex);
  try {
    window.localStorage.setItem(storageKey(reviewId), JSON.stringify(Array.from(current)));
  } catch {
    /* ignore */
  }
  return current;
}

export function clearReadSteps(reviewId: string): void {
  if (!reviewId) return;
  try {
    window.localStorage.removeItem(storageKey(reviewId));
  } catch {
    /* ignore */
  }
}

export function replaceReadSteps(reviewId: string, indexes: Iterable<number>): void {
  if (!reviewId) return;
  const sanitized = new Set<number>();
  for (const entry of indexes) {
    const n = Number(entry);
    if (Number.isFinite(n) && n >= 0) sanitized.add(Math.trunc(n));
  }
  try {
    if (sanitized.size === 0) {
      window.localStorage.removeItem(storageKey(reviewId));
    } else {
      window.localStorage.setItem(storageKey(reviewId), JSON.stringify(Array.from(sanitized)));
    }
  } catch {
    /* ignore */
  }
}
