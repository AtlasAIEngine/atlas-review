/** Review Prompt Context — Prompt context signal collection and bounded block builder. */

import {
  REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
  REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
  REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_CHARS,
  REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_LINES,
  REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT,
  REVIEW_PROMPT_CONTEXT_RANGE_COMMIT_LIMIT,
  REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT,
  REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES,
  REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
  REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
  REVIEW_FILE_RISK_CONTEXT_MAX_FILES,
  RECOMMENDATION_SEVERITY_WEIGHT,
  RECOMMENDATION_TYPE_WEIGHT,
} from './reviewConstants.js';

import { hashReviewFileContent, normalizePathForMatch } from './reviewHelpers.js';
import { REVIEW_LINTER_PROMPT_CONTEXT_MAX_LINES, compareSeverity } from './linter/linterConstants.js';

import changesetService from '../changesetService.js';
import branchReviewService from '../branchReviewService.js';
import gitService from '../gitService.js';
import memoryService from '../memoryService.js';
import verificationService from '../verificationService.js';
import reviewOutcomeService from '../reviewOutcomeService.js';
import { collectReviewStackContext } from './reviewStackContextService.js';

/**
 * The structured output schema we ask the AI to produce.
 *
 * Phase 11: walkthrough/`changeGroups` is a separate artifact produced by
 * `walkthroughGeneration.js`. The review prompt deliberately does NOT request
 * it — review only produces findings. Removing it from this schema also
 * removes it from the prompt rendered into the model, so the model never
 * spends tokens on walkthrough narration during review.
 */
const REVIEW_OUTPUT_SCHEMA = {
  summary: 'string — 1-3 sentence plain-English summary of what changed and why it matters',
  riskLevel: 'low | medium | high | critical',
  recommendations: [
    {
      type: 'issue | suggestion | praise',
      severity: 'low | medium | high | critical',
      title: 'string — short title',
      description: 'string — detailed explanation',
      file: 'string | null — file path if applicable',
      line: 'number | null — line number if applicable',
      targetSnippet: 'string | null — exact code snippet to replace when suggestedFix is a direct replacement',
      suggestedFix: 'string | null — replacement code snippet if you can suggest a concrete fix',
    },
  ],
  candidateFindings: [
    {
      type: 'issue | suggestion',
      severity: 'low | medium | high | critical',
      confidence: 'low | medium | high',
      title: 'string — short title for a plausible but not fully promoted concern',
      description: 'string — concrete failure scenario and why it needs verification',
      file: 'string | null — file path if applicable',
      line: 'number | null — line number if applicable',
      evidence: {
        file: 'string | null — evidence file path',
        line: 'number | null — evidence line number',
        snippet: 'string | null — code snippet showing the concern',
        reasoning: 'string | null — why this concern is plausible',
      },
    },
  ],
  stats: {
    filesAnalyzed: 'number',
    totalAdditions: 'number',
    totalDeletions: 'number',
    estimatedComplexity: 'trivial | simple | moderate | complex',
  },
};

function normalizePromptContextLine(value, maxChars = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS) {
  const collapsed = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return '';
  const normalizedMaxChars = Math.max(24, Math.trunc(Number(maxChars) || REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS));
  if (collapsed.length <= normalizedMaxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, normalizedMaxChars - 3)).trimEnd()}...`;
}

function normalizePromptContextList(values, {
  maxItems = REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  maxCharsPerLine = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES));
  const seen = new Set();
  const normalized = [];
  for (const rawValue of Array.isArray(values) ? values : []) {
    const line = normalizePromptContextLine(rawValue, maxCharsPerLine);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    normalized.push(line);
    if (normalized.length >= normalizedMaxItems) break;
  }
  return normalized;
}

function normalizeQueuedCommitShas(queuedShas, maxItems = REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT) {
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT));
  const shas = [];
  const seen = new Set();
  for (const rawSha of Array.isArray(queuedShas) ? queuedShas : []) {
    const sha = String(rawSha || '').trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    const canonical = sha.toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    shas.push(sha);
    if (shas.length >= normalizedMaxItems) break;
  }
  return shas;
}

function normalizePromptContextProjectMetadata(projectMetadata = {}) {
  const metadata = projectMetadata && typeof projectMetadata === 'object'
    ? projectMetadata
    : {};
  const checks = metadata.availableChecks && typeof metadata.availableChecks === 'object'
    ? metadata.availableChecks
    : {};
  return {
    projectType: typeof metadata.projectType === 'string' && metadata.projectType.trim()
      ? metadata.projectType.trim()
      : null,
    configFile: typeof metadata.configFile === 'string' && metadata.configFile.trim()
      ? metadata.configFile.trim()
      : null,
    availableChecks: {
      lint: checks.lint === true,
      unit: checks.unit === true,
      e2e: checks.e2e === true,
    },
  };
}

const PROMPT_CONTEXT_BLOCK_PRIORITY = Object.freeze({
  commit_intent: 10,
  verification_status: 20,
  reviewer_expectations: 25,
  review_threads: 27,
  prior_same_hash_findings: 30,
  historical_review_learnings: 33,
  file_risk_context: 35,
  claude_conventions: 40,
  dismissed_patterns: 45,
  project_metadata: 50,
  unity_stack_signals: 52,
  unity_review_focus: 53,
});

function resolvePromptContextBlockPriority(block = {}) {
  if (Number.isFinite(Number(block?.priority))) {
    return Number(block.priority);
  }
  return PROMPT_CONTEXT_BLOCK_PRIORITY[block?.id] ?? Number.POSITIVE_INFINITY;
}

function orderPromptContextBlocks(blockDefinitions = []) {
  return [...blockDefinitions].sort((left, right) => {
    const leftPriority = resolvePromptContextBlockPriority(left);
    const rightPriority = resolvePromptContextBlockPriority(right);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });
}

function normalizePromptContextVerificationStatusBlockLines(verificationStatus, {
  maxItems = REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  maxCharsPerLine = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  if (!verificationStatus || typeof verificationStatus !== 'object') return [];
  const rawLines = Array.isArray(verificationStatus.lines)
    ? verificationStatus.lines
    : null;
  if (rawLines && rawLines.length > 0) {
    return normalizePromptContextList(rawLines, { maxItems, maxCharsPerLine });
  }

  if (typeof verificationService.summarizeReviewVerificationStatus !== 'function') {
    return [];
  }
  const summary = verificationService.summarizeReviewVerificationStatus(verificationStatus, {
    maxFailExcerptChars: REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_CHARS,
    maxFailExcerptLines: REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_LINES,
  });
  return normalizePromptContextList(summary?.lines || [], { maxItems, maxCharsPerLine });
}

function normalizePromptContextParticipantList(values, {
  maxItems = REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  maxCharsPerLine = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  return normalizePromptContextList(values, {
    maxItems,
    maxCharsPerLine,
  }).map((entry) => (
    entry.replace(/^@+/, '').trim()
  )).filter(Boolean);
}

function normalizePromptContextReviewerExpectationLines({
  requestedReviewers = [],
  assignees = [],
  maxItems = REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  maxCharsPerLine = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  const normalizedRequestedReviewers = normalizePromptContextParticipantList(requestedReviewers, {
    maxItems,
    maxCharsPerLine,
  });
  const normalizedAssignees = normalizePromptContextParticipantList(assignees, {
    maxItems,
    maxCharsPerLine,
  });
  const lines = [];
  if (normalizedRequestedReviewers.length > 0) {
    lines.push(`Requested reviewers: ${normalizedRequestedReviewers.join(', ')}`);
  }
  if (normalizedAssignees.length > 0) {
    lines.push(`Assignees: ${normalizedAssignees.join(', ')}`);
  }
  return normalizePromptContextList(lines, {
    maxItems: Math.min(maxItems, 2),
    maxCharsPerLine,
  });
}

function normalizePromptContextReviewThreadLines(reviewThreads = [], {
  maxItems = REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  maxCharsPerLine = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  const normalizedThreads = [];
  const seen = new Set();

  for (const rawThread of Array.isArray(reviewThreads) ? reviewThreads : []) {
    let line = '';
    if (typeof rawThread === 'string') {
      line = normalizePromptContextLine(rawThread, maxCharsPerLine);
    } else if (rawThread && typeof rawThread === 'object') {
      const filePath = normalizePathForMatch(rawThread.path || rawThread.file || '');
      if (!filePath) continue;
      const lineNumber = Math.trunc(Number(rawThread.line) || 0);
      const author = normalizePromptContextLine(rawThread.author || rawThread.user || '', 40);
      const status = normalizePromptContextLine(rawThread.status || '', 20).toLowerCase();
      const summary = normalizePromptContextLine(
        rawThread.summary || rawThread.body || rawThread.title || '',
        Math.max(60, maxCharsPerLine - 40)
      );
      if (!summary) continue;
      const prefixParts = [
        `${filePath}${lineNumber > 0 ? `:${lineNumber}` : ''}`,
        status ? `${status} thread` : 'thread',
        author ? `from ${author}` : '',
      ].filter(Boolean);
      line = normalizePromptContextLine(`${prefixParts.join(' ')} - ${summary}`, maxCharsPerLine);
    }

    if (!line || seen.has(line)) continue;
    seen.add(line);
    normalizedThreads.push(line);
    if (normalizedThreads.length >= Math.max(1, Math.trunc(Number(maxItems) || REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES))) {
      break;
    }
  }

  return normalizedThreads;
}

function normalizePriorFindingHintType(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'issue' || normalized === 'suggestion') return normalized;
  return 'suggestion';
}

function normalizePriorFindingHintSeverity(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function normalizePromptContextPriorFindingHintLines(priorFindingHints = [], {
  maxItems = REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES,
  maxCharsPerLine = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
  sameHashOnly = REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
  allowGuardedCrossHashHints = REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
} = {}) {
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES));
  const normalizedHints = [];
  const seen = new Set();

  for (const hint of Array.isArray(priorFindingHints) ? priorFindingHints : []) {
    if (!hint || typeof hint !== 'object') continue;
    const sameHash = hint.sameHash !== false;
    if (sameHashOnly && !sameHash) continue;
    if (!sameHash && !allowGuardedCrossHashHints) continue;

    const filePath = normalizePathForMatch(hint.filePath || hint.path || hint.file || '');
    const title = normalizePromptContextLine(
      hint.title || hint.summary || hint.description || '',
      maxCharsPerLine
    );
    if (!title) continue;

    const severity = normalizePriorFindingHintSeverity(hint.severity);
    const type = normalizePriorFindingHintType(hint.type);
    const key = `${filePath}|${severity}|${type}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedHints.push({
      filePath,
      severity,
      type,
      title,
      sameHash,
    });
  }

  normalizedHints.sort((left, right) => {
    const severityDiff =
      (RECOMMENDATION_SEVERITY_WEIGHT[right.severity] || 0)
      - (RECOMMENDATION_SEVERITY_WEIGHT[left.severity] || 0);
    if (severityDiff !== 0) return severityDiff;
    const pathDiff = String(left.filePath || '').localeCompare(String(right.filePath || ''));
    if (pathDiff !== 0) return pathDiff;
    return String(left.title || '').localeCompare(String(right.title || ''));
  });

  return normalizedHints
    .slice(0, normalizedMaxItems)
    .map((hint) => normalizePromptContextLine(
      `${hint.sameHash ? '' : '[historical] '}[${hint.severity} ${hint.type}] ${hint.filePath ? `${hint.filePath}: ` : ''}${hint.title}`,
      maxCharsPerLine
    ));
}

function normalizePromptContextFileRiskLines(fileRiskContext = [], {
  maxItems = REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  maxCharsPerLine = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  const normalized = [];
  for (const entry of Array.isArray(fileRiskContext) ? fileRiskContext : []) {
    if (!entry || typeof entry !== 'object') continue;
    const filePath = normalizePathForMatch(entry.filePath || entry.path || '');
    if (!filePath) continue;
    const changeCount30d = Math.max(0, Math.trunc(Number(entry.changeCount30d) || 0));
    const distinctAuthors90d = Math.max(0, Math.trunc(Number(entry.distinctAuthors90d) || 0));
    const hotspot = String(entry.hotspot || '').trim().toLowerCase();
    const lastAuthor = String(entry.lastAuthor || '').trim();
    const lastCommitDate = String(entry.lastCommitDate || '').trim();
    const parts = [];
    if (lastCommitDate || lastAuthor) {
      if (lastCommitDate && lastAuthor) {
        parts.push(`last update ${lastCommitDate} by ${lastAuthor}`);
      } else if (lastCommitDate) {
        parts.push(`last update ${lastCommitDate}`);
      } else if (lastAuthor) {
        parts.push(`last updater ${lastAuthor}`);
      }
    }
    parts.push(`${changeCount30d} changes/30d`);
    parts.push(`${distinctAuthors90d} authors/90d`);
    if (hotspot === 'hotspot' || hotspot === 'active' || hotspot === 'stable') {
      parts.push(`risk ${hotspot}`);
    }
    const line = normalizePromptContextLine(`${filePath}: ${parts.join(', ')}`, maxCharsPerLine);
    if (!line) continue;
    normalized.push(line);
    if (normalized.length >= Math.max(1, Math.trunc(Number(maxItems) || REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES))) {
      break;
    }
  }
  return normalized;
}

function normalizeLinterFindingsBlockLines(linterFindings, {
  maxItems = REVIEW_LINTER_PROMPT_CONTEXT_MAX_LINES,
  maxCharsPerLine = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  if (!Array.isArray(linterFindings) || linterFindings.length === 0) return [];
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || REVIEW_LINTER_PROMPT_CONTEXT_MAX_LINES));
  const normalizedMaxChars = Math.max(24, Math.trunc(Number(maxCharsPerLine) || REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS));

  // Sort by severity (highest first)
  const sorted = [...linterFindings].sort((a, b) => compareSeverity(a.severity, b.severity));

  const lines = [];
  for (const finding of sorted) {
    if (lines.length >= normalizedMaxItems) break;
    const source = String(finding.source || 'unknown');
    const severity = String(finding.severity || 'low');
    const file = String(finding.file || 'unknown');
    const line = Number.isFinite(finding.line) && finding.line > 0 ? `:${finding.line}` : '';
    const ruleId = String(finding.ruleId || '');
    const message = String(finding.message || '').replace(/\s+/g, ' ').trim();
    const evidenceSummary = String(finding.promptEvidenceSummary || finding.evidenceSummary || '').replace(/\s+/g, ' ').trim();
    const ruleLabel = ruleId ? ` ${ruleId}:` : ':';
    const localLabel = evidenceSummary ? ` | local: ${evidenceSummary}` : '';
    const raw = `${source} [${severity}] ${file}${line}${ruleLabel} ${message}${localLabel}`;
    lines.push(raw.length <= normalizedMaxChars ? raw : `${raw.slice(0, normalizedMaxChars - 3).trimEnd()}...`);
  }
  return lines;
}

function buildPromptContextBlockDefinitions({
  commitMessages = [],
  verificationStatus = null,
  requestedReviewers = [],
  assignees = [],
  reviewThreads = [],
  priorFindingHints = [],
  fileRiskContext = [],
  claudeConventions = [],
  projectMetadata = {},
  dismissedPatterns = [],
  linterFindings = [],
  additionalBlocks = [],
  sameHashOnly = REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
  allowGuardedCrossHashHints = REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
  maxLinesPerBlock = REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  lineMaxChars = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  const normalizedCommits = normalizePromptContextList(commitMessages, {
    maxItems: maxLinesPerBlock,
    maxCharsPerLine: lineMaxChars,
  });
  const normalizedVerificationStatus = normalizePromptContextVerificationStatusBlockLines(verificationStatus, {
    maxItems: maxLinesPerBlock,
    maxCharsPerLine: lineMaxChars,
  });
  const normalizedReviewerExpectations = normalizePromptContextReviewerExpectationLines({
    requestedReviewers,
    assignees,
    maxItems: maxLinesPerBlock,
    maxCharsPerLine: lineMaxChars,
  });
  const normalizedReviewThreads = normalizePromptContextReviewThreadLines(reviewThreads, {
    maxItems: maxLinesPerBlock,
    maxCharsPerLine: lineMaxChars,
  });
  const normalizedPriorFindings = normalizePromptContextPriorFindingHintLines(priorFindingHints, {
    maxItems: Math.min(maxLinesPerBlock, REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES),
    maxCharsPerLine: lineMaxChars,
    sameHashOnly,
    allowGuardedCrossHashHints,
  });
  const normalizedFileRiskContext = normalizePromptContextFileRiskLines(fileRiskContext, {
    maxItems: maxLinesPerBlock,
    maxCharsPerLine: lineMaxChars,
  });
  const normalizedConventions = normalizePromptContextList(claudeConventions, {
    maxItems: maxLinesPerBlock,
    maxCharsPerLine: lineMaxChars,
  });
  const normalizedDismissedPatterns = normalizePromptContextList(dismissedPatterns, {
    maxItems: maxLinesPerBlock,
    maxCharsPerLine: lineMaxChars,
  });
  const normalizedProjectMetadata = normalizePromptContextProjectMetadata(projectMetadata);
  const projectMetadataLines = [];
  if (normalizedProjectMetadata.projectType) {
    const projectTypeLine = normalizedProjectMetadata.configFile
      ? `${normalizedProjectMetadata.projectType} (${normalizedProjectMetadata.configFile})`
      : normalizedProjectMetadata.projectType;
    projectMetadataLines.push(`Project type: ${projectTypeLine}`);
  }
  const availableChecks = [];
  if (normalizedProjectMetadata.availableChecks.lint) availableChecks.push('lint');
  if (normalizedProjectMetadata.availableChecks.unit) availableChecks.push('unit');
  if (normalizedProjectMetadata.availableChecks.e2e) availableChecks.push('e2e');
  if (availableChecks.length > 0) {
    projectMetadataLines.push(`Available checks: ${availableChecks.join(', ')}`);
  }

  const normalizedLinterFindings = normalizeLinterFindingsBlockLines(linterFindings, {
    maxItems: maxLinesPerBlock,
    maxCharsPerLine: lineMaxChars,
  });

  const blocks = [
    {
      id: 'commit_intent',
      title: '### Atlas Local Context: Commit Intent',
      lines: normalizedCommits,
    },
    ...(normalizedLinterFindings.length > 0 ? [{
      id: 'linter_findings',
      title: '### Atlas Local Context: Deterministic Findings',
      lines: normalizedLinterFindings,
    }] : []),
    {
      id: 'verification_status',
      title: '### Atlas Local Context: Verification Status',
      lines: normalizedVerificationStatus,
    },
    ...(normalizedReviewerExpectations.length > 0 ? [{
      id: 'reviewer_expectations',
      title: '### Atlas Local Context: Reviewer Expectations',
      lines: normalizedReviewerExpectations,
    }] : []),
    ...(normalizedReviewThreads.length > 0 ? [{
      id: 'review_threads',
      title: '### Atlas Local Context: Review Threads',
      lines: normalizedReviewThreads,
    }] : []),
    {
      id: 'prior_same_hash_findings',
      title: '### Atlas Local Context: Prior Findings',
      lines: normalizedPriorFindings,
    },
    {
      id: 'file_risk_context',
      title: '### Atlas Local Context: File Risk Context',
      lines: normalizedFileRiskContext,
    },
    {
      id: 'claude_conventions',
      title: '### Atlas Local Context: CLAUDE Conventions',
      lines: normalizedConventions,
    },
    {
      id: 'project_metadata',
      title: '### Atlas Local Context: Project Metadata',
      lines: normalizePromptContextList(projectMetadataLines, {
        maxItems: maxLinesPerBlock,
        maxCharsPerLine: lineMaxChars,
      }),
    },
    {
      id: 'dismissed_patterns',
      title: '### Atlas Local Context: Dismissed Finding Patterns',
      lines: normalizedDismissedPatterns,
    },
    ...(Array.isArray(additionalBlocks)
      ? additionalBlocks
          .filter((block) => block && typeof block === 'object')
          .map((block) => ({
            id: String(block.id || '').trim(),
            title: String(block.title || '').trim(),
            lines: normalizePromptContextList(block.lines || [], {
              maxItems: maxLinesPerBlock,
              maxCharsPerLine: lineMaxChars,
            }),
            priority: Number.isFinite(Number(block.priority)) ? Number(block.priority) : null,
          }))
          .filter((block) => block.id && block.title && block.lines.length > 0)
      : []),
  ];

  return orderPromptContextBlocks(blocks);
}

function allocatePromptContextBudget(blockDefinitions, normalizedBudget) {
  const outputLines = [];
  let usedChars = 0;
  const telemetryBlocks = [];

  const pushLineWithinBudget = (line) => {
    const candidate = String(line || '');
    const additionalChars = candidate.length + (outputLines.length > 0 ? 1 : 0);
    if (usedChars + additionalChars > normalizedBudget) {
      return false;
    }
    outputLines.push(candidate);
    usedChars += additionalChars;
    return true;
  };

  for (const block of blockDefinitions) {
    const telemetry = {
      id: block.id,
      totalLines: block.lines.length,
      includedLines: 0,
      omittedLines: block.lines.length,
      truncated: false,
      included: false,
    };
    if (block.lines.length === 0) {
      telemetryBlocks.push(telemetry);
      continue;
    }

    const checkpointLineCount = outputLines.length;
    const checkpointUsedChars = usedChars;

    if (outputLines.length > 0 && !pushLineWithinBudget('')) {
      telemetry.truncated = true;
      telemetryBlocks.push(telemetry);
      continue;
    }
    if (!pushLineWithinBudget(block.title)) {
      outputLines.splice(checkpointLineCount);
      usedChars = checkpointUsedChars;
      telemetry.truncated = true;
      telemetryBlocks.push(telemetry);
      continue;
    }

    for (const line of block.lines) {
      if (!pushLineWithinBudget(`- ${line}`)) {
        telemetry.truncated = true;
        break;
      }
      telemetry.includedLines += 1;
    }

    if (telemetry.includedLines === 0) {
      outputLines.splice(checkpointLineCount);
      usedChars = checkpointUsedChars;
      telemetry.truncated = true;
    } else {
      telemetry.included = true;
    }
    telemetry.omittedLines = Math.max(0, telemetry.totalLines - telemetry.includedLines);
    telemetryBlocks.push(telemetry);
  }

  return {
    outputLines,
    usedChars,
    telemetryBlocks,
  };
}

function buildBoundedPromptContextBlocks({
  commitMessages = [],
  verificationStatus = null,
  requestedReviewers = [],
  assignees = [],
  reviewThreads = [],
  priorFindingHints = [],
  fileRiskContext = [],
  claudeConventions = [],
  projectMetadata = {},
  dismissedPatterns = [],
  linterFindings = [],
  additionalBlocks = [],
  queuedCommitShas = [],
  budgetChars = REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
  sameHashOnly = REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
  allowGuardedCrossHashHints = REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
  maxLinesPerBlock = REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
  lineMaxChars = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} = {}) {
  const normalizedBudget = Math.max(120, Math.trunc(Number(budgetChars) || REVIEW_PROMPT_CONTEXT_BUDGET_CHARS));
  const blockDefinitions = buildPromptContextBlockDefinitions({
    commitMessages,
    verificationStatus,
    requestedReviewers,
    assignees,
    reviewThreads,
    priorFindingHints,
    fileRiskContext,
    claudeConventions,
    projectMetadata,
    dismissedPatterns,
    linterFindings,
    additionalBlocks,
    sameHashOnly,
    allowGuardedCrossHashHints,
    maxLinesPerBlock,
    lineMaxChars,
  });
  const {
    outputLines,
    usedChars,
    telemetryBlocks,
  } = allocatePromptContextBudget(blockDefinitions, normalizedBudget);

  const contextText = outputLines.length > 0
    ? `Atlas Local Context:\n${outputLines.join('\n')}`
    : '';
  return {
    contextText,
    telemetry: {
      budgetChars: normalizedBudget,
      usedChars,
      truncated: telemetryBlocks.some((block) => block.truncated || block.omittedLines > 0),
      blocks: telemetryBlocks,
      queuedCommitShas: normalizeQueuedCommitShas(queuedCommitShas, REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT)
        .map((sha) => sha.slice(0, 12)),
    },
  };
}

function createPromptContextHashKey({ filePath = '', beforeHash = '', afterHash = '' } = {}) {
  return `${filePath}\u001f${beforeHash}\u001f${afterHash}`;
}

function buildPromptContextHashDescriptors(files = [], maxItems = REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT) {
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT));
  const descriptors = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = normalizePathForMatch(file?.path || '');
    if (!filePath) continue;
    const descriptor = {
      filePath,
      beforeHash: hashReviewFileContent(file?.before),
      afterHash: hashReviewFileContent(file?.after),
    };
    const key = createPromptContextHashKey(descriptor);
    if (seen.has(key)) continue;
    seen.add(key);
    descriptors.push(descriptor);
    if (descriptors.length >= normalizedMaxItems) break;
  }
  return descriptors;
}

function buildPromptContextPriorFindingHintsFromCacheRows(cacheRows, hashDescriptors, {
  maxItems = REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES,
  sameHashOnly = REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
  allowGuardedCrossHashHints = REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
} = {}) {
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES));
  const descriptorFilePaths = new Set(
    (Array.isArray(hashDescriptors) ? hashDescriptors : [])
      .map((descriptor) => normalizePathForMatch(descriptor?.filePath || ''))
      .filter(Boolean)
  );
  const descriptorKeys = new Set(
    (Array.isArray(hashDescriptors) ? hashDescriptors : [])
      .map((descriptor) => createPromptContextHashKey(descriptor))
  );
  const hints = [];
  const seen = new Set();

  for (const row of Array.isArray(cacheRows) ? cacheRows : []) {
    const filePath = normalizePathForMatch(row?.filePath || '');
    if (!filePath) continue;
    const key = createPromptContextHashKey({
      filePath,
      beforeHash: String(row?.beforeHash || '').trim(),
      afterHash: String(row?.afterHash || '').trim(),
    });
    const sameHash = descriptorKeys.has(key);
    if (sameHashOnly && !sameHash) continue;
    if (!sameHash && !allowGuardedCrossHashHints) continue;
    if (!descriptorFilePaths.has(filePath)) continue;

    const recommendations = Array.isArray(row?.review?.recommendations)
      ? row.review.recommendations
      : [];
    const candidateRecs = recommendations
      .filter((rec) => rec && typeof rec === 'object' && rec.type !== 'praise')
      .map((rec) => ({
        title: normalizePromptContextLine(rec.title || rec.description || ''),
        type: normalizePriorFindingHintType(rec.type),
        severity: normalizePriorFindingHintSeverity(rec.severity),
      }))
      .filter((rec) => rec.title);
    candidateRecs.sort((left, right) => {
      const severityDiff =
        (RECOMMENDATION_SEVERITY_WEIGHT[right.severity] || 0)
        - (RECOMMENDATION_SEVERITY_WEIGHT[left.severity] || 0);
      if (severityDiff !== 0) return severityDiff;
      const typeDiff =
        (RECOMMENDATION_TYPE_WEIGHT[right.type] || 0)
        - (RECOMMENDATION_TYPE_WEIGHT[left.type] || 0);
      if (typeDiff !== 0) return typeDiff;
      return String(left.title || '').localeCompare(String(right.title || ''));
    });

    const chosen = candidateRecs[0];
    const fallbackSummary = normalizePromptContextLine(row?.review?.summary || '');
    const title = chosen?.title || fallbackSummary;
    if (!title) continue;

    const severity = chosen?.severity || 'medium';
    const type = chosen?.type || 'suggestion';
    if (!sameHash) {
      const isHighRiskIssue = type === 'issue' && (severity === 'high' || severity === 'critical');
      if (!isHighRiskIssue) continue;
    }
    const dedupeKey = `${filePath}|${severity}|${type}|${title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    hints.push({
      filePath,
      title,
      severity,
      type,
      sameHash,
    });
  }

  hints.sort((left, right) => {
    const severityDiff =
      (RECOMMENDATION_SEVERITY_WEIGHT[right.severity] || 0)
      - (RECOMMENDATION_SEVERITY_WEIGHT[left.severity] || 0);
    if (severityDiff !== 0) return severityDiff;
    const pathDiff = String(left.filePath || '').localeCompare(String(right.filePath || ''));
    if (pathDiff !== 0) return pathDiff;
    const typeDiff =
      (RECOMMENDATION_TYPE_WEIGHT[right.type] || 0)
      - (RECOMMENDATION_TYPE_WEIGHT[left.type] || 0);
    if (typeDiff !== 0) return typeDiff;
    return String(left.title || '').localeCompare(String(right.title || ''));
  });

  return hints.slice(0, normalizedMaxItems);
}

async function resolveBranchReviewVerificationStatus(projectPath, branchReview = {}, options = {}) {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath || !branchReview || typeof branchReview !== 'object') {
    return null;
  }

  // Prefer the preserved fork point over the volatile merge-base when
  // deriving the commit range for prompt context. After a fast-forward
  // merge, `branchReview.mergeBaseSha` collapses to HEAD and the range
  // becomes empty, hiding the branch's own commits from the reviewer.
  const mergeBaseSha = typeof options?.mergeBaseSha === 'string' && options.mergeBaseSha.trim()
    ? options.mergeBaseSha.trim()
    : typeof branchReview.forkPointSha === 'string' && branchReview.forkPointSha.trim()
      ? branchReview.forkPointSha.trim()
      : typeof branchReview.mergeBaseSha === 'string'
        ? branchReview.mergeBaseSha.trim()
        : '';
  const headSha = typeof options?.headSha === 'string' && options.headSha.trim()
    ? options.headSha.trim()
    : typeof branchReview.headSha === 'string'
      ? branchReview.headSha.trim()
      : '';
  let candidateCommitShas = normalizeQueuedCommitShas(
    [headSha, mergeBaseSha],
    REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT
  );

  if (mergeBaseSha && headSha) {
    const preloadedRangeCommits = Array.isArray(options?.rangeCommits) ? options.rangeCommits : null;
    const rangeCommits = preloadedRangeCommits || await gitService
      .getCommitsBetween(normalizedProjectPath, mergeBaseSha, headSha)
      .catch(() => []);
    const rangeShas = Array.isArray(rangeCommits)
      ? rangeCommits.map((entry) => entry?.hash)
      : [];
    candidateCommitShas = normalizeQueuedCommitShas(
      [...candidateCommitShas, ...rangeShas],
      REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT
    );
  }

  let fallbackSummary = null;
  for (const commitSha of candidateCommitShas) {
    const matchedChangeSets = await changesetService
      .getChangeSetsWithCommit(normalizedProjectPath, commitSha)
      .catch(() => []);
    for (const changeset of Array.isArray(matchedChangeSets) ? matchedChangeSets : []) {
      const verification = changeset?.verification;
      if (!verification || typeof verification !== 'object') continue;
      const summary = verificationService.summarizeReviewVerificationStatus?.(verification, {
        maxFailExcerptChars: REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_CHARS,
        maxFailExcerptLines: REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_LINES,
      });
      if (!summary || typeof summary !== 'object') continue;
      const sourceLabel = changeset?.displayId
        ? `Source changeset: ${changeset.displayId} (${String(commitSha).slice(0, 12)})`
        : changeset?.id
          ? `Source changeset: ${changeset.id} (${String(commitSha).slice(0, 12)})`
          : `Source commit: ${String(commitSha).slice(0, 12)}`;
      const summaryWithSource = {
        ...summary,
        source: {
          changesetId: changeset?.id || null,
          displayId: changeset?.displayId || null,
          commitSha: String(commitSha).slice(0, 12),
        },
        lines: [
          sourceLabel,
          ...(Array.isArray(summary.lines) ? summary.lines : []),
        ],
      };

      if (
        summary.overallStatus === 'pass'
        || summary.overallStatus === 'fail'
        || summary.overallStatus === 'partial'
      ) {
        return summaryWithSource;
      }

      if (!fallbackSummary) {
        fallbackSummary = summaryWithSource;
      }
    }
  }

  return fallbackSummary;
}

async function buildDismissedPatternHints(projectId) {
  if (!projectId) return [];
  try {
    const result = await reviewOutcomeService.getProjectDismissalSummary(projectId, {
      minSamples: 3,
      minDismissedRate: 0.6,
      limit: 3,
    });
    if (!result || !Array.isArray(result.patterns) || result.patterns.length === 0) return [];
    return result.patterns.map(p =>
      `Findings on ${p.pathPattern || 'unknown'} files (${p.language}) are frequently dismissed (${p.dismissed}/${p.total} = ${Math.round(p.dismissedRate * 100)}%)`
    );
  } catch {
    return [];
  }
}

async function collectPromptContextSignals(projectPath, {
  commitMessages = [],
  queuedCommitShas = [],
  mergeBaseSha = null,
  headSha = null,
  rangeCommits = null,
  verificationStatus = null,
  requestedReviewers = [],
  assignees = [],
  reviewThreads = [],
  contextFiles = [],
  cacheProjectId = null,
  reviewProfile = null,
  sameHashOnly = REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
  allowGuardedCrossHashHints = REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
} = {}) {
  const normalizedQueuedShas = normalizeQueuedCommitShas(queuedCommitShas, REVIEW_PROMPT_CONTEXT_SHA_LOOKUP_LIMIT);
  const normalizedCacheProjectId = typeof cacheProjectId === 'string' && cacheProjectId.trim()
    ? cacheProjectId.trim()
    : null;
  const normalizedContextFilePaths = Array.from(new Set(
    (Array.isArray(contextFiles) ? contextFiles : [])
      .map((entry) => normalizePathForMatch(entry?.path || ''))
      .filter(Boolean)
  ));
  const contextHashDescriptors = buildPromptContextHashDescriptors(
    contextFiles,
    REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT
  );
  const canQueryCommitRange =
    typeof mergeBaseSha === 'string'
    && mergeBaseSha.trim()
    && typeof headSha === 'string'
    && headSha.trim();
  const providedRangeCommits = Array.isArray(rangeCommits) ? rangeCommits : null;
  const [shaCommits, rangeCommitEntries, conventions, projectMetadata, priorCacheRows, priorPathCacheRows, fileRiskContext, dismissedPatterns] = await Promise.all([
    normalizedQueuedShas.length > 0
      ? gitService.getCommitMessagesByShas(projectPath, normalizedQueuedShas).catch(() => [])
      : Promise.resolve([]),
    providedRangeCommits
      ? Promise.resolve(providedRangeCommits)
      : canQueryCommitRange
      ? gitService
          .getCommitsBetween(projectPath, String(mergeBaseSha).trim(), String(headSha).trim())
          .catch(() => [])
      : Promise.resolve([]),
    memoryService.getReviewConventions(projectPath, {
      maxItems: REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
      maxCharsPerItem: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    }).catch(() => []),
    verificationService.getReviewProjectMetadata(projectPath).catch(() => ({
      projectType: null,
      configFile: null,
      availableChecks: { lint: false, unit: false, e2e: false },
    })),
    normalizedCacheProjectId
      && contextHashDescriptors.length > 0
      && typeof branchReviewService.getReviewFileCacheByHashDescriptors === 'function'
      ? branchReviewService.getReviewFileCacheByHashDescriptors(
          normalizedCacheProjectId,
          contextHashDescriptors,
          {
            maxDescriptors: REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT,
            maxRows: REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT * 3,
          }
        ).catch(() => [])
      : Promise.resolve([]),
    normalizedCacheProjectId
      && allowGuardedCrossHashHints
      && normalizedContextFilePaths.length > 0
      && typeof branchReviewService.getReviewFileCacheByFilePaths === 'function'
      ? branchReviewService.getReviewFileCacheByFilePaths(
          normalizedCacheProjectId,
          normalizedContextFilePaths,
          {
            maxFilePaths: REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT,
            maxRows: REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT * 4,
          }
        ).catch(() => [])
      : Promise.resolve([]),
    normalizedContextFilePaths.length > 0
      && typeof gitService.getFileRiskContext === 'function'
      ? gitService.getFileRiskContext(projectPath, normalizedContextFilePaths, {
          maxFiles: REVIEW_FILE_RISK_CONTEXT_MAX_FILES,
          recentDays: 30,
          authorDays: 90,
        }).catch(() => [])
      : Promise.resolve([]),
    buildDismissedPatternHints(normalizedCacheProjectId),
  ]);

  const normalizedFallbackCommitMessages = normalizePromptContextList(commitMessages, {
    maxItems: REVIEW_PROMPT_CONTEXT_RANGE_COMMIT_LIMIT,
    maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
  });
  const normalizedShaCommitMessages = normalizePromptContextList(
    shaCommits.map((entry) => {
      const shortSha = String(entry?.hash || '').trim().slice(0, 12);
      const message = normalizePromptContextLine(entry?.message || '', REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS);
      return shortSha && message ? `${shortSha}: ${message}` : message;
    }),
    {
      maxItems: REVIEW_PROMPT_CONTEXT_RANGE_COMMIT_LIMIT,
      maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    }
  );
  const normalizedRangeCommitMessages = normalizePromptContextList(
    rangeCommitEntries
      .slice(0, REVIEW_PROMPT_CONTEXT_RANGE_COMMIT_LIMIT)
      .map((entry) => entry?.message),
    {
      maxItems: REVIEW_PROMPT_CONTEXT_RANGE_COMMIT_LIMIT,
      maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    }
  );

  const resolvedCommitMessages = normalizePromptContextList(
    [
      ...normalizedFallbackCommitMessages,
      ...normalizedShaCommitMessages,
      ...normalizedRangeCommitMessages,
    ],
    {
      maxItems: REVIEW_PROMPT_CONTEXT_RANGE_COMMIT_LIMIT,
      maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    }
  );
  let resolvedVerificationStatus = null;
  if (verificationStatus && typeof verificationStatus === 'object') {
    const hasPrecomputedLines = Array.isArray(verificationStatus.lines)
      && verificationStatus.lines.some((line) => typeof line === 'string' && line.trim());
    resolvedVerificationStatus = hasPrecomputedLines
      ? {
          ...verificationStatus,
          lines: normalizePromptContextList(verificationStatus.lines, {
            maxItems: REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
            maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
          }),
        }
      : verificationService.summarizeReviewVerificationStatus?.(verificationStatus, {
          maxFailExcerptChars: REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_CHARS,
          maxFailExcerptLines: REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_LINES,
        });
  }
  const mergedPriorCacheRows = [
    ...(Array.isArray(priorCacheRows) ? priorCacheRows : []),
    ...(Array.isArray(priorPathCacheRows) ? priorPathCacheRows : []),
  ];
  const priorFindingHints = buildPromptContextPriorFindingHintsFromCacheRows(
    mergedPriorCacheRows,
    contextHashDescriptors,
    {
      maxItems: REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_MAX_LINES,
      sameHashOnly,
      allowGuardedCrossHashHints,
    }
  );
  const stackContext = await collectReviewStackContext(projectPath, {
    reviewProfile,
    contextFiles,
    priorCacheRows: mergedPriorCacheRows,
    projectMetadata,
    maxItems: REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
    maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
  }).catch(() => ({
    projectMetadata,
    additionalBlocks: [],
  }));

  return {
    commitMessages: resolvedCommitMessages,
    queuedCommitShas: normalizedQueuedShas,
    verificationStatus: resolvedVerificationStatus,
    requestedReviewers: normalizePromptContextParticipantList(requestedReviewers, {
      maxItems: REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
      maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    }),
    assignees: normalizePromptContextParticipantList(assignees, {
      maxItems: REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
      maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    }),
    reviewThreads: normalizePromptContextReviewThreadLines(reviewThreads, {
      maxItems: REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
      maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    }),
    priorFindingHints,
    fileRiskContext: Array.isArray(fileRiskContext) ? fileRiskContext : [],
    claudeConventions: normalizePromptContextList(conventions, {
      maxItems: REVIEW_PROMPT_CONTEXT_BLOCK_MAX_LINES,
      maxCharsPerLine: REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
    }),
    projectMetadata: normalizePromptContextProjectMetadata(stackContext?.projectMetadata || projectMetadata),
    dismissedPatterns: Array.isArray(dismissedPatterns) ? dismissedPatterns : [],
    additionalBlocks: Array.isArray(stackContext?.additionalBlocks) ? stackContext.additionalBlocks : [],
  };
}

export {
  REVIEW_OUTPUT_SCHEMA,
  PROMPT_CONTEXT_BLOCK_PRIORITY,
  normalizePromptContextLine,
  normalizePromptContextList,
  normalizeQueuedCommitShas,
  normalizePromptContextProjectMetadata,
  orderPromptContextBlocks,
  normalizePromptContextVerificationStatusBlockLines,
  normalizePromptContextParticipantList,
  normalizePromptContextReviewerExpectationLines,
  normalizePromptContextReviewThreadLines,
  normalizePriorFindingHintType,
  normalizePriorFindingHintSeverity,
  normalizePromptContextPriorFindingHintLines,
  normalizePromptContextFileRiskLines,
  normalizeLinterFindingsBlockLines,
  buildPromptContextBlockDefinitions,
  allocatePromptContextBudget,
  buildBoundedPromptContextBlocks,
  createPromptContextHashKey,
  buildPromptContextHashDescriptors,
  buildPromptContextPriorFindingHintsFromCacheRows,
  resolveBranchReviewVerificationStatus,
  buildDismissedPatternHints,
  collectPromptContextSignals,
};
