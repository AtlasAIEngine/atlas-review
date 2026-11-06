interface BuildPreviewRouteUrlInput {
  rawRoute: unknown;
  backendBaseUrl: string;
  projectId: string;
  devServerRunning: boolean;
  hasDevServerProject: boolean;
  currentUrl: string;
}

export function normalizePreviewRoute(rawRoute: unknown): string | null {
  if (rawRoute === null || rawRoute === undefined) {
    return null;
  }

  const route = String(rawRoute).trim();
  if (!route) {
    return null;
  }

  return route.startsWith('/') ? route : `/${route}`;
}

export function extractRouteFromAtlasHref(href: string | undefined | null): string | null {
  if (!href) {
    return null;
  }

  if (href.startsWith('atlas-route://')) {
    return normalizePreviewRoute(href.replace('atlas-route://', ''));
  }

  if (href.startsWith('/__atlas_route__')) {
    const route = href.replace('/__atlas_route__', '');
    return normalizePreviewRoute(route || '/');
  }

  return null;
}

export function buildPreviewRouteUrl(input: BuildPreviewRouteUrlInput): string | null {
  const route = normalizePreviewRoute(input.rawRoute);
  if (!route) {
    return null;
  }

  const previewBaseUrl =
    input.devServerRunning
      ? `${input.backendBaseUrl}/preview-proxy/dev/${input.projectId}/`
      : (!input.hasDevServerProject ? `${input.backendBaseUrl}/preview/${input.projectId}/` : input.currentUrl);

  if (!previewBaseUrl) {
    return null;
  }

  try {
    const target = new URL(previewBaseUrl);
    target.pathname = target.pathname.replace(/\/$/, '') + (route === '/' ? '' : route);
    return target.toString();
  } catch {
    return null;
  }
}
