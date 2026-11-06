/**
 * Integrations Service
 * Detects known integrations in projects and identifies required environment variables
 *
 * Supports detection of:
 * - NextAuth.js (authentication)
 * - Supabase (backend as a service)
 * - Stripe (payments)
 * - OpenAI (AI)
 */

import fs from 'fs/promises';
import path from 'path';

// ============================================================================
// FRAMEWORK-AWARE ENV VAR MAPPING
// ============================================================================

/**
 * Maps framework type to the env var names used for Supabase client-side access.
 * Each framework has its own prefix convention for exposing env vars to the browser.
 */
const SUPABASE_ENV_VAR_MAP = {
  vite: { url: 'VITE_SUPABASE_URL', anonKey: 'VITE_SUPABASE_ANON_KEY' },
  next: { url: 'NEXT_PUBLIC_SUPABASE_URL', anonKey: 'NEXT_PUBLIC_SUPABASE_ANON_KEY' },
  cra: { url: 'REACT_APP_SUPABASE_URL', anonKey: 'REACT_APP_SUPABASE_ANON_KEY' },
  node: { url: 'SUPABASE_URL', anonKey: 'SUPABASE_ANON_KEY' },
};

/**
 * Detect framework type from package.json dependencies/scripts.
 * Mirrors the detection logic in devServerService.js:detectProjectType.
 *
 * @param {Object} packageJson - Parsed package.json
 * @returns {'vite'|'next'|'cra'|'node'}
 */
function detectFrameworkType(packageJson) {
  if (!packageJson) return 'node';

  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const scripts = packageJson.scripts || {};

  if (deps.vite || scripts.dev?.includes('vite')) return 'vite';
  if (deps.next || scripts.dev?.includes('next')) return 'next';
  if (deps['react-scripts']) return 'cra';

  return 'node';
}

/**
 * Scan source files for env var references matching a given pattern.
 * Walks src/, lib/, app/ directories looking for .ts/.tsx/.js/.jsx files.
 *
 * @param {string} projectPath - Path to the project root
 * @param {RegExp} pattern - Regex to match against file contents (should have global flag)
 * @returns {Promise<string[]>} Array of matched env var names
 */
async function scanSourceForEnvVars(projectPath, pattern) {
  const matches = new Set();
  const scanDirs = ['src', 'lib', 'app'];
  const extensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
  const MAX_FILES = 200;
  const MAX_FILE_SIZE = 100 * 1024; // 100KB

  let filesScanned = 0;

  for (const dir of scanDirs) {
    const dirPath = path.join(projectPath, dir);
    let entries;
    try {
      entries = await fs.readdir(dirPath, { recursive: true, withFileTypes: true });
    } catch {
      continue; // directory doesn't exist
    }

    for (const entry of entries) {
      if (filesScanned >= MAX_FILES) break;
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name);
      if (!extensions.has(ext)) continue;

      const filePath = path.join(entry.parentPath || entry.path, entry.name);
      filesScanned++;

      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;

        const content = await fs.readFile(filePath, 'utf-8');
        const fileMatches = content.matchAll(pattern);
        for (const m of fileMatches) {
          matches.add(m[1] || m[0]);
        }
      } catch {
        // Skip files that can't be read
      }
    }
  }

  return [...matches];
}

// ============================================================================
// KNOWN INTEGRATIONS REGISTRY
// ============================================================================

/**
 * Registry of known integrations with their detection patterns and required variables
 */
const KNOWN_INTEGRATIONS = {
  nextauth: {
    name: 'NextAuth.js',
    detectPackages: ['next-auth', '@auth/core'],
    requiredVars: ['NEXTAUTH_SECRET', 'NEXTAUTH_URL'],
    optionalVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_ID', 'GITHUB_SECRET'],
    docsUrl: 'https://next-auth.js.org/configuration/options',
  },
  supabase: {
    name: 'Supabase',
    detectPackages: ['@supabase/supabase-js'],
    // Default requiredVars — overridden at runtime by resolveSupabaseVars() with framework-aware names
    requiredVars: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'],
    optionalVars: ['SUPABASE_SERVICE_ROLE_KEY'],
    docsUrl: 'https://supabase.com/docs/guides/getting-started',
  },
  stripe: {
    name: 'Stripe',
    detectPackages: ['stripe', '@stripe/stripe-js'],
    requiredVars: ['STRIPE_SECRET_KEY'],
    optionalVars: ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'],
    docsUrl: 'https://stripe.com/docs/keys',
  },
  openai: {
    name: 'OpenAI',
    detectPackages: ['openai'],
    requiredVars: ['OPENAI_API_KEY'],
    optionalVars: [],
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    name: 'Anthropic',
    detectPackages: ['@anthropic-ai/sdk'],
    requiredVars: ['ANTHROPIC_API_KEY'],
    optionalVars: [],
    docsUrl: 'https://docs.anthropic.com/en/api/getting-started',
  },
  clerk: {
    name: 'Clerk',
    detectPackages: ['@clerk/nextjs', '@clerk/clerk-js'],
    requiredVars: ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'],
    optionalVars: ['NEXT_PUBLIC_CLERK_SIGN_IN_URL', 'NEXT_PUBLIC_CLERK_SIGN_UP_URL'],
    docsUrl: 'https://clerk.com/docs/quickstarts/nextjs',
  },
  resend: {
    name: 'Resend',
    detectPackages: ['resend'],
    requiredVars: ['RESEND_API_KEY'],
    optionalVars: [],
    docsUrl: 'https://resend.com/docs/introduction',
  },
  prisma: {
    name: 'Prisma',
    detectPackages: ['@prisma/client', 'prisma'],
    requiredVars: ['DATABASE_URL'],
    optionalVars: ['DIRECT_URL'],
    docsUrl: 'https://www.prisma.io/docs/getting-started',
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Read and parse package.json from a project directory
 *
 * @param {string} projectPath - Path to the project root
 * @returns {Promise<Object|null>} Parsed package.json or null if not found
 */
async function readPackageJson(projectPath) {
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    // File doesn't exist or can't be parsed
    return null;
  }
}

/**
 * Extract all dependencies from package.json
 *
 * @param {Object} packageJson - Parsed package.json
 * @returns {Set<string>} Set of all dependency names
 */
function extractDependencies(packageJson) {
  const deps = new Set();

  if (packageJson.dependencies) {
    Object.keys(packageJson.dependencies).forEach((dep) => deps.add(dep));
  }

  if (packageJson.devDependencies) {
    Object.keys(packageJson.devDependencies).forEach((dep) => deps.add(dep));
  }

  return deps;
}

// ============================================================================
// SERVICE FUNCTIONS
// ============================================================================

/**
 * Detect known integrations in a project by analyzing package.json dependencies
 *
 * @param {string} projectPath - Path to the project root
 * @returns {Promise<Array<{id: string, name: string, requiredVars: string[], optionalVars: string[], docsUrl: string}>>}
 */
async function detectIntegrations(projectPath) {
  const packageJson = await readPackageJson(projectPath);

  if (!packageJson) {
    return [];
  }

  const dependencies = extractDependencies(packageJson);
  const detected = [];

  for (const [id, integration] of Object.entries(KNOWN_INTEGRATIONS)) {
    // Check if any of the detection packages are present
    const hasIntegration = integration.detectPackages.some((pkg) => dependencies.has(pkg));

    if (hasIntegration) {
      let requiredVars = integration.requiredVars;

      // Framework-aware resolution for Supabase
      if (id === 'supabase') {
        requiredVars = await resolveSupabaseVars(projectPath, packageJson);
      }

      detected.push({
        id,
        name: integration.name,
        requiredVars,
        optionalVars: integration.optionalVars,
        docsUrl: integration.docsUrl,
      });
    }
  }

  return detected;
}

/**
 * Resolve Supabase env var names based on source scanning → framework heuristic → fallback.
 * Priority:
 *   1. Source scan (find actual env var references in code)
 *   2. Framework heuristic (Vite → VITE_*, Next → NEXT_PUBLIC_*, etc.)
 *   3. Fallback: SUPABASE_URL / SUPABASE_ANON_KEY
 *
 * @param {string} projectPath
 * @param {Object} packageJson
 * @returns {Promise<string[]>}
 */
async function resolveSupabaseVars(projectPath, packageJson) {
  // 1. Source scan — look for actual env var references
  const supabaseEnvPattern = /(?:import\.meta\.env|process\.env)\.(\w*SUPABASE\w*)/g;
  const sourceVars = await scanSourceForEnvVars(projectPath, supabaseEnvPattern);

  if (sourceVars.length > 0) {
    // Find URL and anon key from source scan results
    const urlVar = sourceVars.find(v => /SUPABASE.*URL/i.test(v));
    const anonVar = sourceVars.find(v => /SUPABASE.*ANON/i.test(v));

    if (urlVar && anonVar) {
      return [urlVar, anonVar];
    }
  }

  // 2. Framework heuristic
  const framework = detectFrameworkType(packageJson);
  const envMap = SUPABASE_ENV_VAR_MAP[framework] || SUPABASE_ENV_VAR_MAP.node;

  return [envMap.url, envMap.anonKey];
}

/**
 * Check which required variables are missing for detected integrations
 *
 * @param {Array} detectedIntegrations - Array of detected integrations from detectIntegrations()
 * @param {Array<{key: string}>} configuredSecrets - Array of configured secrets with at least {key} property
 * @returns {Array<{id: string, name: string, docsUrl: string, requiredVars: Array<{key: string, configured: boolean}>, missingCount: number}>}
 */
function checkMissingVars(detectedIntegrations, configuredSecrets) {
  const configuredKeys = new Set(configuredSecrets.map((s) => s.key));
  const results = [];

  for (const integration of detectedIntegrations) {
    const requiredVars = integration.requiredVars.map((key) => ({
      key,
      configured: configuredKeys.has(key),
    }));

    const missingCount = requiredVars.filter((v) => !v.configured).length;

    results.push({
      id: integration.id,
      name: integration.name,
      docsUrl: integration.docsUrl,
      requiredVars,
      missingCount,
    });
  }

  // Sort by missing count descending (most issues first)
  results.sort((a, b) => b.missingCount - a.missingCount);

  return results;
}

/**
 * Get the full integration check for a project
 *
 * @param {string} projectPath - Path to the project root
 * @param {Array<{key: string}>} configuredSecrets - Array of configured secrets
 * @returns {Promise<{integrations: Array, missingVars: Array}>}
 */
async function checkProjectIntegrations(projectPath, configuredSecrets) {
  const detectedIntegrations = await detectIntegrations(projectPath);
  const integrationChecks = checkMissingVars(detectedIntegrations, configuredSecrets);

  // Flatten missing vars for quick access
  const missingVars = [];
  for (const check of integrationChecks) {
    for (const varInfo of check.requiredVars) {
      if (!varInfo.configured) {
        missingVars.push({
          key: varInfo.key,
          integrationId: check.id,
          integrationName: check.name,
          docsUrl: check.docsUrl,
        });
      }
    }
  }

  return {
    integrations: integrationChecks,
    missingVars,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  KNOWN_INTEGRATIONS,
  SUPABASE_ENV_VAR_MAP,
  detectFrameworkType,
  scanSourceForEnvVars,
  detectIntegrations,
  checkMissingVars,
  checkProjectIntegrations,
};

export {
  KNOWN_INTEGRATIONS,
  SUPABASE_ENV_VAR_MAP,
  detectFrameworkType,
  scanSourceForEnvVars,
  detectIntegrations,
  checkMissingVars,
  checkProjectIntegrations,
};
