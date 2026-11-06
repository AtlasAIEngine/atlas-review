import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { updateProjectGeneratedReviewPolicy } from '../../db/queries.js';
import gitService from '../gitService.js';
import { detectAvailableLinters } from './linter/linterDetection.js';
import { findPrimaryUnityProjectSync } from './reviewProjectProfileService.js';
import { LARGE_REVIEW_STRUCTURAL_SKIP_THRESHOLD } from './reviewConstants.js';

const REVIEW_POLICY_FILE_CANDIDATES = Object.freeze([
  { path: '.atlas/review-policy.json', format: 'json' },
  { path: 'atlas-review.yml', format: 'yaml' },
  { path: 'atlas-review.yaml', format: 'yaml' },
]);

const VALID_FILE_CLASSES = new Set(['deep', 'structural', 'shallow', 'collapsed', 'skip']);
const VALID_REVIEW_POLICY_SOURCES = new Set(['trusted', 'working_tree']);
const DEFAULT_REVIEW_POLICY_CACHE_TTL_MS = 30_000;
const GENERATED_PROJECT_REVIEW_POLICY_GENERATOR_VERSION = 'stack_aware_v1';
const GENERATED_PROJECT_REVIEW_POLICY_SOURCE_PATH = 'atlas:generated-project-review-policy';
const LEGACY_GENERATED_PROMPT_APPEND_ENTRIES = Object.freeze([
  'Prioritize correctness, regressions, security, data loss, and missing tests. Avoid style-only feedback unless it materially affects maintainability.',
]);
const defaultReviewPolicyCache = new Map();

function normalizeText(value, maxChars = 2000) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeStringList(values, maxItems = 12, maxChars = 120) {
  const seen = new Set();
  const normalized = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeText(String(value || ''), maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashStableValue(value) {
  return createHash('sha256')
    .update(stableSerialize(value), 'utf8')
    .digest('hex');
}

function normalizeReviewPolicySource(value, fallback = 'trusted') {
  const normalized = normalizeText(String(value || ''), 40).toLowerCase();
  if (VALID_REVIEW_POLICY_SOURCES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeDefaults(defaults = {}) {
  const maxRecommendations = Number(defaults?.maxRecommendations);
  return {
    requireEvidence: defaults?.requireEvidence !== false,
    allowPraise: defaults?.allowPraise === true,
    maxRecommendations: Number.isFinite(maxRecommendations) && maxRecommendations > 0
      ? Math.max(1, Math.trunc(maxRecommendations))
      : null,
    // Default-on: on large reviews (totalFiles >= LARGE_REVIEW_STRUCTURAL_SKIP_THRESHOLD)
    // promote files classified as `structural` (Unity scenes/prefabs/controllers,
    // Android res/, helm/k8s, Xcode pbxproj, etc.) to `skip` so the diff hunks
    // never reach the LLM. Set to false in .atlas/review-policy.json to keep
    // structural review on big PRs.
    largeReviewStructuralSkip: defaults?.largeReviewStructuralSkip !== false,
    // Default-off: opt-in to drop structural files unconditionally, regardless
    // of review size. Useful for repos where scene/prefab/manifest churn never
    // produces actionable findings (typical for Unity teams that never want
    // those reviewed). When true, this supersedes largeReviewStructuralSkip.
    skipAllStructuralFiles: defaults?.skipAllStructuralFiles === true,
  };
}

function normalizePromptAppendList(...sources) {
  const seen = new Set();
  const normalized = [];

  for (const source of sources) {
    const values = [];
    if (Array.isArray(source)) {
      values.push(...source);
    } else if (typeof source === 'string') {
      values.push(source);
    } else if (source && typeof source === 'object' && !Array.isArray(source)) {
      if (Array.isArray(source.promptAppend)) {
        values.push(...source.promptAppend);
      } else if (typeof source.promptAppend === 'string') {
        values.push(source.promptAppend);
      }
      if (typeof source.reviewAppend === 'string') {
        values.push(source.reviewAppend);
      }
    }

    for (const value of values) {
      const normalizedValue = normalizeText(value, 4000);
      if (!normalizedValue || seen.has(normalizedValue)) continue;
      seen.add(normalizedValue);
      normalized.push(normalizedValue);
    }
  }

  return normalized;
}

function sanitizeGeneratedPromptAppend(promptAppend = []) {
  const normalized = normalizePromptAppendList(promptAppend);
  if (normalized.length === 0) return [];
  const legacyEntries = new Set(LEGACY_GENERATED_PROMPT_APPEND_ENTRIES);
  return normalized.filter((entry) => !legacyEntries.has(entry));
}

function normalizeTypedRule(rule, kind) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const id = normalizeText(rule.id, 80);
  if (!id) return null;
  const where = rule.where && typeof rule.where === 'object' && !Array.isArray(rule.where)
    ? {
        glob: normalizeText(rule.where.glob, 240) || null,
        extension: normalizeText(rule.where.extension, 24) || null,
        language: normalizeText(rule.where.language, 24) || null,
        fileClass: VALID_FILE_CLASSES.has(rule.where.fileClass) ? rule.where.fileClass : null,
        pathMatches: normalizeStringList(rule.where.pathMatches, 12, 120),
      }
    : null;
  const checks = normalizeStringList(rule.checks, 12, 80);
  const match = rule.match && typeof rule.match === 'object' && !Array.isArray(rule.match)
    ? {
        patternClass: normalizeText(rule.match.patternClass, 80) || null,
      }
    : null;
  return {
    kind,
    id,
    where,
    checks,
    match,
  };
}

function normalizePathRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const glob = normalizeText(rule.glob, 240);
  if (!glob) return null;
  const fileClass = VALID_FILE_CLASSES.has(rule.fileClass) ? rule.fileClass : null;
  return {
    glob,
    fileClass,
    promptAppend: normalizeText(rule.promptAppend, 1000),
    mustCheckRules: normalizeStringList(rule.mustCheckRules, 12, 80),
  };
}

const KNOWN_LINTER_IDS = new Set(['eslint', 'tsc', 'dotnet', 'dotnetFormat', 'semgrep']);
const VALID_LINTER_MODES = new Set(['project_only', 'fallback_if_missing']);

function normalizeLinterPolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = {};
  if (Object.prototype.hasOwnProperty.call(raw, 'enabled')) {
    result.enabled = raw.enabled !== false;
  }
  if (VALID_LINTER_MODES.has(raw.mode)) {
    result.mode = raw.mode;
  }
  for (const id of KNOWN_LINTER_IDS) {
    const entry = raw[id];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      result[id] = {
        ...(Object.prototype.hasOwnProperty.call(entry, 'enabled') ? { enabled: entry.enabled !== false } : {}),
        ...(Object.prototype.hasOwnProperty.call(entry, 'allowAtlasManagedFallback')
          ? { allowAtlasManagedFallback: entry.allowAtlasManagedFallback !== false }
          : {}),
      };
    }
  }
  return result;
}

function normalizeRepoPolicyDocument(rawPolicy = {}) {
  const policy = rawPolicy && typeof rawPolicy === 'object' && !Array.isArray(rawPolicy)
    ? rawPolicy
    : {};
  const normalizedRules = {
    suppressionRules: (Array.isArray(policy.rules?.suppressionRules) ? policy.rules.suppressionRules : [])
      .map((rule) => normalizeTypedRule(rule, 'suppression'))
      .filter(Boolean),
    mustCheckRules: (Array.isArray(policy.rules?.mustCheckRules) ? policy.rules.mustCheckRules : [])
      .map((rule) => normalizeTypedRule(rule, 'must_check'))
      .filter(Boolean),
  };
  return {
    version: Number.isFinite(Number(policy.version)) ? Math.max(1, Math.trunc(Number(policy.version))) : 1,
    defaults: normalizeDefaults(policy.defaults),
    promptAppend: normalizePromptAppendList(policy.promptAppend, policy.prompt),
    ...(normalizedRules.suppressionRules.length > 0 || normalizedRules.mustCheckRules.length > 0
      ? { rules: normalizedRules }
      : {}),
    linters: normalizeLinterPolicy(policy.linters),
    paths: (Array.isArray(policy.paths) ? policy.paths : [])
      .map((rule) => normalizePathRule(rule))
      .filter(Boolean),
  };
}

function buildAtlasDefaultPolicy() {
  return {
    version: 1,
    defaults: {
      requireEvidence: true,
      allowPraise: false,
      maxRecommendations: null,
      largeReviewStructuralSkip: true,
      skipAllStructuralFiles: false,
    },
    promptAppend: [],
    rules: {
      suppressionRules: [],
      mustCheckRules: [],
    },
    linters: null,
    paths: [],
  };
}

function buildNormalizedPolicyHashPayload(policy) {
  return {
    version: policy?.version ?? 1,
    defaults: policy?.defaults ?? {},
    promptAppend: policy?.promptAppend ?? [],
    rules: policy?.rules ?? {},
    paths: policy?.paths ?? [],
    linters: policy?.linters ?? null,
  };
}

function buildSmartLinterPolicy(projectPath) {
  if (!projectPath) return null;
  try {
    const detected = detectAvailableLinters(projectPath);
    const anyAvailable = Object.values(detected).some((d) => d.available);
    if (!anyAvailable) return null;
    const linters = { enabled: true, mode: 'fallback_if_missing' };
    for (const [id, info] of Object.entries(detected)) {
      linters[id] = {
        enabled: Object.prototype.hasOwnProperty.call(info, 'defaultEnabled')
          ? info.defaultEnabled !== false
          : info.available,
      };
      if (id === 'semgrep' && info.available) {
        linters[id].allowAtlasManagedFallback = true;
      }
    }
    return linters;
  } catch {
    return null;
  }
}

// ── Smart path rule candidates ────────────────────────────────────────────────

const TEST_PATH_RULES = [
  {
    glob: '**/*.test.*',
    fileClass: 'shallow',
    promptAppend: 'Review tests for correctness and regression coverage, but do not spend effort on style-only issues.',
    detect: (projectPath) => hasFilesMatching(projectPath, /\.test\.(?:[cm]?[jt]sx?)$/),
  },
  {
    glob: '**/*.spec.*',
    fileClass: 'shallow',
    promptAppend: 'Review tests for correctness and regression coverage, but do not spend effort on style-only issues.',
    detect: (projectPath) => hasFilesMatching(projectPath, /\.spec\.(?:[cm]?[jt]sx?)$/),
  },
  {
    glob: '**/*.snap',
    fileClass: 'collapsed',
    detect: (projectPath) => hasFilesMatching(projectPath, /\.snap$/),
  },
];

const LOCK_FILE_RULES = [
  { glob: '**/package-lock.json', fileClass: 'collapsed', file: 'package-lock.json' },
  { glob: '**/pnpm-lock.yaml', fileClass: 'collapsed', file: 'pnpm-lock.yaml' },
  { glob: '**/yarn.lock', fileClass: 'collapsed', file: 'yarn.lock' },
  { glob: '**/bun.lock', fileClass: 'collapsed', file: 'bun.lock' },
  { glob: '**/bun.lockb', fileClass: 'collapsed', file: 'bun.lockb' },
  { glob: '**/Gemfile.lock', fileClass: 'collapsed', file: 'Gemfile.lock' },
  { glob: '**/composer.lock', fileClass: 'collapsed', file: 'composer.lock' },
  { glob: '**/Cargo.lock', fileClass: 'collapsed', file: 'Cargo.lock' },
  { glob: '**/poetry.lock', fileClass: 'collapsed', file: 'poetry.lock' },
  { glob: '**/go.sum', fileClass: 'collapsed', file: 'go.sum' },
  { glob: '**/go.work.sum', fileClass: 'collapsed', file: 'go.work.sum' },
  { glob: '**/buf.lock', fileClass: 'collapsed', file: 'buf.lock' },
  { glob: '**/Pipfile.lock', fileClass: 'collapsed', file: 'Pipfile.lock' },
];

const BUILD_OUTPUT_RULES = [
  { glob: '**/dist/**', fileClass: 'skip', dir: 'dist' },
  { glob: '**/build/**', fileClass: 'skip', dir: 'build' },
  { glob: '**/coverage/**', fileClass: 'skip', dir: 'coverage' },
  { glob: '**/.next/**', fileClass: 'skip', dir: '.next' },
  { glob: '**/out/**', fileClass: 'skip', dir: 'out' },
  { glob: '**/__pycache__/**', fileClass: 'skip', dir: '__pycache__' },
  { glob: '**/target/**', fileClass: 'skip', dir: 'target' },
  { glob: '**/bin/Debug/**', fileClass: 'skip', dir: 'bin' },
  { glob: '**/obj/**', fileClass: 'skip', dir: 'obj' },
];

const GENERATED_FILE_RULES = [
  { glob: '**/__generated__/**', fileClass: 'collapsed', dir: '__generated__' },
  { glob: '**/generated/**', fileClass: 'collapsed', dir: 'generated' },
  { glob: '**/*.generated.*', fileClass: 'collapsed', detect: (projectPath) => hasFilesMatching(projectPath, /\.generated\.[a-z]+$/i) },
  { glob: '**/*.pb.go', fileClass: 'collapsed', detect: (projectPath) => hasFilesMatching(projectPath, /\.pb\.go$/) },
  { glob: '**/*.pb.gw.go', fileClass: 'collapsed', detect: (projectPath) => hasFilesMatching(projectPath, /\.pb\.gw\.go$/) },
  { glob: '**/*.pb.validate.go', fileClass: 'collapsed', detect: (projectPath) => hasFilesMatching(projectPath, /\.pb\.validate\.go$/) },
  { glob: '**/*.min.js', fileClass: 'skip', detect: (projectPath) => hasFilesMatching(projectPath, /\.min\.js$/) },
  { glob: '**/*.min.css', fileClass: 'skip', detect: (projectPath) => hasFilesMatching(projectPath, /\.min\.css$/) },
];

const UNITY_MARKERS = Object.freeze([
  'ProjectSettings/ProjectVersion.txt',
  'Assets',
]);

const UNITY_SKIP_SUFFIXES = [
  'Library/**',
  'Logs/**',
  'Obj/**',
  'Temp/**',
  'Build/**',
  'Builds/**',
  'MemoryCaptures/**',
  'Packages/packages-lock.json',
  'UserSettings/Layouts/**',
];

const UNITY_COLLAPSED_SUFFIXES = [
  '**/*.meta',
  '**/*.csproj',
  '**/*.sln',
  'Assets/**/*.mat',
  'UserSettings/**',
];

const UNITY_DEEP_SUFFIXES = [
  'Assets/Scripts/**',
  'Assets/Editor/**',
  'Packages/**',
  'ProjectSettings/**',
  'Tools/**',
  '**/*.cs',
  '**/*.asmdef',
  '**/*.asmref',
  '**/*.cginc',
  '**/*.hlsl',
  '**/*.shader',
];

const UNITY_STRUCTURAL_SUFFIXES = [
  'Assets/**/*.anim',
  'Assets/**/*.asset',
  'Assets/**/*.controller',
  'Assets/**/*.playable',
  'Assets/**/*.prefab',
  'Assets/**/*.shadergraph',
  'Assets/**/*.unity',
];

const STACK_PATH_RULE_BUILDERS = [
  {
    name: 'go',
    detect: ({ entries, names }) => (
      names.has('go.mod')
      || names.has('go.work')
      || (
        entries.some((entry) => entry.isFile() && /\.go$/.test(entry.name))
        && (names.has('cmd') || names.has('internal') || names.has('pkg'))
      )
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['vendor/**'],
      shallow: ['**/*_test.go'],
      structural: [
        'buf.yaml',
        'buf.gen.yaml',
        'buf.work.yaml',
        {
          glob: '**/*.proto',
          promptAppend: 'Check protobuf and RPC contract changes for backward compatibility, field numbering, wire-format safety, and generated-code impact.',
        },
      ],
      deep: [
        'cmd/**',
        'internal/**',
        'pkg/**',
        {
          glob: '**/*.go',
          promptAppend: 'Prioritize request validation, auth, datastore consistency, context handling, error paths, and concurrency safety in Go services.',
        },
      ],
    }),
  },
  {
    name: 'protobuf',
    detect: ({ entries, names }) => (
      names.has('buf.yaml')
      || names.has('buf.gen.yaml')
      || names.has('buf.work.yaml')
      || names.has('proto')
      || entries.some((entry) => entry.isFile() && /\.proto$/.test(entry.name))
    ),
    rules: ({ root }) => buildStackRules(root, {
      structural: [
        'buf.yaml',
        'buf.gen.yaml',
        'buf.work.yaml',
        {
          glob: '**/*.proto',
          promptAppend: 'Check protobuf and RPC contract changes for backward compatibility, field numbering, wire-format safety, and generated-code impact.',
        },
      ],
    }),
  },
  {
    name: 'rails',
    detect: ({ dir, names }) => (
      names.has('Gemfile')
      && existsSync(path.join(dir, 'config', 'application.rb'))
      && names.has('app')
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['log/**', 'tmp/**', 'storage/**', 'vendor/bundle/**'],
      collapsed: ['Gemfile.lock', 'db/schema.rb'],
      shallow: ['test/**', 'spec/**'],
      deep: ['app/**', 'config/**', 'db/migrate/**', 'lib/**', '**/*.rb', '**/*.rake'],
    }),
  },
  {
    name: 'python',
    detect: ({ names }) => (
      names.has('pyproject.toml')
      || names.has('requirements.txt')
      || names.has('setup.py')
      || names.has('setup.cfg')
      || names.has('manage.py')
      || names.has('Pipfile')
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['.venv/**', 'venv/**', 'env/**', '__pycache__/**', '.pytest_cache/**', '.mypy_cache/**', '.ruff_cache/**'],
      collapsed: ['poetry.lock', 'Pipfile.lock'],
      shallow: ['tests/**', '**/test_*.py', '**/*_test.py'],
      deep: ['src/**', 'app/**', 'alembic/**', 'migrations/**', '**/*.py', '**/*.pyi'],
    }),
  },
  {
    name: 'gradle',
    detect: ({ names }) => (
      names.has('settings.gradle')
      || names.has('settings.gradle.kts')
      || names.has('build.gradle')
      || names.has('build.gradle.kts')
      || names.has('gradlew')
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['.gradle/**', 'build/**', 'out/**'],
      collapsed: ['gradle.lockfile'],
      shallow: ['src/test/**', 'src/androidTest/**'],
      structural: ['app/src/main/res/**'],
      deep: ['src/main/**', 'buildSrc/**', 'gradle/**', '**/*.java', '**/*.kt', '**/*.kts'],
    }),
  },
  {
    name: 'iac',
    detect: ({ entries, names }) => (
      entries.some((entry) => entry.isFile() && /\.(tf|tfvars|tfvars\.json|hcl)$/.test(entry.name))
      || names.has('helm')
      || names.has('charts')
      || names.has('k8s')
      || names.has('terraform')
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['.terraform/**', '.terragrunt-cache/**'],
      collapsed: ['.terraform.lock.hcl'],
      structural: ['helm/**', 'charts/**', 'k8s/**', 'terraform/**'],
      deep: ['**/*.tf', '**/*.tfvars', '**/*.tfvars.json', '**/*.hcl'],
    }),
  },
  {
    name: 'apple',
    detect: ({ entries, names }) => (
      names.has('Package.swift')
      || names.has('Podfile')
      || entries.some((entry) => entry.isDirectory() && /\.(xcodeproj|xcworkspace)$/.test(entry.name))
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['DerivedData/**', 'Pods/**', 'Carthage/Build/**'],
      structural: ['**/*.xcodeproj/project.pbxproj', '**/*.xcworkspace/**'],
      deep: ['Package.swift', 'Sources/**', 'fastlane/**', '**/*.swift'],
    }),
  },
  {
    name: 'unreal',
    detect: ({ entries, names }) => (
      entries.some((entry) => entry.isFile() && /\.uproject$/.test(entry.name))
      || (names.has('Source') && names.has('Config'))
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['Binaries/**', 'Intermediate/**', 'Saved/**', 'DerivedDataCache/**'],
      structural: ['Content/**'],
      deep: ['Source/**', 'Config/**', 'Plugins/**', '**/*.uproject', '**/*.Build.cs', '**/*.Target.cs'],
    }),
  },
  {
    name: 'laravel',
    detect: ({ names }) => (
      names.has('artisan')
      && names.has('app')
      && names.has('routes')
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['storage/**', 'bootstrap/cache/**', 'vendor/**'],
      collapsed: ['composer.lock'],
      shallow: ['tests/**'],
      structural: ['resources/views/**'],
      deep: ['artisan', 'app/**', 'config/**', 'routes/**', 'database/migrations/**', '**/*.php'],
    }),
  },
  {
    name: 'phoenix',
    detect: ({ names }) => (
      names.has('mix.exs')
      && names.has('lib')
      && names.has('config')
    ),
    rules: ({ root }) => buildStackRules(root, {
      skip: ['_build/**', 'deps/**', 'cover/**'],
      collapsed: ['mix.lock'],
      shallow: ['test/**'],
      deep: ['lib/**', 'config/**', 'priv/repo/migrations/**', '**/*.ex', '**/*.exs'],
    }),
  },
];

const SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  '__pycache__', 'target', 'obj', '.cache', '.output', '.temp',
  'vendor', '.yarn', '.pnp', 'venv', '.venv', 'env',
  '.idea', '.vscode', '.playwright-mcp', 'test-results', '.tmp',
]);

function getTrackedProjectFiles(projectPath) {
  if (!projectPath) return null;
  try {
    const stdout = execFileSync('git', ['ls-files', '-z'], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      // Large repos like ExampleProject can exceed Node's default sync buffer.
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = String(stdout || '')
      .split('\0')
      .map((entry) => String(entry || '').trim().replace(/\\/g, '/'))
      .filter(Boolean);
    if (files.length === 0) return null;
    return new Set(files);
  } catch {
    return null;
  }
}

function hasTrackedFileMatchingGlob(trackedFiles, glob) {
  if (!(trackedFiles instanceof Set) || trackedFiles.size === 0) return false;
  for (const filePath of trackedFiles) {
    if (matchGlob(glob, filePath)) return true;
    if (typeof glob === 'string' && glob.startsWith('**/') && matchGlob(glob.slice(3), filePath)) return true;
  }
  return false;
}

function filterPathRulesForTrackedFiles(pathRules, trackedFiles) {
  if (!(trackedFiles instanceof Set) || trackedFiles.size === 0) {
    return pathRules;
  }
  return pathRules.filter((rule) => hasTrackedFileMatchingGlob(trackedFiles, rule?.glob));
}

function hasFilesMatching(projectPath, pattern, { maxDepth = 6, maxEntries = 2000 } = {}) {
  return scanDirForPattern(projectPath, pattern, maxDepth, 0, maxEntries, { count: 0 });
}

function scanDirForPattern(dirPath, pattern, maxDepth, currentDepth, maxEntries, counter) {
  if (currentDepth > maxDepth || counter.count > maxEntries) return false;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      counter.count++;
      if (counter.count > maxEntries) return false;
      const name = entry.name;
      if (SCAN_SKIP_DIRS.has(name)) continue;
      if (entry.isFile() && pattern.test(name)) return true;
      if (entry.isDirectory() && currentDepth < maxDepth) {
        if (scanDirForPattern(path.join(dirPath, name), pattern, maxDepth, currentDepth + 1, maxEntries, counter)) return true;
      }
    }
  } catch { /* ignore permission/access errors */ }
  return false;
}

function fileExistsInProjectTree(projectPath, filename, maxDepth = 2) {
  return scanDirForFile(projectPath, filename, maxDepth, 0);
}

function scanDirForFile(dirPath, filename, maxDepth, currentDepth) {
  if (currentDepth > maxDepth) return false;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      if (entry.isFile() && entry.name === filename) return true;
      if (entry.isDirectory() && currentDepth < maxDepth) {
        if (scanDirForFile(path.join(dirPath, entry.name), filename, maxDepth, currentDepth + 1)) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

function dirExistsInProjectTree(projectPath, dirname, maxDepth = 2) {
  return scanDirForDir(projectPath, dirname, maxDepth, 0);
}

function scanDirForDir(dirPath, dirname, maxDepth, currentDepth) {
  if (currentDepth > maxDepth) return false;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === dirname) return true;
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      if (currentDepth < maxDepth) {
        if (scanDirForDir(path.join(dirPath, entry.name), dirname, maxDepth, currentDepth + 1)) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

function buildRootedGlob(root, suffix) {
  const normalizedRoot = String(root || '').trim().replace(/\\/g, '/');
  return normalizedRoot ? `${normalizedRoot}/${suffix}` : suffix;
}

function buildStackRules(root, groups = {}) {
  const rules = [];
  const orderedGroups = [
    ['skip', groups.skip],
    ['collapsed', groups.collapsed],
    ['shallow', groups.shallow],
    ['structural', groups.structural],
    ['deep', groups.deep],
  ];
  for (const [fileClass, suffixes] of orderedGroups) {
    for (const suffix of Array.isArray(suffixes) ? suffixes : []) {
      if (typeof suffix === 'string') {
        rules.push({ glob: buildRootedGlob(root, suffix), fileClass });
        continue;
      }
      if (!suffix || typeof suffix !== 'object' || Array.isArray(suffix)) continue;
      const glob = normalizeText(suffix.glob ?? suffix.suffix, 240);
      if (!glob) continue;
      const rule = {
        glob: buildRootedGlob(root, glob),
        fileClass,
      };
      const promptAppend = normalizeText(suffix.promptAppend, 1000);
      if (promptAppend) rule.promptAppend = promptAppend;
      rules.push(rule);
    }
  }
  return rules;
}

function findProjectRootsByPredicate(projectPath, predicate, { maxDepth = 4, maxDirectories = 240 } = {}) {
  if (!projectPath || typeof predicate !== 'function') return [];

  const roots = [];
  const queue = [{ dir: projectPath, depth: 0 }];
  const visited = new Set([projectPath]);
  let scannedDirectories = 0;

  while (queue.length > 0 && scannedDirectories < maxDirectories) {
    const { dir, depth } = queue.shift();
    scannedDirectories += 1;

    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    const names = new Set(entries.map((entry) => entry.name));
    if (predicate({
      dir,
      depth,
      entries,
      names,
      projectPath,
      relativeRoot: path.relative(projectPath, dir).replace(/\\/g, '/') || '',
    })) {
      const relativeRoot = path.relative(projectPath, dir).replace(/\\/g, '/');
      roots.push(relativeRoot || '');
    }

    if (depth >= maxDepth) continue;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      const childPath = path.join(dir, entry.name);
      if (visited.has(childPath)) continue;
      visited.add(childPath);
      queue.push({ dir: childPath, depth: depth + 1 });
    }
  }

  return [...new Set(roots)];
}

function buildUnityPathRules(projectPath) {
  const unityProject = findPrimaryUnityProjectSync(projectPath, {
    markers: UNITY_MARKERS,
    minMarkersMatched: 2,
    maxDepth: 4,
  });
  if (!unityProject?.root && unityProject?.root !== '') return [];

  const rules = [];
  const root = unityProject.root || '';
  for (const suffix of UNITY_SKIP_SUFFIXES) {
    rules.push({ glob: buildRootedGlob(root, suffix), fileClass: 'skip' });
  }
  for (const suffix of UNITY_COLLAPSED_SUFFIXES) {
    rules.push({ glob: buildRootedGlob(root, suffix), fileClass: 'collapsed' });
  }
  for (const suffix of UNITY_DEEP_SUFFIXES) {
    rules.push({ glob: buildRootedGlob(root, suffix), fileClass: 'deep' });
  }
  for (const suffix of UNITY_STRUCTURAL_SUFFIXES) {
    rules.push({ glob: buildRootedGlob(root, suffix), fileClass: 'structural' });
  }

  return rules;
}

function buildStackAwarePathRules(projectPath) {
  const rules = [];
  for (const builder of STACK_PATH_RULE_BUILDERS) {
    const roots = findProjectRootsByPredicate(projectPath, builder.detect);
    for (const root of roots) {
      rules.push(...builder.rules({ root, projectPath }));
    }
  }
  return rules;
}

function buildSmartPathRules(projectPath) {
  if (!projectPath) return [];
  try {
    const paths = [];
    const trackedFiles = getTrackedProjectFiles(projectPath);

    // Test file patterns
    for (const rule of TEST_PATH_RULES) {
      if (rule.detect(projectPath)) {
        const entry = { glob: rule.glob, fileClass: rule.fileClass };
        if (rule.promptAppend) entry.promptAppend = rule.promptAppend;
        paths.push(entry);
      }
    }

    // Lock files — only include ones that actually exist
    for (const rule of LOCK_FILE_RULES) {
      if (fileExistsInProjectTree(projectPath, rule.file)) {
        paths.push({ glob: rule.glob, fileClass: rule.fileClass });
      }
    }

    // Build output dirs — only include ones that exist
    for (const rule of BUILD_OUTPUT_RULES) {
      if (dirExistsInProjectTree(projectPath, rule.dir)) {
        paths.push({ glob: rule.glob, fileClass: rule.fileClass });
      }
    }

    // Generated files — only include if detected
    for (const rule of GENERATED_FILE_RULES) {
      const detected = rule.detect
        ? rule.detect(projectPath)
        : rule.dir
          ? dirExistsInProjectTree(projectPath, rule.dir)
          : false;
      if (detected) {
        paths.push({ glob: rule.glob, fileClass: rule.fileClass });
      }
    }

    for (const rule of buildUnityPathRules(projectPath)) {
      paths.push(rule);
    }

    for (const rule of buildStackAwarePathRules(projectPath)) {
      paths.push(rule);
    }

    return mergePathRules([], filterPathRulesForTrackedFiles(paths, trackedFiles));
  } catch {
    return [];
  }
}

function createDefaultReviewPolicyDocument(projectPath) {
  if (projectPath) {
    const now = Date.now();
    const cached = defaultReviewPolicyCache.get(projectPath);
    if (cached && (now - cached.createdAt) < DEFAULT_REVIEW_POLICY_CACHE_TTL_MS) {
      return cached.document;
    }
  }
  const linters = buildSmartLinterPolicy(projectPath);
  const paths = buildSmartPathRules(projectPath);
  const document = {
    version: 1,
    defaults: {
      requireEvidence: true,
      allowPraise: false,
      maxRecommendations: 20,
      largeReviewStructuralSkip: true,
      skipAllStructuralFiles: false,
    },
    promptAppend: [],
    ...(linters ? { linters } : {}),
    paths,
  };
  if (projectPath) {
    defaultReviewPolicyCache.set(projectPath, {
      createdAt: Date.now(),
      document,
    });
  }
  return document;
}

function createGeneratedProjectReviewPolicyBaseline(projectPath) {
  const policy = normalizeRepoPolicyDocument(createDefaultReviewPolicyDocument(projectPath));
  const hash = hashStableValue(buildNormalizedPolicyHashPayload(policy));
  return {
    policy,
    content: `${JSON.stringify(policy, null, 2)}\n`,
    hash,
    version: policy.version,
    generatorVersion: GENERATED_PROJECT_REVIEW_POLICY_GENERATOR_VERSION,
    generatedAt: new Date().toISOString(),
    sourcePath: GENERATED_PROJECT_REVIEW_POLICY_SOURCE_PATH,
    format: 'json',
    loadError: null,
  };
}

function parseStoredGeneratedProjectReviewPolicy(project = null) {
  const rawContent = typeof project?.generated_review_policy_json === 'string'
    ? project.generated_review_policy_json
    : '';
  if (!rawContent.trim()) {
    return {
      policy: null,
      content: null,
      hash: null,
      version: null,
      generatorVersion: null,
      generatedAt: null,
      sourcePath: GENERATED_PROJECT_REVIEW_POLICY_SOURCE_PATH,
      format: 'json',
      loadError: null,
    };
  }

  try {
    const parsed = normalizeRepoPolicyDocument(JSON.parse(rawContent));
    const sanitizedPolicy = {
      ...parsed,
      promptAppend: sanitizeGeneratedPromptAppend(parsed.promptAppend),
    };
    const hash = hashStableValue(buildNormalizedPolicyHashPayload(sanitizedPolicy));
    return {
      policy: sanitizedPolicy,
      content: `${JSON.stringify(sanitizedPolicy, null, 2)}\n`,
      hash,
      version: Number.isFinite(Number(project?.generated_review_policy_version))
        ? Math.max(1, Math.trunc(Number(project.generated_review_policy_version)))
        : sanitizedPolicy.version,
      generatorVersion: normalizeText(project?.generated_review_policy_generator_version, 80)
        || GENERATED_PROJECT_REVIEW_POLICY_GENERATOR_VERSION,
      generatedAt: normalizeText(project?.generated_review_policy_generated_at, 80) || null,
      sourcePath: GENERATED_PROJECT_REVIEW_POLICY_SOURCE_PATH,
      format: 'json',
      loadError: null,
    };
  } catch (error) {
    return {
      policy: null,
      content: null,
      hash: null,
      version: null,
      generatorVersion: normalizeText(project?.generated_review_policy_generator_version, 80) || null,
      generatedAt: normalizeText(project?.generated_review_policy_generated_at, 80) || null,
      sourcePath: GENERATED_PROJECT_REVIEW_POLICY_SOURCE_PATH,
      format: 'json',
      loadError: {
        code: 'invalid_json',
        message: normalizeText(error?.message || 'Failed to parse stored generated review policy JSON.', 240),
      },
    };
  }
}

async function ensureGeneratedProjectReviewPolicy(project = null) {
  const stored = parseStoredGeneratedProjectReviewPolicy(project);
  if (stored.policy) {
    const storedHash = normalizeText(project?.generated_review_policy_hash, 160);
    const storedContent = typeof project?.generated_review_policy_json === 'string'
      ? project.generated_review_policy_json.trim()
      : '';
    const normalizedStoredContent = typeof stored.content === 'string'
      ? stored.content.trim()
      : '';
    const staleStoredMetadata = !!project?.id && (
      storedHash !== normalizeText(stored.hash, 160)
      || storedContent !== normalizedStoredContent
    );
    if (staleStoredMetadata) {
      await Promise.resolve(updateProjectGeneratedReviewPolicy(project.id, {
        generatedReviewPolicyJson: stored.content?.trim() || null,
        generatedReviewPolicyHash: stored.hash,
        generatedReviewPolicyVersion: stored.version,
        generatedReviewPolicyGeneratorVersion: stored.generatorVersion,
        generatedReviewPolicyGeneratedAt: stored.generatedAt,
      })).catch((error) => {
        console.warn(
          `[ReviewPolicy] Failed to persist sanitized generated project policy for ${project.id}:`,
          error?.message || error
        );
        return null;
      });
    }
    return stored;
  }

  if (!project?.path) {
    return stored;
  }

  const generated = createGeneratedProjectReviewPolicyBaseline(project.path);
  if (project?.id) {
    await Promise.resolve(updateProjectGeneratedReviewPolicy(project.id, {
      generatedReviewPolicyJson: generated.content.trim(),
      generatedReviewPolicyHash: generated.hash,
      generatedReviewPolicyVersion: generated.version,
      generatedReviewPolicyGeneratorVersion: generated.generatorVersion,
      generatedReviewPolicyGeneratedAt: generated.generatedAt,
    })).catch((error) => {
      console.warn(
        `[ReviewPolicy] Failed to persist generated project policy for ${project.id}:`,
        error?.message || error
      );
      return null;
    });
  }

  return generated;
}

function getDefaultReviewPolicyContent(projectPath) {
  return `${JSON.stringify(createDefaultReviewPolicyDocument(projectPath), null, 2)}\n`;
}

function parseReviewPolicyContent(content) {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) {
    return {
      policy: null,
      error: {
        code: 'empty_content',
        message: 'Review policy content is empty.',
      },
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        policy: null,
        error: {
          code: 'invalid_shape',
          message: 'Review policy must be a JSON object.',
        },
      };
    }
    return {
      policy: normalizeRepoPolicyDocument(parsed),
      error: null,
    };
  } catch (error) {
    return {
      policy: null,
      error: {
        code: 'invalid_json',
        message: normalizeText(error?.message || 'Failed to parse review policy JSON.', 240),
      },
    };
  }
}

function buildReviewProfilePolicyDefaults(reviewProfile = null) {
  const promptGuidance = normalizeText(reviewProfile?.promptGuidance, 1200);
  return {
    version: 1,
    defaults: {},
    promptAppend: promptGuidance ? [promptGuidance] : [],
    rules: {
      suppressionRules: [],
      mustCheckRules: [],
    },
    paths: [],
  };
}

function mergePromptAppendLists(baseValue, nextValue) {
  return normalizePromptAppendList(baseValue, nextValue);
}

function mergePathRules(baseRules = [], nextRules = []) {
  const merged = [];
  const seen = new Set();
  for (const rule of [...baseRules, ...nextRules]) {
    const normalized = normalizePathRule(rule);
    if (!normalized) continue;
    const key = hashStableValue(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function mergeTypedRules(baseRules = [], nextRules = []) {
  const merged = [];
  const seen = new Set();
  for (const rule of [...baseRules, ...nextRules]) {
    const normalized = normalizeTypedRule(rule, rule?.kind || 'policy');
    if (!normalized) continue;
    const key = hashStableValue(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function mergeLinterPolicies(basePolicy = null, nextPolicy = null) {
  const normalizedBase = normalizeLinterPolicy(basePolicy);
  const normalizedNext = normalizeLinterPolicy(nextPolicy);
  if (!normalizedBase) return normalizedNext;
  if (!normalizedNext) return normalizedBase;

  const merged = {};

  if (Object.prototype.hasOwnProperty.call(normalizedBase, 'enabled')) {
    merged.enabled = normalizedBase.enabled !== false;
  }
  if (normalizedBase.mode && VALID_LINTER_MODES.has(normalizedBase.mode)) {
    merged.mode = normalizedBase.mode;
  }

  if (normalizedNext && Object.prototype.hasOwnProperty.call(normalizedNext, 'enabled')) {
    merged.enabled = normalizedNext.enabled !== false;
  }
  if (normalizedNext?.mode && VALID_LINTER_MODES.has(normalizedNext.mode)) {
    merged.mode = normalizedNext.mode;
  }

  for (const id of KNOWN_LINTER_IDS) {
    if (normalizedBase[id]) {
      merged[id] = {};
      if (Object.prototype.hasOwnProperty.call(normalizedBase[id], 'enabled')) {
        merged[id].enabled = normalizedBase[id].enabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(normalizedBase[id], 'allowAtlasManagedFallback')) {
        merged[id].allowAtlasManagedFallback = normalizedBase[id].allowAtlasManagedFallback !== false;
      }
    }
    if (normalizedNext[id]) {
      merged[id] = {
        ...(merged[id] || {}),
      };
      if (Object.prototype.hasOwnProperty.call(normalizedNext[id], 'enabled')) {
        merged[id].enabled = normalizedNext[id].enabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(normalizedNext[id], 'allowAtlasManagedFallback')) {
        merged[id].allowAtlasManagedFallback = normalizedNext[id].allowAtlasManagedFallback !== false;
      }
    }
  }

  return merged;
}

function mergeReviewPolicyLayers(...layers) {
  const merged = buildAtlasDefaultPolicy();
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    const normalized = normalizeRepoPolicyDocument(layer);
    merged.version = Math.max(merged.version, normalized.version);
    merged.defaults = {
      ...merged.defaults,
      ...normalized.defaults,
    };
    merged.promptAppend = mergePromptAppendLists(merged.promptAppend, normalized.promptAppend);
    merged.rules = {
      suppressionRules: mergeTypedRules(merged.rules?.suppressionRules, normalized.rules?.suppressionRules),
      mustCheckRules: mergeTypedRules(merged.rules?.mustCheckRules, normalized.rules?.mustCheckRules),
    };
    merged.paths = mergePathRules(merged.paths, normalized.paths);
    merged.linters = mergeLinterPolicies(merged.linters, normalized.linters);
  }
  return merged;
}

async function resolveTrustedReviewPolicyRef({
  projectPath = null,
  reviewType = 'branch_review',
  baseBranch = null,
  baseSha = null,
} = {}) {
  if (!projectPath) {
    return {
      trustedRef: null,
      trustedRefSource: 'unavailable',
    };
  }

  const normalizedType = String(reviewType || '').trim().toLowerCase();
  const normalizedBaseSha = normalizeText(baseSha, 80);
  const normalizedBaseBranch = normalizeText(baseBranch, 120);

  if (normalizedType === 'pr_review' && normalizedBaseSha) {
    return {
      trustedRef: normalizedBaseSha,
      trustedRefSource: 'pr_base_sha',
    };
  }

  if (normalizedBaseBranch) {
    const resolvedBranchRef = await gitService.resolveBranchRef(projectPath, normalizedBaseBranch).catch(() => null);
    return {
      trustedRef: resolvedBranchRef || normalizedBaseBranch,
      trustedRefSource: normalizedType === 'pr_review' ? 'pr_base_branch' : 'branch_base_branch',
    };
  }

  const remoteDefaultBranch = await gitService.getRemoteDefaultBranch(projectPath).catch(() => null);
  if (remoteDefaultBranch) {
    const resolvedDefaultRef = await gitService.resolveBranchRef(projectPath, remoteDefaultBranch).catch(() => null);
    return {
      trustedRef: resolvedDefaultRef || remoteDefaultBranch,
      trustedRefSource: 'remote_default_branch',
    };
  }

  return {
    trustedRef: null,
    trustedRefSource: 'unavailable',
  };
}

async function loadTrustedRepoReviewPolicy(projectPath, trustedRef) {
  const normalizedRef = normalizeText(trustedRef, 240);
  if (!projectPath || !normalizedRef) {
    return {
      sourcePath: null,
      format: null,
      policy: null,
      loadError: null,
    };
  }

  for (const candidate of REVIEW_POLICY_FILE_CANDIDATES) {
    const content = await gitService.getFileAtRef(projectPath, normalizedRef, candidate.path);
    if (content == null) continue;

    if (candidate.format !== 'json') {
      return {
        sourcePath: candidate.path,
        format: candidate.format,
        policy: null,
        loadError: {
          code: 'unsupported_format',
          message: `Unsupported review policy format at ${candidate.path}; JSON is required for the current slice.`,
        },
      };
    }

    try {
      return {
        sourcePath: candidate.path,
        format: candidate.format,
        policy: normalizeRepoPolicyDocument(JSON.parse(content)),
        loadError: null,
      };
    } catch (error) {
      return {
        sourcePath: candidate.path,
        format: candidate.format,
        policy: null,
        loadError: {
          code: 'invalid_json',
          message: normalizeText(error?.message || 'Failed to parse review policy JSON.', 240),
        },
      };
    }
  }

  return {
    sourcePath: null,
    format: null,
    policy: null,
    loadError: null,
  };
}

async function loadWorkingTreeReviewPolicy(projectPath) {
  if (!projectPath) {
    return {
      sourcePath: null,
      format: null,
      policy: null,
      loadError: null,
    };
  }

  for (const candidate of REVIEW_POLICY_FILE_CANDIDATES) {
    const filePath = path.join(projectPath, candidate.path);
    let content = null;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    if (candidate.format !== 'json') {
      return {
        sourcePath: candidate.path,
        format: candidate.format,
        policy: null,
        loadError: {
          code: 'unsupported_format',
          message: `Unsupported review policy format at ${candidate.path}; JSON is required for the current slice.`,
        },
      };
    }

    try {
      return {
        sourcePath: candidate.path,
        format: candidate.format,
        policy: normalizeRepoPolicyDocument(JSON.parse(content)),
        loadError: null,
      };
    } catch (error) {
      return {
        sourcePath: candidate.path,
        format: candidate.format,
        policy: null,
        loadError: {
          code: 'invalid_json',
          message: normalizeText(error?.message || 'Failed to parse review policy JSON.', 240),
        },
      };
    }
  }

  return {
    sourcePath: null,
    format: null,
    policy: null,
    loadError: null,
  };
}

function matchGlob(glob, filePath) {
  const normalizedGlob = normalizeText(glob, 240);
  const normalizedPath = normalizeText(filePath, 400);
  if (!normalizedGlob || !normalizedPath) return false;
  const escaped = normalizedGlob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`).test(normalizedPath);
}

function applyReviewPolicyToReviewProfile(reviewProfile = null, reviewPolicy = null, options = {}) {
  if (!reviewProfile || typeof reviewProfile !== 'object') return reviewProfile;
  const pathRules = Array.isArray(reviewPolicy?.paths) ? reviewPolicy.paths.filter((rule) => rule?.fileClass) : [];

  // Structural-file demotion: two policy knobs can promote `structural` to
  // `skip` so the diff hunks never enter the prompt. Both run AFTER the
  // path-rule pass, so a repo can still pin a specific glob to deep/structural.
  //
  //   - skipAllStructuralFiles (default off): demote every structural file
  //     regardless of review size. Wins outright when set.
  //   - largeReviewStructuralSkip (default on): demote only when totalFiles
  //     crosses LARGE_REVIEW_STRUCTURAL_SKIP_THRESHOLD.
  const totalFiles = Math.max(0, Math.trunc(Number(options?.totalFiles) || 0));
  const skipAllStructuralFiles = reviewPolicy?.defaults?.skipAllStructuralFiles === true;
  const largeReviewStructuralSkip = reviewPolicy?.defaults?.largeReviewStructuralSkip !== false;
  const largeDemoteApplies = largeReviewStructuralSkip
    && totalFiles >= LARGE_REVIEW_STRUCTURAL_SKIP_THRESHOLD;
  const shouldDemoteStructural = skipAllStructuralFiles || largeDemoteApplies;

  if (pathRules.length === 0 && !shouldDemoteStructural) return reviewProfile;

  const baseClassifyEntry = typeof reviewProfile.classifyEntry === 'function'
    ? reviewProfile.classifyEntry.bind(reviewProfile)
    : (() => ({
        fileClass: 'deep',
        reason: 'policy_default',
        pairWithSiblingMeta: false,
        riskBoost: 0,
        sizeMultiplier: 1,
      }));

  return {
    ...reviewProfile,
    classifyEntry(entry, context = {}) {
      const classified = baseClassifyEntry(entry, context) || {};
      const matchingRule = pathRules.find((rule) => matchGlob(rule.glob, entry?.path || ''));
      const afterPathRule = matchingRule
        ? {
            ...classified,
            fileClass: matchingRule.fileClass || classified.fileClass,
            reason: `policy_override:${matchingRule.glob}`,
          }
        : classified;
      if (shouldDemoteStructural && afterPathRule.fileClass === 'structural') {
        return {
          ...afterPathRule,
          fileClass: 'skip',
          reason: skipAllStructuralFiles
            ? 'skip_all_structural_files'
            : `large_review_structural_skip:${totalFiles}>=${LARGE_REVIEW_STRUCTURAL_SKIP_THRESHOLD}`,
        };
      }
      return afterPathRule;
    },
  };
}

function buildReviewPolicyStats(reviewPolicy = null) {
  if (!reviewPolicy || typeof reviewPolicy !== 'object') return {};
  return {
    reviewPolicy: {
      version: Math.max(1, Math.trunc(Number(reviewPolicy.version) || 1)),
      hash: normalizeText(reviewPolicy.hash, 80) || null,
      policySource: normalizeReviewPolicySource(reviewPolicy.provenance?.policySource, 'trusted'),
      sourcePath: normalizeText(reviewPolicy.provenance?.sourcePath, 240) || null,
      trustedRef: normalizeText(reviewPolicy.provenance?.trustedRef, 240) || null,
      trustedRefSource: normalizeText(reviewPolicy.provenance?.trustedRefSource, 80) || null,
      loadError: reviewPolicy.provenance?.loadError || null,
      layersApplied: normalizeStringList(reviewPolicy.provenance?.layersApplied, 8, 80),
      defaults: {
        requireEvidence: reviewPolicy.defaults?.requireEvidence !== false,
        allowPraise: reviewPolicy.defaults?.allowPraise === true,
        maxRecommendations: Number.isFinite(Number(reviewPolicy.defaults?.maxRecommendations))
          ? Math.max(1, Math.trunc(Number(reviewPolicy.defaults.maxRecommendations)))
          : null,
        largeReviewStructuralSkip: reviewPolicy.defaults?.largeReviewStructuralSkip !== false,
        skipAllStructuralFiles: reviewPolicy.defaults?.skipAllStructuralFiles === true,
      },
      promptAppendApplied: normalizePromptAppendList(reviewPolicy.promptAppend).length > 0,
      pathRuleCount: Array.isArray(reviewPolicy.paths) ? reviewPolicy.paths.length : 0,
      mustCheckRuleCount: Array.isArray(reviewPolicy.rules?.mustCheckRules)
        ? reviewPolicy.rules.mustCheckRules.length
        : 0,
      suppressionRuleCount: Array.isArray(reviewPolicy.rules?.suppressionRules)
        ? reviewPolicy.rules.suppressionRules.length
        : 0,
      linters: normalizeLinterPolicy(reviewPolicy.linters),
    },
  };
}

async function resolveEffectiveReviewPolicy({
  projectPath = null,
  reviewType = 'branch_review',
  reviewProfile = null,
  baseBranch = null,
  baseSha = null,
  policySource = 'trusted',
  generatedProjectPolicy = null,
} = {}) {
  const atlasDefaults = buildAtlasDefaultPolicy();
  const profileDefaults = buildReviewProfilePolicyDefaults(reviewProfile);
  const normalizedPolicySource = normalizeReviewPolicySource(policySource, 'trusted');
  const trustedRefMeta = await resolveTrustedReviewPolicyRef({
    projectPath,
    reviewType,
    baseBranch,
    baseSha,
  });
  const repoPolicyMeta = normalizedPolicySource === 'working_tree'
    ? await loadWorkingTreeReviewPolicy(projectPath)
    : await loadTrustedRepoReviewPolicy(projectPath, trustedRefMeta.trustedRef);
  const effectivePolicy = mergeReviewPolicyLayers(
    atlasDefaults,
    profileDefaults,
    generatedProjectPolicy?.policy,
    repoPolicyMeta.policy
  );
  effectivePolicy.hash = hashStableValue({
    version: effectivePolicy.version,
    defaults: effectivePolicy.defaults,
    promptAppend: effectivePolicy.promptAppend,
    rules: effectivePolicy.rules,
    paths: effectivePolicy.paths,
    linters: effectivePolicy.linters,
  });
  effectivePolicy.provenance = {
    policySource: normalizedPolicySource,
    trustedRef: normalizedPolicySource === 'working_tree' ? null : trustedRefMeta.trustedRef,
    trustedRefSource: normalizedPolicySource === 'working_tree' ? 'working_tree' : trustedRefMeta.trustedRefSource,
    sourcePath: repoPolicyMeta.sourcePath,
    format: repoPolicyMeta.format,
    loadError: repoPolicyMeta.loadError || generatedProjectPolicy?.loadError || null,
    layersApplied: [
      'atlas_defaults',
      normalizeText(reviewProfile?.id, 80) ? 'review_profile_defaults' : null,
      generatedProjectPolicy?.policy ? 'generated_project_policy' : null,
      repoPolicyMeta.policy
        ? (normalizedPolicySource === 'working_tree' ? 'working_tree_policy_file' : 'repo_policy_file')
        : null,
    ].filter(Boolean),
  };
  if (!effectivePolicy.provenance.sourcePath && generatedProjectPolicy?.policy) {
    effectivePolicy.provenance.sourcePath = generatedProjectPolicy.sourcePath;
    effectivePolicy.provenance.format = generatedProjectPolicy.format;
  }
  return effectivePolicy;
}

export {
  GENERATED_PROJECT_REVIEW_POLICY_GENERATOR_VERSION,
  GENERATED_PROJECT_REVIEW_POLICY_SOURCE_PATH,
  REVIEW_POLICY_FILE_CANDIDATES,
  applyReviewPolicyToReviewProfile,
  buildAtlasDefaultPolicy,
  buildReviewPolicyStats,
  createGeneratedProjectReviewPolicyBaseline,
  createDefaultReviewPolicyDocument,
  ensureGeneratedProjectReviewPolicy,
  getDefaultReviewPolicyContent,
  matchGlob,
  mergeReviewPolicyLayers,
  parseReviewPolicyContent,
  parseStoredGeneratedProjectReviewPolicy,
  normalizeRepoPolicyDocument,
  normalizeReviewPolicySource,
  resolveEffectiveReviewPolicy,
  resolveTrustedReviewPolicyRef,
};

export default {
  GENERATED_PROJECT_REVIEW_POLICY_GENERATOR_VERSION,
  GENERATED_PROJECT_REVIEW_POLICY_SOURCE_PATH,
  REVIEW_POLICY_FILE_CANDIDATES,
  applyReviewPolicyToReviewProfile,
  buildAtlasDefaultPolicy,
  buildReviewPolicyStats,
  createGeneratedProjectReviewPolicyBaseline,
  createDefaultReviewPolicyDocument,
  ensureGeneratedProjectReviewPolicy,
  getDefaultReviewPolicyContent,
  matchGlob,
  mergeReviewPolicyLayers,
  parseReviewPolicyContent,
  parseStoredGeneratedProjectReviewPolicy,
  normalizeRepoPolicyDocument,
  normalizeReviewPolicySource,
  resolveEffectiveReviewPolicy,
  resolveTrustedReviewPolicyRef,
};
