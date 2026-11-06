import { createHash } from 'crypto';

/**
 * Normalize a git remote URL to a canonical form for identity comparison.
 *
 * Examples:
 *   git@github.com:example-org/ExampleProject.git  → github.com/example-org/exampleproject
 *   https://github.com/example-org/ExampleProject.git → github.com/example-org/exampleproject
 *   https://x-token@github.com/Org/Repo → github.com/org/repo
 *   ssh://git@gitlab.com/team/project.git → gitlab.com/team/project
 *
 * @param {string} url - Git remote URL (SSH, HTTPS, or ssh:// format)
 * @returns {string|null} Normalized URL or null if invalid
 */
export function normalizeRepoUrl(url) {
  if (!url || typeof url !== 'string') return null;

  let normalized = url.trim();

  // ssh://git@host/path → host/path
  normalized = normalized.replace(/^ssh:\/\/[^@]*@/, '');
  normalized = normalized.replace(/^ssh:\/\//, '');

  // git@host:path → host/path
  normalized = normalized.replace(/^[^@]+@([^:]+):/, '$1/');

  // https://host/path or http://host/path
  normalized = normalized.replace(/^https?:\/\//, '');

  // Strip embedded auth (token@host)
  normalized = normalized.replace(/^[^@/]+@/, '');

  // Strip .git suffix
  normalized = normalized.replace(/\.git$/, '');

  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, '');

  // Lowercase for case-insensitive comparison
  normalized = normalized.toLowerCase();

  return normalized || null;
}

/**
 * Compute a stable identity hash from a git remote URL.
 * Same repo via SSH or HTTPS produces the same hash.
 *
 * @param {string} url - Git remote URL
 * @returns {string|null} 16-char hex hash or null if no URL
 */
export function hashRepoUrl(url) {
  const normalized = normalizeRepoUrl(url);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
