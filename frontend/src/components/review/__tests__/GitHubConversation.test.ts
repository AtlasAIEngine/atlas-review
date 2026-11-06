import { expect, test } from '@playwright/test';
import {
  describeGitHubConversationLoadError,
  isRetryableGitHubConversationLoadError,
} from '../GitHubConversation';

test.describe('GitHub conversation load errors', () => {
  test('normalizes GitHub HTML error pages', () => {
    const message = describeGitHubConversationLoadError({
      response: {
        data: '<!DOCTYPE html><html><body>Hello future GitHubber</body></html>',
      },
    });

    expect(message).toBe(
      'GitHub returned a temporary HTML error page while loading conversations. Try syncing again in a moment.'
    );
  });

  test('preserves non-HTML upstream messages with angle-bracketed content', () => {
    const upstreamMessage = 'Upstream error: <body>rate limit exceeded</body> for <html-fragment>';
    const message = describeGitHubConversationLoadError({
      response: {
        data: upstreamMessage,
      },
    });

    expect(message).toBe(upstreamMessage);
  });

  test('normalizes plain html error pages without a doctype', () => {
    const message = describeGitHubConversationLoadError({
      response: {
        data: '<html><body>temporary upstream error</body></html>',
      },
    });

    expect(message).toBe(
      'GitHub returned a temporary HTML error page while loading conversations. Try syncing again in a moment.'
    );
  });

  test('retries plain html error pages without a doctype', () => {
    expect(isRetryableGitHubConversationLoadError({
      response: {
        data: '<html><body>temporary upstream error</body></html>',
      },
    })).toBe(true);
  });
});
