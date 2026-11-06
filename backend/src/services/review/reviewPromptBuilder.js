/** Review Prompt Builder — Prompt construction, response parsing, and quality guards. */

import {
  VALID_RISK_LEVELS,
  VALID_RECOMMENDATION_TYPES,
  VALID_COMPLEXITIES,
  MAX_CHANGE_GROUPS,
  REVIEW_RESULT_TOP_LEVEL_KEYS,
  RECOMMENDATION_TYPE_ALIASES,
  RECOMMENDATION_TYPE_WEIGHT,
  RECOMMENDATION_SEVERITY_WEIGHT,
  RECOMMENDATION_LOW_SIGNAL_CAP,
  RECOMMENDATION_SINGLE_ISSUE_CAP,
  IMPACT_HINT_RE,
  IMPACT_APPENDIX,
  REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
  REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
  SEVERITY_FLOOR_NON_SOURCE_EXTENSIONS,
  SEVERITY_FLOOR_IMPACT_PATTERNS,
  REVIEW_CANDIDATE_PROMOTION_MAX_FINDINGS,
} from './reviewConstants.js';

import {
  toNumberOrNull,
  getBaseRecommendationBudget,
  isReviewQualityV2Enabled,
  normalizePathForMatch,
} from './reviewHelpers.js';

import { buildBoundedPromptContextBlocks, REVIEW_OUTPUT_SCHEMA } from './reviewPromptContext.js';

function normalizeContextFilePathSet(filePaths) {
  const set = new Set();
  if (!Array.isArray(filePaths)) return set;

  for (const filePath of filePaths) {
    if (typeof filePath !== 'string') continue;
    const normalized = normalizePathForMatch(filePath);
    if (!normalized) continue;
    set.add(normalized);
  }

  return set;
}

/**
 * Resolve an agentic model's file path to the closest matching allowed diff path.
 * Agentic models may return paths relative to a subdirectory (e.g. `src/services/reviewService.js`)
 * while the diff uses project-root-relative paths (e.g. `backend/src/services/reviewService.js`).
 * Returns the matched allowed path, or the original path if no suffix match is found.
 */
function resolveAgenticPathToAllowed(normalizedPath, allowedFilePathSet) {
  if (allowedFilePathSet.has(normalizedPath)) return normalizedPath;
  const suffix = `/${normalizedPath}`;
  for (const allowed of allowedFilePathSet) {
    if (allowed.endsWith(suffix)) return allowed;
  }
  return normalizedPath;
}

function buildRenderedDiffLineIndex(diffText) {
  const fileMap = new Map();
  const lines = String(diffText || '').split('\n');
  let currentFilePath = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of lines) {
    const fileMatch = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentFilePath = normalizePathForMatch(fileMatch[2] || fileMatch[1]);
      oldLine = 0;
      newLine = 0;
      inHunk = false;
      if (currentFilePath && !fileMap.has(currentFilePath)) {
        fileMap.set(currentFilePath, { renderedNewLines: [] });
      }
      continue;
    }

    if (!currentFilePath) continue;
    const hunkMatch = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      oldLine = Math.max(1, Math.trunc(Number(hunkMatch[1]) || 0));
      newLine = Math.max(1, Math.trunc(Number(hunkMatch[2]) || 0));
      inHunk = true;
      continue;
    }

    const fileEntry = fileMap.get(currentFilePath);
    if (!fileEntry || !inHunk) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      fileEntry.renderedNewLines.push({ line: newLine, content: rawLine.slice(1) });
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith(' ')) {
      const content = rawLine.slice(1);
      fileEntry.renderedNewLines.push({ line: newLine, content });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      oldLine += 1;
    }
  }

  return fileMap;
}

/**
 * Transforms a raw unified diff into a line-numbered format.
 * Each line gets an explicit right-side (new file) line number prefix so the AI
 * can report findings using exact diff-line references.
 *
 * Format:
 *   @@ -10,5 +10,7 @@ context
 *   R10  unchanged context line
 *   R11 +added line
 *        -removed line (old only, no R-number)
 *   R12  another context line
 */
function formatNumberedDiff(diffText) {
  const lines = String(diffText || '').split('\n');
  const output = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of lines) {
    if (rawLine.startsWith('diff --git ')) {
      inHunk = false;
      output.push(rawLine);
      continue;
    }
    if (rawLine.startsWith('---') || rawLine.startsWith('+++') || rawLine.startsWith('index ')) {
      output.push(rawLine);
      continue;
    }
    const hunkMatch = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)/);
    if (hunkMatch) {
      oldLine = Math.max(1, Math.trunc(Number(hunkMatch[1]) || 0));
      newLine = Math.max(1, Math.trunc(Number(hunkMatch[2]) || 0));
      inHunk = true;
      output.push(rawLine);
      continue;
    }
    if (!inHunk) {
      output.push(rawLine);
      continue;
    }

    if (rawLine.startsWith('\\ ')) {
      // "\ No newline at end of file" marker — pass through without numbering
      output.push(rawLine);
    } else if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      output.push(`R${newLine} ${rawLine}`);
      newLine += 1;
    } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      const prefixWidth = `R${newLine} `.length;
      output.push(`${' '.repeat(prefixWidth)}${rawLine}`);
      oldLine += 1;
    } else {
      // Context line (space prefix) or empty
      output.push(`R${newLine} ${rawLine}`);
      oldLine += 1;
      newLine += 1;
    }
  }

  return output.join('\n');
}

function normalizeSnippetToComparableLines(snippet) {
  if (typeof snippet !== 'string') return [];
  const normalized = snippet
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, array) => {
      if (line) return true;
      return index !== 0 && index !== array.length - 1;
    });
  return normalized.filter(Boolean);
}

function findSnippetRenderedBlock(renderedNewLines, snippet) {
  const snippetLines = normalizeSnippetToComparableLines(snippet);
  if (snippetLines.length < 2 || !Array.isArray(renderedNewLines) || renderedNewLines.length < snippetLines.length) {
    return null;
  }

  const comparableRendered = renderedNewLines.map((entry) => ({
    line: Math.trunc(Number(entry?.line) || 0),
    content: String(entry?.content || '').trim(),
  }));

  for (let start = 0; start <= comparableRendered.length - snippetLines.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < snippetLines.length; offset += 1) {
      if (comparableRendered[start + offset].content !== snippetLines[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const first = comparableRendered[start];
    const last = comparableRendered[start + snippetLines.length - 1];
    if (first.line <= 0 || last.line <= 0) continue;
    return {
      startLine: first.line,
      endLine: last.line,
    };
  }

  return null;
}

function findPartialSnippetRenderedBlock(renderedNewLines, snippet) {
  const snippetLines = normalizeSnippetToComparableLines(snippet);
  if (snippetLines.length < 2 || !Array.isArray(renderedNewLines) || renderedNewLines.length < 2) {
    return null;
  }

  const comparableRendered = renderedNewLines.map((entry) => ({
    line: Math.trunc(Number(entry?.line) || 0),
    content: String(entry?.content || '').trim(),
  }));
  const dp = Array.from({ length: snippetLines.length + 1 }, () => (
    Array.from({ length: comparableRendered.length + 1 }, () => 0)
  ));

  for (let snippetIdx = 1; snippetIdx <= snippetLines.length; snippetIdx += 1) {
    for (let renderedIdx = 1; renderedIdx <= comparableRendered.length; renderedIdx += 1) {
      if (snippetLines[snippetIdx - 1] === comparableRendered[renderedIdx - 1].content) {
        dp[snippetIdx][renderedIdx] = dp[snippetIdx - 1][renderedIdx - 1] + 1;
      } else {
        dp[snippetIdx][renderedIdx] = Math.max(dp[snippetIdx - 1][renderedIdx], dp[snippetIdx][renderedIdx - 1]);
      }
    }
  }

  const matchedLines = [];
  let snippetIdx = snippetLines.length;
  let renderedIdx = comparableRendered.length;
  while (snippetIdx > 0 && renderedIdx > 0) {
    if (snippetLines[snippetIdx - 1] === comparableRendered[renderedIdx - 1].content) {
      matchedLines.push(comparableRendered[renderedIdx - 1].line);
      snippetIdx -= 1;
      renderedIdx -= 1;
      continue;
    }
    if (dp[snippetIdx - 1][renderedIdx] >= dp[snippetIdx][renderedIdx - 1]) {
      snippetIdx -= 1;
    } else {
      renderedIdx -= 1;
    }
  }

  matchedLines.reverse();
  if (matchedLines.length < 2) return null;

  const startLine = matchedLines[0];
  const endLine = matchedLines[matchedLines.length - 1];
  if (startLine <= 0 || endLine <= startLine) return null;

  const span = endLine - startLine + 1;
  const coverageRatio = matchedLines.length / snippetLines.length;
  const gaps = span - matchedLines.length;

  // Conservative fuzzy match:
  // - at least two snippet lines matched in order
  // - majority of snippet lines matched
  // - matched lines stay inside a tight rendered span
  if (coverageRatio < 0.5 || gaps > 2) return null;

  return {
    startLine,
    endLine,
    matchedLineCount: matchedLines.length,
    totalSnippetLines: snippetLines.length,
    coverageRatio,
    gaps,
  };
}

function findUniqueNearbySnippetLineMatch(renderedNewLines, snippet, currentLine) {
  const snippetLines = normalizeSnippetToComparableLines(snippet);
  const normalizedCurrentLine = Number.isFinite(Number(currentLine))
    ? Math.trunc(Number(currentLine))
    : null;
  if (!Array.isArray(renderedNewLines) || renderedNewLines.length === 0 || !snippetLines.length || normalizedCurrentLine == null) {
    return null;
  }

  const comparableRendered = renderedNewLines.map((entry) => ({
    line: Math.trunc(Number(entry?.line) || 0),
    content: String(entry?.content || '').trim(),
  }));
  const uniqueMatchedLines = new Set();

  for (const snippetLine of snippetLines) {
    for (const renderedEntry of comparableRendered) {
      if (renderedEntry.content === snippetLine && renderedEntry.line > 0) {
        uniqueMatchedLines.add(renderedEntry.line);
      }
    }
  }

  if (uniqueMatchedLines.size !== 1) return null;

  const [matchedLine] = Array.from(uniqueMatchedLines);
  if (matchedLine <= 0) return null;

  // Conservative adjacency fallback:
  // - only one rendered candidate exists
  // - source line is very close, so this is likely a patch/window offset rather than a semantic move
  if (Math.abs(matchedLine - normalizedCurrentLine) > 2) return null;

  return {
    startLine: matchedLine,
    endLine: matchedLine,
    matchedLineCount: 1,
    totalSnippetLines: snippetLines.length,
    coverageRatio: 1 / snippetLines.length,
    gaps: 0,
    allowNearbyCurrentLine: true,
    maxSourceDistance: 2,
  };
}

function buildPatchAnchor(normalizedFile, matchedBlock, status) {
  if (!normalizedFile || !matchedBlock || matchedBlock.endLine < matchedBlock.startLine) return null;
  return {
    file: normalizedFile,
    line: matchedBlock.endLine,
    startLine: matchedBlock.startLine,
    endLine: matchedBlock.endLine,
    status,
  };
}

function resolveRecommendationPatchAnchor({
  diffLineIndex = null,
  normalizedFile = null,
  sourceLine = null,
  normalizedEvidence = null,
  evidenceSnippet = null,
  targetSnippet = null,
} = {}) {
  if (!normalizedFile) return null;
  if (!(diffLineIndex instanceof Map)) {
    return {
      file: normalizedFile,
      line: null,
      startLine: null,
      endLine: null,
      status: 'diff_unavailable',
    };
  }

  const fileEntry = diffLineIndex.get(normalizedFile);
  if (!fileEntry) {
    return {
      file: normalizedFile,
      line: null,
      startLine: null,
      endLine: null,
      status: 'file_not_in_diff',
    };
  }

  const normalizedSourceLine = Number.isFinite(Number(sourceLine)) && Number(sourceLine) > 0
    ? Math.trunc(Number(sourceLine))
    : null;

  const snippet = typeof targetSnippet === 'string' && targetSnippet.trim()
    ? targetSnippet
    : (typeof normalizedEvidence?.snippet === 'string' && normalizedEvidence.snippet.trim()
      ? normalizedEvidence.snippet
      : (typeof evidenceSnippet === 'string' && evidenceSnippet.trim() ? evidenceSnippet : null));
  if (snippet) {
    const exactBlock = findSnippetRenderedBlock(fileEntry.renderedNewLines, snippet);
    if (exactBlock) {
      return buildPatchAnchor(normalizedFile, exactBlock, 'exact_block');
    }
    const partialBlock = findPartialSnippetRenderedBlock(fileEntry.renderedNewLines, snippet);
    if (partialBlock) {
      return buildPatchAnchor(normalizedFile, partialBlock, 'partial_block');
    }
  }

  if (normalizedSourceLine != null) {
    const exactEntry = Array.isArray(fileEntry.renderedNewLines)
      ? fileEntry.renderedNewLines.find((entry) => Math.trunc(Number(entry?.line) || 0) === normalizedSourceLine)
      : null;
    if (exactEntry) {
      return {
        file: normalizedFile,
        line: normalizedSourceLine,
        startLine: normalizedSourceLine,
        endLine: normalizedSourceLine,
        status: 'exact',
      };
    }
  }

  if (snippet) {
    const uniqueNearbyLine = findUniqueNearbySnippetLineMatch(fileEntry.renderedNewLines, snippet, normalizedSourceLine);
    if (uniqueNearbyLine) {
      return buildPatchAnchor(normalizedFile, uniqueNearbyLine, 'nearby_unique_line');
    }
  }

  return {
    file: normalizedFile,
    line: null,
    startLine: null,
    endLine: null,
    status: normalizedSourceLine != null ? 'outside_patch' : 'unanchored',
  };
}

function normalizePromptMetaText(value, maxChars = 280) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function resolveMaxRecommendations(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.max(1, Math.trunc(normalized));
}

function resolvePolicyMaxRecommendations(reviewPolicy = null) {
  if (!reviewPolicy || typeof reviewPolicy !== 'object') return null;
  return resolveMaxRecommendations(
    reviewPolicy.defaults?.maxRecommendations ?? reviewPolicy.maxRecommendations ?? null
  );
}

function getRecommendationBudget(fileCount, recommendations = [], options = {}) {
  const baseBudget = getBaseRecommendationBudget(fileCount);
  const issueCount = recommendations.filter((rec) => rec.type === 'issue').length;
  const highRiskCount = recommendations.filter(
    (rec) => rec.severity === 'high' || rec.severity === 'critical'
  ).length;
  const normalizedRiskLevel = VALID_RISK_LEVELS.includes(options?.riskLevel)
    ? options.riskLevel
    : null;
  const hasHighRiskSignal = normalizedRiskLevel === 'high'
    || normalizedRiskLevel === 'critical'
    || highRiskCount > 0;

  let budget = baseBudget;

  // Keep low-signal/simple diffs concise by capping non-issue-heavy outputs.
  if (!hasHighRiskSignal && issueCount === 0) {
    budget = Math.min(budget, RECOMMENDATION_LOW_SIGNAL_CAP);
  } else if (!hasHighRiskSignal && issueCount === 1) {
    budget = Math.min(budget, RECOMMENDATION_SINGLE_ISSUE_CAP);
  }

  // Preserve room for additional high-risk issues without re-expanding verbosity too far.
  if (highRiskCount > baseBudget) {
    budget = Math.min(baseBudget + 1, highRiskCount);
  }

  const policyMaxRecommendations = resolveMaxRecommendations(options?.maxRecommendations);
  if (policyMaxRecommendations != null) {
    budget = Math.min(budget, policyMaxRecommendations);
  }

  return Math.max(0, budget);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the review prompt for a given diff
 * @param {string} diff - The unified diff text
 * @param {Object} metadata - Changeset metadata
 * @param {string} metadata.title - Changeset title
 * @param {string[]} metadata.commitMessages - Commit messages if available
 * @param {Object} metadata.riskFlags - Pre-computed risk flags
 * @returns {{ prompt: string, promptContextTelemetry: object | null }} Prompt + bounded context telemetry
 */
function buildReviewPrompt(diff, metadata = {}) {
  const qualityV2 = isReviewQualityV2Enabled(metadata.qualityMode);
  const fileCount = toNumberOrNull(metadata.fileCount)
    ?? toNumberOrNull(metadata.riskFlags?.fileCount)
    ?? null;
  const totalAdditions = toNumberOrNull(metadata.totalAdditions)
    ?? toNumberOrNull(metadata.riskFlags?.totalAdditions)
    ?? null;
  const totalDeletions = toNumberOrNull(metadata.totalDeletions)
    ?? toNumberOrNull(metadata.riskFlags?.totalDeletions)
    ?? null;
  const reviewPolicy = metadata.reviewPolicy && typeof metadata.reviewPolicy === 'object'
    ? metadata.reviewPolicy
    : null;
  const policyMaxRecommendations = resolvePolicyMaxRecommendations(reviewPolicy);
  const recommendationBudget = policyMaxRecommendations != null
    ? Math.min(getBaseRecommendationBudget(fileCount), policyMaxRecommendations)
    : getBaseRecommendationBudget(fileCount);
  const omittedFiles = Array.isArray(metadata.omittedFiles)
    ? metadata.omittedFiles.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const omittedCount = toNumberOrNull(metadata.omittedFilesCount) ?? omittedFiles.length;

  const scopeParts = [];
  if (fileCount != null) scopeParts.push(`${fileCount} files`);
  if (totalAdditions != null || totalDeletions != null) {
    scopeParts.push(`+${totalAdditions || 0} / -${totalDeletions || 0}`);
  }
  const scopeContext = scopeParts.length > 0
    ? `\nReview scope: ${scopeParts.join(', ')}.`
    : '';
  const omittedContext = omittedCount > 0
    ? `\nFocused review note: ${omittedCount} file(s) were omitted from deep analysis due focus budget/scope constraints.${omittedFiles.length > 0
      ? ` Top omitted files: ${omittedFiles.join(', ')}.`
      : ''} Mention scope limits if confidence is reduced.`
    : '';
  const diffScopeMode = typeof metadata.diffScopeMode === 'string' ? metadata.diffScopeMode.trim().toLowerCase() : 'full';
  const diffScopeStartSha = normalizePromptMetaText(
    metadata.diffScopeStartSha || metadata.diffBaseSha || '',
    16
  );
  const diffScopeEndSha = normalizePromptMetaText(
    metadata.diffScopeEndSha || metadata.diffHeadSha || '',
    16
  );
  const diffScopeCommitCount = toNumberOrNull(metadata.diffScopeCommitCount);
  const diffScopeContext = diffScopeMode === 'delta'
    ? `\nIncremental review note: this rerun covers only unreviewed commits${diffScopeStartSha && diffScopeEndSha ? ` (${diffScopeStartSha}..${diffScopeEndSha})` : ''}${diffScopeCommitCount != null ? ` across ${diffScopeCommitCount} commit(s)` : ''}. Focus on newly introduced issues in this delta and any touched areas that were previously risky.`
    : '';
  const priorReviewSummary = normalizePromptMetaText(metadata.priorReviewSummary || '', 320);
  const priorReviewFindings = Array.isArray(metadata.priorReviewFindings)
    ? metadata.priorReviewFindings
        .map((entry) => normalizePromptMetaText(entry, 160))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const priorReviewContext = priorReviewSummary
    ? `\nPrevious review summary: ${priorReviewSummary}`
    : '';
  const priorReviewFindingsContext = priorReviewFindings.length > 0
    ? `\nPrevious top findings: ${priorReviewFindings.join('; ')}.`
    : '';
  const reviewProfile = metadata.reviewProfile && typeof metadata.reviewProfile === 'object'
    ? metadata.reviewProfile
    : null;
  const shapedScope = metadata.shapedScope && typeof metadata.shapedScope === 'object'
    ? metadata.shapedScope
    : null;
  const profileContext = reviewProfile
    ? `\nReview profile: ${reviewProfile.label || reviewProfile.id || 'Generic'} (${reviewProfile.source || 'fallback'}).`
    : '';
  const reviewPolicySourcePath = normalizePromptMetaText(reviewPolicy?.sourcePath || '', 120);
  const reviewPolicySource = normalizePromptMetaText(reviewPolicy?.policySource || '', 40);
  const reviewPolicyTrustedRef = normalizePromptMetaText(reviewPolicy?.trustedRef || '', 40);
  const reviewPolicyHash = normalizePromptMetaText(reviewPolicy?.hash || '', 16);
  const reviewPolicySummaryParts = [];
  if (reviewPolicySource === 'working_tree') reviewPolicySummaryParts.push('working tree preview');
  if (reviewPolicySourcePath) reviewPolicySummaryParts.push(`file ${reviewPolicySourcePath}`);
  if (reviewPolicyTrustedRef) reviewPolicySummaryParts.push(`trusted ref ${reviewPolicyTrustedRef}`);
  if (reviewPolicyHash) reviewPolicySummaryParts.push(`hash ${reviewPolicyHash}`);
  const reviewPolicySummary = reviewPolicySummaryParts.length > 0
    ? `\nAtlas review policy: ${reviewPolicySummaryParts.join(', ')}.`
    : '';
  const reviewPolicyPromptAppend = Array.isArray(reviewPolicy?.promptAppend)
    ? reviewPolicy.promptAppend
        .map((entry) => normalizePromptMetaText(entry, 320))
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const reviewPolicyPromptContext = reviewPolicyPromptAppend.length > 0
    ? `\nPolicy guidance: ${reviewPolicyPromptAppend.join(' / ')}`
    : '';
  const reviewPolicyGlobalMustCheckHints = Array.isArray(reviewPolicy?.rules?.mustCheckRules)
    ? reviewPolicy.rules.mustCheckRules
        .map((rule) => normalizePromptMetaText(rule?.id || '', 40))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const reviewPolicyGlobalSuppressionHints = Array.isArray(reviewPolicy?.rules?.suppressionRules)
    ? reviewPolicy.rules.suppressionRules
        .map((rule) => normalizePromptMetaText(rule?.id || '', 40))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const reviewPolicyRuleContext = (
    reviewPolicyGlobalMustCheckHints.length > 0 || reviewPolicyGlobalSuppressionHints.length > 0
  )
    ? `\nPolicy rule hints: ${[
      reviewPolicyGlobalMustCheckHints.length > 0
        ? `must-check ${reviewPolicyGlobalMustCheckHints.join('/')}`
        : '',
      reviewPolicyGlobalSuppressionHints.length > 0
        ? `suppress ${reviewPolicyGlobalSuppressionHints.join('/')}`
        : '',
    ].filter(Boolean).join('; ')}.`
    : '';
  const reviewPolicyPathHints = Array.isArray(reviewPolicy?.paths)
    ? reviewPolicy.paths
        .map((rule) => {
          const glob = normalizePromptMetaText(rule?.glob || '', 80);
          if (!glob) return '';
          const parts = [glob];
          if (typeof rule?.fileClass === 'string' && rule.fileClass.trim()) {
            parts.push(`class ${rule.fileClass.trim()}`);
          }
          const mustCheckRules = Array.isArray(rule?.mustCheckRules)
            ? rule.mustCheckRules.map((entry) => normalizePromptMetaText(entry, 40)).filter(Boolean).slice(0, 3)
            : [];
          if (mustCheckRules.length > 0) {
            parts.push(`checks ${mustCheckRules.join('/')}`);
          }
          const promptAppend = normalizePromptMetaText(rule?.promptAppend || '', 120);
          if (promptAppend) {
            parts.push(`guidance ${promptAppend}`);
          }
          return parts.join(' -> ');
        })
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const reviewPolicyPathContext = reviewPolicyPathHints.length > 0
    ? `\nPolicy path hints: ${reviewPolicyPathHints.join('; ')}.`
    : '';
  const shapedScopeContext = shapedScope
    ? `\nStack-aware shaping: ${Math.max(0, Number(shapedScope.rawFileCount) || 0)} raw changed files became ${Math.max(0, Number(shapedScope.reviewUnitCount) || 0)} review units (deep ${Math.max(0, Number(shapedScope.classCounts?.deep) || 0)}, structural ${Math.max(0, Number(shapedScope.classCounts?.structural) || 0)}, shallow ${Math.max(0, Number(shapedScope.classCounts?.shallow) || 0)}, collapsed ${Math.max(0, Number(shapedScope.classCounts?.collapsed) || 0)}, skipped ${Math.max(0, Number(shapedScope.classCounts?.skip) || 0)}).`
    : '';

  let localContext = '';
  let promptContextTelemetry = null;

  if (typeof buildBoundedPromptContextBlocks === 'function') {
    const promptContext = buildBoundedPromptContextBlocks({
      commitMessages: metadata.commitMessages || [],
      verificationStatus: metadata.verificationStatus || null,
      requestedReviewers: metadata.requestedReviewers || [],
      assignees: metadata.assignees || [],
      reviewThreads: metadata.reviewThreads || [],
      priorFindingHints: metadata.priorFindingHints || [],
      fileRiskContext: metadata.fileRiskContext || [],
      claudeConventions: metadata.claudeConventions || [],
      projectMetadata: metadata.projectMetadata || {},
      dismissedPatterns: metadata.dismissedPatterns || [],
      linterFindings: metadata.linterFindings || [],
      additionalBlocks: metadata.additionalPromptContextBlocks || [],
      queuedCommitShas: metadata.queuedCommitShas || [],
      sameHashOnly: metadata.promptContextSameHashOnly,
      allowGuardedCrossHashHints: metadata.promptContextAllowCrossHashHints,
      budgetChars: metadata.promptContextBudgetChars || REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
      maxLinesPerBlock: metadata.promptContextBlockMaxLines || REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
      lineMaxChars: metadata.promptContextLineMaxChars || REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    });
    promptContextTelemetry = promptContext?.telemetry && typeof promptContext.telemetry === 'object'
      ? { ...promptContext.telemetry }
      : null;
    localContext = promptContext.contextText
      ? `\n${promptContext.contextText}`
      : '';
  }

  const riskContext = metadata.riskFlags
    ? `\nPre-computed risk flags: ${JSON.stringify(metadata.riskFlags)}`
    : '';

  const qualityGuidelines = qualityV2
    ? `- Prioritize correctness, security, data integrity, reliability, and meaningful performance regressions over style nits.
- Keep the summary concise: 2-4 sentences focused on top risks and what appears safe.
- Be specific about issues. Every "issue" should include evidence from the diff and reference file paths and line numbers when possible.
- Recommendation budget for this review: aim for <= ${recommendationBudget} total recommendations. Only exceed this for additional high/critical findings with clear evidence.
- For small/straightforward diffs, prefer 0-2 recommendations when no meaningful risk is present.
- Do not add praise by default. Include praise only when it highlights a materially risk-reducing decision.
- Do NOT flag intentional defensive patterns as issues. Recognize these as deliberate design choices:
  - Graceful degradation: catch blocks that return a safe fallback (null, empty array, default rendering) are intentional, not "silent error handling."
  - Fallback-to-unstyled: rendering code that falls back to plain output when optional enrichment (syntax highlighting, formatting) fails is correct behavior.
  - Minimal config files: test or config files with only essential settings do not need additional options unless correctness requires them.
  - Guard clauses returning early: functions that bail out with a safe default on unexpected input are defensive, not incomplete.
- When evaluating error handling, ask: "Does the catch/fallback produce a safe, usable result?" If yes, it is not a finding.
- For every "issue" or "suggestion", you MUST include a concrete failure scenario: what breaks, what data is lost, or what user-visible misbehavior occurs. If you cannot articulate a specific failure scenario, do not include the finding.
- Use "recommendations" only for findings you are confident Atlas should show directly to the developer.
- Use "candidateFindings" for plausible concerns that have grounding and a concrete failure scenario, but still need extra verification before Atlas should promote them. Keep this list short: at most ${REVIEW_CANDIDATE_PROMOTION_MAX_FINDINGS}.
- Ask yourself: "So what? What actually goes wrong?" If the answer is "nothing breaks, it's just not ideal," downgrade to a suggestion or omit entirely.`
    : `- Be specific about issues. Reference file paths and line numbers when possible.
- Include at least one "praise" recommendation if something is done well.`;

  const prompt = `You are a senior code reviewer analyzing a set of changes. Your job is to help a developer understand what changed, assess risk, and catch issues.

Analyze the following diff and return a JSON object with this exact structure:

{
  "summary": "1-3 sentence plain-English summary of what changed and why it matters",
  "riskLevel": "low | medium | high | critical",
  "recommendations": [
    {
      "type": "issue | suggestion | praise",
      "severity": "low | medium | high | critical",
      "title": "Short title",
      "description": "Detailed explanation",
      "file": "file path or null",
      "line": <right-side line number from the R-prefixed diff lines, or null>,
      "targetSnippet": "exact code snippet being replaced or null",
      "suggestedFix": "replacement code snippet or null"
    }
  ],
  "candidateFindings": [
    {
      "type": "issue | suggestion",
      "severity": "low | medium | high | critical",
      "confidence": "low | medium | high",
      "title": "Short title for a plausible but not fully promoted concern",
      "description": "Concrete failure scenario and why this still needs verification",
      "file": "file path or null",
      "line": <right-side line number from the R-prefixed diff lines, or null>,
      "evidence": {
        "file": "file path or null",
        "line": <right-side line number from the R-prefixed diff lines, or null>,
        "snippet": "code showing the concern or null",
        "reasoning": "why this concern is plausible"
      }
    }
  ],
  "stats": {
    "filesAnalyzed": <number>,
    "totalAdditions": <number>,
    "totalDeletions": <number>,
    "estimatedComplexity": "trivial | simple | moderate | complex"
  }
}

Guidelines:
- Risk levels: low = routine/safe, medium = needs attention, high = could break things, critical = security/data-loss risk
${qualityGuidelines}
- For issues and suggestions, include a "suggestedFix" with a concrete replacement code snippet when you can. The fix should be the corrected version of the specific lines, ready to drop in. Set to null if no concrete fix applies.
- When "suggestedFix" directly replaces changed code, include "targetSnippet" with the exact existing code to replace. Do not guess. Set "targetSnippet" to null when the replacement span is ambiguous or the fix is only conceptual.
- Use "recommendations" for direct output-worthy findings only.
- Use "candidateFindings" for plausible, grounded concerns that still need verification. Return [] when none apply.
- If there are no issues, say so clearly. Don't invent problems.
- ONLY include files that appear in the diff. Never hallucinate file paths.
- Each diff line is prefixed with its right-side (new file) line number (e.g., "R42 +added line"). Use the R-number as the "line" value in your findings for exact anchoring. Removed lines have no R-number.
- CRITICAL: The "line" field in each recommendation MUST be an R-number from the diff. If a finding concerns code outside the diff, anchor it to the nearest changed line (R-numbered) that triggers or relates to the concern. Never use line numbers from reading source files — only use R-prefixed line numbers from the diff above.
- If the local context below includes "Deterministic Linter Findings", those issues were already identified by local analysis tools. Do not duplicate them. Use them as context and focus on logic, behavioral regressions, architecture, and semantic risk.
- Return ONLY the JSON object, no markdown fences, no extra text.
${scopeContext}${diffScopeContext}${priorReviewContext}${priorReviewFindingsContext}${profileContext}${reviewPolicySummary}${reviewPolicyPromptContext}${reviewPolicyRuleContext}${reviewPolicyPathContext}${shapedScopeContext}${omittedContext}${localContext}${riskContext}

Title: ${metadata.title || 'Untitled changeset'}

Diff:
${formatNumberedDiff(diff)}`;
  return {
    prompt,
    promptContextTelemetry,
  };
}

// ---------------------------------------------------------------------------
// Severity floor filter helpers
// (SEVERITY_FLOOR_NON_SOURCE_EXTENSIONS and SEVERITY_FLOOR_IMPACT_PATTERNS
//  are imported from reviewConstants.js — single source of truth)
// ---------------------------------------------------------------------------

function isNonSourceFile(filePath) {
  if (!filePath) return false; // No file anchor → treat as source-level (keep)
  const lower = String(filePath).toLowerCase();
  for (const ext of SEVERITY_FLOOR_NON_SOURCE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function hasConcreteImpact(rec) {
  const text = `${rec.title || ''} ${rec.description || ''}`.toLowerCase();
  return SEVERITY_FLOOR_IMPACT_PATTERNS.some(p => p.test(text));
}

function recommendationScore(rec) {
  return (RECOMMENDATION_SEVERITY_WEIGHT[rec.severity] || 0) * 10
    + (RECOMMENDATION_TYPE_WEIGHT[rec.type] || 0);
}

function recommendationKey(rec) {
  const title = String(rec.title || '').trim().toLowerCase();
  const file = String(rec.file || '').trim().toLowerCase();
  const line = rec.line == null ? '' : String(rec.line);
  return `${rec.type}|${rec.severity}|${title}|${file}|${line}`;
}

function normalizeRiskValue(value, fallback = 'low') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (VALID_RISK_LEVELS.includes(normalized)) {
    return normalized;
  }
  return VALID_RISK_LEVELS.includes(fallback) ? fallback : 'low';
}

function normalizeRecommendationTypeValue(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (Object.prototype.hasOwnProperty.call(RECOMMENDATION_TYPE_ALIASES, normalized)) {
    return RECOMMENDATION_TYPE_ALIASES[normalized];
  }
  return VALID_RECOMMENDATION_TYPES.includes(normalized) ? normalized : 'suggestion';
}

function normalizeRecommendationConfidenceValue(value, fallback = null) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return fallback;
}

function normalizeComplexityValue(value, fallback = 'simple') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (VALID_COMPLEXITIES.includes(normalized)) {
    return normalized;
  }
  return VALID_COMPLEXITIES.includes(fallback) ? fallback : 'simple';
}

function toNonNegativeInteger(value, fallback = 0) {
  const parsed = toNumberOrNull(value);
  if (parsed == null) {
    return Math.max(0, Math.trunc(Number(fallback) || 0));
  }
  return Math.max(0, Math.trunc(parsed));
}

function resolveChangeGroupFilePath(file) {
  if (!file || typeof file !== 'object') return null;
  if (typeof file.path === 'string' && file.path.trim()) return file.path.trim();
  if (typeof file.file === 'string' && file.file.trim()) return file.file.trim();
  if (typeof file.filename === 'string' && file.filename.trim()) return file.filename.trim();
  return null;
}

function buildFallbackReviewSummary(parsed) {
  const fallbackRisk = normalizeRiskValue(parsed?.riskLevel, 'medium');
  const groupCount = Array.isArray(parsed?.changeGroups) ? parsed.changeGroups.length : 0;
  const recommendationCount = Array.isArray(parsed?.recommendations) ? parsed.recommendations.length : 0;
  const candidateCount = Array.isArray(parsed?.candidateFindings) ? parsed.candidateFindings.length : 0;
  return `Automated review completed (${fallbackRisk} risk). Parsed ${groupCount} change group${groupCount === 1 ? '' : 's'}, ${recommendationCount} recommendation${recommendationCount === 1 ? '' : 's'}, and ${candidateCount} candidate finding${candidateCount === 1 ? '' : 's'}.`;
}

function buildAtlasAgentMetadata(parsed) {
  const metadata = {};
  const stats = (parsed?.stats && typeof parsed.stats === 'object' && !Array.isArray(parsed.stats))
    ? parsed.stats
    : null;
  const statsAtlasAgent = stats?.atlasAgent;
  if (statsAtlasAgent && typeof statsAtlasAgent === 'object' && !Array.isArray(statsAtlasAgent)) {
    Object.assign(metadata, statsAtlasAgent);
  } else if (statsAtlasAgent != null) {
    metadata.rawStatsAtlasAgent = statsAtlasAgent;
  }

  const topLevelAtlasAgent = parsed?.atlasAgent;
  if (topLevelAtlasAgent && typeof topLevelAtlasAgent === 'object' && !Array.isArray(topLevelAtlasAgent)) {
    Object.assign(metadata, topLevelAtlasAgent);
  } else if (topLevelAtlasAgent != null) {
    metadata.rawTopLevelAtlasAgent = topLevelAtlasAgent;
  }

  const topLevelExtras = {};
  if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      if (REVIEW_RESULT_TOP_LEVEL_KEYS.has(key)) continue;
      if (key === 'atlasAgent') continue;
      topLevelExtras[key] = value;
    }
  }
  if (Object.keys(topLevelExtras).length > 0) {
    metadata.topLevel = topLevelExtras;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function detectReviewContractVersion(parsed) {
  const topLevel = String(parsed?.contractVersion || parsed?.schema || '').trim();
  if (/atlas_review_result\.v2/i.test(topLevel)) return 'atlas_review_result.v2';
  if (/atlas_review_result\.v1/i.test(topLevel)) return 'atlas_review_result.v1';

  const stats = parsed?.stats && typeof parsed.stats === 'object' ? parsed.stats : {};
  const statsVersion = String(stats?.contractVersion || stats?.schema || '').trim();
  if (/atlas_review_result\.v2/i.test(statsVersion)) return 'atlas_review_result.v2';
  if (/atlas_review_result\.v1/i.test(statsVersion)) return 'atlas_review_result.v1';

  const hasEvidenceObject = Array.isArray(parsed?.recommendations)
    && parsed.recommendations.some((rec) => rec && typeof rec?.evidence === 'object' && !Array.isArray(rec.evidence));
  if (hasEvidenceObject) return 'atlas_review_result.v2';
  return 'atlas_review_result.v1';
}

function normalizeRecommendationEvidence(rawEvidence, {
  fallbackFile = null,
  fallbackLine = null,
  fallbackSnippet = null,
} = {}) {
  const evidence = rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)
    ? rawEvidence
    : {};
  const rawFile = typeof evidence.file === 'string'
    ? evidence.file
    : (typeof fallbackFile === 'string' ? fallbackFile : '');
  const normalizedFile = normalizePathForMatch(rawFile) || null;
  const rawLine = evidence.line != null ? evidence.line : fallbackLine;
  const parsedLine = toNumberOrNull(rawLine);
  const normalizedLine = parsedLine != null && parsedLine > 0 ? Math.floor(parsedLine) : null;
  const snippet = typeof evidence.snippet === 'string' && evidence.snippet.trim()
    ? evidence.snippet.trim()
    : (typeof fallbackSnippet === 'string' && fallbackSnippet.trim() ? fallbackSnippet.trim() : null);
  const reasoning = typeof evidence.reasoning === 'string' && evidence.reasoning.trim()
    ? evidence.reasoning.trim()
    : null;
  const hasAny = Boolean(normalizedFile || normalizedLine || snippet || reasoning);
  if (!hasAny) return null;
  return {
    file: normalizedFile,
    line: normalizedLine,
    snippet,
    reasoning,
  };
}

function normalizeReviewContract(parsed) {
  const statsSource = (parsed?.stats && typeof parsed.stats === 'object' && !Array.isArray(parsed.stats))
    ? { ...parsed.stats }
    : {};
  delete statsSource.atlasAgent;

  // Phase 11: walkthrough is a separate artifact. Fresh review output must
  // NOT include `changeGroups` — if the model still emits one (older
  // prompts cached, model echoes the previous schema), we drop it on the
  // floor here so the persisted reviewJson is shaped against the new
  // contract. Legacy reviews that already persisted `changeGroups` are
  // still readable via `walkthroughService.getWalkthroughForReview`.
  const normalized = {
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : buildFallbackReviewSummary(parsed),
    riskLevel: normalizeRiskValue(parsed?.riskLevel, 'medium'),
    changeGroups: null,
    recommendations: [],
    candidateFindings: [],
    stats: {
      ...statsSource,
      filesAnalyzed: toNonNegativeInteger(statsSource.filesAnalyzed, 0),
      totalAdditions: toNonNegativeInteger(statsSource.totalAdditions, 0),
      totalDeletions: toNonNegativeInteger(statsSource.totalDeletions, 0),
      estimatedComplexity: normalizeComplexityValue(statsSource.estimatedComplexity, 'simple'),
      reviewContractVersion: detectReviewContractVersion(parsed),
    },
  };

  const recommendations = Array.isArray(parsed?.recommendations) ? parsed.recommendations : [];
  for (const recommendation of recommendations) {
    const normalizedRec = normalizeRecommendation(recommendation, {
      allowedFilePathSet: new Set(),
      hasScopedFiles: false,
    });
    if (!normalizedRec) continue;
    normalized.recommendations.push(normalizedRec);
  }

  const candidateFindings = Array.isArray(parsed?.candidateFindings) ? parsed.candidateFindings : [];
  for (const candidateFinding of candidateFindings) {
    const normalizedCandidate = normalizeCandidateFinding(candidateFinding, {
      allowedFilePathSet: new Set(),
      hasScopedFiles: false,
    });
    if (!normalizedCandidate) continue;
    normalized.candidateFindings.push(normalizedCandidate);
  }

  const atlasAgent = buildAtlasAgentMetadata(parsed);
  if (atlasAgent) {
    normalized.stats.atlasAgent = atlasAgent;
  }

  return normalized;
}

function normalizeRecommendation(rawRec, {
  allowedFilePathSet,
  hasScopedFiles,
  agenticMode = false,
  diffLineIndex = null,
}) {
  if (!rawRec || typeof rawRec !== 'object') return null;

  const rec = { ...rawRec };
  rec.type = normalizeRecommendationTypeValue(rec.type);
  rec.severity = normalizeRiskValue(rec.severity, 'low');
  if (rec.type !== 'issue' && (rec.severity === 'high' || rec.severity === 'critical')) {
    rec.severity = 'medium';
  }
  rec.title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : 'Review note';
  rec.description = typeof rec.description === 'string' && rec.description.trim()
    ? rec.description.trim()
    : 'No additional details provided.';
  const normalizedConfidence = normalizeRecommendationConfidenceValue(rec.confidence, null);

  const normalizedEvidence = normalizeRecommendationEvidence(rec.evidence, {
    fallbackFile: rec.file,
    fallbackLine: rec.line,
    fallbackSnippet: rec.evidenceSnippet,
  });
  let normalizedFile = normalizedEvidence?.file
    || (typeof rec.file === 'string' && rec.file.trim() ? normalizePathForMatch(rec.file.trim()) : null);

  const lineNumber = toNumberOrNull(normalizedEvidence?.line ?? rec.line);
  rec.line = lineNumber != null && lineNumber > 0 ? Math.floor(lineNumber) : null;

  if (hasScopedFiles) {
    if (!normalizedFile || !allowedFilePathSet.has(normalizedFile)) {
      if (agenticMode) {
        // Agentic mode: resolve path by suffix match against allowed diff paths.
        // Agent may return paths relative to a subdirectory.
        if (normalizedFile) {
          normalizedFile = resolveAgenticPathToAllowed(normalizedFile, allowedFilePathSet);
        }
        if (!allowedFilePathSet.has(normalizedFile)) {
          // Path couldn't be resolved — null both file and line to avoid
          // broken links in the UI from hallucinated/out-of-scope paths.
          normalizedFile = null;
          rec.line = null;
        }
      } else {
        normalizedFile = null;
        rec.line = null;
      }
    }
  }

  rec.file = normalizedFile;
  if (rec.file || rec.line != null || normalizedEvidence?.snippet || normalizedEvidence?.reasoning) {
    rec.sourceAnchor = {
      file: rec.file || null,
      line: rec.line || null,
      snippet: normalizedEvidence?.snippet || null,
      reasoning: normalizedEvidence?.reasoning || null,
    };
  } else {
    delete rec.sourceAnchor;
  }
  if (normalizedConfidence) {
    rec.confidence = normalizedConfidence;
  } else {
    delete rec.confidence;
  }
  if (normalizedEvidence) {
    rec.evidence = {
      file: rec.file || null,
      line: rec.line || null,
      snippet: normalizedEvidence.snippet || null,
      reasoning: normalizedEvidence.reasoning || null,
    };
    if (typeof rec.evidenceSnippet !== 'string' || !rec.evidenceSnippet.trim()) {
      if (normalizedEvidence.snippet) {
        rec.evidenceSnippet = normalizedEvidence.snippet;
      } else {
        delete rec.evidenceSnippet;
      }
    }
  } else {
    delete rec.evidence;
    if (typeof rec.evidenceSnippet !== 'string' || !rec.evidenceSnippet.trim()) {
      delete rec.evidenceSnippet;
    } else {
      rec.evidenceSnippet = rec.evidenceSnippet.trim();
    }
  }

  if (typeof rec.targetSnippet !== 'string' || !rec.targetSnippet.trim()) {
    delete rec.targetSnippet;
  } else {
    rec.targetSnippet = rec.targetSnippet.trim();
  }

  rec.patchAnchor = resolveRecommendationPatchAnchor({
    diffLineIndex,
    normalizedFile: rec.file,
    sourceLine: rec.line,
    normalizedEvidence,
    evidenceSnippet: rec.evidenceSnippet,
    targetSnippet: rec.targetSnippet,
  });

  if (typeof rec.suggestedFix !== 'string' || !rec.suggestedFix.trim()) {
    delete rec.suggestedFix;
  } else {
    rec.suggestedFix = rec.suggestedFix.trim();
  }

  if (rec.type === 'issue' && !rec.file) {
    rec.line = null;
    rec.evidenceMissing = true;
    rec.confidence = 'low';
    if (!/\bevidence\b|\bdiff\b|\bpath\b/i.test(rec.description)) {
      rec.description = `${rec.description} Evidence gap: file path/line could not be grounded to the reviewed diff.`;
    }
  }

  if (
    rec.type === 'issue'
    && (rec.severity === 'high' || rec.severity === 'critical')
    && !IMPACT_HINT_RE.test(`${rec.title} ${rec.description}`)
  ) {
    rec.description = `${rec.description}${IMPACT_APPENDIX}`;
  }

  return rec;
}

function normalizeCandidateFinding(rawRec, {
  allowedFilePathSet,
  hasScopedFiles,
  agenticMode = false,
  diffLineIndex = null,
}) {
  const candidate = normalizeRecommendation(rawRec, {
    allowedFilePathSet,
    hasScopedFiles,
    agenticMode,
    diffLineIndex,
  });
  if (!candidate) return null;
  if (candidate.type === 'praise') return null;
  candidate.type = candidate.type === 'issue' ? 'issue' : 'suggestion';
  candidate.confidence = normalizeRecommendationConfidenceValue(candidate.confidence, 'medium') || 'medium';
  return candidate;
}

function normalizeChangeGroups(changeGroups, allowedFilePathSet, hasScopedFiles, agenticMode = false) {
  if (!Array.isArray(changeGroups)) return [];

  const groups = [];
  for (const group of changeGroups) {
    if (!group || typeof group !== 'object') continue;
    const normalizedGroup = {
      label: typeof group.label === 'string' && group.label.trim() ? group.label.trim() : 'Changes',
      description: typeof group.description === 'string' && group.description.trim()
        ? group.description.trim()
        : 'Grouped related changes.',
      risk: normalizeRiskValue(group.risk, 'low'),
      files: [],
    };

    const files = Array.isArray(group.files) ? group.files : [];
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const compatiblePath = resolveChangeGroupFilePath(file);
      if (!compatiblePath) continue;
      let normalizedPath = normalizePathForMatch(compatiblePath);
      if (!normalizedPath) continue;
      if (hasScopedFiles && !allowedFilePathSet.has(normalizedPath)) {
        if (agenticMode) {
          // Agentic mode: resolve path by suffix match against allowed diff paths.
          normalizedPath = resolveAgenticPathToAllowed(normalizedPath, allowedFilePathSet);
          if (!allowedFilePathSet.has(normalizedPath)) {
            // Path couldn't be resolved — skip to avoid broken links from
            // hallucinated/out-of-scope paths in change group file lists.
            continue;
          }
        } else {
          continue;
        }
      }

      normalizedGroup.files.push({
        path: normalizedPath,
        additions: toNonNegativeInteger(file.additions, 0),
        deletions: toNonNegativeInteger(file.deletions, 0),
        description: typeof file.description === 'string' && file.description.trim()
          ? file.description.trim()
          : 'Changes in this file.',
      });
    }

    if (normalizedGroup.files.length === 0) continue;
    groups.push(normalizedGroup);
  }

  return groups.slice(0, MAX_CHANGE_GROUPS);
}

function reconcileReviewRiskLevel(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  const actionableRecommendations = recommendations.filter((rec) => rec && rec.type !== 'praise');

  // If actionable findings exist, overall risk should reflect the highest
  // actionable finding severity (not model-declared/change-group-only risk).
  if (actionableRecommendations.length > 0) {
    let highestActionableRisk = 'low';
    for (const rec of actionableRecommendations) {
      if (
        VALID_RISK_LEVELS.includes(rec.severity)
        && RECOMMENDATION_SEVERITY_WEIGHT[rec.severity] > RECOMMENDATION_SEVERITY_WEIGHT[highestActionableRisk]
      ) {
        highestActionableRisk = rec.severity;
      }
    }
    parsed.riskLevel = highestActionableRisk;
    return parsed;
  }

  let effectiveRisk = VALID_RISK_LEVELS.includes(parsed.riskLevel) ? parsed.riskLevel : 'medium';

  const changeGroups = Array.isArray(parsed.changeGroups) ? parsed.changeGroups : [];
  for (const group of changeGroups) {
    if (
      VALID_RISK_LEVELS.includes(group?.risk)
      && RECOMMENDATION_SEVERITY_WEIGHT[group.risk] > RECOMMENDATION_SEVERITY_WEIGHT[effectiveRisk]
    ) {
      effectiveRisk = group.risk;
    }
  }

  parsed.riskLevel = effectiveRisk;
  return parsed;
}

function applyReviewQualityGuards(parsed, context = {}) {
  const allowedFilePathSet = normalizeContextFilePathSet(context.filePaths);
  const hasScopedFiles = allowedFilePathSet.size > 0;
  const isAgenticMode = context?.agenticMode === true;
  const requireEvidence = context?.reviewPolicy?.defaults?.requireEvidence !== false;
  const diffLineIndex = buildRenderedDiffLineIndex(context?.diffText || '');

  const normalizedRecs = [];
  const seen = new Set();
  const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  for (const recommendation of recommendations) {
    const normalizedRec = normalizeRecommendation(recommendation, {
      allowedFilePathSet,
      hasScopedFiles,
      agenticMode: isAgenticMode,
      diffLineIndex,
    });
    if (!normalizedRec) continue;
    const key = recommendationKey(normalizedRec);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedRecs.push(normalizedRec);
  }

  // Agentic mode: filter recommendations with zero evidence (no file, no line, no snippet, no reasoning).
  // Agentic reviewers read code directly so should always have grounding.
  const evidenceFilteredRecs = isAgenticMode && requireEvidence
    ? normalizedRecs.filter(rec => {
      if (rec.type === 'praise') return true;
      const ev = rec.evidence;
      const hasAnyEvidence = rec.file || rec.line
        || (ev && (ev.file || ev.line || ev.snippet || ev.reasoning));
      return Boolean(hasAnyEvidence);
    })
    : normalizedRecs;

  evidenceFilteredRecs.sort((a, b) => {
    const scoreDiff = recommendationScore(b) - recommendationScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.title).localeCompare(String(b.title));
  });

  const contextFileCount = toNumberOrNull(context.fileCount);
  const statsFileCount = toNumberOrNull(parsed.stats?.filesAnalyzed);
  const effectiveFileCount = contextFileCount ?? statsFileCount ?? (hasScopedFiles ? allowedFilePathSet.size : 0);
  parsed.recommendations = evidenceFilteredRecs;
  reconcileReviewRiskLevel(parsed);
  const floorEligibleRecommendations = evidenceFilteredRecs.filter(rec => {
    if (rec.type === 'praise') return true;
    if (normalizeRiskValue(rec.severity, 'low') !== 'low') return true;
    if (hasConcreteImpact(rec)) return true;
    if (!isNonSourceFile(rec.file)) return true;
    return false;
  });

  const rawBudget = getRecommendationBudget(effectiveFileCount, floorEligibleRecommendations, {
    riskLevel: parsed.riskLevel,
    maxRecommendations: resolvePolicyMaxRecommendations(context.reviewPolicy),
  });
  const policyCap = resolvePolicyMaxRecommendations(context.reviewPolicy);
  // Agentic mode: 1.5x budget multiplier — agent has better context, allow more valid findings
  const boostedBudget = isAgenticMode ? Math.ceil(rawBudget * 1.5) : rawBudget;
  const recommendationBudget = policyCap != null
    ? Math.min(boostedBudget, policyCap)
    : boostedBudget;
  const floorFilteredRecommendations = floorEligibleRecommendations.slice(0, recommendationBudget);

  // Phase 11: walkthrough/changeGroups is a separate artifact. Drop on the
  // floor here so quality-guarded review output never carries it forward.
  parsed.changeGroups = null;
  parsed.recommendations = floorFilteredRecommendations;

  const normalizedCandidates = [];
  const seenCandidates = new Set();
  const candidateFindings = Array.isArray(parsed.candidateFindings) ? parsed.candidateFindings : [];
  for (const candidateFinding of candidateFindings) {
    const normalizedCandidate = normalizeCandidateFinding(candidateFinding, {
      allowedFilePathSet,
      hasScopedFiles,
      agenticMode: isAgenticMode,
      diffLineIndex,
    });
    if (!normalizedCandidate) continue;
    const key = recommendationKey(normalizedCandidate);
    if (seen.has(key) || seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    normalizedCandidates.push(normalizedCandidate);
  }

  const evidenceFilteredCandidates = isAgenticMode && requireEvidence
    ? normalizedCandidates.filter((candidate) => {
      const ev = candidate.evidence;
      const hasAnyEvidence = candidate.file || candidate.line
        || (ev && (ev.file || ev.line || ev.snippet || ev.reasoning));
      return Boolean(hasAnyEvidence);
    })
    : normalizedCandidates;

  evidenceFilteredCandidates.sort((a, b) => {
    const scoreDiff = recommendationScore(b) - recommendationScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.title).localeCompare(String(b.title));
  });

  parsed.candidateFindings = evidenceFilteredCandidates.slice(0, REVIEW_CANDIDATE_PROMOTION_MAX_FINDINGS);

  const totalAdditions = toNumberOrNull(context.totalAdditions) ?? toNumberOrNull(parsed.stats?.totalAdditions) ?? 0;
  const totalDeletions = toNumberOrNull(context.totalDeletions) ?? toNumberOrNull(parsed.stats?.totalDeletions) ?? 0;

  if (!parsed.stats || typeof parsed.stats !== 'object') parsed.stats = {};
  parsed.stats.filesAnalyzed = effectiveFileCount;
  parsed.stats.totalAdditions = totalAdditions;
  parsed.stats.totalDeletions = totalDeletions;
  parsed.stats.candidateFindingsCount = parsed.candidateFindings.length;
  if (!VALID_COMPLEXITIES.includes(parsed.stats.estimatedComplexity)) {
    parsed.stats.estimatedComplexity = 'simple';
  }

  reconcileReviewRiskLevel(parsed);

  return parsed;
}

/**
 * Parse and validate the AI response into a ReviewResult
 * @param {string} text - Raw AI response text
 * @param {Object} [context]
 * @returns {Object} Validated ReviewResult
 */
function parseReviewResponse(text, context = {}) {
  const qualityV2 = isReviewQualityV2Enabled(context.qualityMode);
  const disableQualityGuards = context?.disableQualityGuards === true;
  const cleaned = String(text || '').trim();

  const DISCOVERY_HEADINGS = [
    'Summary',
    'Overall risk',
    'Issues',
    'Candidate concerns',
    'Positives',
  ];

  const parseDiscoverySection = (input, heading) => {
    const pattern = new RegExp(`(?:^|\\n)${heading}:\\s*\\n?([\\s\\S]*?)(?=\\n(?:${DISCOVERY_HEADINGS.join('|')}):|$)`, 'i');
    const match = String(input || '').match(pattern);
    return match?.[1]?.trim() || '';
  };

  const parseDiscoveryFindings = (sectionText, fallbackSeverity = 'medium') => {
    const source = String(sectionText || '').trim();
    if (!source || /^none$/i.test(source)) return [];

    const blocks = source
      .split(/\n(?=- \[)/)
      .map((block) => block.trim())
      .filter(Boolean);

    return blocks.map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      const header = lines.shift() || '';
      const headerMatch = header.match(/^- \[(critical|high|medium|low)\]\s+(.+)$/i);
      const finding = {
        severity: (headerMatch?.[1] || fallbackSeverity).toLowerCase(),
        title: headerMatch?.[2]?.trim() || header.replace(/^- /, '').trim() || 'Untitled concern',
        file: null,
        line: null,
        why: '',
        snippet: '',
        fix: '',
      };

      for (const line of lines) {
        const kv = line.match(/^([a-zA-Z ]+):\s*(.*)$/);
        if (!kv) continue;
        const key = kv[1].trim().toLowerCase();
        const value = kv[2].trim();
        if (key === 'file') {
          finding.file = value && value !== '?' ? value : null;
        } else if (key === 'line') {
          const parsedLine = Number.parseInt(value, 10);
          finding.line = Number.isFinite(parsedLine) ? parsedLine : null;
        } else if (key === 'why') {
          finding.why = value && value !== '?' ? value : '';
        } else if (key === 'snippet') {
          finding.snippet = value && value !== '?' ? value : '';
        } else if (key === 'fix') {
          finding.fix = value && value !== '?' ? value : '';
        }
      }

      return finding;
    });
  };

  const toRecommendation = (entry, type = 'issue') => ({
    type,
    severity: entry.severity || 'medium',
    title: entry.title || 'Untitled concern',
    description: entry.why || entry.title || 'No additional details provided.',
    file: entry.file || null,
    line: entry.line || null,
    evidence: {
      file: entry.file || null,
      line: entry.line || null,
      snippet: entry.snippet || '',
      reasoning: entry.why || entry.title || '',
    },
    suggestedFix: entry.fix || '',
  });

  const salvageSectionReviewPayload = (input) => {
    const source = String(input || '').trim();
    if (!source) return null;

    const summary = parseDiscoverySection(source, 'Summary');
    const overallRiskMatch = source.match(/Overall risk:\s*(low|medium|high|critical)/i);
    const issues = parseDiscoveryFindings(parseDiscoverySection(source, 'Issues'), 'medium');
    const candidateConcerns = parseDiscoveryFindings(parseDiscoverySection(source, 'Candidate concerns'), 'medium');
    const positivesSection = parseDiscoverySection(source, 'Positives');
    const positives = !positivesSection || /^none$/i.test(positivesSection)
      ? []
      : positivesSection
        .split('\n')
        .map((line) => line.replace(/^- /, '').trim())
        .filter(Boolean);

    const hasStructuredSections = Boolean(
      summary
      || overallRiskMatch
      || issues.length > 0
      || candidateConcerns.length > 0
      || positives.length > 0
    );
    if (!hasStructuredSections) return null;

    return {
      summary: summary || 'Automated review completed with recovered structured output.',
      riskLevel: (overallRiskMatch?.[1] || 'medium').toLowerCase(),
      changeGroups: [],
      recommendations: issues.map((entry) => toRecommendation(entry, 'issue')),
      candidateFindings: candidateConcerns.map((entry) => toRecommendation(entry, 'suggestion')),
      stats: {
        positives,
      },
    };
  };

  const looksLikeProviderError = (input) => {
    const source = String(input || '').trim();
    if (!source) return true;
    return /^(error|failed|exception|traceback|timeout|deadline exceeded|authentication failed|unauthorized|forbidden|cannot connect)\b/i.test(source);
  };

  const salvageMinimalFallbackPayload = (input) => {
    const source = String(input || '').trim();
    if (!source || source.length < 32 || looksLikeProviderError(source)) return null;

    let summary = null;
    const summaryMatch = source.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (summaryMatch) {
      try {
        const unescaped = JSON.parse(`"${summaryMatch[1]}"`);
        if (typeof unescaped === 'string' && unescaped.trim().length >= 16) {
          summary = unescaped.trim();
        }
      } catch {
        summary = null;
      }
    }

    if (!summary) {
      const normalizedText = source
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalizedText.length < 24) return null;
      summary = normalizedText.length > 480
        ? `${normalizedText.slice(0, 477).trim()}...`
        : normalizedText;
    }

    const riskMatch = source.match(/"riskLevel"\s*:\s*"(low|medium|high|critical)"/i)
      || source.match(/\b(low|medium|high|critical)\s+risk\b/i);

    return {
      summary,
      riskLevel: (riskMatch?.[1] || 'medium').toLowerCase(),
      changeGroups: [],
      recommendations: [],
      candidateFindings: [],
      stats: {},
    };
  };

  const uniqueCandidates = [];
  const seenCandidates = new Set();
  const pushCandidate = (candidate, mode = 'raw_json') => {
    if (!candidate || typeof candidate !== 'string') return;
    const normalized = candidate.trim();
    if (!normalized || seenCandidates.has(normalized)) return;
    seenCandidates.add(normalized);
    uniqueCandidates.push({ text: normalized, mode });
  };

  const repairLikelyJsonStringEscapes = (input) => {
    if (typeof input !== 'string' || !input.includes('\\')) return input;

    let output = '';
    let inString = false;
    const isHex = (value) => /^[0-9a-fA-F]$/.test(value);

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];

      if (!inString) {
        output += ch;
        if (ch === '"') {
          inString = true;
        }
        continue;
      }

      if (ch === '\\') {
        const next = input[i + 1];
        if (!next) {
          output += '\\\\';
          continue;
        }
        if ('"\\/bfnrt'.includes(next)) {
          output += `\\${next}`;
          i += 1;
          continue;
        }
        if (next === 'u') {
          const codepoints = input.slice(i + 2, i + 6);
          if (codepoints.length === 4 && codepoints.split('').every(isHex)) {
            output += `\\u${codepoints}`;
            i += 5;
            continue;
          }
        }
        output += '\\\\';
        continue;
      }

      output += ch;
      if (ch === '"') {
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && input[j] === '\\'; j -= 1) {
          backslashCount += 1;
        }
        if (backslashCount % 2 === 0) {
          inString = false;
        }
      }
    }

    return output;
  };

  const repairLikelyJsonStructure = (input) => {
    if (typeof input !== 'string' || input.length === 0) return input;

    let output = '';
    let inString = false;
    let escapeNext = false;
    let previousSignificantChar = '';

    const isValueStartChar = (ch) => (
      ch === '"'
      || ch === '{'
      || ch === '['
      || ch === '-'
      || (ch >= '0' && ch <= '9')
      || ch === 't'
      || ch === 'f'
      || ch === 'n'
    );
    const isValueEndChar = (ch) => (
      ch === '"'
      || ch === '}'
      || ch === ']'
      || (ch >= '0' && ch <= '9')
      || ch === 'e'
      || ch === 'E'
      || ch === 'l'
    );

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];

      if (inString) {
        output += ch;
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (ch === '\\') {
          escapeNext = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
          previousSignificantChar = '"';
        }
        continue;
      }

      if (/\s/.test(ch)) {
        output += ch;
        continue;
      }

      if (
        previousSignificantChar
        && isValueEndChar(previousSignificantChar)
        && isValueStartChar(ch)
      ) {
        output += ',';
        previousSignificantChar = ',';
      }

      if ((ch === '}' || ch === ']') && previousSignificantChar === ',') {
        output = output.replace(/,\s*$/, '');
      }

      output += ch;
      if (ch === '"') {
        inString = true;
      }
      previousSignificantChar = ch;
    }

    return output;
  };

  // 1) Raw text as-is.
  pushCandidate(cleaned, 'raw_json');

  // 2) Markdown fenced JSON block.
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    pushCandidate(fenceMatch[1], 'fenced_json');
  }

  // 3) Legacy behavior: strip leading/trailing fences if the whole response is fenced.
  if (cleaned.startsWith('```')) {
    pushCandidate(cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''), 'stripped_fence_json');
  }

  // 4) First balanced JSON object in mixed prose responses.
  const extractFirstJsonObject = (input) => {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];

      if (start === -1) {
        if (ch === '{') {
          start = i;
          depth = 1;
        }
        continue;
      }

      if (inString) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (ch === '\\') {
          escapeNext = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        continue;
      }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return input.slice(start, i + 1);
        }
      }
    }

    return null;
  };

  const extractedObject = extractFirstJsonObject(cleaned);
  if (extractedObject) {
    pushCandidate(extractedObject, 'extracted_json_object');
  }

  for (const candidate of [...uniqueCandidates]) {
    const repaired = repairLikelyJsonStringEscapes(candidate.text);
    if (repaired !== candidate.text) {
      pushCandidate(repaired, 'repaired_json');
    }
    const repairedStructure = repairLikelyJsonStructure(repaired);
    if (repairedStructure !== repaired) {
      pushCandidate(repairedStructure, 'repaired_json');
    }
  }

  let parsed = null;
  let lastParseError = null;
  let parseMode = null;
  let parseRecovered = false;
  for (const candidate of uniqueCandidates) {
    try {
      parsed = JSON.parse(candidate.text);
      parseMode = (
        candidate.mode === 'raw_json'
          ? 'strict_json'
          : (candidate.mode === 'fenced_json' || candidate.mode === 'stripped_fence_json')
            ? 'fenced_json'
            : 'repaired_json'
      );
      parseRecovered = parseMode === 'repaired_json';
      break;
    } catch (error) {
      lastParseError = error;
    }
  }
  if (!parsed) {
    parsed = salvageSectionReviewPayload(cleaned);
    if (parsed) {
      parseMode = 'section_salvage';
      parseRecovered = true;
    }
  }
  if (!parsed) {
    parsed = salvageMinimalFallbackPayload(cleaned);
    if (parsed) {
      parseMode = 'minimal_fallback';
      parseRecovered = true;
    }
  }
  if (!parsed) {
    throw new Error(`Failed to parse review response as JSON: ${lastParseError?.message || 'unknown parse error'}`);
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Review response must be a JSON object');
  }

  // In agentic mode, reject empty or near-empty objects that lack any review content.
  // The agent reads actual code, so a valid response must contain a summary, recommendations, or changeGroups.
  // (Non-agentic mode tolerates minimal responses like `{riskLevel: "low"}` since normalizeReviewContract
  // synthesizes defaults — this is intentional for partial chunk results.)
  if (context?.agenticMode) {
    const hasAnySummary = typeof parsed.summary === 'string' && parsed.summary.trim().length > 0;
    const hasAnyRecs = Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0;
    const hasAnyCandidateFindings = Array.isArray(parsed.candidateFindings) && parsed.candidateFindings.length > 0;
    const hasAnyCGs = Array.isArray(parsed.changeGroups || parsed.change_groups) && (parsed.changeGroups || parsed.change_groups).length > 0;
    if (!hasAnySummary && !hasAnyRecs && !hasAnyCandidateFindings && !hasAnyCGs) {
      throw new Error(`Agentic review response is an empty or minimal JSON object without review content (keys: ${Object.keys(parsed).join(', ') || 'none'})`);
    }
  }

  parsed = normalizeReviewContract(parsed);
  if (!parsed.stats || typeof parsed.stats !== 'object') parsed.stats = {};
  parsed.stats.parseMode = parseMode || 'strict_json';
  parsed.stats.parseRecovered = parseRecovered;
  const normalized = qualityV2 && !disableQualityGuards
    ? applyReviewQualityGuards(parsed, context)
    : parsed;
  return reconcileReviewRiskLevel(normalized);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  // Prompt construction
  buildReviewPrompt,

  // Response parsing
  parseReviewResponse,

  // Quality guards and normalization
  applyReviewQualityGuards,
  reconcileReviewRiskLevel,
  normalizeRecommendation,
  normalizeChangeGroups,
  normalizeReviewContract,

  // Severity floor filter helpers
  SEVERITY_FLOOR_NON_SOURCE_EXTENSIONS,
  isNonSourceFile,
  hasConcreteImpact,

  // Recommendation helpers
  recommendationScore,
  recommendationKey,
  getRecommendationBudget,

  // Normalization helpers
  normalizeRiskValue,
  normalizeRecommendationTypeValue,
  normalizeRecommendationConfidenceValue,
  normalizeComplexityValue,
  toNonNegativeInteger,
  resolveChangeGroupFilePath,
  normalizeRecommendationEvidence,
  detectReviewContractVersion,
  buildFallbackReviewSummary,
  buildAtlasAgentMetadata,
  buildRenderedDiffLineIndex,
  formatNumberedDiff,
  normalizePathForMatch,
  normalizeContextFilePathSet,
};
