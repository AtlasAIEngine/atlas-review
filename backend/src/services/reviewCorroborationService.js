const HIGH_RISK_SEVERITIES = new Set(['high', 'critical']);
const CORROBORATION_STATUSES = new Set(['supported', 'unsupported', 'inconclusive', 'not_applicable']);
const CORROBORATION_CONFIDENCE = new Set(['low', 'medium', 'high']);
const CORROBORATION_SOURCE_CLASSES = new Set(['deterministic_tool', 'verifier', 'grounding', 'none']);

const SEVERITY_DOWNGRADE_ORDER = Object.freeze({
  critical: 'high',
  high: 'medium',
  medium: 'low',
  low: 'low',
});

const SECURITY_SIGNAL_RE = /\b(security|auth|authentication|authorization|token|secret|credential|sql|injection|xss|csrf|ssrf|rce|privilege|encryption|decrypt|cipher|hash)\b/i;

function normalizeSeverity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'low';
}

function normalizeCorroborationStatus(value, fallback = 'not_applicable') {
  const normalizedFallback = CORROBORATION_STATUSES.has(String(fallback || '').trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : 'not_applicable';
  const normalized = String(value || '').trim().toLowerCase();
  if (CORROBORATION_STATUSES.has(normalized)) {
    return normalized;
  }
  return normalizedFallback;
}

function normalizeConfidence(value, fallback = 'low') {
  const normalizedFallback = CORROBORATION_CONFIDENCE.has(String(fallback || '').trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : 'low';
  const normalized = String(value || '').trim().toLowerCase();
  if (CORROBORATION_CONFIDENCE.has(normalized)) {
    return normalized;
  }
  return normalizedFallback;
}

function normalizeReasonCode(value, fallback = 'not_applicable') {
  const normalizedFallback = String(fallback || '').trim().toLowerCase() || 'not_applicable';
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return normalizedFallback;
  return normalized.replace(/\s+/g, '_');
}

function normalizeCorroborationSourceClass(value, fallback = 'none') {
  const normalizedFallback = CORROBORATION_SOURCE_CLASSES.has(String(fallback || '').trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : 'none';
  const normalized = String(value || '').trim().toLowerCase();
  if (CORROBORATION_SOURCE_CLASSES.has(normalized)) return normalized;
  return normalizedFallback;
}

function normalizeCorroborationSourceName(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function hasEvidenceSnippet(recommendation) {
  const topLevel = String(recommendation?.evidenceSnippet || '').trim();
  if (topLevel) return true;
  const nested = String(recommendation?.evidence?.snippet || '').trim();
  return Boolean(nested);
}

function hasLineAnchor(recommendation) {
  const parsed = Math.trunc(Number(recommendation?.line) || 0);
  return parsed > 0;
}

function hasGroundingSignal(recommendation) {
  const explicitGrounding = recommendation?.grounding;
  if (explicitGrounding && typeof explicitGrounding === 'object') {
    if (explicitGrounding.grounded === true) return true;
  }
  if (recommendation?.evidenceMissing === true) return false;
  return hasLineAnchor(recommendation) || hasEvidenceSnippet(recommendation);
}

function isHighRiskIssue(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') return false;
  const type = String(recommendation.type || '').trim().toLowerCase();
  if (type !== 'issue') return false;
  return HIGH_RISK_SEVERITIES.has(normalizeSeverity(recommendation.severity));
}

function isSecuritySensitiveRecommendation(recommendation) {
  const title = String(recommendation?.title || '');
  const description = String(recommendation?.description || '');
  const combined = `${title} ${description}`.trim();
  if (!combined) return false;
  return SECURITY_SIGNAL_RE.test(combined);
}

function evaluateDeterministicSourceSignal(recommendation, options = {}) {
  const evaluator = typeof options.sourceEvaluator === 'function'
    ? options.sourceEvaluator
    : null;
  if (!evaluator) return null;

  let result = null;
  try {
    result = evaluator(recommendation, options);
  } catch {
    return null;
  }
  if (!result || typeof result !== 'object') return null;

  const status = normalizeCorroborationStatus(result.status, 'not_applicable');
  if (status === 'not_applicable') return null;

  return {
    status,
    reason: normalizeReasonCode(result.reason, status === 'supported' ? 'deterministic_source_supported' : 'deterministic_source_unsupported'),
    confidence: normalizeConfidence(result.confidence, status === 'supported' ? 'high' : 'low'),
    sourceClass: normalizeCorroborationSourceClass(result.sourceClass, 'deterministic_tool'),
    sourceName: normalizeCorroborationSourceName(result.sourceName),
  };
}

function evaluateRecommendationCorroboration(recommendation, options = {}) {
  const allowGroundedFallback = options.allowGroundedFallback !== false;
  if (!isHighRiskIssue(recommendation)) {
    return {
      status: 'not_applicable',
      reason: 'not_high_risk_issue',
      confidence: null,
    };
  }

  const deterministicSignal = evaluateDeterministicSourceSignal(recommendation, options);
  if (deterministicSignal) {
    return deterministicSignal;
  }

  const verifierDecision = String(recommendation?.verifierDecision || '').trim().toLowerCase();
  if (verifierDecision === 'supported') {
    return {
      status: 'supported',
      reason: 'verifier_supported',
      confidence: 'high',
      sourceClass: 'verifier',
    };
  }
  if (verifierDecision === 'unsupported') {
    return {
      status: 'unsupported',
      reason: 'verifier_unsupported',
      confidence: 'low',
      sourceClass: 'verifier',
    };
  }
  if (verifierDecision === 'needs_more_context' || verifierDecision === 'needs_context') {
    return {
      status: 'inconclusive',
      reason: 'verifier_needs_more_context',
      confidence: 'low',
      sourceClass: 'verifier',
    };
  }

  if (allowGroundedFallback && hasGroundingSignal(recommendation)) {
    if (hasEvidenceSnippet(recommendation)) {
      return {
        status: 'supported',
        reason: 'grounded_snippet',
        confidence: 'medium',
        sourceClass: 'grounding',
      };
    }
    return {
      status: 'supported',
      reason: 'grounded_line_anchor',
      confidence: 'medium',
      sourceClass: 'grounding',
    };
  }

  return {
    status: 'unsupported',
    reason: 'missing_corroboration',
    confidence: 'low',
    sourceClass: 'none',
  };
}

function buildCorroborationEntry(recommendation, evaluation) {
  return {
    status: normalizeCorroborationStatus(evaluation?.status, 'not_applicable'),
    reason: normalizeReasonCode(evaluation?.reason, 'not_applicable'),
    confidence: evaluation?.confidence == null ? null : normalizeConfidence(evaluation.confidence, 'low'),
    sourceClass: normalizeCorroborationSourceClass(evaluation?.sourceClass, 'none'),
    sourceName: normalizeCorroborationSourceName(evaluation?.sourceName),
    isSecuritySensitive: isSecuritySensitiveRecommendation(recommendation),
  };
}

function applyCorroborationToRecommendation(recommendation, evaluation, options = {}) {
  const downgradeOnUnsupported = options.downgradeOnUnsupported !== false;
  const source = recommendation && typeof recommendation === 'object' ? recommendation : {};
  const next = { ...source };
  const corroboration = buildCorroborationEntry(source, evaluation);
  next.corroboration = corroboration;

  let downgraded = false;
  if (corroboration.status === 'unsupported' && downgradeOnUnsupported) {
    const previousSeverity = normalizeSeverity(next.severity);
    if (HIGH_RISK_SEVERITIES.has(previousSeverity)) {
      const downgradedSeverity = SEVERITY_DOWNGRADE_ORDER[previousSeverity] || previousSeverity;
      if (downgradedSeverity !== previousSeverity) {
        next.severity = downgradedSeverity;
        next.confidence = 'low';
        const description = String(next.description || '').trim();
        if (!/\bcorroboration\b/i.test(description)) {
          next.description = description
            ? `${description} Corroboration was not found for this high-risk finding; severity was downgraded for manual follow-up.`
            : 'Corroboration was not found for this high-risk finding; severity was downgraded for manual follow-up.';
        }
        next.corroboration = {
          ...next.corroboration,
          downgradedFrom: previousSeverity,
          downgradedTo: downgradedSeverity,
        };
        downgraded = true;
      }
    }
  } else if (corroboration.status !== 'unsupported' && !next.confidence && corroboration.confidence) {
    next.confidence = corroboration.confidence;
  }

  return {
    recommendation: next,
    downgraded,
  };
}

function summarizeCorroborationStats(entries = []) {
  const stats = {
    checked: 0,
    supported: 0,
    unsupported: 0,
    inconclusive: 0,
    notApplicable: 0,
    downgraded: 0,
    securitySensitiveChecked: 0,
    reasonCounts: {},
    sourceClassCounts: {},
    sourceNameCounts: {},
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const status = normalizeCorroborationStatus(entry.status, 'not_applicable');
    const reason = normalizeReasonCode(entry.reason, 'not_applicable');
    const sourceClass = normalizeCorroborationSourceClass(entry.sourceClass, 'none');
    const sourceName = normalizeCorroborationSourceName(entry.sourceName);
    const sourceNameKey = sourceName ? sourceName.toLowerCase() : null;
    stats.checked += 1;
    if (status === 'supported') stats.supported += 1;
    if (status === 'unsupported') stats.unsupported += 1;
    if (status === 'inconclusive') stats.inconclusive += 1;
    if (status === 'not_applicable') stats.notApplicable += 1;
    if (entry.downgraded === true) stats.downgraded += 1;
    if (entry.isSecuritySensitive === true) stats.securitySensitiveChecked += 1;
    stats.reasonCounts[reason] = (stats.reasonCounts[reason] || 0) + 1;
    stats.sourceClassCounts[sourceClass] = (stats.sourceClassCounts[sourceClass] || 0) + 1;
    if (sourceNameKey) {
      stats.sourceNameCounts[sourceNameKey] = (stats.sourceNameCounts[sourceNameKey] || 0) + 1;
    }
  }

  return stats;
}

function applyCorroborationToReview(reviewResult, options = {}) {
  const enabled = options.enabled !== false;
  const allowGroundedFallback = options.allowGroundedFallback !== false;
  const downgradeOnUnsupported = options.downgradeOnUnsupported !== false;
  const sourceEvaluator = typeof options.sourceEvaluator === 'function'
    ? options.sourceEvaluator
    : null;
  const source = reviewResult && typeof reviewResult === 'object' ? reviewResult : {};
  const recommendations = Array.isArray(source.recommendations) ? source.recommendations : [];
  const nextRecommendations = [];
  const entries = [];

  for (const recommendation of recommendations) {
    if (!isHighRiskIssue(recommendation)) {
      nextRecommendations.push(recommendation);
      continue;
    }
    const evaluation = enabled
      ? evaluateRecommendationCorroboration(recommendation, { allowGroundedFallback, sourceEvaluator })
      : { status: 'not_applicable', reason: 'corroboration_disabled', confidence: null };
    const applied = applyCorroborationToRecommendation(recommendation, evaluation, {
      downgradeOnUnsupported: enabled && downgradeOnUnsupported,
    });
    nextRecommendations.push(applied.recommendation);
    entries.push({
      status: applied.recommendation?.corroboration?.status,
      reason: applied.recommendation?.corroboration?.reason,
      downgraded: applied.downgraded,
      sourceClass: applied.recommendation?.corroboration?.sourceClass,
      sourceName: applied.recommendation?.corroboration?.sourceName,
      isSecuritySensitive: isSecuritySensitiveRecommendation(applied.recommendation),
    });
  }

  const stats = summarizeCorroborationStats(entries);
  const nextStats = (source.stats && typeof source.stats === 'object')
    ? { ...source.stats }
    : {};
  nextStats.corroborationEnabled = enabled;
  nextStats.corroborationChecked = stats.checked;
  nextStats.corroborationSupported = stats.supported;
  nextStats.corroborationUnsupported = stats.unsupported;
  nextStats.corroborationInconclusive = stats.inconclusive;
  nextStats.corroborationNotApplicable = stats.notApplicable;
  nextStats.corroborationDowngraded = stats.downgraded;
  nextStats.corroborationSecuritySensitiveChecked = stats.securitySensitiveChecked;
  nextStats.corroborationReasonCounts = { ...stats.reasonCounts };
  nextStats.corroborationSourceClassCounts = { ...stats.sourceClassCounts };
  nextStats.corroborationSourceNameCounts = { ...stats.sourceNameCounts };
  nextStats.corroboration = {
    enabled,
    checked: stats.checked,
    supported: stats.supported,
    unsupported: stats.unsupported,
    inconclusive: stats.inconclusive,
    notApplicable: stats.notApplicable,
    downgraded: stats.downgraded,
    securitySensitiveChecked: stats.securitySensitiveChecked,
    reasonCounts: { ...stats.reasonCounts },
    sourceClassCounts: { ...stats.sourceClassCounts },
    sourceNameCounts: { ...stats.sourceNameCounts },
  };

  return {
    review: {
      ...source,
      recommendations: nextRecommendations,
      stats: nextStats,
    },
    stats: {
      ...stats,
      enabled,
    },
  };
}

export default {
  evaluateRecommendationCorroboration,
  applyCorroborationToRecommendation,
  applyCorroborationToReview,
  summarizeCorroborationStats,
  __testing: {
    normalizeCorroborationStatus,
    normalizeReasonCode,
    normalizeConfidence,
    normalizeSeverity,
    normalizeCorroborationSourceClass,
    normalizeCorroborationSourceName,
    hasEvidenceSnippet,
    hasLineAnchor,
    hasGroundingSignal,
    isHighRiskIssue,
    isSecuritySensitiveRecommendation,
    evaluateDeterministicSourceSignal,
    buildCorroborationEntry,
  },
};
