import { expect, test } from '@playwright/test';
import { buildCompletionSummary } from '../routeDetection';
import { buildPreviewRouteUrl, extractRouteFromAtlasHref } from '../previewNavigation';

function getFirstAtlasHref(summary: string): string | null {
  const match = summary.match(/\((\/__atlas_route__[^\)]+)\)/);
  return match ? match[1] : null;
}

test.describe('preview route navigation flow', () => {
  test('uses route button href to replace preview path from stable dev base', () => {
    const summary = buildCompletionSummary({
      filesChanged: 1,
      filePaths: ['src/pages/Settings.tsx'],
      newFiles: [],
      modifiedFiles: ['src/pages/Settings.tsx'],
      changesetId: 'cs_123',
      changesetTitle: 'Add settings page',
    });

    const href = getFirstAtlasHref(summary);
    expect(href).toBe('/__atlas_route__/settings');

    const route = extractRouteFromAtlasHref(href);
    expect(route).toBe('/settings');

    const nextUrl = buildPreviewRouteUrl({
      rawRoute: route,
      backendBaseUrl: 'http://127.0.0.1:3000',
      projectId: 'project_42',
      devServerRunning: true,
      hasDevServerProject: true,
      currentUrl: 'http://127.0.0.1:3000/preview-proxy/dev/project_42/dashboard',
    });

    expect(nextUrl).toBe('http://127.0.0.1:3000/preview-proxy/dev/project_42/settings');
  });
});
