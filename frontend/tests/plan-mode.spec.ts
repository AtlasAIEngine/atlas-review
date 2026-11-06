import { test, expect, APIRequestContext, request as playwrightRequest } from '@playwright/test';

const BASE_URL = process.env.PW_BASE_URL || 'http://localhost:5173';
const API_BASE_URL = process.env.PW_API_BASE_URL || 'http://127.0.0.1:3101/api';
const PLAN_OVERLAY_TEXT = 'Plan response complete';
const COMPLETION_TIMEOUT_MS = 180000;
const BUILD_TIMEOUT_MS = 300000;

const createProjectForTest = async (request: APIRequestContext): Promise<string> => {
  const createResponse = await request.post(`${API_BASE_URL}/projects`, {
    data: {
      name: `Plan Mode Test ${Date.now()}`,
      description: 'Automated plan mode test project',
      framework: 'react',
      language: 'typescript',
    },
  });
  if (!createResponse.ok()) {
    throw new Error(`Create project failed: ${createResponse.status()}`);
  }
  const createPayload = await createResponse.json();
  return createPayload.project?.id;
};

const deleteProjectForTest = async (projectId?: string | null) => {
  if (!projectId) return;
  // Use a standalone API context so cleanup works even after browser/page closes
  const ctx = await playwrightRequest.newContext();
  try {
    const response = await ctx.delete(`${API_BASE_URL}/projects/${projectId}`);
    if (!response.ok()) {
      console.warn(`Delete project ${projectId} failed: ${response.status()}`);
    }
  } catch (error) {
    console.warn(`Delete project ${projectId} failed: ${error}`);
  } finally {
    await ctx.dispose();
  }
};

const ensureClaudeReady = async (request: APIRequestContext): Promise<boolean> => {
  const statusResponse = await request.get(`${API_BASE_URL}/claude/status`);
  if (!statusResponse.ok()) return false;
  const payload = await statusResponse.json();
  return Boolean(payload?.data?.authenticated);
};

const waitForCompletion = async (page, timeoutMs: number = COMPLETION_TIMEOUT_MS) => {
  const stopButton = page.getByTitle('Stop');
  await expect(stopButton).toHaveCount(0, { timeout: timeoutMs });
};

const waitForOverlay = async (page) => {
  const overlayText = page.getByText(PLAN_OVERLAY_TEXT, { exact: false });
  await expect(overlayText).toBeVisible({ timeout: COMPLETION_TIMEOUT_MS });
};

const getChangesets = async (request, projectId: string) => {
  const response = await request.get(`${API_BASE_URL}/projects/${projectId}/changesets`);
  if (!response.ok()) {
    throw new Error(`Changesets request failed: ${response.status()}`);
  }
  const payload = await response.json();
  return payload.changesets || [];
};

test.describe('Plan mode chat flow', () => {
  test('shows plan actions and routes build flow correctly', async ({ page, request }) => {
    test.setTimeout(COMPLETION_TIMEOUT_MS);
    const hasClaude = await ensureClaudeReady(request);
    test.skip(!hasClaude, 'Claude CLI not authenticated on backend; skipping plan mode UI flow.');

    const projectId = await createProjectForTest(request);
    try {
      await page.goto(`${BASE_URL}/?projectId=${projectId}`);
      const modeSelector = () => page.locator('select[title*="Chat mode"]');
      await expect(modeSelector()).toBeEnabled({ timeout: COMPLETION_TIMEOUT_MS });

      await modeSelector().selectOption('plan');
      await expect(modeSelector()).toHaveValue('plan');

      await page.fill('textarea', 'Provide a brief 2-step plan. Do not read files.');
      await page.click('button[title="Send"]');

      await waitForCompletion(page);
      await waitForOverlay(page);
      await expect(page.getByRole('button', { name: 'Keep chatting' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start building' })).toBeVisible();
      await expect(modeSelector()).toHaveValue('plan');

      // Overlay does NOT persist after reload (simplified behavior)
      // User can continue chatting or manually switch modes after reload
      await page.reload();
      await expect(modeSelector()).toBeEnabled({ timeout: COMPLETION_TIMEOUT_MS });
      await expect(page.getByText(PLAN_OVERLAY_TEXT, { exact: false })).toBeHidden();
      await expect(modeSelector()).toHaveValue('plan');

      // Send another plan request to get the overlay again
      await page.fill('textarea', 'Provide a brief plan again with no file reads.');
      await page.click('button[title="Send"]');
      await waitForCompletion(page);
      await waitForOverlay(page);

      // Test "Keep chatting" flow - overlay hides, mode stays plan
      await page.getByRole('button', { name: 'Keep chatting' }).click();
      await expect(page.getByText(PLAN_OVERLAY_TEXT, { exact: false })).toBeHidden();
      await expect(modeSelector()).toHaveValue('plan');

      // Send one more plan request, then use Start building
      await page.fill('textarea', 'Final brief plan. No file reads.');
      await page.click('button[title="Send"]');
      await waitForCompletion(page);
      await waitForOverlay(page);

      await page.getByRole('button', { name: 'Start building' }).click();
      await expect(page.getByText(PLAN_OVERLAY_TEXT, { exact: false })).toBeHidden();
      await expect(modeSelector()).toHaveValue('build');

      const proceedMessage = page.getByText(/Proceed with (the following )?implementation plan/i).last();
      await expect(proceedMessage).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteProjectForTest(projectId);
    }
  });

  test('does not show plan actions outside plan mode', async ({ page, request }) => {
    test.setTimeout(COMPLETION_TIMEOUT_MS);
    const hasClaude = await ensureClaudeReady(request);
    test.skip(!hasClaude, 'Claude CLI not authenticated on backend; skipping plan mode UI flow.');

    const projectId = await createProjectForTest(request);
    try {
      await page.goto(`${BASE_URL}/?projectId=${projectId}`);
      const modeSelector = page.locator('select[title*="Chat mode"]');
      await expect(modeSelector).toBeEnabled({ timeout: COMPLETION_TIMEOUT_MS });
      await modeSelector.selectOption('agent');
      await expect(modeSelector).toHaveValue('agent');

      await page.fill('textarea', 'Just answer normally in one short paragraph.');
      await page.click('button[title="Send"]');

      await waitForCompletion(page);
      const overlayText = page.getByText(PLAN_OVERLAY_TEXT, { exact: false });
      await expect(overlayText).toBeHidden({ timeout: 2000 });
    } finally {
      await deleteProjectForTest(projectId);
    }
  });

  test('plan mode does not modify files until Start building (todo app)', async ({ page, request }) => {
    test.setTimeout(BUILD_TIMEOUT_MS);
    const hasClaude = await ensureClaudeReady(request);
    test.skip(!hasClaude, 'Claude CLI not authenticated on backend; skipping plan mode UI flow.');

    const projectId = await createProjectForTest(request);
    try {
      await page.goto(`${BASE_URL}/?projectId=${projectId}`);
      const modeSelector = () => page.locator('select[title*="Chat mode"]');
      await expect(modeSelector()).toBeEnabled({ timeout: COMPLETION_TIMEOUT_MS });
      await modeSelector().selectOption('plan');
      await expect(modeSelector()).toHaveValue('plan');

      await page.fill(
        'textarea',
        'Create a minimal todo app (HTML/CSS/JS). Provide a plan only, no file writes.'
      );
      await page.click('button[title="Send"]');
      await waitForCompletion(page);
      await waitForOverlay(page);

      const planChangesets = await getChangesets(request, projectId);
      expect(planChangesets.length).toBe(0);

      await page.getByRole('button', { name: 'Start building' }).click();
      await waitForCompletion(page, BUILD_TIMEOUT_MS);

      const buildChangesets = await getChangesets(request, projectId);
      expect(buildChangesets.length).toBeGreaterThan(0);
    } finally {
      await deleteProjectForTest(projectId);
    }
  });
});
