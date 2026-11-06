import { test, expect } from '@playwright/test';

import { createPendingProjectPrompt } from '@/utils/homePromptTransfer';

test.describe('home prompt transfer', () => {
  test('defaults pending home prompts to agent mode', () => {
    const result = createPendingProjectPrompt('project-1', 'Build me a dashboard');

    expect(result).toMatchObject({
      projectId: 'project-1',
      prompt: 'Build me a dashboard',
      files: [],
      chatMode: 'agent',
      providerType: null,
      modelAlias: null,
    });
    expect(result?.requestId).toMatch(/.+/);
  });

  test('preserves explicit plan mode and selected provider/model metadata', () => {
    const file = new File(['spec'], 'spec.md', { type: 'text/markdown' });

    const result = createPendingProjectPrompt(
      'project-2',
      'Plan this app',
      [file],
      {
        chatMode: 'plan',
        providerType: 'anthropic',
        modelAlias: 'claude-sonnet-4-6',
      },
    );

    expect(result).toMatchObject({
      projectId: 'project-2',
      prompt: 'Plan this app',
      chatMode: 'plan',
      providerType: 'anthropic',
      modelAlias: 'claude-sonnet-4-6',
    });
    expect(result?.requestId).toMatch(/.+/);
    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.name).toBe('spec.md');
  });
});
