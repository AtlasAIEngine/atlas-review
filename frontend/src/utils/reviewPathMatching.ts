export function normalizeReviewPathForMatch(pathValue: unknown): string {
  let path = String(pathValue || '').trim();
  if (!path) return '';

  // Normalize platform separators and duplicate separators.
  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

  // Trim common relative prefixes.
  while (path.startsWith('./')) {
    path = path.slice(2);
  }

  return path.trim().toLowerCase();
}

export function buildReviewPathLookup(paths: Array<string | null | undefined>): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const rawPath of paths) {
    const canonicalPath = String(rawPath || '').trim();
    if (!canonicalPath) continue;
    const normalized = normalizeReviewPathForMatch(canonicalPath);
    if (!normalized || lookup.has(normalized)) continue;
    lookup.set(normalized, canonicalPath);
  }
  return lookup;
}

export function resolveCanonicalReviewPath(
  pathValue: unknown,
  lookup: Map<string, string>
): string | null {
  const trimmed = String(pathValue || '').trim();
  if (!trimmed) return null;
  const normalized = normalizeReviewPathForMatch(trimmed);
  if (!normalized) return null;
  const direct = lookup.get(normalized);
  if (direct) return direct;

  // Accept git-diff style prefixes (a/ and b/) as fallbacks for provider output.
  if (normalized.startsWith('a/') || normalized.startsWith('b/')) {
    const fallback = lookup.get(normalized.slice(2));
    if (fallback) return fallback;
  }

  // Accept paths that include extra repo/root prefixes as long as the trailing
  // path segments still match a known diff path boundary.
  for (const [lookupKey, canonicalPath] of lookup.entries()) {
    if (normalized.endsWith(`/${lookupKey}`) || lookupKey.endsWith(`/${normalized}`)) {
      return canonicalPath;
    }
  }

  return trimmed;
}
