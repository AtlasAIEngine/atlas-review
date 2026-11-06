import path from 'node:path';

/**
 * Resolve a user-supplied (i.e., agent-supplied) path against the review's
 * project root and reject anything that escapes it. Pure, no I/O.
 *
 * Returns the absolute path on success; throws on:
 *   - non-string input
 *   - empty string
 *   - absolute path outside projectRoot
 *   - relative path that resolves outside projectRoot via `..`
 *
 * Symlink resolution is NOT performed here — the caller may choose to do so
 * with realpath if it cares about post-link escape. For the runtime MCP
 * tools (read-only git/fs operations), realpath isn't strictly necessary
 * because the operations either go through git (which respects the repo
 * boundary on its own) or read the file at the literal path the agent
 * provided. The startsWith guard still catches the obvious `../../etc/passwd`
 * traversal regardless of links.
 */
export function resolveSafeProjectPath(projectRoot, userPath) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('projectRoot is required');
  }
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new Error('path is required');
  }
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, userPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw new Error(`path resolves outside project root: ${userPath}`);
  }
  return candidate;
}

/**
 * Compute the path relative to `projectRoot`. Used when invoking git, which
 * expects pathspecs relative to the repository root rather than absolute
 * paths. Assumes `absPath` was already validated by `resolveSafeProjectPath`.
 */
export function relativeToProjectRoot(projectRoot, absPath) {
  return path.relative(path.resolve(projectRoot), absPath);
}
