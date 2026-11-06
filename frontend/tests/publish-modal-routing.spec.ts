import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API_BASE_URL = process.env.PW_API_BASE_URL || 'http://127.0.0.1:43367/api';

let projectId: string | null = null;

async function createProject(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_BASE_URL}/projects`, {
    data: {
      name: `Publish Modal Routing ${Date.now()}`,
      description: 'Regression fixture for publish modal routing',
      framework: 'react',
      language: 'typescript',
    },
  });

  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  expect(payload.project?.id).toBeTruthy();

  return payload.project.id as string;
}

async function deleteProject(request: APIRequestContext, id?: string | null) {
  if (!id) return;
  await request.delete(`${API_BASE_URL}/projects/${id}`).catch(() => {});
}

async function openProject(page: Page, id: string) {
  await page.goto(`/?projectId=${id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
}

async function openAndExpectPublishPanel(page: Page, id: string, trigger: () => Promise<void>) {
  const publishStatusResponse = page.waitForResponse((response) =>
    response.request().method() === 'GET'
    && response.url().includes(`/api/projects/${id}/publish-status`)
  );

  const hostingStatusResponse = page.waitForResponse((response) =>
    response.request().method() === 'GET'
    && response.url().includes('/api/atlas-hosting/status')
  );

  await trigger();
  await Promise.all([publishStatusResponse, hostingStatusResponse]);
  await expect(page.getByText('Publish Project')).toHaveCount(1);
  await expect(page.getByText('Publish to Cloud')).toHaveCount(0);
}

test.beforeAll(async ({ request }) => {
  projectId = await createProject(request);
});

test.afterAll(async ({ request }) => {
  await deleteProject(request, projectId);
  projectId = null;
});

test.describe('Publish Modal Routing', () => {
  test('Cloud Deploy opens the shared publish panel', async ({ page }) => {
    expect(projectId).toBeTruthy();
    await openProject(page, projectId!);

    await openAndExpectPublishPanel(page, projectId!, async () => {
      await page.locator('button[title="Deploy to cloud"]').evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
    });
  });

  test('Change Sets publish opens the same publish panel', async ({ page }) => {
    expect(projectId).toBeTruthy();
    await openProject(page, projectId!);

    await page.evaluate(() => {
      (window as Window & { __atlasNavigate?: (tab: string) => void }).__atlasNavigate?.('changesets');
    });
    await page.waitForTimeout(1000);

    await openAndExpectPublishPanel(page, projectId!, async () => {
      await page.locator('button[title="Publish Project"]').first().evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
    });
  });
});
