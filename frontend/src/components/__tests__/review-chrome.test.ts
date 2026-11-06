import { test, expect } from '@playwright/test';

import { getReviewActionButtonStyle, getReviewToneVars } from '../review/ReviewChrome';

test.describe('review chrome helpers', () => {
  test('resolves semantic tone vars for reusable review chips', () => {
    expect(getReviewToneVars('blue')).toEqual({
      text: 'var(--accent-blue)',
      bg: 'var(--chip-info-bg)',
      border: 'var(--chip-info-border)',
    });
    expect(getReviewToneVars('neutral')).toEqual({
      text: 'var(--text-secondary)',
      bg: 'var(--review-chip-neutral-bg)',
      border: 'var(--review-chip-neutral-border)',
    });
  });

  test('builds compact action button styles with disabled and active states', () => {
    expect(getReviewActionButtonStyle({ tone: 'green', active: true })).toMatchObject({
      minHeight: 30,
      background: 'var(--chip-success-bg)',
      color: 'var(--accent-green)',
      border: '1px solid var(--chip-success-border)',
      cursor: 'pointer',
    });

    expect(getReviewActionButtonStyle({ tone: 'red', disabled: true })).toMatchObject({
      background: 'var(--review-chip-neutral-bg)',
      color: 'var(--text-tertiary)',
      border: '1px solid var(--review-shell-border)',
      cursor: 'not-allowed',
      opacity: 0.55,
    });
  });
});
