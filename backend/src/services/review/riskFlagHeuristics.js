const EMPTY_FILE_RISK_FLAGS = Object.freeze({
  dependencyChanges: false,
  envChanges: false,
  buildConfigChanges: false,
  securitySensitive: false,
  authPermissionChanges: false,
  dataMigrationChanges: false,
  publicApiChanges: false,
  billingPaymentChanges: false,
  destructiveDataChanges: false,
  reviewEngineChanges: false,
});

const HIGH_RISK_ROUTING_FLAG_KEYS = Object.freeze([
  'dependencyChanges',
  'envChanges',
  'buildConfigChanges',
  'largeBlastRadius',
  'securitySensitive',
  'authPermissionChanges',
  'dataMigrationChanges',
  'publicApiChanges',
  'billingPaymentChanges',
  'destructiveDataChanges',
  'reviewEngineChanges',
  'hasGitHubCheckFailures',
  'failingChecks',
  'hasLinterFailures',
]);

const DEPENDENCY_PATTERNS = Object.freeze([
  /package\.json$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /gemfile$/,
  /gemfile\.lock$/,
  /requirements\.txt$/,
  /pipfile$/,
  /pipfile\.lock$/,
  /go\.mod$/,
  /go\.sum$/,
  /cargo\.toml$/,
  /cargo\.lock$/,
  /composer\.json$/,
  /composer\.lock$/,
]);

const ENV_PATTERNS = Object.freeze([
  /\.env$/,
  /\.env\./,
  /(^|\/)config\//,
  /\.config\./,
  /settings\./,
]);

const BUILD_CONFIG_PATTERNS = Object.freeze([
  /vite\.config\./,
  /webpack\.config\./,
  /tsconfig\./,
  /babel\.config\./,
  /\.babelrc/,
  /rollup\.config\./,
  /esbuild\.config\./,
  /next\.config\./,
  /nuxt\.config\./,
  /svelte\.config\./,
  /tailwind\.config\./,
  /postcss\.config\./,
  /jest\.config\./,
  /vitest\.config\./,
  /\.eslintrc/,
  /\.prettierrc/,
  /dockerfile/,
  /docker-compose/,
]);

const SECURITY_PATTERNS = Object.freeze([
  /(^|\/|[._-])(security|crypto|cryptography|encryption|secrets?|credentials?|certs?|keys?|keychain)(\/|[._-]|$)/,
  /(^|\/)(secrets?|credentials?)\.(json|ya?ml|toml|ini|env)$/,
]);

const AUTH_PERMISSION_PATTERNS = Object.freeze([
  /(^|\/|[._-])(auth|authentication|authorization|permissions?|rbac|acl|oauth|saml|jwt|session|sessions|login|logout|signup|password|token|identity)(\/|[._-]|$)/,
]);

const DATA_MIGRATION_PATTERNS = Object.freeze([
  /(^|\/)(migrations?|db\/migrate|database\/migrations?|prisma\/migrations?|supabase\/migrations?|alembic|liquibase|flyway)(\/|$)/,
  /(^|\/)(schema\.prisma|schema\.sql|database\.sql)$/,
  /(^|\/)\d{6,}[_-].*\.(sql|js|ts|cs|py|rb)$/,
]);

const PUBLIC_API_PATTERNS = Object.freeze([
  /(^|\/)(api|apis|routes?|controllers?|graphql|grpc|proto|openapi|swagger)(\/|[._-]|$)/,
  /(^|\/)(openapi|swagger)\.(json|ya?ml)$/,
  /\.proto$/,
]);

const BILLING_PAYMENT_PATTERNS = Object.freeze([
  /(^|\/|[._-])(billing|payment|payments|checkout|stripe|paypal|invoice|invoices|subscription|subscriptions|pricing|tax|taxes)(\/|[._-]|$)/,
]);

const REVIEW_ENGINE_PATTERNS = Object.freeze([
  /(^|\/)backend\/src\/services\/review(\/|[._-]|$)/,
  /(^|\/)backend\/src\/services\/reviewservice\.(js|ts)$/,
  /(^|\/)backend\/src\/services\/providerservice\.(js|ts)$/,
  /(^|\/)backend\/src\/routes\/(reviews|prreviews)\.(js|ts)$/,
  /(^|\/)frontend\/src\/components\/(trustreview|trustpipeline|globalsettingsmodal)/,
  /(^|\/)frontend\/src\/components\/review\//,
  /(^|\/)mcp-review-server\//,
]);

const DESTRUCTIVE_DATA_CONTENT_RE = /(?:\b(?:drop\s+table|drop\s+database|truncate\s+table|delete\s+from|cascade\s+delete)\b|\bdeleteMany\s*\(\s*(?:\{\s*\})?\s*\))/i;

function normalizeRiskFilePath(file) {
  return String(file?.path || file?.filename || file?.name || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function hasPattern(patterns, value) {
  return patterns.some((pattern) => pattern.test(value));
}

function sampleRiskFileContent(file) {
  const parts = [];
  for (const key of ['before', 'after', 'patch', 'diff']) {
    if (typeof file?.[key] === 'string' && file[key]) {
      parts.push(file[key]);
    }
  }
  if (parts.length === 0) return '';
  return parts.join('\n').slice(0, 120000);
}

function inferFileRiskFlags(files = []) {
  const flags = { ...EMPTY_FILE_RISK_FLAGS };
  const normalizedFiles = Array.isArray(files) ? files : [];

  for (const file of normalizedFiles) {
    const filePath = normalizeRiskFilePath(file);
    if (!filePath) continue;

    if (hasPattern(DEPENDENCY_PATTERNS, filePath)) flags.dependencyChanges = true;
    if (hasPattern(ENV_PATTERNS, filePath)) flags.envChanges = true;
    if (hasPattern(BUILD_CONFIG_PATTERNS, filePath)) flags.buildConfigChanges = true;
    if (hasPattern(SECURITY_PATTERNS, filePath)) flags.securitySensitive = true;
    if (hasPattern(AUTH_PERMISSION_PATTERNS, filePath)) flags.authPermissionChanges = true;
    if (hasPattern(DATA_MIGRATION_PATTERNS, filePath)) flags.dataMigrationChanges = true;
    if (hasPattern(PUBLIC_API_PATTERNS, filePath)) flags.publicApiChanges = true;
    if (hasPattern(BILLING_PAYMENT_PATTERNS, filePath)) flags.billingPaymentChanges = true;
    if (hasPattern(REVIEW_ENGINE_PATTERNS, filePath)) flags.reviewEngineChanges = true;

    const contentSample = sampleRiskFileContent(file);
    if (contentSample && DESTRUCTIVE_DATA_CONTENT_RE.test(contentSample)) {
      flags.destructiveDataChanges = true;
    }
  }

  return flags;
}

function normalizeRoutingRiskFlags(riskFlags = {}, files = []) {
  const inferred = inferFileRiskFlags(files);
  const normalizedInput = riskFlags && typeof riskFlags === 'object' ? riskFlags : {};
  const normalized = {};

  for (const key of HIGH_RISK_ROUTING_FLAG_KEYS) {
    normalized[key] = Boolean(normalizedInput[key] || inferred[key]);
  }

  return normalized;
}

export {
  EMPTY_FILE_RISK_FLAGS,
  HIGH_RISK_ROUTING_FLAG_KEYS,
  inferFileRiskFlags,
  normalizeRoutingRiskFlags,
};
