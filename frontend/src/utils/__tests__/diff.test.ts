import { test, expect } from '@playwright/test';

import { computeUnifiedDiff } from '../diff';

test.describe('computeUnifiedDiff', () => {
  test('returns an empty diff instead of throwing on malformed non-string payloads', () => {
    expect(() => computeUnifiedDiff({ before: 'x' } as any, ['y'] as any)).not.toThrow();
    expect(computeUnifiedDiff({ before: 'x' } as any, ['y'] as any)).toEqual([]);
  });

  test('still computes one-sided diffs when only one side is malformed', () => {
    expect(computeUnifiedDiff('alpha', { value: 'beta' } as any)).toEqual([
      { type: 'del', content: 'alpha', oldNum: 1, newNum: null },
    ]);
    expect(computeUnifiedDiff({ value: 'alpha' } as any, 'beta')).toEqual([
      { type: 'add', content: 'beta', oldNum: null, newNum: 1 },
    ]);
  });
});
