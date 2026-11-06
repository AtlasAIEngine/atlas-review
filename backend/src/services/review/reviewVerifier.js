/** Review Verifier — Two-pass verification for high/medium-risk recommendations. */

import {
  REVIEW_TWO_PASS_VERIFIER_ENABLED,
  REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS,
  REVIEW_TWO_PASS_VERIFIER_INCLUDE_MEDIUM,
  REVIEW_TWO_PASS_VERIFIER_MAX_MEDIUM_FINDINGS,
  REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS,
  REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS,
  REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE,
  REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES,
  REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY,
  REVIEW_CANDIDATE_PROMOTION_ENABLED,
  REVIEW_CANDIDATE_PROMOTION_MAX_FINDINGS,
  RECOMMENDATION_SEVERITY_WEIGHT,
  REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS,
} from './reviewConstants.js';

import {
  reconcileReviewRiskLevel,
  normalizeRiskValue,
  normalizeRecommendationTypeValue,
  normalizePathForMatch,
} from './reviewPromptBuilder.js';

import { clampNumber } from './reviewHelpers.js';

// ---------------------------------------------------------------------------
// Local helper — normalizePromptContextLine (not yet extracted to a shared
// sub-module, duplicated here to keep the verifier self-contained).
// ---------------------------------------------------------------------------
function normalizePromptContextLine(value, maxChars = REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS) {
  const collapsed = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return '';
  const normalizedMaxChars = Math.max(24, Math.trunc(Number(maxChars) || REVIEW_PROMPT_CONTEXT_LINE_MAX_CHARS));
  if (collapsed.length <= normalizedMaxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, normalizedMaxChars - 3)).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// Verifier decision normalization
// ---------------------------------------------------------------------------

function normalizeVerifierDecision(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'supported') return 'supported';
  if (normalized === 'unsupported') return 'unsupported';
  if (normalized === 'needs_more_context') return 'needs_more_context';
  if (normalized === 'skipped_budget') return 'skipped_budget';
  return 'needs_more_context';
}

function normalizeVerifierUnsupportedPolicy(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'hide' || normalized === 'demote') return normalized;
  return REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY;
}

function isVerifierDecisionSupported(value) {
  return normalizeVerifierDecision(value) === 'supported';
}

// ---------------------------------------------------------------------------
// Verifier prompt construction
// ---------------------------------------------------------------------------

function buildHighRiskVerifierPrompt(diffText, recommendation, metadata = {}) {
  const rec = recommendation && typeof recommendation === 'object'
    ? recommendation
    : {};
  const safeTitle = normalizePromptContextLine(rec.title || rec.description || 'Untitled finding', 220);
  const safeDescription = normalizePromptContextLine(rec.description || '', 280);
  const safeSeverity = normalizeRiskValue(rec.severity, 'medium');
  const safeType = normalizeRecommendationTypeValue(rec.type);
  const safeFile = normalizePathForMatch(rec.file || '') || 'unknown';
  const safeLine = Number.isFinite(Number(rec.line)) && Number(rec.line) > 0
    ? Math.floor(Number(rec.line))
    : null;
  const safeTitleContext = typeof metadata.title === 'string' && metadata.title.trim()
    ? metadata.title.trim()
    : 'Review';
  const scopeSummary = `files=${Math.max(0, Number(metadata.fileCount || 0))}, +${Math.max(0, Number(metadata.totalAdditions || 0))}/-${Math.max(0, Number(metadata.totalDeletions || 0))}`;

  return `You are a second-pass verifier for high-risk automated code review findings.

Determine whether the finding is supported by the diff evidence.
Return ONLY JSON:
{
  "decision": "supported | unsupported | needs_more_context",
  "reason": "one short sentence"
}

Rules:
- "supported": clear evidence in the diff substantiates the finding.
- "unsupported": diff evidence contradicts or does not support the finding.
- "needs_more_context": plausible concern, but available diff is insufficient.

Review title: ${safeTitleContext}
Review scope: ${scopeSummary}

Candidate finding:
- severity: ${safeSeverity}
- type: ${safeType}
- location: ${safeFile}${safeLine ? `:${safeLine}` : ''}
- title: ${safeTitle}
- description: ${safeDescription || 'none'}

Diff:
${diffText}`;
}

// ---------------------------------------------------------------------------
// Verifier response parsing
// ---------------------------------------------------------------------------

function parseHighRiskVerifierDecision(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) {
    return { decision: 'needs_more_context', reason: 'Verifier returned empty output.' };
  }

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (candidate) => {
    const normalized = String(candidate || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };
  pushCandidate(cleaned);

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    pushCandidate(fenceMatch[1]);
  }

  const extractFirstJsonObject = (input) => {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let index = 0; index < input.length; index += 1) {
      const ch = input[index];
      if (start === -1) {
        if (ch === '{') {
          start = index;
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
          return input.slice(start, index + 1);
        }
      }
    }
    return null;
  };
  const extractedObject = extractFirstJsonObject(cleaned);
  if (extractedObject) {
    pushCandidate(extractedObject);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const decision = normalizeVerifierDecision(
        parsed.decision || parsed.status || parsed.result
      );
      const reason = normalizePromptContextLine(
        parsed.reason || parsed.rationale || parsed.explanation || '',
        220
      );
      return {
        decision,
        reason: reason || 'Verifier did not provide a reason.',
      };
    } catch {
      // Continue candidate parsing
    }
  }

  return {
    decision: 'needs_more_context',
    reason: 'Verifier output could not be parsed as JSON.',
  };
}

// ---------------------------------------------------------------------------
// Apply verifier decision to a recommendation
// ---------------------------------------------------------------------------

function applyVerifierDecisionToRecommendation(recommendation, {
  decision = 'needs_more_context',
  reason = '',
  unsupportedPolicy = REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY,
} = {}) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  const normalizedDecision = normalizeVerifierDecision(decision);
  const normalizedPolicy = normalizeVerifierUnsupportedPolicy(unsupportedPolicy);
  const normalizedReason = normalizePromptContextLine(reason, 220);
  const base = {
    ...recommendation,
    verifierDecision: normalizedDecision,
  };
  if (normalizedReason) {
    base.verifierReason = normalizedReason;
  }

  if (normalizedDecision === 'unsupported') {
    if (normalizedPolicy === 'hide') {
      return null;
    }
    const demotedSeverityWeight = RECOMMENDATION_SEVERITY_WEIGHT[normalizeRiskValue(base.severity, 'medium')] || 0;
    const demotedSeverity = demotedSeverityWeight > RECOMMENDATION_SEVERITY_WEIGHT.medium
      ? 'medium'
      : normalizeRiskValue(base.severity, 'medium');
    const normalizedDescription = String(base.description || '').trim();
    const suffix = 'Verifier could not fully support this finding from the available diff context.';
    return {
      ...base,
      type: base.type === 'praise' ? 'praise' : 'suggestion',
      severity: demotedSeverity,
      description: normalizedDescription
        ? `${normalizedDescription} ${suffix}`
        : suffix,
    };
  }

  if (normalizedDecision === 'needs_more_context') {
    const normalizedDescription = String(base.description || '').trim();
    if (!/\bneeds more context\b/i.test(normalizedDescription)) {
      base.description = normalizedDescription
        ? `${normalizedDescription} Verifier needs more context to fully confirm this finding.`
        : 'Verifier needs more context to fully confirm this finding.';
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Verifier telemetry
// ---------------------------------------------------------------------------

function applyVerifierTelemetryToReviewStats(reviewResult, telemetry = {}) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
    reviewResult.stats = {};
  }
  const normalizedPolicy = normalizeVerifierUnsupportedPolicy(telemetry.unsupportedPolicy);
  reviewResult.stats.verifierEnabled = telemetry.enabled === true;
  reviewResult.stats.verifierMaxFindings = Math.max(0, Math.trunc(Number(telemetry.maxFindings) || 0));
  reviewResult.stats.verifierUnsupportedPolicy = normalizedPolicy;
  reviewResult.stats.verifierChecked = Math.max(0, Math.trunc(Number(telemetry.checked) || 0));
  reviewResult.stats.verifierSupported = Math.max(0, Math.trunc(Number(telemetry.supported) || 0));
  reviewResult.stats.verifierUnsupported = Math.max(0, Math.trunc(Number(telemetry.unsupported) || 0));
  reviewResult.stats.verifierNeedsMoreContext = Math.max(0, Math.trunc(Number(telemetry.needsMoreContext) || 0));
  reviewResult.stats.verifierNeedsContext = reviewResult.stats.verifierNeedsMoreContext;
  reviewResult.stats.verifierSkippedBudget = Math.max(0, Math.trunc(Number(telemetry.skippedBudget) || 0));
  reviewResult.stats.verifierMediumEnabled = telemetry.mediumEnabled === true;
  reviewResult.stats.verifierMediumMaxFindings = Math.max(0, Math.trunc(Number(telemetry.mediumMaxFindings) || 0));
  reviewResult.stats.verifierMediumConsidered = Math.max(0, Math.trunc(Number(telemetry.mediumConsidered) || 0));
  reviewResult.stats.verifierMediumChecked = Math.max(0, Math.trunc(Number(telemetry.mediumChecked) || 0));
  reviewResult.stats.verifierMediumSkippedBudget = Math.max(0, Math.trunc(Number(telemetry.mediumSkippedBudget) || 0));
  reviewResult.stats.verifierMediumGateStatus = String(telemetry.mediumGateStatus || 'disabled');
  reviewResult.stats.verifierMediumGateReasonCodes = Array.isArray(telemetry.mediumGateReasonCodes)
    ? telemetry.mediumGateReasonCodes
        .map((reason) => String(reason || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 12)
    : [];
  return reviewResult;
}

// ---------------------------------------------------------------------------
// Verifier candidate classification
// ---------------------------------------------------------------------------

function isHighRiskVerifierCandidate(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') return false;
  if (recommendation.type !== 'issue') return false;
  return recommendation.severity === 'high' || recommendation.severity === 'critical';
}

function isMediumRiskVerifierCandidate(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') return false;
  if (recommendation.type !== 'issue') return false;
  return recommendation.severity === 'medium';
}

function recommendationIdentityKey(recommendation) {
  const rec = recommendation && typeof recommendation === 'object' ? recommendation : {};
  return [
    normalizeRecommendationTypeValue(rec.type),
    normalizeRiskValue(rec.severity, 'low'),
    String(rec.title || '').trim().toLowerCase(),
    normalizePathForMatch(rec.file || '') || '',
    Number.isFinite(Number(rec.line)) && Number(rec.line) > 0 ? Math.floor(Number(rec.line)) : '',
  ].join('|');
}

function candidateFindingScore(recommendation) {
  const rec = recommendation && typeof recommendation === 'object' ? recommendation : {};
  const severityScore = RECOMMENDATION_SEVERITY_WEIGHT[normalizeRiskValue(rec.severity, 'low')] || 0;
  const confidenceScore = ({
    high: 3,
    medium: 2,
    low: 1,
  })[String(rec.confidence || '').trim().toLowerCase()] || 0;
  return (severityScore * 10) + confidenceScore;
}

async function runCandidateFindingPromotionPass(reviewResult, {
  enabled = REVIEW_CANDIDATE_PROMOTION_ENABLED,
  maxFindings = REVIEW_CANDIDATE_PROMOTION_MAX_FINDINGS,
  verifyCandidate = null,
} = {}) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  const sourceCandidates = Array.isArray(reviewResult.candidateFindings)
    ? reviewResult.candidateFindings.map((entry) => (entry && typeof entry === 'object' ? { ...entry } : entry)).filter(Boolean)
    : [];
  const normalizedMaxFindings = Math.max(0, Math.trunc(Number(maxFindings) || 0));
  const baseRecommendations = Array.isArray(reviewResult.recommendations)
    ? reviewResult.recommendations.map((entry) => (entry && typeof entry === 'object' ? { ...entry } : entry)).filter(Boolean)
    : [];
  const nextReview = {
    ...reviewResult,
    recommendations: baseRecommendations,
    candidateFindings: sourceCandidates,
    stats: reviewResult.stats && typeof reviewResult.stats === 'object'
      ? { ...reviewResult.stats }
      : {},
  };
  const telemetry = {
    enabled: enabled === true,
    maxFindings: normalizedMaxFindings,
    totalCandidates: sourceCandidates.length,
    checked: 0,
    promoted: 0,
    supported: 0,
    unsupported: 0,
    needsMoreContext: 0,
    skippedBudget: 0,
  };

  if (!telemetry.enabled || sourceCandidates.length === 0 || normalizedMaxFindings === 0 || typeof verifyCandidate !== 'function') {
    nextReview.stats.candidateFindingPromotion = telemetry;
    return nextReview;
  }

  const orderedEntries = sourceCandidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const scoreDiff = candidateFindingScore(right.candidate) - candidateFindingScore(left.candidate);
      if (scoreDiff !== 0) return scoreDiff;
      return left.index - right.index;
    });
  const existingKeys = new Set(baseRecommendations.map((entry) => recommendationIdentityKey(entry)));
  let checkedCount = 0;

  for (const entry of orderedEntries) {
    if (checkedCount >= normalizedMaxFindings) {
      telemetry.skippedBudget += 1;
      nextReview.candidateFindings[entry.index] = {
        ...nextReview.candidateFindings[entry.index],
        verifierDecision: 'skipped_budget',
      };
      continue;
    }

    checkedCount += 1;
    telemetry.checked += 1;
    let decisionPayload = null;
    try {
      decisionPayload = await verifyCandidate(
        { ...entry.candidate },
        { index: entry.index, ordinal: checkedCount, maxFindings: normalizedMaxFindings }
      );
    } catch (error) {
      decisionPayload = {
        decision: 'needs_more_context',
        reason: error?.message || 'Candidate verifier execution failed.',
      };
    }

    const normalizedDecision = normalizeVerifierDecision(decisionPayload?.decision);
    const reason = normalizePromptContextLine(decisionPayload?.reason || '', 220);
    const updatedCandidate = {
      ...nextReview.candidateFindings[entry.index],
      verifierDecision: normalizedDecision,
      ...(reason ? { verifierReason: reason } : {}),
    };
    nextReview.candidateFindings[entry.index] = updatedCandidate;

    if (normalizedDecision === 'supported') {
      telemetry.supported += 1;
      const identityKey = recommendationIdentityKey(updatedCandidate);
      if (!existingKeys.has(identityKey)) {
        const promoted = {
          ...updatedCandidate,
          promotedFromCandidate: true,
          confidence: updatedCandidate.confidence || 'medium',
        };
        nextReview.recommendations.push(promoted);
        existingKeys.add(identityKey);
        telemetry.promoted += 1;
      }
    } else if (normalizedDecision === 'unsupported') {
      telemetry.unsupported += 1;
    } else {
      telemetry.needsMoreContext += 1;
    }
  }

  nextReview.stats.candidateFindingPromotion = telemetry;
  reconcileReviewRiskLevel(nextReview);
  return nextReview;
}

// ---------------------------------------------------------------------------
// Medium-severity verifier expansion gate
// ---------------------------------------------------------------------------

function evaluateMediumVerifierExpansionGate(reviewResult = {}, {
  includeMedium = false,
  maxFirstSignalMs = REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS,
  maxDurationMs = REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS,
  maxOmittedRate = REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE,
  minDeepReviewedFiles = REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES,
} = {}) {
  const normalizedIncludeMedium = includeMedium === true;
  const stats = reviewResult?.stats && typeof reviewResult.stats === 'object'
    ? reviewResult.stats
    : {};
  const timing = reviewResult?.timing && typeof reviewResult.timing === 'object'
    ? reviewResult.timing
    : {};
  const totalFiles = Math.max(0, Math.trunc(Number(
    stats.totalChangedFiles ?? stats.filesTotal ?? stats.filesAnalyzed ?? 0
  ) || 0));
  const deepReviewedFiles = Math.max(0, Math.trunc(Number(
    stats.deepReviewedFiles ?? stats.filesDeepReviewed ?? stats.filesAnalyzed ?? 0
  ) || 0));
  const omittedFiles = Math.max(
    0,
    Math.max(
      Math.trunc(Number(stats.omittedFiles) || 0),
      Math.max(0, totalFiles - deepReviewedFiles)
    )
  );
  const omittedRate = totalFiles > 0 ? Math.max(0, Math.min(1, omittedFiles / totalFiles)) : 0;
  const rawFirstSignalMs = Number(stats.firstSignalMs ?? timing.firstSignalMs);
  const firstSignalMs = Number.isFinite(rawFirstSignalMs) && rawFirstSignalMs > 0
    ? rawFirstSignalMs
    : null;
  const durationMs = Math.max(
    0,
    Number(timing.totalMs ?? stats.totalDurationMs ?? 0) || 0
  );

  const reasonCodes = [];
  if (!normalizedIncludeMedium) {
    reasonCodes.push('medium_verifier_disabled');
  } else {
    if (firstSignalMs != null && firstSignalMs > Math.max(0, Number(maxFirstSignalMs) || REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS)) {
      reasonCodes.push('medium_gate_first_signal_slow');
    }

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      reasonCodes.push('medium_gate_missing_duration');
    } else if (durationMs > Math.max(0, Number(maxDurationMs) || REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS)) {
      reasonCodes.push('medium_gate_duration_high');
    }

    if (deepReviewedFiles < Math.max(0, Math.trunc(Number(minDeepReviewedFiles) || REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES))) {
      reasonCodes.push('medium_gate_insufficient_deep_reviewed_files');
    }

    if (omittedRate > clampNumber(maxOmittedRate, 0, 1)) {
      reasonCodes.push('medium_gate_omitted_rate_high');
    }
  }

  return {
    includeMedium: normalizedIncludeMedium,
    passed: normalizedIncludeMedium && reasonCodes.length === 0,
    reasonCodes,
    metrics: {
      totalFiles,
      deepReviewedFiles,
      omittedFiles,
      omittedRate,
      firstSignalMs,
      durationMs: durationMs > 0 ? durationMs : null,
    },
    thresholds: {
      maxFirstSignalMs: Math.max(0, Number(maxFirstSignalMs) || REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS),
      maxDurationMs: Math.max(0, Number(maxDurationMs) || REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS),
      maxOmittedRate: clampNumber(maxOmittedRate, 0, 1),
      minDeepReviewedFiles: Math.max(0, Math.trunc(Number(minDeepReviewedFiles) || REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES)),
    },
  };
}

// ---------------------------------------------------------------------------
// Main verifier pass — runBoundedHighRiskVerifierPass
//
// NOTE: This function accepts `verifyRecommendation` as a callback parameter
// (dependency injection) to avoid coupling with provider execution logic.
// ---------------------------------------------------------------------------

async function runBoundedHighRiskVerifierPass(reviewResult, {
  enabled = REVIEW_TWO_PASS_VERIFIER_ENABLED,
  maxFindings = REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS,
  includeMedium = REVIEW_TWO_PASS_VERIFIER_INCLUDE_MEDIUM,
  maxMediumFindings = REVIEW_TWO_PASS_VERIFIER_MAX_MEDIUM_FINDINGS,
  mediumGate = null,
  unsupportedPolicy = REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY,
  verifyRecommendation = null,
} = {}) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  const clonedRecommendations = Array.isArray(reviewResult.recommendations)
    ? reviewResult.recommendations.map((rec) => (rec && typeof rec === 'object' ? { ...rec } : rec))
    : [];
  const verified = {
    ...reviewResult,
    recommendations: clonedRecommendations,
    stats: (reviewResult.stats && typeof reviewResult.stats === 'object')
      ? { ...reviewResult.stats }
      : {},
  };
  const normalizedMaxFindings = Math.max(0, Math.trunc(Number(maxFindings) || 0));
  const normalizedMaxMediumFindings = Math.max(0, Math.trunc(Number(maxMediumFindings) || 0));
  const normalizedPolicy = normalizeVerifierUnsupportedPolicy(unsupportedPolicy);
  const mediumGateEvaluation = evaluateMediumVerifierExpansionGate(verified, {
    includeMedium,
    ...(mediumGate && typeof mediumGate === 'object' ? mediumGate : {}),
  });
  const highRiskCandidateEntries = verified.recommendations
    .map((rec, index) => ({ rec, index }))
    .filter(({ rec }) => isHighRiskVerifierCandidate(rec));
  const allMediumCandidateEntries = verified.recommendations
    .map((rec, index) => ({ rec, index }))
    .filter(({ rec }) => isMediumRiskVerifierCandidate(rec));
  const mediumCandidateEntries = mediumGateEvaluation.passed
    ? allMediumCandidateEntries
    : [];
  const telemetry = {
    enabled: enabled === true,
    maxFindings: normalizedMaxFindings,
    unsupportedPolicy: normalizedPolicy,
    checked: 0,
    supported: 0,
    unsupported: 0,
    needsMoreContext: 0,
    skippedBudget: 0,
    mediumEnabled: includeMedium === true,
    mediumMaxFindings: normalizedMaxMediumFindings,
    mediumConsidered: allMediumCandidateEntries.length,
    mediumChecked: 0,
    mediumSkippedBudget: 0,
    mediumGateStatus: mediumGateEvaluation.includeMedium
      ? (mediumGateEvaluation.passed ? 'pass' : 'blocked')
      : 'disabled',
    mediumGateReasonCodes: mediumGateEvaluation.reasonCodes,
  };
  const totalCandidates = highRiskCandidateEntries.length + mediumCandidateEntries.length;
  if (!telemetry.enabled || totalCandidates === 0) {
    applyVerifierTelemetryToReviewStats(verified, telemetry);
    return verified;
  }

  if (typeof verifyRecommendation !== 'function') {
    telemetry.skippedBudget = highRiskCandidateEntries.length;
    telemetry.mediumSkippedBudget = mediumCandidateEntries.length;
    applyVerifierTelemetryToReviewStats(verified, telemetry);
    return verified;
  }

  let highRiskVerifiedCount = 0;
  let mediumVerifiedCount = 0;
  let ordinal = 0;

  const processCandidate = async (entry, {
    tier = 'high_risk',
    maxTierFindings = 0,
    tierVerifiedCount = 0,
  }) => {
    if (tierVerifiedCount >= maxTierFindings) {
      if (tier === 'medium') {
        telemetry.mediumSkippedBudget += 1;
      } else {
        telemetry.skippedBudget += 1;
      }
      if (verified.recommendations[entry.index] && typeof verified.recommendations[entry.index] === 'object') {
        verified.recommendations[entry.index] = {
          ...verified.recommendations[entry.index],
          verifierDecision: 'skipped_budget',
        };
      }
      return tierVerifiedCount;
    }

    const nextTierVerifiedCount = tierVerifiedCount + 1;
    ordinal += 1;
    let decisionPayload = null;
    try {
      decisionPayload = await verifyRecommendation(
        { ...entry.rec },
        {
          index: entry.index,
          ordinal,
          maxFindings: maxTierFindings,
          tier,
        }
      );
    } catch (error) {
      decisionPayload = {
        decision: 'needs_more_context',
        reason: error?.message || 'Verifier execution failed.',
      };
    }

    const normalizedDecision = normalizeVerifierDecision(decisionPayload?.decision);
    const reason = normalizePromptContextLine(decisionPayload?.reason || '', 220);
    telemetry.checked += 1;
    if (tier === 'medium') {
      telemetry.mediumChecked += 1;
    }
    if (normalizedDecision === 'supported') {
      telemetry.supported += 1;
    } else if (normalizedDecision === 'unsupported') {
      telemetry.unsupported += 1;
    } else if (normalizedDecision === 'needs_more_context') {
      telemetry.needsMoreContext += 1;
    }

    verified.recommendations[entry.index] = applyVerifierDecisionToRecommendation(entry.rec, {
      decision: normalizedDecision,
      reason,
      unsupportedPolicy: normalizedPolicy,
    });
    return nextTierVerifiedCount;
  };

  for (const entry of highRiskCandidateEntries) {
    highRiskVerifiedCount = await processCandidate(entry, {
      tier: 'high_risk',
      maxTierFindings: normalizedMaxFindings,
      tierVerifiedCount: highRiskVerifiedCount,
    });
  }

  for (const entry of mediumCandidateEntries) {
    mediumVerifiedCount = await processCandidate(entry, {
      tier: 'medium',
      maxTierFindings: normalizedMaxMediumFindings,
      tierVerifiedCount: mediumVerifiedCount,
    });
  }

  verified.recommendations = verified.recommendations.filter(Boolean);
  reconcileReviewRiskLevel(verified);
  applyVerifierTelemetryToReviewStats(verified, telemetry);
  return verified;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  normalizeVerifierDecision,
  normalizeVerifierUnsupportedPolicy,
  isVerifierDecisionSupported,
  buildHighRiskVerifierPrompt,
  parseHighRiskVerifierDecision,
  applyVerifierDecisionToRecommendation,
  applyVerifierTelemetryToReviewStats,
  isHighRiskVerifierCandidate,
  isMediumRiskVerifierCandidate,
  runCandidateFindingPromotionPass,
  evaluateMediumVerifierExpansionGate,
  runBoundedHighRiskVerifierPass,
};
