/**
 * Linter Diff Anchors
 * Shared helper to derive changed-line ranges per file from review diff text.
 * Reuses the same hunk semantics as reviewEvidenceValidator.js.
 */

// ── Path normalization ───────────────────────────────────────────────────────

function normalizePathForAnchor(pathValue) {
  const normalized = String(pathValue || '').trim().replace(/\\/g, '/');
  if (!normalized) return null;
  if (normalized.startsWith('a/') || normalized.startsWith('b/')) {
    return normalized.slice(2).trim() || null;
  }
  return normalized;
}

// ── Build changed-line index ─────────────────────────────────────────────────

/**
 * Build an index of changed-line ranges per file from unified diff text.
 * Returns a Map<normalizedFilePath, { path, lineRanges: Array<{ start, end }> }>
 */
export function buildChangedLineIndex(diffText) {
  const lines = String(diffText || '').split('\n');
  const fileMap = new Map();
  let currentFilePath = null;
  let inHunk = false;
  let nextNewLine = 0;

  const ensureFileEntry = (filePath) => {
    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, { path: filePath, changedLines: new Set(), lineRanges: [] });
    }
    return fileMap.get(filePath);
  };

  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentFilePath = normalizePathForAnchor(fileMatch[2] || fileMatch[1]);
      inHunk = false;
      if (!currentFilePath) {
        currentFilePath = null;
        continue;
      }
      ensureFileEntry(currentFilePath);
      continue;
    }

    if (!currentFilePath) continue;
    const fileEntry = ensureFileEntry(currentFilePath);
    const hunkMatch = String(line || '').match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      nextNewLine = Math.max(1, Math.trunc(Number(hunkMatch[1]) || 0));
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      fileEntry.changedLines.add(nextNewLine);
      nextNewLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    nextNewLine += 1;
  }

  for (const fileEntry of fileMap.values()) {
    const sortedChangedLines = [...fileEntry.changedLines].sort((left, right) => left - right);
    let rangeStart = null;
    let previousLine = null;
    for (const lineNumber of sortedChangedLines) {
      if (rangeStart == null) {
        rangeStart = lineNumber;
        previousLine = lineNumber;
        continue;
      }
      if (lineNumber === previousLine + 1) {
        previousLine = lineNumber;
        continue;
      }
      fileEntry.lineRanges.push({ start: rangeStart, end: previousLine });
      rangeStart = lineNumber;
      previousLine = lineNumber;
    }
    if (rangeStart != null) {
      fileEntry.lineRanges.push({ start: rangeStart, end: previousLine });
    }
    delete fileEntry.changedLines;
  }

  return fileMap;
}

// ── Anchoring checks ─────────────────────────────────────────────────────────

/**
 * Resolve a finding's file path against the diff index, handling suffix matching
 * for tools that may report paths relative to a subdirectory.
 */
function resolveFileInIndex(filePath, diffIndex) {
  const normalized = normalizePathForAnchor(filePath);
  if (!normalized) return null;
  if (diffIndex.has(normalized)) return diffIndex.get(normalized);
  // Suffix match for paths relative to subdirectories
  const suffix = `/${normalized}`;
  const matches = [];
  for (const [key, entry] of diffIndex) {
    if (key.endsWith(suffix)) matches.push(entry);
  }
  return matches.length === 1 ? matches[0] : null;
}

function isLineWithinRanges(lineNumber, ranges) {
  const target = Math.trunc(Number(lineNumber) || 0);
  if (target <= 0) return false;
  for (const range of ranges) {
    if (target >= range.start && target <= range.end) return true;
  }
  return false;
}

/**
 * Check if a finding is anchored to a changed diff line.
 */
export function isFindingAnchoredToDiff(finding, diffIndex) {
  if (!finding || !finding.file || !Number.isFinite(finding.line) || finding.line <= 0) return false;
  const fileEntry = resolveFileInIndex(finding.file, diffIndex);
  if (!fileEntry) return false;
  return isLineWithinRanges(finding.line, fileEntry.lineRanges);
}

/**
 * Filter findings to only those anchored to changed diff lines.
 * Returns { anchored: LinterFinding[], unanchored: LinterFinding[] }
 */
export function filterAnchoredFindings(findings, diffIndex) {
  const anchored = [];
  const unanchored = [];
  for (const finding of findings) {
    if (isFindingAnchoredToDiff(finding, diffIndex)) {
      anchored.push(finding);
    } else {
      unanchored.push(finding);
    }
  }
  return { anchored, unanchored };
}

/**
 * Resolve a finding's file path to the canonical diff path (for recommendation normalization).
 */
export function resolveCanonicalDiffPath(filePath, diffIndex) {
  const entry = resolveFileInIndex(filePath, diffIndex);
  return entry ? entry.path : normalizePathForAnchor(filePath);
}
