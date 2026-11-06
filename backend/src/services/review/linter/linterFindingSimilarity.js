/**
 * Linter Finding Similarity
 * Shared matching heuristics for corroboration and standalone merge dedupe.
 */

const ISSUE_TOKEN_STOPWORDS = new Set([
  'and',
  'are',
  'but',
  'code',
  'file',
  'for',
  'from',
  'function',
  'have',
  'line',
  'lint',
  'linter',
  'object',
  'path',
  'review',
  'should',
  'that',
  'the',
  'their',
  'there',
  'this',
  'type',
  'value',
  'with',
]);

const ISSUE_TOKEN_ALIASES = new Map([
  ['func', 'function'],
  ['unuseds', 'unused'],
  ['variable', 'var'],
  ['variables', 'var'],
  ['vars', 'var'],
]);

export function normalizeReviewPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

export function reviewPathsMatch(left, right) {
  const normalizedLeft = normalizeReviewPath(left);
  const normalizedRight = normalizeReviewPath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function normalizeIssueToken(rawToken) {
  let token = String(rawToken || '').trim().toLowerCase();
  if (!token) return null;
  if (token.endsWith('ies') && token.length > 4) {
    token = `${token.slice(0, -3)}y`;
  } else if (token.endsWith('s') && token.length > 4 && !token.endsWith('ss')) {
    token = token.slice(0, -1);
  }
  token = ISSUE_TOKEN_ALIASES.get(token) || token;
  if (token.length < 3) return null;
  if (ISSUE_TOKEN_STOPWORDS.has(token)) return null;
  return token;
}

function buildIssueTextTokens(...parts) {
  const tokens = [];
  const seen = new Set();
  for (const part of parts) {
    const rawTokens = String(part || '').split(/[^a-z0-9]+/gi).filter(Boolean);
    for (const rawToken of rawTokens) {
      const token = normalizeIssueToken(rawToken);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

function buildIssueBigrams(tokens) {
  const bigrams = new Set();
  for (let index = 0; index < tokens.length - 1; index += 1) {
    bigrams.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return bigrams;
}

export function scoreLinterIssueSimilarity(left, right) {
  const leftTokens = buildIssueTextTokens(left?.ruleId, left?.title, left?.message, left?.description);
  const rightTokens = buildIssueTextTokens(right?.ruleId, right?.title, right?.message, right?.description);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const rightTokenSet = new Set(rightTokens);
  let score = 0;
  for (const token of leftTokens) {
    if (!rightTokenSet.has(token)) continue;
    score += token.length >= 6 ? 2 : 1;
  }

  if (score > 0) {
    const leftBigrams = buildIssueBigrams(leftTokens);
    const rightBigrams = buildIssueBigrams(rightTokens);
    for (const bigram of leftBigrams) {
      if (rightBigrams.has(bigram)) {
        score += 1;
        break;
      }
    }
  }

  return score;
}

export function isLinterFindingMatch(recommendation, finding, { lineWindow = 3, minimumScore = 2 } = {}) {
  if (!reviewPathsMatch(recommendation?.file, finding?.file)) return false;

  const recommendationLine = Math.trunc(Number(recommendation?.line) || 0);
  const findingLine = Math.trunc(Number(finding?.line) || 0);
  if (recommendationLine <= 0 || findingLine <= 0) return false;

  const normalizedLineWindow = Math.max(0, Math.trunc(Number(lineWindow) || 3));
  if (Math.abs(recommendationLine - findingLine) > normalizedLineWindow) return false;

  return scoreLinterIssueSimilarity(recommendation, finding) >= Math.max(1, Math.trunc(Number(minimumScore) || 2));
}
