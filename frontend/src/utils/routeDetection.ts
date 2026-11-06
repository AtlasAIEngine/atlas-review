/**
 * Route Detection & Build Completion Summary
 * Heuristic route detection from file paths and markdown summary builder
 */

export interface DetectedRoute {
  path: string;    // e.g. "/dashboard"
  source: string;  // e.g. "src/pages/Dashboard.tsx"
}

interface BuildSummaryData {
  filesChanged: number;
  filePaths: string[];
  newFiles: string[];
  modifiedFiles: string[];
  changesetId: string | null;
  changesetTitle: string | null;
}

/** Convert PascalCase/camelCase to kebab-case */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function normalizeRoutePath(path: string): string {
  if (!path) return '/';
  if (path === 'index' || path === '/index') return '/';
  if (path === '') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

/** Strip common page/view suffixes from component names */
function stripSuffix(name: string): string {
  return name.replace(/(Page|View|Screen|Component)$/i, '');
}

/** Check if a segment is a dynamic route parameter */
function isDynamic(segment: string): boolean {
  return /^\[.*\]$/.test(segment) || /^:/.test(segment) || segment.startsWith('_');
}

function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

const ROUTE_PATTERNS: Array<{ regex: RegExp; extractRoute: (match: RegExpMatchArray) => string | null }> = [
  // Next.js App Router root: app/page.tsx -> /
  {
    regex: /^(?:src\/)?app\/page\.(tsx?|jsx?)$/,
    extractRoute: () => '/',
  },
  // Next.js App Router: app/dashboard/page.tsx → /dashboard
  {
    regex: /^(?:src\/)?app\/(.+)\/page\.(tsx?|jsx?)$/,
    extractRoute: (m) => {
      const segments = m[1]
        .split('/')
        .filter((s) => !isRouteGroupSegment(s) && !s.startsWith('@'));
      if (segments.some(isDynamic)) return null;
      return normalizeRoutePath(`/${segments.join('/')}`);
    },
  },
  // Next.js Pages Router: pages/dashboard.tsx → /dashboard
  {
    regex: /^(?:src\/)?pages\/([^[]+)\.(tsx?|jsx?)$/,
    extractRoute: (m) => {
      const name = m[1].replace(/\/index$/, '');
      const segments = name.split('/').filter(Boolean);
      if (name === '_app' || name === '_document' || segments.some(isDynamic)) return null;
      const normalized = segments
        .map((segment) => toKebabCase(stripSuffix(segment)))
        .join('/');
      return normalizeRoutePath(normalized || name);
    },
  },
  // Vite/CRA pages folder: src/pages/Dashboard.tsx → /dashboard
  {
    regex: /^src\/(?:pages|views)\/([^[]+)\.(tsx?|jsx?)$/,
    extractRoute: (m) => {
      let name = m[1].replace(/\/index$/, '');
      if (name.split('/').filter(Boolean).some(isDynamic)) return null;
      name = stripSuffix(name);
      return normalizeRoutePath(toKebabCase(name));
    },
  },
  // Public HTML files: public/dashboard.html → /dashboard.html
  {
    regex: /^public\/(.+\.html)$/,
    extractRoute: (m) => {
      const name = m[1];
      if (name === 'index.html') return '/';
      return '/' + name;
    },
  },
];

/**
 * Detect navigable routes from a list of new/modified file paths
 */
export function detectRoutes(filePaths: string[]): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const seen = new Set<string>();

  for (const filePath of filePaths) {
    for (const pattern of ROUTE_PATTERNS) {
      const match = filePath.match(pattern.regex);
      if (!match) continue;

      const route = pattern.extractRoute(match);
      if (route && !seen.has(route)) {
        seen.add(route);
        routes.push({ path: route, source: filePath });
      }
      break; // Only match first pattern per file
    }
  }

  return routes;
}

/**
 * Build a markdown completion summary for the chat
 */
export function buildCompletionSummary(data: BuildSummaryData): string {
  const lines: string[] = [];

  // Header
  let header = '**Build Complete**';
  if (data.changesetTitle) {
    header += ` — ${data.changesetTitle}`;
  }
  lines.push(header);
  lines.push('');

  // File stats
  if (data.newFiles.length > 0) {
    lines.push(`**${data.newFiles.length}** new file${data.newFiles.length === 1 ? '' : 's'}`);
  }
  if (data.modifiedFiles.length > 0) {
    lines.push(`**${data.modifiedFiles.length}** modified file${data.modifiedFiles.length === 1 ? '' : 's'}`);
  }

  // File list (max 8)
  const allFiles = [...data.newFiles, ...data.modifiedFiles];
  const displayFiles = allFiles.slice(0, 8);
  if (displayFiles.length > 0) {
    lines.push('');
    for (const f of displayFiles) {
      const isNew = data.newFiles.includes(f);
      lines.push(`- \`${f}\`${isNew ? ' *(new)*' : ''}`);
    }
    if (allFiles.length > 8) {
      lines.push(`- *+${allFiles.length - 8} more files*`);
    }
  }

  // Detected routes
  const routes = detectRoutes([...data.newFiles, ...data.modifiedFiles]);
  if (routes.length > 0) {
    lines.push('');
    lines.push('**Preview routes:**');
    for (const route of routes) {
      lines.push(`- [${route.path}](/__atlas_route__${route.path})`);
    }
  }

  return lines.join('\n');
}
