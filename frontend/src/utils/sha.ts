export function normalizeHeadSha(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}
