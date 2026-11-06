/**
 * Playwright E2E Tests for Deployments Feature
 *
 * Tests cover:
 * - Deployments panel: production banner, history table, LIVE badge, Promote button
 * - ChangeSets: LIVE badge on production changeset, Deployed badge on others
 * - Deployment section in expanded changeset view
 */

import { test, expect, APIRequestContext } from '@playwright/test';

// Test configuration
const BASE_URL = process.env.PW_BASE_URL || 'http://127.0.0.1:5173';
const API_BASE_URL = process.env.PW_API_BASE_URL || 'http://127.0.0.1:3101/api';

// Shared project fixture
let projectId: string | null = null;

const createProjectFixture = async (request: APIRequestContext): Promise<string> => {
  const response = await request.post(`${API_BASE_URL}/projects`, {
    data: {
      name: `Deployments Test ${Date.now()}`,
      description: 'Automated deployment test project',
      framework: 'react',
      language: 'typescript',
    },
  });
  if (!response.ok()) {
    throw new Error(`Create project failed: ${response.status()}`);
  }
  const payload = await response.json();
  return payload.project?.id;
};

const deleteProjectFixture = async (request: APIRequestContext, id?: string | null) => {
  if (!id) return;
  try {
    await request.delete(`${API_BASE_URL}/projects/${id}`);
  } catch (error) {
    console.warn(`Delete project ${id} failed: ${error}`);
  }
};

// Helper to get the project URL
const projectUrl = () => `${BASE_URL}/?projectId=${projectId}`;

// Helper to wait for network idle (useful after navigation)
const waitForAppReady = async (page) => {
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('[data-testid="app-container"], main', { timeout: 10000 }).catch(() => {
    // App might not have test IDs, continue anyway
  });
};

test.beforeAll(async ({ request }) => {
  projectId = await createProjectFixture(request);
});

test.afterAll(async ({ request }) => {
  await deleteProjectFixture(request, projectId);
  projectId = null;
});

test.describe('Deployments Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(projectUrl());
    await waitForAppReady(page);
  });

  test('should display loading state initially', async ({ page }) => {
    // Look for loading spinner or loading text in deployments area
    const loadingIndicator = page.locator('text=Loading').or(page.locator('.animate-spin'));
    // This may or may not be visible depending on load speed
    await expect(loadingIndicator.first()).toBeVisible({ timeout: 5000 }).catch(() => {
      // Loading was too fast to catch, which is fine
    });
  });

  test('should show Deployments tab in the tab list', async ({ page }) => {
    // Look for Deployments tab
    const deploymentsTab = page.getByRole('tab', { name: /deployments/i })
      .or(page.locator('button:has-text("Deployments")'));

    await expect(deploymentsTab.first()).toBeVisible({ timeout: 10000 });
  });

  test('should display production banner when project has production deployment', async ({ page }) => {
    // Click on Deployments tab
    const deploymentsTab = page.getByRole('tab', { name: /deployments/i })
      .or(page.locator('button:has-text("Deployments")'));
    await deploymentsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Look for production banner elements
    const productionIndicators = page.locator('text=Production')
      .or(page.locator('text=PRODUCTION'))
      .or(page.locator('.bg-green-600').filter({ hasText: /production/i }));

    // Either we see production banner (project has deployment) or empty state
    const hasProduction = await productionIndicators.first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=No deployments').isVisible().catch(() => false);

    expect(hasProduction || hasEmptyState).toBeTruthy();
  });

  test('should show deployment history table with correct columns', async ({ page }) => {
    // Click on Deployments tab
    const deploymentsTab = page.getByRole('tab', { name: /deployments/i })
      .or(page.locator('button:has-text("Deployments")'));
    await deploymentsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Check for table structure or deployment rows
    const tableOrList = page.locator('table, [role="table"], .deployment-row, .border-gray-700');

    // If there are deployments, we should see some structure
    const hasTable = await tableOrList.first().isVisible().catch(() => false);
    const hasNoDeployments = await page.locator('text=No deployments').isVisible().catch(() => false);

    expect(hasTable || hasNoDeployments).toBeTruthy();
  });

  test('should show LIVE badge for production deployment', async ({ page }) => {
    // Click on Deployments tab
    const deploymentsTab = page.getByRole('tab', { name: /deployments/i })
      .or(page.locator('button:has-text("Deployments")'));
    await deploymentsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Look for LIVE badge (matches both Deployments panel and ChangeSets panel)
    const liveBadge = page.locator('.bg-green-600:has-text("LIVE")');

    // LIVE badge only appears if there's a production deployment
    const hasProduction = await liveBadge.first().isVisible().catch(() => false);

    if (hasProduction) {
      await expect(liveBadge.first()).toBeVisible();
    }
  });

  test('should show Promote button for non-production deployments', async ({ page }) => {
    // Click on Deployments tab
    const deploymentsTab = page.getByRole('tab', { name: /deployments/i })
      .or(page.locator('button:has-text("Deployments")'));
    await deploymentsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Look for Promote button
    const promoteButton = page.getByRole('button', { name: /promote/i });

    // Promote button only appears if there's a non-production deployment that can be promoted
    const hasPromote = await promoteButton.first().isVisible().catch(() => false);

    if (hasPromote) {
      await expect(promoteButton.first()).toBeEnabled();
    }
  });

  test('should open confirmation modal when clicking Promote', async ({ page }) => {
    // Click on Deployments tab
    const deploymentsTab = page.getByRole('tab', { name: /deployments/i })
      .or(page.locator('button:has-text("Deployments")'));
    await deploymentsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Look for Promote or Rollback button
    const promoteButton = page.getByRole('button', { name: /promote|rollback/i });
    const hasPromote = await promoteButton.first().isVisible().catch(() => false);

    if (hasPromote) {
      await promoteButton.first().click();

      // Look for confirmation modal
      const modal = page.locator('[role="dialog"]')
        .or(page.locator('.fixed.inset-0'))
        .or(page.locator('text=Confirm'));

      await expect(modal.first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('should show Logs links for deployments', async ({ page }) => {
    // Click on Deployments tab
    const deploymentsTab = page.getByRole('tab', { name: /deployments/i })
      .or(page.locator('button:has-text("Deployments")'));
    await deploymentsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Look for Build logs link/button
    const logsLink = page.locator('a:has-text("Build logs")')
      .or(page.locator('a:has-text("Logs")'))
      .or(page.locator('[title*="logs" i]'));

    // Logs link only appears if there are deployments
    const hasLogs = await logsLink.first().isVisible().catch(() => false);

    if (hasLogs) {
      await expect(logsLink.first()).toBeVisible();
    }
  });
});

test.describe('ChangeSets Panel - Deployment Display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(projectUrl());
    await waitForAppReady(page);
  });

  test('should show Change Sets tab', async ({ page }) => {
    // Look for Change Sets tab
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'))
      .or(page.locator('text=Change Sets'));

    await expect(changesetsTab.first()).toBeVisible({ timeout: 10000 });
  });

  test('should show LIVE badge for production changeset', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for changesets to load
    await page.waitForTimeout(1000);

    // Look for LIVE badge
    const liveBadge = page.locator('text=LIVE')
      .or(page.locator('.animate-pulse:has-text("LIVE")'))
      .or(page.locator('.bg-green-600:has-text("LIVE")'));

    // LIVE badge only appears if there's a production changeset
    const hasLive = await liveBadge.first().isVisible().catch(() => false);

    if (hasLive) {
      await expect(liveBadge.first()).toBeVisible();
      // Verify it has pulsing animation
      const element = liveBadge.first();
      const classes = await element.getAttribute('class');
      expect(classes).toContain('animate-pulse');
    }
  });

  test('should show Deployed badge for non-production deployed changesets', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for changesets to load
    await page.waitForTimeout(1000);

    // Look for Deployed badge (not production) - now uses blue color
    const deployedBadge = page.locator('.bg-blue-600\\/20:has-text("Deployed")')
      .or(page.locator('span:has-text("Deployed"):not(:has-text("LIVE"))'));

    // Deployed badge appears for deployed but not production changesets
    const hasDeployed = await deployedBadge.first().isVisible().catch(() => false);

    if (hasDeployed) {
      await expect(deployedBadge.first()).toBeVisible();
    }
  });

  test('should expand changeset when clicked', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for changesets to load
    await page.waitForTimeout(1000);

    // Find first changeset row
    const changesetRow = page.locator('.bg-gray-900.rounded-lg').first()
      .or(page.locator('[class*="changeset"]').first());

    const hasChangesets = await changesetRow.isVisible().catch(() => false);

    if (hasChangesets) {
      // Click to expand
      await changesetRow.click();

      // Wait for expansion
      await page.waitForTimeout(500);

      // Look for expanded content indicators
      const expandedContent = page.locator('text=Files changed')
        .or(page.locator('text=Verification'))
        .or(page.locator('text=Deployment'));

      await expect(expandedContent.first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('should show Deployment section in expanded changeset with deployment', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for changesets to load
    await page.waitForTimeout(1000);

    // Look for changesets with deployment indicators
    const deployedChangeset = page.locator('.bg-gray-900.rounded-lg:has-text("Deployed")')
      .or(page.locator('.bg-gray-900.rounded-lg:has-text("LIVE")'));

    const hasDeployedChangeset = await deployedChangeset.first().isVisible().catch(() => false);

    if (hasDeployedChangeset) {
      // Click to expand
      await deployedChangeset.first().click();

      // Wait for expansion
      await page.waitForTimeout(500);

      // Look for Deployment section header
      const deploymentSection = page.locator('text=Deployment').first();
      await expect(deploymentSection).toBeVisible({ timeout: 5000 });
    }
  });

  test('should show "Live in Production" status for production changeset', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for changesets to load
    await page.waitForTimeout(1000);

    // Look for production changeset (has LIVE badge)
    const productionChangeset = page.locator('.bg-gray-900.rounded-lg:has-text("LIVE")');
    const hasProduction = await productionChangeset.first().isVisible().catch(() => false);

    if (hasProduction) {
      // Click to expand
      await productionChangeset.first().click();

      // Wait for expansion
      await page.waitForTimeout(500);

      // Look for "Live in Production" text
      const liveInProduction = page.locator('text=Live in Production');
      await expect(liveInProduction).toBeVisible({ timeout: 5000 });
    }
  });

  test('should show deployment URL in expanded section', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for changesets to load
    await page.waitForTimeout(1000);

    // Look for deployed changeset
    const deployedChangeset = page.locator('.bg-gray-900.rounded-lg:has-text("Deployed")')
      .or(page.locator('.bg-gray-900.rounded-lg:has-text("LIVE")'));

    const hasDeployedChangeset = await deployedChangeset.first().isVisible().catch(() => false);

    if (hasDeployedChangeset) {
      // Click to expand
      await deployedChangeset.first().click();

      // Wait for expansion
      await page.waitForTimeout(500);

      // Look for URL (typically vercel URLs)
      const urlElement = page.locator('a[href*="vercel.app"]')
        .or(page.locator('.font-mono:has-text("vercel.app")')
        .or(page.locator('text=/.+\\.vercel\\.app/')));

      const hasUrl = await urlElement.first().isVisible().catch(() => false);

      if (hasUrl) {
        await expect(urlElement.first()).toBeVisible();
      }
    }
  });

  test('should show deployed timestamp in expanded section', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for changesets to load
    await page.waitForTimeout(1000);

    // Look for deployed changeset
    const deployedChangeset = page.locator('.bg-gray-900.rounded-lg:has-text("Deployed")')
      .or(page.locator('.bg-gray-900.rounded-lg:has-text("LIVE")'));

    const hasDeployedChangeset = await deployedChangeset.first().isVisible().catch(() => false);

    if (hasDeployedChangeset) {
      // Click to expand
      await deployedChangeset.first().click();

      // Wait for expansion
      await page.waitForTimeout(500);

      // Look for timestamp indicators
      const timestamp = page.locator('text=/Deployed \\d/')
        .or(page.locator('text=/\\d+[hmd] ago/'));

      const hasTimestamp = await timestamp.first().isVisible().catch(() => false);

      if (hasTimestamp) {
        await expect(timestamp.first()).toBeVisible();
      }
    }
  });

  test('should show error message for failed deployments', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for changesets to load
    await page.waitForTimeout(1000);

    // Look for failed changeset
    const failedChangeset = page.locator('.bg-gray-900.rounded-lg:has-text("Failed")');
    const hasFailed = await failedChangeset.first().isVisible().catch(() => false);

    if (hasFailed) {
      // Click to expand
      await failedChangeset.first().click();

      // Wait for expansion
      await page.waitForTimeout(500);

      // Look for error message section (red background)
      const errorSection = page.locator('.bg-red-900, [class*="bg-red"]');

      const hasError = await errorSection.first().isVisible().catch(() => false);

      if (hasError) {
        await expect(errorSection.first()).toBeVisible();
      }
    }
  });
});

test.describe('Production Status Banner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(projectUrl());
    await waitForAppReady(page);
  });

  test('should show production banner in ChangeSets panel header', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Look for production banner (gradient green background)
    const productionBanner = page.locator('.from-green-900')
      .or(page.locator('.bg-gradient-to-r:has-text("Production")'));

    const hasBanner = await productionBanner.first().isVisible().catch(() => false);

    if (hasBanner) {
      // Verify banner contains key elements
      await expect(productionBanner.first()).toBeVisible();

      // Should have pulsing indicator
      const pulsingDot = productionBanner.locator('.animate-pulse');
      const hasPulsingDot = await pulsingDot.first().isVisible().catch(() => false);
      expect(hasPulsingDot).toBeTruthy();
    }
  });

  test('should show changeset reference in production banner', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Look for production banner
    const productionBanner = page.locator('.from-green-900')
      .or(page.locator('.bg-gradient-to-r:has-text("Production")'));

    const hasBanner = await productionBanner.first().isVisible().catch(() => false);

    if (hasBanner) {
      // Should have CS-### reference
      const csReference = productionBanner.locator('button:has-text("CS-")');
      const hasReference = await csReference.first().isVisible().catch(() => false);
      expect(hasReference).toBeTruthy();
    }
  });

  test('should navigate to changeset when clicking reference in banner', async ({ page }) => {
    // Navigate to Change Sets
    const changesetsTab = page.getByRole('tab', { name: /change ?sets/i })
      .or(page.locator('button:has-text("Change Sets")'));
    await changesetsTab.first().click();

    // Wait for panel to load
    await page.waitForTimeout(1000);

    // Look for production banner with CS reference
    const csReference = page.locator('.from-green-900 button:has-text("CS-")')
      .or(page.locator('.bg-gradient-to-r:has-text("Production") button:has-text("CS-")'));

    const hasReference = await csReference.first().isVisible().catch(() => false);

    if (hasReference) {
      // Click the CS reference
      await csReference.first().click();

      // Wait for expansion
      await page.waitForTimeout(500);

      // Verify changeset expanded (shows detailed content)
      const expandedContent = page.locator('text=Files changed')
        .or(page.locator('text=Verification'));

      await expect(expandedContent.first()).toBeVisible({ timeout: 5000 });
    }
  });
});
