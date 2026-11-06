const VALID_EVIDENCE_POLICIES = new Set(['demote', 'suppress']);

function normalizePathForEvidence(pathValue) {
  const normalized = String(pathValue || '').trim().replace(/\\/g, '/');
  if (!normalized) return null;
  if (normalized.startsWith('a/') || normalized.startsWith('b/')) {
    return normalized.slice(2).trim() || null;
  }
  return normalized;
}

function normalizeEvidencePolicy(policy, fallback = 'demote') {
  const normalizedFallback = VALID_EVIDENCE_POLICIES.has(String(fallback || '').trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : 'demote';
  const normalized = String(policy || '').trim().toLowerCase();
  if (VALID_EVIDENCE_POLICIES.has(normalized)) {
    return normalized;
  }
  return normalizedFallback;
}

function parseHunkRange(line) {
  const match = String(line || '').match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) return null;
  const start = Math.max(1, Math.trunc(Number(match[1]) || 0));
  const count = Math.max(0, Math.trunc(Number(match[2] == null ? 1 : match[2]) || 0));
  return {
    start,
    // Deletion-only hunks (e.g. +10,0) still provide a valid anchor point.
    end: count <= 0 ? start : start + count - 1,
  };
}

function normalizeEvidenceLineNumber(lineRaw) {
  if (lineRaw == null) return null;
  let parsed = null;
  if (typeof lineRaw === 'number') {
    parsed = lineRaw;
  } else if (typeof lineRaw === 'string') {
    const trimmed = lineRaw.trim();
    if (!trimmed || !/^-?\d+$/.test(trimmed)) {
      return null;
    }
    parsed = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0) return null;
  return normalized;
}

function buildDiffEvidenceIndex(diffText) {
  const lines = String(diffText || '').split('\n');
  const fileMap = new Map();
  let currentFilePath = null;

  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentFilePath = normalizePathForEvidence(fileMatch[2] || fileMatch[1]);
      if (!currentFilePath) {
        currentFilePath = null;
        continue;
      }
      if (!fileMap.has(currentFilePath)) {
        fileMap.set(currentFilePath, {
          path: currentFilePath,
          lineRanges: [],
          patchLines: [],
        });
      }
      continue;
    }

    if (!currentFilePath) continue;
    const fileEntry = fileMap.get(currentFilePath);
    if (!fileEntry) continue;

    fileEntry.patchLines.push(line);
    const hunkRange = parseHunkRange(line);
    if (hunkRange) {
      fileEntry.lineRanges.push(hunkRange);
    }
  }

  for (const fileEntry of fileMap.values()) {
    fileEntry.patchText = fileEntry.patchLines.join('\n');
    fileEntry.patchTextLower = fileEntry.patchText.toLowerCase();
  }

  return fileMap;
}

function normalizeAllowedFilePathSet(allowedFilePaths, diffIndex) {
  const normalizedPaths = Array.isArray(allowedFilePaths)
    ? allowedFilePaths.map((path) => normalizePathForEvidence(path)).filter(Boolean)
    : [];
  if (normalizedPaths.length > 0) {
    return new Set(normalizedPaths);
  }
  return new Set(Array.from(diffIndex.keys()));
}

function isLineWithinRanges(lineNumber, ranges) {
  const target = Math.trunc(Number(lineNumber) || 0);
  if (target <= 0) return false;
  for (const range of Array.isArray(ranges) ? ranges : []) {
    const start = Math.max(1, Math.trunc(Number(range?.start) || 0));
    const end = Math.max(start, Math.trunc(Number(range?.end) || 0));
    if (target >= start && target <= end) {
      return true;
    }
  }
  return false;
}

function dedupeReasonCodes(reasonCodes) {
  const unique = [];
  const seen = new Set();
  for (const rawCode of reasonCodes) {
    const code = String(rawCode || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    unique.push(code);
  }
  return unique;
}

function validateIssueEvidence(issue, {
  diffText = '',
  diffIndex = null,
  allowedFilePaths = [],
} = {}) {
  const resolvedDiffIndex = diffIndex instanceof Map ? diffIndex : buildDiffEvidenceIndex(diffText);
  const allowedSet = normalizeAllowedFilePathSet(allowedFilePaths, resolvedDiffIndex);
  const evidence = issue?.evidence && typeof issue.evidence === 'object' && !Array.isArray(issue.evidence)
    ? issue.evidence
    : {};
  const normalizedFile = normalizePathForEvidence(issue?.file ?? evidence.file);
  const reasonCodes = [];

  let fileEntry = null;
  if (!normalizedFile) {
    reasonCodes.push('file_missing');
  } else if (allowedSet.size > 0 && !allowedSet.has(normalizedFile)) {
    reasonCodes.push('file_out_of_scope');
  } else {
    fileEntry = resolvedDiffIndex.get(normalizedFile) || null;
    if (!fileEntry) {
      reasonCodes.push('file_not_in_diff');
    }
  }

  const lineRaw = issue?.line ?? evidence.line;
  let hasValidLineAnchor = false;
  const normalizedLine = normalizeEvidenceLineNumber(lineRaw);
  if (lineRaw != null) {
    if (normalizedLine == null) {
      reasonCodes.push('line_invalid');
    } else if (fileEntry && isLineWithinRanges(normalizedLine, fileEntry.lineRanges)) {
      hasValidLineAnchor = true;
    } else {
      reasonCodes.push('line_out_of_range');
    }
  }

  const snippet = String(issue?.evidenceSnippet || evidence.snippet || '').trim();
  let hasValidSnippetAnchor = false;
  if (snippet) {
    if (fileEntry && fileEntry.patchTextLower.includes(snippet.toLowerCase())) {
      hasValidSnippetAnchor = true;
    } else {
      reasonCodes.push('snippet_not_found');
    }
  }

  if (!hasValidLineAnchor && !hasValidSnippetAnchor) {
    reasonCodes.push('anchor_missing');
  }

  const dedupedReasons = dedupeReasonCodes(reasonCodes);
  return {
    grounded: dedupedReasons.length === 0,
    reasonCodes: dedupedReasons,
    normalizedFile,
    line: lineRaw == null ? null : normalizedLine,
  };
}

function attachPrecisionStats(stats = {}, precisionStats = {}) {
  const baseStats = stats && typeof stats === 'object' ? stats : {};
  return {
    ...baseStats,
    issuesTotal: Math.max(0, Math.trunc(Number(precisionStats.issuesTotal) || 0)),
    issuesGrounded: Math.max(0, Math.trunc(Number(precisionStats.issuesGrounded) || 0)),
    issuesDemoted: Math.max(0, Math.trunc(Number(precisionStats.issuesDemoted) || 0)),
    issuesSuppressed: Math.max(0, Math.trunc(Number(precisionStats.issuesSuppressed) || 0)),
  };
}

function applyEvidencePolicyToReview(review, {
  diffText = '',
  allowedFilePaths = [],
  policy = 'demote',
} = {}) {
  const normalizedPolicy = normalizeEvidencePolicy(policy, 'demote');
  const sourceReview = review && typeof review === 'object' ? review : {};
  const sourceRecommendations = Array.isArray(sourceReview.recommendations)
    ? sourceReview.recommendations
    : [];
  const resolvedDiffIndex = buildDiffEvidenceIndex(diffText);
  const stats = {
    issuesTotal: 0,
    issuesGrounded: 0,
    issuesDemoted: 0,
    issuesSuppressed: 0,
  };

  const nextRecommendations = [];
  for (const recommendation of sourceRecommendations) {
    const normalizedType = String(recommendation?.type || '').trim().toLowerCase();
    if (normalizedType !== 'issue') {
      nextRecommendations.push(recommendation);
      continue;
    }

    stats.issuesTotal += 1;
    const validation = validateIssueEvidence(recommendation, {
      diffIndex: resolvedDiffIndex,
      allowedFilePaths,
    });
    if (validation.grounded) {
      stats.issuesGrounded += 1;
      nextRecommendations.push(recommendation);
      continue;
    }

    if (normalizedPolicy === 'suppress') {
      stats.issuesSuppressed += 1;
      continue;
    }

    stats.issuesDemoted += 1;
    nextRecommendations.push({
      ...recommendation,
      type: 'suggestion',
      grounding: {
        grounded: false,
        policyAction: 'demote',
        reasonCodes: validation.reasonCodes,
      },
    });
  }

  const nextReview = {
    ...sourceReview,
    recommendations: nextRecommendations,
    stats: attachPrecisionStats(sourceReview.stats, stats),
  };

  return {
    review: nextReview,
    stats: {
      ...stats,
    },
    policy: normalizedPolicy,
  };
}

export default {
  normalizeEvidencePolicy,
  buildDiffEvidenceIndex,
  validateIssueEvidence,
  applyEvidencePolicyToReview,
};
