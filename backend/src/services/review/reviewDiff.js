/** Review Diff — Diff generation and prompt-size guardrails. */

import { structuredPatch } from 'diff';
import { SMALL_DIFF_LIMIT, MEDIUM_DIFF_LIMIT } from './reviewConstants.js';

// Lock/generated files to exclude from AI review diffs (too large, low review value)
const LOCK_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Cargo\.lock$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /poetry\.lock$/,
  /Pipfile\.lock$/,
];

function isLockFile(filePath) {
  return LOCK_FILE_PATTERNS.some(p => p.test(filePath));
}

function generateDiffFromFiles(files) {
  const parts = [];
  const skippedLockFiles = [];

  for (const file of files) {
    const nextPath = typeof file?.path === 'string' ? file.path : '';
    const oldPath = typeof file?.oldPath === 'string' && file.oldPath.trim() && file.oldPath !== nextPath
      ? file.oldPath
      : null;
    const isRename = Boolean(oldPath);

    // Skip lock/generated files — they blow out the context window
    if (isLockFile(nextPath)) {
      skippedLockFiles.push(nextPath);
      continue;
    }
    const rawFallbackPatch = typeof file?.patch === 'string' ? file.patch : '';
    const fallbackPatch = rawFallbackPatch.trim()
      ? rawFallbackPatch.replace(/\r\n/g, '\n').replace(/\n+$/, '')
      : '';
    if (file.before == null && file.after == null && fallbackPatch) {
      const fromPath = oldPath || nextPath;
      parts.push(`diff --git a/${fromPath} b/${nextPath}`);
      if (isRename) {
        parts.push(`rename from ${fromPath}`);
        parts.push(`rename to ${nextPath}`);
      }
      parts.push(`--- a/${fromPath}`);
      parts.push(`+++ b/${nextPath}`);
      parts.push(fallbackPatch);
    } else if (file.before === null && file.after !== null) {
      // New file
      parts.push(`diff --git a/${nextPath} b/${nextPath}`);
      parts.push(`new file`);
      parts.push(`--- /dev/null`);
      parts.push(`+++ b/${nextPath}`);
      const lines = file.after.split('\n');
      parts.push(`@@ -0,0 +1,${lines.length} @@`);
      for (const line of lines) {
        parts.push(`+${line}`);
      }
    } else if (file.after === null && file.before !== null) {
      // Deleted file
      parts.push(`diff --git a/${nextPath} b/${nextPath}`);
      parts.push(`deleted file`);
      parts.push(`--- a/${nextPath}`);
      parts.push(`+++ /dev/null`);
      const lines = file.before.split('\n');
      parts.push(`@@ -1,${lines.length} +0,0 @@`);
      for (const line of lines) {
        parts.push(`-${line}`);
      }
    } else if (file.before !== null && file.after !== null) {
      // Modified file — hunked unified diff (token-efficient vs full before/after dump)
      const fromPath = oldPath || nextPath;
      const unchangedRename = isRename && file.before === file.after;
      parts.push(`diff --git a/${fromPath} b/${nextPath}`);
      if (unchangedRename) {
        parts.push('similarity index 100%');
      }
      if (isRename) {
        parts.push(`rename from ${fromPath}`);
        parts.push(`rename to ${nextPath}`);
      }
      parts.push(`--- a/${fromPath}`);
      parts.push(`+++ b/${nextPath}`);
      const patch = structuredPatch(
        `a/${fromPath}`,
        `b/${nextPath}`,
        file.before,
        file.after,
        '',
        '',
        { context: 3 }
      );
      const hunks = Array.isArray(patch.hunks) ? patch.hunks : [];
      if (hunks.length === 0) {
        if (!unchangedRename) {
          parts.push('@@ -0,0 +0,0 @@');
        }
      } else {
        for (const hunk of hunks) {
          const oldLines = Number.isFinite(Number(hunk.oldLines)) ? Number(hunk.oldLines) : 0;
          const newLines = Number.isFinite(Number(hunk.newLines)) ? Number(hunk.newLines) : 0;
          parts.push(`@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@`);
          for (const line of hunk.lines || []) {
            parts.push(line);
          }
        }
      }
    }
    parts.push(''); // Blank line between files
  }

  if (skippedLockFiles.length > 0) {
    parts.push(`\n# Note: ${skippedLockFiles.length} lock/generated file(s) excluded from review: ${skippedLockFiles.join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * Apply prompt-size guardrails to keep provider requests stable on large diffs.
 * - <= SMALL: send full diff
 * - <= MEDIUM: send full diff + "large diff" hint
 * - > MEDIUM: truncate hard and annotate truncation
 */
function prepareDiffForPrompt(diff, hardLimit = MEDIUM_DIFF_LIMIT) {
  const normalizedHardLimit = Math.max(SMALL_DIFF_LIMIT, Number(hardLimit) || MEDIUM_DIFF_LIMIT);
  if (diff.length <= SMALL_DIFF_LIMIT) {
    return diff;
  }

  if (diff.length <= normalizedHardLimit) {
    return `${diff}\n\n# Note: Large diff (${diff.length} chars). Prioritize highest-risk issues first.`;
  }

  const truncated = diff.slice(0, normalizedHardLimit);
  return `${truncated}\n\n# Note: Diff truncated at ${normalizedHardLimit} characters from ${diff.length}. Review only covers included content.`;
}

export { isLockFile, generateDiffFromFiles, prepareDiffForPrompt };
