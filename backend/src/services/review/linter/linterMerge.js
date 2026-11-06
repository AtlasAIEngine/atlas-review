/**
 * Linter Merge — Merges deterministic linter findings into AI review output.
 * Only anchored findings become standalone recommendations.
 * Deduplicates against existing AI recommendations.
 */

import { normalizeLinterSeverity } from './linterConstants.js';
import { isLinterFindingMatch } from './linterFindingSimilarity.js';

// ── Dedupe check ─────────────────────────────────────────────────────────────

function normalizeFindingConfidence(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized;
  return 'high';
}

function isPromotableDeterministicFinding(finding) {
  const promotionMode = String(finding?.promotionMode || '').trim().toLowerCase();
  if (promotionMode === 'candidate_evidence') return false;
  return normalizeFindingConfidence(finding?.confidence) === 'high';
}

function isDuplicate(finding, aiRecommendations, lineWindow = 3) {
  for (const rec of aiRecommendations) {
    if (isLinterFindingMatch(rec, finding, { lineWindow, minimumScore: 2 })) {
      return true;
    }
  }

  return false;
}

// ── Convert finding to recommendation ────────────────────────────────────────

function findingToRecommendation(finding) {
  const evidenceReasoning = buildFindingEvidenceReasoning(finding);
  return {
    type: 'issue',
    severity: normalizeLinterSeverity(finding.severity),
    title: buildFindingTitle(finding),
    description: buildFindingDescription(finding),
    file: finding.file || null,
    line: Number.isFinite(finding.line) && finding.line > 0 ? finding.line : null,
    suggestedFix: finding.suggestedFix || null,
    confidence: 'high',
    evidence: {
      file: finding.file || null,
      line: Number.isFinite(finding.line) && finding.line > 0 ? finding.line : null,
      snippet: null,
      reasoning: evidenceReasoning,
    },
    corroboration: {
      status: 'supported',
      confidence: 'high',
      sourceClass: 'deterministic_tool',
      sourceName: `${finding.source || 'linter'}:${finding.ruleId || 'unknown'}`,
      reason: 'deterministic_linter',
    },
  };
}

function buildFindingTitle(finding) {
  const ruleId = String(finding.ruleId || '').trim();
  const message = String(finding.message || '').trim();
  if (ruleId && message) {
    const short = message.length > 80 ? `${message.slice(0, 77).trimEnd()}...` : message;
    return short;
  }
  return message || ruleId || 'Deterministic linter finding';
}

function buildFindingDescription(finding) {
  const source = String(finding.source || 'linter');
  const ruleId = String(finding.ruleId || '').trim();
  const message = String(finding.message || '').trim();
  const parts = [`${source}`];
  if (ruleId) parts[0] += ` \`${ruleId}\``;
  parts[0] += ` reported`;
  if (message) parts.push(`${message.endsWith('.') ? message : `${message}.`}`);
  parts.push('This is a deterministic finding anchored to a changed diff line.');
  const evidenceSummary = String(finding?.evidenceSummary || '').trim();
  if (evidenceSummary) {
    parts.push(`Local verification: ${evidenceSummary}.`);
  }
  return parts.join(': ');
}

function buildFindingEvidenceReasoning(finding) {
  const evidenceSummary = String(finding?.evidenceSummary || '').trim();
  if (evidenceSummary) {
    return `Deterministic linter finding anchored to a changed diff line. Local verification: ${evidenceSummary}.`;
  }
  return 'Deterministic linter finding anchored to a changed diff line.';
}

// ── Main merge function ──────────────────────────────────────────────────────

/**
 * Merge anchored deterministic findings into the review result.
 *
 * @param {object} reviewResult - The AI review result (with recommendations array)
 * @param {Array} anchoredFindings - Linter findings already filtered to anchored-only
 * @param {object} [options]
 * @param {number} [options.lineWindow] - Line window for dedup matching
 * @returns {object} Updated review result with merged recommendations
 */
export function mergeDeterministicFindingsIntoReview(reviewResult, anchoredFindings, options = {}) {
  if (!Array.isArray(anchoredFindings) || anchoredFindings.length === 0) {
    return reviewResult;
  }

  const source = reviewResult && typeof reviewResult === 'object' ? reviewResult : {};
  const aiRecommendations = Array.isArray(source.recommendations) ? source.recommendations : [];
  const lineWindow = Number.isFinite(options.lineWindow) ? options.lineWindow : 3;

  const merged = [];
  let mergedCount = 0;
  let deduplicatedCount = 0;
  let candidateEvidenceSkipped = 0;

  for (const finding of anchoredFindings) {
    if (!isPromotableDeterministicFinding(finding)) {
      candidateEvidenceSkipped++;
      continue;
    }
    if (isDuplicate(finding, aiRecommendations, lineWindow)) {
      deduplicatedCount++;
      continue;
    }
    merged.push(findingToRecommendation(finding));
    mergedCount++;
  }

  if (merged.length === 0) {
    return {
      ...source,
      stats: {
        ...(source.stats || {}),
        deterministicMerge: {
          merged: 0,
          deduplicated: deduplicatedCount,
          candidateEvidenceSkipped,
          total: anchoredFindings.length,
        },
      },
    };
  }

  return {
    ...source,
    recommendations: [...aiRecommendations, ...merged],
    stats: {
      ...(source.stats || {}),
      deterministicMerge: {
        merged: mergedCount,
        deduplicated: deduplicatedCount,
        candidateEvidenceSkipped,
        total: anchoredFindings.length,
      },
    },
  };
}
