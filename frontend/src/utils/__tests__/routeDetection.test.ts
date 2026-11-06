import { expect, test } from '@playwright/test';
import { buildCompletionSummary, detectRoutes } from '../routeDetection';

test.describe('detectRoutes', () => {
  test('maps index routes to root', () => {
    const routes = detectRoutes([
      'pages/index.tsx',
      'src/pages/index.tsx',
      'public/index.html',
    ]);

    const paths = routes.map((route) => route.path);
    expect(paths).toContain('/');
    expect(paths).not.toContain('/index');
  });

  test('strips Next.js app route groups and preserves leaf route', () => {
    const routes = detectRoutes([
      'app/page.tsx',
      'app/(marketing)/dashboard/page.tsx',
      'src/app/(app-shell)/settings/page.tsx',
    ]);

    expect(routes.map((route) => route.path)).toEqual(['/', '/dashboard', '/settings']);
  });

  test('returns normalized kebab routes for src/pages and src/views', () => {
    const routes = detectRoutes([
      'src/pages/DashboardPage.tsx',
      'src/views/AdminPanelView.tsx',
    ]);

    expect(routes.map((route) => route.path)).toEqual(['/dashboard', '/admin-panel']);
  });
});

test.describe('buildCompletionSummary', () => {
  test('includes preview route links from modified files too', () => {
    const summary = buildCompletionSummary({
      filesChanged: 2,
      filePaths: ['src/pages/Dashboard.tsx', 'src/pages/index.tsx'],
      newFiles: [],
      modifiedFiles: ['src/pages/Dashboard.tsx', 'src/pages/index.tsx'],
      changesetId: 'cs_123',
      changesetTitle: 'Update dashboard route',
    });

    expect(summary).toContain('**Build Complete** — Update dashboard route');
    expect(summary).toContain('[/dashboard](/__atlas_route__/dashboard)');
    expect(summary).toContain('[/](/__atlas_route__/)');
  });
});
