import { describe, expect, it } from 'vitest';
import { normalizeGitHubUpstreamErrorMessage } from '../prReviews.js';

describe('PR review GitHub upstream error normalization', () => {
  it('preserves structured messages containing html-like fragments', () => {
    const message = 'GitHub API error: <html-fragment>rate limit exceeded</html-fragment>';

    expect(normalizeGitHubUpstreamErrorMessage(new Error(message), 'fallback')).toBe(message);
  });

  it('preserves messages that start with html-like non-page tags', () => {
    const message = '<html-fragment>rate limit exceeded</html-fragment>';

    expect(normalizeGitHubUpstreamErrorMessage(new Error(message), 'fallback')).toBe(message);
  });

  it('normalizes real HTML pages to a temporary GitHub error message', () => {
    const message = '  <html><body>Hello future GitHubber</body></html>';

    expect(normalizeGitHubUpstreamErrorMessage(new Error(message), 'fallback')).toBe(
      'GitHub returned a temporary HTML error page. Try syncing again in a moment.'
    );
  });
});
