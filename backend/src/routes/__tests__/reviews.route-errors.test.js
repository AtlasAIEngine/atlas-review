import { describe, expect, it } from 'vitest';
import { __testing } from '../reviews.js';

describe('reviews route error classification', () => {
  it('prefers explicit HTTP status fields over message parsing', () => {
    const status = __testing.classifyOutcomeRouteErrorStatus({
      statusCode: 409,
      message: 'not found',
    });
    expect(status).toBe(409);
  });

  it('maps known validation/storage codes to bad request', () => {
    expect(__testing.classifyOutcomeRouteErrorStatus({ code: '23514' })).toBe(400);
    expect(__testing.classifyOutcomeRouteErrorStatus({ code: 'SQLITE_CONSTRAINT_CHECK' })).toBe(400);
  });

  it('maps not-found message to 404 when no explicit metadata exists', () => {
    expect(__testing.classifyOutcomeRouteErrorStatus(new Error('Changeset not found'))).toBe(404);
  });

  it('falls back to 500 for unknown errors', () => {
    expect(__testing.classifyOutcomeRouteErrorStatus(new Error('unexpected boom'))).toBe(500);
  });

  it('allows only safe review stats passthrough fields and strips unknown keys', () => {
    const normalized = __testing.normalizePrecisionIssueCounters({
      filesAnalyzed: 3,
      issuesGrounded: 1,
      issuesDemoted: 1,
      issuesSuppressed: 0,
      reviewModelStrategy: 'smart',
      internalPromptDump: 'sensitive',
      debugCostUsd: 12.34,
    });

    expect(normalized.filesAnalyzed).toBe(3);
    expect(normalized.issuesTotal).toBe(2);
    expect(normalized.reviewModelStrategy).toBe('smart');
    expect(normalized.internalPromptDump).toBeUndefined();
    expect(normalized.debugCostUsd).toBeUndefined();
  });
});
