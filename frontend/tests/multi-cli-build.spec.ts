import { test, expect, APIRequestContext, request as playwrightRequest } from '@playwright/test';

const UI_BASE_URL = process.env.PW_BASE_URL || 'http://127.0.0.1:5175';
const API_BASE_URL = process.env.PW_API_BASE_URL || 'http://127.0.0.1:3002/api';
const COMPLETION_TIMEOUT_MS = 30_000;

async function createProjectForTest(request: APIRequestContext): Promise<string> {
  const createResponse = await request.post(`${API_BASE_URL}/projects`, {
    data: {
      name: `Multi CLI E2E ${Date.now()}`,
      description: 'Automated multi-cli build flow test',
      framework: 'react',
      language: 'typescript',
    },
  });
  expect(createResponse.ok()).toBeTruthy();
  const payload = await createResponse.json();
  return payload.project.id as string;
}

async function deleteProjectForTest(projectId?: string | null) {
  if (!projectId) return;
  const ctx = await playwrightRequest.newContext();
  try {
    await ctx.delete(`${API_BASE_URL}/projects/${projectId}`);
  } finally {
    await ctx.dispose();
  }
}

async function waitForCompletion(page: import('@playwright/test').Page) {
  const stopButton = page.getByTitle('Stop');
  await expect(stopButton).toHaveCount(0, { timeout: COMPLETION_TIMEOUT_MS });
}

async function selectModelForProvider(
  page: import('@playwright/test').Page,
  providerType: string,
) {
  const modelSelect = page.locator('select[title="Select model"]');
  await expect(modelSelect).toBeVisible({ timeout: COMPLETION_TIMEOUT_MS });

  const options = await modelSelect.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: node.getAttribute('value') || '',
      label: (node.textContent || '').trim(),
    })),
  );

  const target = options.find((option) => option.value.startsWith(`${providerType}:`));
  expect(target).toBeTruthy();
  if (!target?.value) {
    throw new Error(`No model value found for provider type: ${providerType}`);
  }

  await modelSelect.selectOption(target.value);
}

test.describe('Multi-CLI build flow', () => {
  test('switches CLI providers and persists final streamed chunks', async ({ page, request }) => {
    test.setTimeout(90_000);

    const adaptersResponse = await request.get(`${API_BASE_URL}/cli-adapters`);
    expect(adaptersResponse.ok()).toBeTruthy();
    const adaptersPayload = await adaptersResponse.json();
    expect(adaptersPayload.success).toBe(true);
    const adapterTypes = (adaptersPayload.adapters || []).map((adapter: { type: string }) => adapter.type);
    expect(adapterTypes).toContain('anthropic');
    expect(adapterTypes).toContain('openai');

    const projectId = await createProjectForTest(request);
    try {
      await page.addInitScript(() => {
        localStorage.setItem('atlas_visited', 'true');
        localStorage.setItem('atlas_active_tab', 'atlas-builder');
        localStorage.setItem('atlas_chat_mode', 'agent');
      });

      await page.goto(`${UI_BASE_URL}/?projectId=${projectId}`, { waitUntil: 'domcontentloaded' });
      const openAppButton = page.getByRole('button', { name: /^Open App$/i }).first();
      if (await openAppButton.isVisible().catch(() => false)) {
        await openAppButton.click();
      }
      await expect(page.locator('select[title*="Chat mode"]')).toBeVisible({ timeout: COMPLETION_TIMEOUT_MS });

      await selectModelForProvider(page, 'openai');
      await page.fill('textarea', 'codex test response');
      await page.click('button[title="Send"]');
      await waitForCompletion(page);
      await expect(page.getByText('FAKE_CODEX_LINE_1')).toBeVisible({ timeout: COMPLETION_TIMEOUT_MS });
      await expect(page.getByText('FAKE_CODEX_FINAL_CHUNK')).toBeVisible({ timeout: COMPLETION_TIMEOUT_MS });

      await selectModelForProvider(page, 'anthropic');
      await page.fill('textarea', 'claude test response');
      await page.click('button[title="Send"]');
      await waitForCompletion(page);
      await expect(page.getByText('FAKE_CLAUDE_RESPONSE')).toBeVisible({ timeout: COMPLETION_TIMEOUT_MS });

      const historyResponse = await request.get(`${API_BASE_URL}/chat/sessions/${projectId}/history`, {
        params: { limit: 100, latest: true },
      });
      expect(historyResponse.ok()).toBeTruthy();
      const historyPayload = await historyResponse.json();
      const assistantContent = (historyPayload.messages || [])
        .filter((msg: { role: string }) => msg.role === 'assistant')
        .map((msg: { content?: string }) => msg.content || '')
        .join('\n');

      expect(assistantContent).toContain('FAKE_CODEX_FINAL_CHUNK');
      expect(assistantContent).toContain('FAKE_CLAUDE_RESPONSE');
    } finally {
      await deleteProjectForTest(projectId);
    }
  });
});
