/**
 * Linter Path Utils
 * Shared path normalization helpers for adapter output.
 */

export function toRepoRelativePath(rawPath, projectPath) {
  const normalizedPath = String(rawPath || '').trim().replace(/\\/g, '/');
  if (!normalizedPath) return normalizedPath;

  const normalizedRoot = String(projectPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedRoot) return normalizedPath;
  const pathCmp = normalizedPath.toLowerCase();
  const rootCmp = normalizedRoot.toLowerCase();
  if (pathCmp === rootCmp) return '';

  const prefixCmp = `${rootCmp}/`;
  return pathCmp.startsWith(prefixCmp) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath;
}
