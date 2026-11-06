import { test, expect } from '@playwright/test';

import { shouldApplyChatRecovery } from '@/utils/chatRecovery';

test.describe('chat recovery', () => {
  test('ignores empty recovery when backend is idle', () => {
    expect(shouldApplyChatRecovery(
      { content: '' },
      { active: false, hasStreamContent: false },
    )).toBe(false);
  });

  test('applies empty recovery while backend still has an active run', () => {
    expect(shouldApplyChatRecovery(
      { content: '' },
      { active: true, hasStreamContent: false },
    )).toBe(true);
  });

  test('applies recovery when buffered content exists', () => {
    expect(shouldApplyChatRecovery(
      { content: 'partial answer' },
      { active: false, hasStreamContent: false },
    )).toBe(true);
  });
});
