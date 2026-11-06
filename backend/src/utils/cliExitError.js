const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/g;

function stripAnsi(value) {
  return String(value || '').replace(ANSI_ESCAPE_RE, '');
}

function normalizeForMatch(value) {
  return stripAnsi(value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sanitizeSnippet(value, maxLength = 260) {
  const normalized = stripAnsi(value)
    .replace(CONTROL_CHAR_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^error:\s*/i, '')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function extractStderrSnippet(stderrBuffer) {
  const raw = stripAnsi(stderrBuffer);
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const signalRe = /(error|failed|quota|credit|billing|429|rate limit|resource exhausted|unauthorized|forbidden|denied|invalid|not found|timeout|timed out|context|too long)/i;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (signalRe.test(lines[i])) {
      return lines[i];
    }
  }

  return lines[lines.length - 1] || '';
}

function withDetails(message, detail) {
  const safeDetail = sanitizeSnippet(detail);
  if (!safeDetail) return message;
  const lowerMessage = normalizeForMatch(message);
  const lowerDetail = normalizeForMatch(safeDetail);
  if (lowerMessage.includes(lowerDetail)) {
    return message;
  }
  const suffix = message.endsWith('.') ? '' : '.';
  return `${message}${suffix} Details: ${safeDetail}`;
}

function getCliLoginCommand(providerType) {
  if (providerType === 'anthropic') return 'claude login';
  if (providerType === 'openai') return 'codex login';
  if (providerType === 'google') return 'gemini auth login';
  if (providerType === 'opencode') return 'opencode auth';
  return 'login';
}

/**
 * Build a user-facing message for non-zero CLI exits.
 * Classifies known failures (auth, context, quota, model access, request) and
 * falls back to the most useful stderr/stream error snippet when unknown.
 */
export function buildCliExitErrorMessage({
  providerType,
  cliName,
  exitCode,
  stderrBuffer,
  streamErrorMessage,
} = {}) {
  const name = cliName || 'AI CLI';
  const detail = sanitizeSnippet(streamErrorMessage) || sanitizeSnippet(extractStderrSnippet(stderrBuffer));
  const textForMatch = normalizeForMatch(`${streamErrorMessage || ''} ${stderrBuffer || ''}`);

  const isAuthError = (
    textForMatch.includes('not authenticated')
    || textForMatch.includes('authentication failed')
    || textForMatch.includes('unauthorized')
    || textForMatch.includes('invalid api key')
    || textForMatch.includes('api key not valid')
    || textForMatch.includes('refresh token')
    || textForMatch.includes('please login')
    || textForMatch.includes('please log in')
    || textForMatch.includes('invalid credentials')
  );
  if (isAuthError) {
    return withDetails(
      `${name} authentication failed. Please run \`${getCliLoginCommand(providerType)}\` to re-authenticate.`,
      detail
    );
  }

  const isContextError = (
    textForMatch.includes('context window')
    || textForMatch.includes('context length')
    || textForMatch.includes('maximum context length')
    || textForMatch.includes('too long')
    || textForMatch.includes('too large')
    || textForMatch.includes('token limit')
    || textForMatch.includes('ran out of room')
  );
  if (isContextError) {
    return withDetails(`${name} context limit exceeded. Try a smaller prompt.`, detail);
  }

  const isQuotaError = (
    textForMatch.includes('429')
    || textForMatch.includes('too many requests')
    || textForMatch.includes('rate limit')
    || textForMatch.includes('quota')
    || textForMatch.includes('resource exhausted')
    || textForMatch.includes('insufficient credits')
    || textForMatch.includes('credits exhausted')
    || textForMatch.includes('billing')
    || textForMatch.includes('payment required')
    || textForMatch.includes('no payment method')
    || textForMatch.includes('requests per minute')
    || textForMatch.includes('tokens per minute')
    || textForMatch.includes('daily limit')
    || textForMatch.includes('monthly limit')
  );
  if (isQuotaError) {
    const quotaMessage = providerType === 'google'
      ? `${name} quota or rate limit reached. You may have hit Gemini free-tier credits or API quota limits. Check Google AI Studio quota/billing and retry.`
      : `${name} quota or rate limit reached. Check provider credits/quota and retry.`;
    return withDetails(quotaMessage, detail);
  }

  const isModelAccessError = (
    textForMatch.includes('invalid model')
    || textForMatch.includes('model not found')
    || textForMatch.includes('unknown model')
    || textForMatch.includes('unsupported model')
    || textForMatch.includes('model is not available')
    || textForMatch.includes('not enabled for this model')
    || textForMatch.includes('permission denied for model')
    || textForMatch.includes('access denied to model')
  );
  if (isModelAccessError) {
    return withDetails(
      `${name} model access failed. Verify the selected model is available for your account and retry.`,
      detail
    );
  }

  const isInvalidRequestError = (
    textForMatch.includes('bad request')
    || textForMatch.includes('invalid request')
    || textForMatch.includes('invalid argument')
    || textForMatch.includes('request was rejected')
    || textForMatch.includes('failed precondition')
  );
  if (isInvalidRequestError) {
    return withDetails(`${name} rejected the request.`, detail);
  }

  const isNetworkError = (
    textForMatch.includes('network')
    || textForMatch.includes('econnreset')
    || textForMatch.includes('enotfound')
    || textForMatch.includes('etimedout')
    || textForMatch.includes('timed out')
    || textForMatch.includes('connection reset')
    || textForMatch.includes('connection refused')
  );
  if (isNetworkError) {
    return withDetails(`${name} could not reach the provider service. Check connectivity and retry.`, detail);
  }

  if (detail && streamErrorMessage) {
    return `${name}: ${detail}`;
  }

  return withDetails(`${name} exited with code ${exitCode}`, detail);
}

