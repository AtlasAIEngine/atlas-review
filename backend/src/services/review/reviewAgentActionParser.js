const ACTION_BLOCK_RE = /```atlas-review-agent-action\s*([\s\S]*?)```/gi;
const GENERIC_FENCE_RE = /```[^\n`]*\n?([\s\S]*?)```/g;
const ACTION_TYPES = new Set([
  'draft_pr_reply',
  'fix_findings',
  'run_review',
  'set_outcome',
  'publish_pr_review',
]);
const MAX_ACTIONS = 4;
const MAX_DRAFT_BODY_CHARS = 8000;
const FIX_INTENT_RE = /\b(fix|repair|correct|patch|resolve|run\s+fix(?:es)?|fix\s+issues?)\b/i;
const ATTACHED_FINDING_RE = /\b(this|that|attached|selected|current)\s+(finding|issue)\b/i;
const FINDING_ID_RE = /\bF[1-9]\d*\b/gi;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRecommendationKeyValue(value) {
  return normalizeText(value)
    .replace(/\\+\|/g, '\\|')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, '\'')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeDraftBody(value) {
  const body = normalizeText(value);
  if (!body) return '';
  return body.length > MAX_DRAFT_BODY_CHARS ? body.slice(0, MAX_DRAFT_BODY_CHARS).trimEnd() : body;
}

function getAllowedThreadIds(context) {
  return new Set(
    (context?.attachments || [])
      .filter((attachment) => attachment?.type === 'github_thread')
      .flatMap((attachment) => [
        attachment.threadNodeId,
        attachment.conversation?.thread?.nodeId,
        attachment.conversation?.thread?.id,
      ])
      .map(normalizeText)
      .filter(Boolean)
  );
}

function getAllowedRecommendationKeys(context) {
  return new Set(
    [
      ...(context?.attachments || [])
      .filter((attachment) => attachment?.type === 'finding')
      .map((attachment) => normalizeRecommendationKeyValue(attachment.recommendationKey))
      .filter(Boolean),
      ...(context?.findingRefs || [])
        .map((finding) => normalizeRecommendationKeyValue(finding?.recommendationKey))
        .filter(Boolean),
    ]
  );
}

function getFindingIdToRecommendationKey(context) {
  return new Map(
    (context?.findingRefs || [])
      .map((finding) => [
        normalizeText(finding?.findingId).toUpperCase(),
        normalizeRecommendationKeyValue(finding?.recommendationKey),
      ])
      .filter(([findingId, recommendationKey]) => /^F[1-9]\d*$/.test(findingId) && recommendationKey)
  );
}

function buildLooseRecommendationKeyMap(allowedRecommendationKeys) {
  const entries = Array.from(allowedRecommendationKeys || []);
  return new Map(entries.map((key) => [normalizeRecommendationKeyValue(key).replace(/`/g, ''), key]));
}

function resolveRecommendationKeyOrFindingId(value, findingIdToRecommendationKey, looseRecommendationKeyMap = null) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const findingId = normalized.toUpperCase();
  if (findingIdToRecommendationKey.has(findingId)) {
    return findingIdToRecommendationKey.get(findingId);
  }
  const recommendationKey = normalizeRecommendationKeyValue(normalized);
  if (looseRecommendationKeyMap?.has(recommendationKey.replace(/`/g, ''))) {
    return looseRecommendationKeyMap.get(recommendationKey.replace(/`/g, ''));
  }
  return recommendationKey;
}

function normalizeDraftPrReplyAction(rawAction, allowedThreadIds) {
  const threadNodeId = normalizeText(rawAction?.threadNodeId);
  const body = normalizeDraftBody(rawAction?.body);
  if (!threadNodeId || !body) return null;
  if (!allowedThreadIds.has(threadNodeId)) return null;
  return {
    type: 'draft_pr_reply',
    threadNodeId,
    body,
  };
}

function normalizeFixFindingsAction(rawAction, context) {
  const allowedRecommendationKeys = getAllowedRecommendationKeys(context);
  if (allowedRecommendationKeys.size === 0) return null;
  const findingIdToRecommendationKey = getFindingIdToRecommendationKey(context);
  const looseRecommendationKeyMap = buildLooseRecommendationKeyMap(allowedRecommendationKeys);
  const rawKeys = Array.isArray(rawAction?.recommendationKeys)
    ? rawAction.recommendationKeys
    : [rawAction?.recommendationKey];
  const rawFindingIds = Array.isArray(rawAction?.findingIds)
    ? rawAction.findingIds
    : [rawAction?.findingId];
  const recommendationKeys = rawKeys
    .concat(rawFindingIds)
    .map((key) => resolveRecommendationKeyOrFindingId(key, findingIdToRecommendationKey, looseRecommendationKeyMap))
    .filter(Boolean)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .filter((key) => allowedRecommendationKeys.has(key));
  if (recommendationKeys.length === 0) return null;
  return {
    type: 'fix_findings',
    recommendationKeys,
  };
}

function getAttachedFindingRecommendationKeys(context) {
  return (context?.attachments || [])
    .filter((attachment) => attachment?.type === 'finding')
    .map((attachment) => normalizeRecommendationKeyValue(attachment.recommendationKey))
    .filter(Boolean);
}

export function inferReviewAgentActionsFromRequest(request, context = null) {
  const text = normalizeText(request);
  if (!text || !FIX_INTENT_RE.test(text)) return [];

  const findingIds = Array.from(text.matchAll(FINDING_ID_RE))
    .map((match) => normalizeText(match[0]).toUpperCase())
    .filter((findingId, index, values) => values.indexOf(findingId) === index);

  const rawAction = findingIds.length > 0
    ? { type: 'fix_findings', findingIds }
    : ATTACHED_FINDING_RE.test(text)
      ? { type: 'fix_findings', recommendationKeys: getAttachedFindingRecommendationKeys(context) }
      : null;

  if (!rawAction) return [];
  const action = normalizeFixFindingsAction(rawAction, context);
  return action ? [action] : [];
}

function normalizeRunReviewAction(rawAction) {
  const mode = normalizeText(rawAction?.mode).toLowerCase();
  return {
    type: 'run_review',
    mode: mode === 'full' ? 'full' : 'standard',
  };
}

function normalizeSetOutcomeAction(rawAction, context) {
  const allowedRecommendationKeys = getAllowedRecommendationKeys(context);
  if (allowedRecommendationKeys.size === 0) return null;
  const findingIdToRecommendationKey = getFindingIdToRecommendationKey(context);
  const looseRecommendationKeyMap = buildLooseRecommendationKeyMap(allowedRecommendationKeys);
  const recommendationKey = resolveRecommendationKeyOrFindingId(
    rawAction?.recommendationKey || rawAction?.findingId,
    findingIdToRecommendationKey,
    looseRecommendationKeyMap
  );
  const status = normalizeText(rawAction?.status).toLowerCase();
  const note = normalizeDraftBody(rawAction?.note);
  if (!recommendationKey || (status !== 'addressed' && status !== 'dismissed')) return null;
  if (!allowedRecommendationKeys.has(recommendationKey)) return null;
  return {
    type: 'set_outcome',
    recommendationKey,
    status,
    ...(note ? { note } : {}),
  };
}

function normalizePublishPrReviewAction(rawAction, context) {
  if (context?.scope?.reviewType !== 'pr_review') return null;
  const action = normalizeText(rawAction?.action).toLowerCase();
  if (action !== 'comment' && action !== 'approve' && action !== 'request_changes') return null;
  const allowedRecommendationKeys = getAllowedRecommendationKeys(context);
  const findingIdToRecommendationKey = getFindingIdToRecommendationKey(context);
  const looseRecommendationKeyMap = buildLooseRecommendationKeyMap(allowedRecommendationKeys);
  const rawKeys = Array.isArray(rawAction?.recommendationKeys) ? rawAction.recommendationKeys : [];
  const rawFindingIds = Array.isArray(rawAction?.findingIds) ? rawAction.findingIds : [];
  const recommendationKeys = rawKeys
    .concat(rawFindingIds)
    .map((key) => resolveRecommendationKeyOrFindingId(key, findingIdToRecommendationKey, looseRecommendationKeyMap))
    .filter(Boolean)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .filter((key) => allowedRecommendationKeys.size === 0 || allowedRecommendationKeys.has(key));
  const body = normalizeDraftBody(rawAction?.body);
  return {
    type: 'publish_pr_review',
    action,
    ...(body ? { body } : {}),
    ...(recommendationKeys.length > 0 ? { recommendationKeys } : {}),
  };
}

function normalizeAction(rawAction, context) {
  if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) return null;
  const type = normalizeText(rawAction.type);
  if (type === 'run_review') {
    return normalizeRunReviewAction(rawAction);
  }
  if (type === 'draft_pr_reply') {
    return normalizeDraftPrReplyAction(rawAction, getAllowedThreadIds(context));
  }
  if (type === 'fix_findings') {
    return normalizeFixFindingsAction(rawAction, context);
  }
  if (type === 'set_outcome') {
    return normalizeSetOutcomeAction(rawAction, context);
  }
  if (type === 'publish_pr_review') {
    return normalizePublishPrReviewAction(rawAction, context);
  }
  return null;
}

function parseActionJson(rawJson) {
  const rawText = String(rawJson || '').trim();
  const attempts = [rawText];
  if (rawText.includes('\\"')) {
    attempts.push(rawText.replace(/\\"/g, '"'));
  }
  let parsed;
  let lastError = null;
  for (const attempt of attempts) {
    try {
      parsed = JSON.parse(attempt);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (typeof parsed === 'string') {
    return parseActionJson(parsed);
  }
  if (parsed === undefined && lastError) {
    throw lastError;
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.actions)) return parsed.actions;
  return [parsed];
}

function hasReviewAgentActionShape(rawActions) {
  return rawActions.some((rawAction) => (
    rawAction
    && typeof rawAction === 'object'
    && !Array.isArray(rawAction)
    && ACTION_TYPES.has(normalizeText(rawAction.type))
  ));
}

export function parseReviewAgentActions(content, context = null) {
  const text = String(content || '');
  const actions = [];
  let strippedActionPayload = false;
  const addActionsFromJson = (rawJson) => {
    try {
      const rawActions = parseActionJson(rawJson);
      const hasActionPayload = hasReviewAgentActionShape(rawActions);
      strippedActionPayload = strippedActionPayload || hasActionPayload;
      const normalizedActions = rawActions
        .map((rawAction) => normalizeAction(rawAction, context))
        .filter(Boolean);
      actions.push(...normalizedActions);
      return { hasActionPayload, added: normalizedActions.length > 0 };
    } catch {
      return { hasActionPayload: false, added: false };
    }
  };

  let cleanContent = text.replace(ACTION_BLOCK_RE, (_match, rawJson) => {
    addActionsFromJson(rawJson);
    // Invalid explicit action blocks are omitted from display and ignored.
    return '';
  });

  cleanContent = cleanContent.replace(GENERIC_FENCE_RE, (match, rawJson) => {
    const result = addActionsFromJson(rawJson);
    if (result.hasActionPayload) {
      return '';
    }
    return match;
  }).replace(/\n{3,}/g, '\n\n').trim();

  if (cleanContent) {
    const result = addActionsFromJson(cleanContent);
    if (result.hasActionPayload) {
      cleanContent = '';
    }
  }

  const dedupedActions = [];
  const seenActions = new Set();
  for (const action of actions) {
    const key = JSON.stringify(action);
    if (seenActions.has(key)) continue;
    seenActions.add(key);
    dedupedActions.push(action);
    if (dedupedActions.length >= MAX_ACTIONS) break;
  }

  return { content: cleanContent, actions: dedupedActions, strippedActionPayload };
}

export default {
  parseReviewAgentActions,
  inferReviewAgentActionsFromRequest,
  __testing: {
    getAllowedThreadIds,
    getAllowedRecommendationKeys,
    getFindingIdToRecommendationKey,
    resolveRecommendationKeyOrFindingId,
    normalizeAction,
    normalizeFixFindingsAction,
    normalizeRunReviewAction,
    normalizeSetOutcomeAction,
    normalizePublishPrReviewAction,
  },
};
