import githubService from './githubService.js';
import reviewOutcomeService from './reviewOutcomeService.js';
import reviewPublicationService, { REVIEW_DECISION_PUBLICATION_KEY } from './reviewPublicationService.js';
import reviewSyncService from './reviewSyncService.js';
import { getProjectById } from '../db/queries.js';
import { buildReviewActionEligibility, buildReviewLifecycle } from '../utils/reviewLifecycle.js';

const GITHUB_CHANNEL = 'github_pr_review';
const REVIEW_TYPE = 'pr_review';
const VALID_ACTIONS = new Set(['comment', 'approve', 'request_changes']);
const NON_REVIEWABLE_PATCH_STATUSES = new Set([
  'outside_patch',
  'file_not_in_diff',
  'diff_unavailable',
  'unanchored',
]);
const SAFE_INLINE_PATCH_STATUSES = new Set(['exact', 'exact_block']);
const SOURCE_LINE_FALLBACK_PATCH_STATUSES = new Set([
  'file_not_in_diff',
  'diff_unavailable',
  'unanchored',
]);
const MAX_NON_INLINE_FINDINGS_IN_BODY = 8;
const SAFE_APPLYABLE_SUGGESTION_STATUSES = new Set(['exact', 'exact_block']);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveLineNumber(value) {
  const line = Number(value);
  if (!Number.isFinite(line) || line <= 0) return null;
  return Math.trunc(line);
}

function normalizeAction(value) {
  const action = normalizeText(value).toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    throw new Error('action must be one of: comment, approve, request_changes');
  }
  return action;
}

function normalizeRecommendationKeyList(values) {
  if (!Array.isArray(values)) return [];
  const deduped = [];
  const seen = new Set();
  for (const value of values) {
    const key = normalizeText(value).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(key);
  }
  return deduped;
}

function normalizeCommentOverrideMap(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const key = normalizeText(rawKey).toLowerCase();
    const body = normalizeText(rawValue);
    if (!key || !body) continue;
    normalized[key] = body;
  }
  return normalized;
}

function normalizeManualLineComments(values) {
  if (!Array.isArray(values)) return [];
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const id = normalizeText(value.id);
    const path = normalizeText(value.path);
    const line = Number.isFinite(Number(value.line)) ? Math.trunc(Number(value.line)) : null;
    const side = normalizeText(value.side).toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
    const body = normalizeText(value.body);
    if (!id || !path || !line || !body || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, path, line, side, body });
  }
  return normalized;
}

function getReviewLifecycle(prReview) {
  return buildReviewLifecycle({
    reviewStatus: prReview.reviewStatus ?? 'none',
    errorMessage: prReview.reviewError ?? null,
    reviewedAt: prReview.reviewedAt ?? null,
    updatedAt: prReview.updatedAt ?? null,
    sourceStatus: prReview.reviewStatus ?? null,
  });
}

function getActionEligibility(prReview) {
  const lifecycle = prReview.reviewLifecycle || getReviewLifecycle(prReview);
  return buildReviewActionEligibility(prReview, lifecycle);
}

function normalizeRecommendation(recommendation) {
  if (!recommendation || typeof recommendation !== 'object' || Array.isArray(recommendation)) return null;
  const sourceFile = normalizeText(recommendation.file || recommendation.path || '');
  const sourceLine = Number.isFinite(Number(recommendation.line)) ? Math.trunc(Number(recommendation.line)) : null;
  const rawPatchFile = recommendation.patchAnchor && typeof recommendation.patchAnchor === 'object'
    ? recommendation.patchAnchor.file
    : null;
  const rawPatchLine = recommendation.patchAnchor && typeof recommendation.patchAnchor === 'object'
    ? recommendation.patchAnchor.line
    : null;
  const rawPatchStartLine = recommendation.patchAnchor && typeof recommendation.patchAnchor === 'object'
    ? recommendation.patchAnchor.startLine
    : null;
  const rawPatchEndLine = recommendation.patchAnchor && typeof recommendation.patchAnchor === 'object'
    ? recommendation.patchAnchor.endLine
    : null;
  const patchStatus = recommendation.patchAnchor && typeof recommendation.patchAnchor === 'object'
    ? normalizeText(recommendation.patchAnchor.status).toLowerCase()
    : '';
  const patchAnchorUsable = !NON_REVIEWABLE_PATCH_STATUSES.has(patchStatus);
  const rawNormalizedPatchLine = patchAnchorUsable ? normalizePositiveLineNumber(rawPatchLine) : null;
  const rawNormalizedPatchStartLine = patchAnchorUsable ? normalizePositiveLineNumber(rawPatchStartLine) : null;
  const rawNormalizedPatchEndLine = patchAnchorUsable ? normalizePositiveLineNumber(rawPatchEndLine) : null;
  let patchStartLine = rawNormalizedPatchStartLine ?? rawNormalizedPatchLine;
  let patchEndLine = rawNormalizedPatchEndLine ?? rawNormalizedPatchLine ?? rawNormalizedPatchStartLine;
  if (patchStartLine && patchEndLine && patchStartLine > patchEndLine) {
    [patchStartLine, patchEndLine] = [patchEndLine, patchStartLine];
  }
  const patchLine = rawNormalizedPatchLine ?? patchEndLine ?? patchStartLine;
  return {
    ...recommendation,
    file: sourceFile,
    patchFile: normalizeText(rawPatchFile || '') || sourceFile,
    line: sourceLine,
    patchLine,
    patchStartLine,
    patchEndLine,
    patchStatus,
    title: normalizeText(recommendation.title),
    description: normalizeText(recommendation.description),
    targetSnippet: normalizeText(recommendation.targetSnippet),
    suggestedFix: normalizeText(recommendation.suggestedFix),
    type: normalizeText(recommendation.type).toLowerCase() || 'suggestion',
    severity: normalizeText(recommendation.severity).toLowerCase() || 'medium',
  };
}

function isCommentEligibleRecommendation(recommendation) {
  if (!recommendation || recommendation.type === 'praise') return false;
  if (recommendation.commentEligible === true) return true;
  if (
    recommendation.commentEligibility
    && typeof recommendation.commentEligibility === 'object'
    && recommendation.commentEligibility.eligible === true
  ) {
    return true;
  }
  return false;
}

function canPublishInlineRecommendation(recommendation) {
  if (!recommendation || recommendation.type === 'praise') return false;
  const targetPath = normalizeText(recommendation.patchFile || recommendation.file);
  const targetLine = recommendation.patchLine ?? recommendation.line;
  const patchStatus = normalizeText(recommendation.patchStatus).toLowerCase();
  return Boolean(targetPath && targetLine && SAFE_INLINE_PATCH_STATUSES.has(patchStatus));
}

function stripCommentBoilerplate(text) {
  return String(text || '')
    .replace(/\s*Impact:\s*This may cause correctness, security, data integrity, or availability issues\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferFenceLanguage(filePath) {
  const path = normalizeText(filePath).toLowerCase();
  if (path.endsWith('.cs')) return 'csharp';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'ts';
  if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.mjs')) return 'javascript';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.java')) return 'java';
  if (path.endsWith('.cpp') || path.endsWith('.cc') || path.endsWith('.cxx')) return 'cpp';
  if (path.endsWith('.c') || path.endsWith('.h')) return 'c';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  if (path.endsWith('.sh')) return 'bash';
  return '';
}

function normalizeComparableSnippetLines(snippet) {
  if (typeof snippet !== 'string') return [];
  return snippet
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => {
      if (line) return true;
      return index !== 0 && index !== lines.length - 1;
    })
    .filter(Boolean);
}

function buildGitHubSuggestionBlock(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  const suggestedFix = normalizeText(recommendation.suggestedFix);
  const targetSnippet = normalizeText(recommendation.targetSnippet);
  if (!targetSnippet || !suggestedFix || suggestedFix.includes('```') || targetSnippet.includes('```')) return null;

  const patchStatus = normalizeText(recommendation.patchStatus).toLowerCase();
  if (!SAFE_APPLYABLE_SUGGESTION_STATUSES.has(patchStatus)) return null;

  const startLine = normalizePositiveLineNumber(
    recommendation.patchStartLine ?? recommendation.patchLine ?? recommendation.line
  );
  const endLine = normalizePositiveLineNumber(
    recommendation.patchEndLine ?? recommendation.patchLine ?? recommendation.line
  );
  if (!startLine || !endLine || endLine < startLine) return null;

  const selectedLineCount = endLine - startLine + 1;
  const targetLineCount = normalizeComparableSnippetLines(targetSnippet).length;
  if (targetLineCount !== selectedLineCount) return null;
  if (selectedLineCount <= 1 && patchStatus !== 'exact') return null;
  if (selectedLineCount > 1 && patchStatus !== 'exact_block') return null;

  return `**Suggested change**\n\n\`\`\`suggestion\n${suggestedFix}\n\`\`\``;
}

function formatSuggestedFixBlock(suggestedFix, filePath) {
  const text = normalizeText(suggestedFix);
  if (!text) return null;
  if (!text.includes('\n')) {
    return `**Suggested fix**\n\n\`${text}\``;
  }
  const language = inferFenceLanguage(filePath);
  return `**Suggested fix**\n\n\`\`\`${language}\n${text}\n\`\`\``;
}

function buildRecommendationCommentBody(recommendation) {
  const lines = [];
  const severity = String(recommendation.severity || '').trim().toUpperCase() || 'MEDIUM';
  const title = recommendation.title || 'Atlas finding';
  lines.push(`**[${severity}] ${title}**`);
  const description = stripCommentBoilerplate(recommendation.description);
  if (description) {
    lines.push('');
    lines.push(description);
  }
  const suggestedFixBlock = buildGitHubSuggestionBlock(recommendation)
    || formatSuggestedFixBlock(recommendation.suggestedFix, recommendation.file);
  if (suggestedFixBlock) {
    lines.push('');
    lines.push(suggestedFixBlock);
  }
  return lines.join('\n').trim();
}

function buildPublishedRecommendationCommentBody(recommendation, userComment = '') {
  const generatedBody = buildRecommendationCommentBody(recommendation);
  const normalizedUserComment = normalizeText(userComment);
  if (!normalizedUserComment) return generatedBody;
  return [
    generatedBody,
    '',
    '---',
    '',
    '**Reviewer comment**',
    '',
    normalizedUserComment,
  ].join('\n').trim();
}

function formatRecommendationRef(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  const title = normalizeText(recommendation.title) || 'Atlas finding';
  const path = normalizeText(recommendation.path || recommendation.file || '');
  const line = Number.isFinite(Number(recommendation.line)) ? Math.trunc(Number(recommendation.line)) : null;
  if (path && line) return `${title} (${path}:${line})`;
  if (path) return `${title} (${path})`;
  return title;
}

function formatRecommendationSource(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  const path = normalizeText(recommendation.path || recommendation.file || '');
  const line = Number.isFinite(Number(recommendation.line)) ? Math.trunc(Number(recommendation.line)) : null;
  if (path && line) return `${path}:${line}`;
  if (path) return path;
  return null;
}

function formatSkippedReason(reason) {
  if (reason === 'anchor_unavailable') return 'line is not part of the current PR diff';
  if (reason === 'fuzzy_anchor') return 'Atlas could not place this finding on an exact diff line';
  if (reason === 'missing_location') return 'finding has no file/line source';
  if (reason === 'not_comment_eligible') return 'finding is not eligible for inline publication';
  return 'finding could not be posted inline';
}

function buildNonInlineFindingBlock(recommendation, _reason) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  const lines = [];
  const severity = String(recommendation.severity || '').trim().toUpperCase() || 'MEDIUM';
  const title = normalizeText(recommendation.title) || 'Atlas finding';
  const description = stripCommentBoilerplate(recommendation.description);
  const source = formatRecommendationSource(recommendation);
  const suggestedFixBlock = formatSuggestedFixBlock(recommendation.suggestedFix, recommendation.file);
  lines.push(`- **[${severity}] ${title}**`);
  if (description) {
    lines.push(`  ${description}`);
  }
  if (source) {
    lines.push(`  Source: \`${source}\``);
  }
  if (suggestedFixBlock) {
    lines.push('');
    lines.push(suggestedFixBlock.split('\n').map((line) => `  ${line}`.trimEnd()).join('\n'));
  }
  return lines.join('\n');
}

function buildReviewCoverageLabel(prReview) {
  const stats = prReview?.reviewJson?.stats && typeof prReview.reviewJson.stats === 'object' && !Array.isArray(prReview.reviewJson.stats)
    ? prReview.reviewJson.stats
    : {};
  const totalFiles = Math.max(
    0,
    Number(stats.filesTotal)
    || Number(stats.totalChangedFiles)
    || Number(prReview?.fileCount)
    || 0
  );
  const analyzedFiles = Math.max(
    0,
    Number(stats.filesDeepReviewed)
    || Number(stats.deepReviewedFiles)
    || Number(stats.filesAnalyzed)
    || 0
  );
  const omittedFiles = Math.max(
    0,
    Number(stats.omittedFiles)
    || Math.max(0, totalFiles - analyzedFiles)
  );
  if (totalFiles > 0) {
    return `Coverage: ${Math.min(analyzedFiles, totalFiles)} analyzed · ${omittedFiles} omitted`;
  }
  return `Coverage: ${analyzedFiles} analyzed`;
}

function buildCompactReviewBody({ prReview, action = 'comment', publishedCount, skippedResults = [] }) {
  const lines = [];
  const summary = normalizeText(prReview.reviewSummary || prReview.reviewJson?.summary || '');
  const coverageLabel = buildReviewCoverageLabel(prReview);
  const nonInlineFindings = skippedResults.filter((entry) => entry?.reason === 'fuzzy_anchor');
  const leadLine = action === 'request_changes'
    ? `Atlas requested changes and posted ${publishedCount} inline finding${publishedCount !== 1 ? 's' : ''} for this pull request.`
    : `Atlas posted ${publishedCount} inline finding${publishedCount !== 1 ? 's' : ''} for this pull request.`;
  lines.push('💡 **Atlas Review**');
  lines.push('');
  lines.push(leadLine);
  lines.push(coverageLabel);
  if (nonInlineFindings.length > 0) {
    lines.push('');
    const shownCount = Math.min(nonInlineFindings.length, MAX_NON_INLINE_FINDINGS_IN_BODY);
    const countLabel = nonInlineFindings.length > MAX_NON_INLINE_FINDINGS_IN_BODY
      ? `${shownCount} of ${nonInlineFindings.length}`
      : `${nonInlineFindings.length}`;
    lines.push(`Additional findings: ${countLabel}`);
    lines.push('');
    for (const finding of nonInlineFindings.slice(0, MAX_NON_INLINE_FINDINGS_IN_BODY)) {
      const block = buildNonInlineFindingBlock(finding, finding.reason);
      if (block) lines.push(block);
    }
    if (nonInlineFindings.length > MAX_NON_INLINE_FINDINGS_IN_BODY) {
      const overflow = nonInlineFindings.length - MAX_NON_INLINE_FINDINGS_IN_BODY;
      lines.push(`- ${overflow} more non-inline finding${overflow !== 1 ? 's' : ''}`);
    }
  }
  if (summary || skippedResults.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Review summary</summary>');
    if (summary) {
      lines.push('');
      lines.push(summary);
    }
    lines.push('');
    lines.push(`- Inline findings: ${publishedCount}`);
    if (skippedResults.length > 0) {
      lines.push(`- Skipped findings: ${skippedResults.length}`);
    }
    lines.push('');
    lines.push('[Download Atlas on your machine](https://www.atlasengine.dev/)');
    lines.push('</details>');
  }
  return lines.join('\n').trim();
}

function buildSubmissionBody({ prReview, action, publishedCount, skippedResults = [] }) {
  if (action === 'comment' || action === 'request_changes') {
    return buildCompactReviewBody({
      prReview,
      action,
      publishedCount,
      skippedResults,
    });
  }
  const actionLabel = action === 'approve'
      ? 'approve'
      : 'comment';
  const lines = [];
  const prLabel = Number.isFinite(Number(prReview.githubPrNumber))
    ? `PR #${Math.trunc(Number(prReview.githubPrNumber))}`
    : (prReview.displayId || 'this PR');
  lines.push(`Atlas ${actionLabel} review for ${prLabel}`);
  if (prReview.reviewSummary) {
    lines.push('');
    lines.push(prReview.reviewSummary);
  } else if (prReview.reviewJson?.summary) {
    lines.push('');
    lines.push(String(prReview.reviewJson.summary));
  }
  lines.push('');
  lines.push(`Published inline findings: ${publishedCount}`);
  if (skippedResults.length > 0) {
    lines.push(`Skipped findings: ${skippedResults.length}`);
    lines.push('');
    lines.push('Findings that could not be posted inline:');
    for (const skipped of skippedResults.slice(0, 8)) {
      const label = formatRecommendationRef(skipped);
      const reason = formatSkippedReason(skipped.reason);
      lines.push(`- ${label} — ${reason}`);
    }
    if (skippedResults.length > 8) {
      lines.push(`- ${skippedResults.length - 8} more skipped findings`);
    }
  }
  return lines.join('\n').trim();
}

function buildBodyPublishedRecommendationEntries({ body, skippedResults = [] }) {
  if (body == null) return [];
  return skippedResults
    .filter((entry) => entry?.reason === 'fuzzy_anchor' && entry?.recommendationKey)
    .map((entry) => ({
      recommendationKey: entry.recommendationKey,
      manualLineCommentId: null,
      path: entry.path || null,
      line: entry.line || null,
    }));
}

function shouldOmitGeneratedReviewBody({ explicitBodyProvided }) {
  return Boolean(explicitBodyProvided);
}

function buildNoInlineCommentsMessage(results) {
  const entries = Array.isArray(results) ? results : [];
  const alreadyPublishedCount = entries.filter((entry) => entry?.status === 'already_published').length;
  const missingAnchorCount = entries.filter((entry) => entry?.status === 'skipped' && entry?.reason === 'missing_location').length;
  const unavailableAnchorCount = entries.filter((entry) => entry?.status === 'skipped' && entry?.reason === 'anchor_unavailable').length;
  const fuzzyAnchorCount = entries.filter((entry) => entry?.status === 'skipped' && entry?.reason === 'fuzzy_anchor').length;
  const parts = ['No new inline findings could be published for the selected items.'];
  if (alreadyPublishedCount > 0) {
    parts.push(`${alreadyPublishedCount} selected finding${alreadyPublishedCount !== 1 ? 's are' : ' is'} already posted for the current PR head.`);
  }
  if (missingAnchorCount > 0) {
    parts.push(`${missingAnchorCount} selected finding${missingAnchorCount !== 1 ? 's do' : ' does'} not have a file/line anchor.`);
  }
  if (unavailableAnchorCount > 0) {
    parts.push(`${unavailableAnchorCount} selected finding${unavailableAnchorCount !== 1 ? 's no longer match' : ' no longer matches'} the current PR diff.`);
  }
  if (fuzzyAnchorCount > 0) {
    parts.push(`${fuzzyAnchorCount} selected finding${fuzzyAnchorCount !== 1 ? 's do' : ' does'} not have an exact diff anchor.`);
  }
  return parts.join(' ');
}

function collectDiffSideLines(patch, side = 'RIGHT') {
  const lines = new Set();
  const source = typeof patch === 'string' ? patch.replace(/\r\n/g, '\n') : '';
  if (!source.trim()) return lines;

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const normalizedSide = side === 'LEFT' ? 'LEFT' : 'RIGHT';

  for (const rawLine of source.split('\n')) {
    if (rawLine.startsWith('@@')) {
      const match = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) {
        inHunk = false;
        continue;
      }
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      if (normalizedSide === 'RIGHT') {
        lines.add(newLine);
      }
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      if (normalizedSide === 'LEFT') {
        lines.add(oldLine);
      }
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(' ')) {
      lines.add(normalizedSide === 'LEFT' ? oldLine : newLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  return lines;
}

function buildFilePatchLookup(prFiles = []) {
  const byPath = new Map();
  for (const file of Array.isArray(prFiles) ? prFiles : []) {
    const path = normalizeText(file?.filename || file?.path);
    if (!path) continue;
    byPath.set(path, {
      path,
      patch: typeof file?.patch === 'string' ? file.patch : null,
      availableRightLines: collectDiffSideLines(file?.patch, 'RIGHT'),
      availableLeftLines: collectDiffSideLines(file?.patch, 'LEFT'),
    });
  }
  return byPath;
}

function areDiffSideLinesAvailable(availableLines, startLine, endLine = startLine) {
  if (!(availableLines instanceof Set)) return false;
  const start = normalizePositiveLineNumber(startLine);
  const end = normalizePositiveLineNumber(endLine ?? startLine);
  if (!start || !end || end < start) return false;
  for (let line = start; line <= end; line += 1) {
    if (!availableLines.has(line)) return false;
  }
  return true;
}

function mapActionToGitHubEvent(action) {
  if (action === 'approve') return 'APPROVE';
  if (action === 'request_changes') return 'REQUEST_CHANGES';
  return 'COMMENT';
}

function findRecommendationByKey(recommendations, recommendationKey) {
  return recommendations.find((entry) => entry.recommendationKey === recommendationKey) || null;
}

async function listPublications(scope) {
  return reviewPublicationService.listPublications(scope, { channel: GITHUB_CHANNEL });
}

async function publishReview({
  projectId,
  reviewId,
  installationId,
  owner,
  repo,
  prReview,
  action,
  recommendationKeys = [],
  useExplicitRecommendationSelection = false,
  body,
  commentOverridesByRecommendationKey = {},
  manualLineComments = [],
  skipExistingPublicationCheck = false,
}) {
  const normalizedAction = normalizeAction(action);
  const normalizedCommentOverrides = normalizeCommentOverrideMap(commentOverridesByRecommendationKey);
  const normalizedManualLineComments = normalizeManualLineComments(manualLineComments);
  if (!prReview || typeof prReview !== 'object') {
    throw new Error('prReview is required');
  }

  const lifecycle = getReviewLifecycle(prReview);
  const eligibility = getActionEligibility({ ...prReview, reviewLifecycle: lifecycle });
  const actionBlockedReason = normalizedAction === 'approve'
    ? (eligibility.approveBlockedReason || eligibility.blockedReason || null)
    : normalizedAction === 'request_changes'
      ? (eligibility.requestChangesBlockedReason || eligibility.blockedReason || null)
      : (eligibility.blockedReason || null);
  const hasAiFindingPayload = (
    (Array.isArray(recommendationKeys) && recommendationKeys.length > 0)
    || Object.keys(normalizedCommentOverrides).length > 0
  );
  const isMissingReviewBlock = /No completed review is available/i.test(String(actionBlockedReason || ''));
  const allowFreeformActionWithoutAiReview = Boolean(
    isMissingReviewBlock
    && !hasAiFindingPayload
    && (normalizedAction === 'approve' || body !== undefined || normalizedManualLineComments.length > 0)
  );
  const canPerformAction = normalizedAction === 'approve'
    ? eligibility.canApprove !== false
    : normalizedAction === 'request_changes'
      ? eligibility.canRequestChanges !== false
      : (!eligibility.blockedReason || Boolean(eligibility.staleReason));
  if (!canPerformAction && !allowFreeformActionWithoutAiReview) {
    const error = new Error(actionBlockedReason || 'Review cannot be published right now.');
    error.code = 'ACTION_BLOCKED';
    error.statusCode = 409;
    error.blockedReason = actionBlockedReason || null;
    error.staleReason = eligibility.staleReason || null;
    throw error;
  }

  const rawRecommendations = Array.isArray(prReview.reviewJson?.recommendations)
    ? prReview.reviewJson.recommendations
    : [];
  const recommendations = rawRecommendations
    .map((entry) => {
      const normalized = normalizeRecommendation(entry);
      if (!normalized) return null;
      return {
        ...normalized,
        recommendationKey: reviewOutcomeService.getRecommendationIdentityKey(normalized),
      };
    })
    .filter(Boolean);

  const explicitKeys = normalizeRecommendationKeyList(recommendationKeys);
  const outcomesResponse = await reviewOutcomeService.listOutcomes({
    projectId,
    reviewType: REVIEW_TYPE,
    reviewId,
  }, {
    reviewRecommendations: recommendations,
  });
  const outcomesByKey = outcomesResponse.byRecommendationKey || {};
  const publicationState = await reviewPublicationService.listPublications({
    projectId,
    reviewType: REVIEW_TYPE,
    reviewId,
  }, {
    channel: GITHUB_CHANNEL,
  });
  const publicationsByKey = publicationState.byRecommendationKey || {};

  const hasExplicitRecommendationSelection = useExplicitRecommendationSelection === true;
  const selectedRecommendations = hasExplicitRecommendationSelection
    ? explicitKeys.map((key) => findRecommendationByKey(recommendations, key)).filter(Boolean)
    : recommendations.filter((entry) => {
      const outcome = outcomesByKey[entry.recommendationKey] || null;
      return !outcome || (outcome.status !== 'addressed' && outcome.status !== 'dismissed');
    });

  const prFiles = await githubService.getPullRequestFiles(
    installationId,
    owner,
    repo,
    prReview.githubPrNumber
  );
  const filePatchLookup = buildFilePatchLookup(prFiles);

  const results = [];
  const comments = [];
  const headSha = normalizeText(prReview.headSha || prReview.reviewHeadSha || '');

  for (const recommendation of selectedRecommendations) {
    const existingPublication = publicationsByKey[recommendation.recommendationKey] || null;
    if (
      skipExistingPublicationCheck !== true
      && existingPublication
      && existingPublication.headSha
      && headSha
      && existingPublication.headSha === headSha
    ) {
      results.push({
        recommendationKey: recommendation.recommendationKey,
        status: 'already_published',
        reason: 'already_published_for_current_head',
        path: recommendation.file || null,
        line: recommendation.line || null,
      });
      continue;
    }

    const hasExactPatchAnchor = canPublishInlineRecommendation(recommendation);
    let targetPath = normalizeText(recommendation.patchFile || recommendation.file);
    let targetStartLine = recommendation.patchStartLine ?? recommendation.patchLine ?? recommendation.line;
    let targetLine = recommendation.patchEndLine ?? recommendation.patchLine ?? recommendation.line;
    let patchInfo = filePatchLookup.get(targetPath);
    let usedSourceLineFallback = false;

    if (!hasExactPatchAnchor) {
      const sourcePath = normalizeText(recommendation.file);
      const sourceLine = normalizePositiveLineNumber(recommendation.line);
      const sourcePatchInfo = sourcePath ? filePatchLookup.get(sourcePath) : null;
      const patchStatus = normalizeText(recommendation.patchStatus).toLowerCase();
      if (
        sourcePatchInfo
        && sourceLine
        && SOURCE_LINE_FALLBACK_PATCH_STATUSES.has(patchStatus)
        && areDiffSideLinesAvailable(sourcePatchInfo.availableRightLines, sourceLine)
      ) {
        targetPath = sourcePath;
        targetStartLine = sourceLine;
        targetLine = sourceLine;
        patchInfo = sourcePatchInfo;
        usedSourceLineFallback = true;
      }
    }

    if (!hasExactPatchAnchor && !usedSourceLineFallback) {
      const targetPath = normalizeText(recommendation.patchFile || recommendation.file);
      const targetLine = recommendation.patchLine ?? recommendation.line;
      results.push({
        recommendationKey: recommendation.recommendationKey,
        status: 'skipped',
        reason: targetPath && targetLine ? 'fuzzy_anchor' : 'missing_location',
        title: recommendation.title || null,
        severity: recommendation.severity || null,
        path: recommendation.file || null,
        line: recommendation.line || null,
        description: recommendation.description || null,
        suggestedFix: recommendation.suggestedFix || null,
      });
      continue;
    }

    if (!patchInfo || !areDiffSideLinesAvailable(patchInfo.availableRightLines, targetStartLine, targetLine)) {
      results.push({
        recommendationKey: recommendation.recommendationKey,
        status: 'skipped',
        reason: 'anchor_unavailable',
        title: recommendation.title || null,
        severity: recommendation.severity || null,
        path: targetPath || recommendation.file,
        line: targetLine,
        description: recommendation.description || null,
        suggestedFix: recommendation.suggestedFix || null,
      });
      continue;
    }

    comments.push({
      path: targetPath,
      line: targetLine,
      startLine: targetStartLine && targetStartLine < targetLine ? targetStartLine : null,
      side: 'RIGHT',
      startSide: targetStartLine && targetStartLine < targetLine ? 'RIGHT' : null,
      body: buildPublishedRecommendationCommentBody(
        recommendation,
        normalizedCommentOverrides[recommendation.recommendationKey] || ''
      ),
      recommendationKey: recommendation.recommendationKey,
      manualLineCommentId: null,
    });
  }

  for (const manualComment of normalizedManualLineComments) {
    const existingPublication = publicationsByKey[manualComment.id] || null;
    if (
      skipExistingPublicationCheck !== true
      && existingPublication
      && existingPublication.headSha
      && headSha
      && existingPublication.headSha === headSha
    ) {
      results.push({
        recommendationKey: manualComment.id,
        manualLineCommentId: manualComment.id,
        status: 'already_published',
        reason: 'already_published_for_current_head',
        path: manualComment.path,
        line: manualComment.line,
      });
      continue;
    }

    const patchInfo = filePatchLookup.get(manualComment.path);
    const availableLines = manualComment.side === 'LEFT'
      ? patchInfo?.availableLeftLines
      : patchInfo?.availableRightLines;
    if (!patchInfo || !areDiffSideLinesAvailable(availableLines, manualComment.line)) {
      results.push({
        recommendationKey: manualComment.id,
        manualLineCommentId: manualComment.id,
        status: 'skipped',
        reason: 'anchor_unavailable',
        title: 'Manual line comment',
        path: manualComment.path,
        line: manualComment.line,
      });
      continue;
    }

    comments.push({
      path: manualComment.path,
      line: manualComment.line,
      side: manualComment.side,
      body: manualComment.body,
      recommendationKey: manualComment.id,
      manualLineCommentId: manualComment.id,
    });
  }

  const normalizedBody = normalizeText(body);
  const skippedResults = results.filter((entry) => entry.status === 'skipped');
  const hasNonInlineFindings = skippedResults.some((entry) => entry.reason === 'fuzzy_anchor');
  const inlineFindingCount = comments.filter((entry) => !entry.manualLineCommentId).length;
  if ((normalizedAction === 'comment' || normalizedAction === 'request_changes') && body === undefined && comments.length === 0 && !hasNonInlineFindings) {
    const error = new Error(buildNoInlineCommentsMessage(results));
    error.code = 'ACTION_BLOCKED';
    error.statusCode = 409;
    error.blockedReason = error.message;
    error.staleReason = eligibility.staleReason || null;
    throw error;
  }
  const reviewBody = body === undefined
    ? (
        shouldOmitGeneratedReviewBody({
          action: normalizedAction,
          explicitBodyProvided: false,
          inlineCommentCount: comments.length,
        }) || (inlineFindingCount === 0 && !hasNonInlineFindings)
          ? null
          : buildSubmissionBody({
              prReview,
              action: normalizedAction,
              publishedCount: inlineFindingCount,
              skippedResults,
            })
      )
    : (normalizedBody || null);
  const bodyPublishedEntries = buildBodyPublishedRecommendationEntries({
    body: reviewBody,
    skippedResults,
  });
  if (normalizedAction !== 'approve' && comments.length === 0 && !reviewBody) {
    const error = new Error(
      normalizedAction === 'request_changes'
        ? 'Add a summary before requesting changes.'
        : 'Add a comment before submitting.'
    );
    error.code = 'ACTION_BLOCKED';
    error.statusCode = 409;
    error.blockedReason = error.message;
    error.staleReason = eligibility.staleReason || null;
    throw error;
  }

  const submission = await githubService.submitPullRequestReview(
    installationId,
    owner,
    repo,
    prReview.githubPrNumber,
    {
      event: mapActionToGitHubEvent(normalizedAction),
      body: reviewBody,
      commitId: headSha || null,
      comments: comments.map((entry) => ({
        path: entry.path,
        line: entry.line,
        side: entry.side,
        ...(entry.startLine && entry.startLine < entry.line
          ? {
              startLine: entry.startLine,
              startSide: entry.startSide || entry.side,
            }
          : {}),
        body: entry.body,
      })),
    }
  );

  const publishedAt = submission.submittedAt || new Date().toISOString();
  const project = projectId ? await getProjectById(projectId).catch(() => null) : null;
  for (const entry of [...comments, ...bodyPublishedEntries]) {
    await reviewPublicationService.upsertPublication(
      {
        projectId,
        reviewType: REVIEW_TYPE,
        reviewId,
      },
      {
        recommendationKey: entry.recommendationKey,
        channel: GITHUB_CHANNEL,
        action: normalizedAction,
        githubReviewId: submission.githubReviewId || null,
        githubPrNumber: prReview.githubPrNumber,
        headSha: headSha || null,
        filePath: entry.path,
        line: entry.line,
        publishedAt,
      }
    );
    try {
      await reviewSyncService.queueEvent(
        reviewSyncService.buildReviewPublishedEvent({
          userId: project?.user_id || null,
          projectId,
          projectName: project?.name || null,
          projectPath: project?.path || null,
          reviewType: REVIEW_TYPE,
          reviewId,
          recommendationKey: entry.recommendationKey,
          occurredAt: publishedAt,
          action: normalizedAction,
          channel: GITHUB_CHANNEL,
          githubPrNumber: prReview.githubPrNumber,
          headSha: headSha || null,
        })
      );
    } catch (error) {
      console.warn('[review-sync] Failed to queue review_published event', {
        projectId,
        reviewId,
        recommendationKey: entry.recommendationKey,
        error: error?.message || error,
      });
    }
    const existingResult = results.find((result) => result.recommendationKey === entry.recommendationKey);
    if (existingResult) {
      existingResult.status = 'published';
      delete existingResult.reason;
      existingResult.path = entry.path;
      existingResult.line = entry.line;
      existingResult.githubReviewId = submission.githubReviewId || null;
      existingResult.manualLineCommentId = entry.manualLineCommentId || null;
    } else {
      results.push({
        recommendationKey: entry.recommendationKey,
        manualLineCommentId: entry.manualLineCommentId || null,
        status: 'published',
        path: entry.path,
        line: entry.line,
        githubReviewId: submission.githubReviewId || null,
      });
    }
  }

  await reviewPublicationService.upsertPublication(
    {
      projectId,
      reviewType: REVIEW_TYPE,
      reviewId,
    },
    {
      recommendationKey: REVIEW_DECISION_PUBLICATION_KEY,
      channel: GITHUB_CHANNEL,
      action: normalizedAction,
      githubReviewId: submission.githubReviewId || null,
      githubPrNumber: prReview.githubPrNumber,
      headSha: headSha || null,
      filePath: null,
      line: null,
      publishedAt,
    }
  );

  const publication = await reviewPublicationService.listPublications({
    projectId,
    reviewType: REVIEW_TYPE,
    reviewId,
  }, {
    channel: GITHUB_CHANNEL,
  });

  return {
    publication,
    reviewSubmission: {
      event: submission.event,
      githubReviewId: submission.githubReviewId || null,
      htmlUrl: submission.htmlUrl || null,
      state: submission.state || null,
      commentCount: comments.length,
      submittedAt: submission.submittedAt || publishedAt,
    },
    results,
  };
}

const prReviewPublishService = {
  listPublications,
  publishReview,
  __testing: {
    normalizeAction,
    normalizeRecommendation,
    isCommentEligibleRecommendation,
    canPublishInlineRecommendation,
    stripCommentBoilerplate,
    inferFenceLanguage,
    formatSuggestedFixBlock,
    buildGitHubSuggestionBlock,
    buildRecommendationCommentBody,
    buildPublishedRecommendationCommentBody,
    normalizeCommentOverrideMap,
    normalizeManualLineComments,
    buildSubmissionBody,
    shouldOmitGeneratedReviewBody,
    buildCommentReviewBody: (args) => buildCompactReviewBody({ action: 'comment', ...args }),
    buildCompactReviewBody,
    buildReviewCoverageLabel,
    buildNoInlineCommentsMessage,
    formatRecommendationRef,
    formatSkippedReason,
    collectDiffSideLines,
    buildFilePatchLookup,
    areDiffSideLinesAvailable,
    mapActionToGitHubEvent,
  },
};

export default prReviewPublishService;
