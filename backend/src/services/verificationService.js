/**
 * Verification Service
 * Detects available checks from package.json and runs lint/test/e2e commands
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

// Maximum log size to prevent storage bloat (50KB)
const MAX_LOG_SIZE = 50 * 1024;
const DEFAULT_FAIL_EXCERPT_MAX_CHARS = Math.max(
  80,
  Math.trunc(Number(process.env.ATLAS_REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_CHARS) || 180)
);
const DEFAULT_FAIL_EXCERPT_MAX_LINES = Math.max(
  1,
  Math.trunc(Number(process.env.ATLAS_REVIEW_PROMPT_CONTEXT_VERIFICATION_FAIL_EXCERPT_MAX_LINES) || 2)
);
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;
const FAIL_SIGNAL_RE = /\b(error|fail|failed|exception|cannot|unable|denied|timeout|timed out)\b/i;
const FAIL_EXCERPT_REDACTION_PATTERNS = Object.freeze([
  {
    regex: /\b(authorization)\s*:\s*bearer\s+[^\s]+/gi,
    replace: '$1: Bearer [REDACTED]',
  },
  {
    regex: /\bbearer\s+[a-z0-9._~+/=-]{12,}\b/gi,
    replace: 'Bearer [REDACTED]',
  },
  {
    regex: /\b(?:sk|rk|pk|ghp|gho|github_pat)_[a-z0-9_]+(?:-[a-z0-9_]+)*\b/gi,
    replace: '[REDACTED]',
  },
  {
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: '[REDACTED]',
  },
  {
    regex: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE_KEY)[A-Z0-9_]*)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s]+)/gi,
    replace: '$1=[REDACTED]',
  },
  {
    regex: /([a-z]+:\/\/[^/\s:@]+:)[^@/\s]+@/gi,
    replace: '$1[REDACTED]@',
  },
]);

function redactSensitiveFailExcerpt(text) {
  let redacted = String(text || '');
  for (const pattern of FAIL_EXCERPT_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern.regex, pattern.replace);
  }
  return redacted;
}

/**
 * Read and parse package.json from a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object|null>} Parsed package.json or null if not found
 */
async function readPackageJson(projectPath) {
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Check if a file exists at a given path
 * @param {string} filePath - Absolute file path
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the project type from config files
 * @param {string} projectPath - Path to the project
 * @returns {Promise<{type: string, configFile: string}|null>}
 */
async function detectProjectType(projectPath) {
  // Check in priority order
  const checks = [
    { type: 'node', file: 'package.json' },
    { type: 'rust', file: 'Cargo.toml' },
    { type: 'python', file: 'pyproject.toml' },
    { type: 'python', file: 'setup.py' },
    { type: 'go', file: 'go.mod' },
  ];

  for (const check of checks) {
    if (await fileExists(path.join(projectPath, check.file))) {
      return { type: check.type, configFile: check.file };
    }
  }
  return null;
}

async function detectPackageManager(projectPath) {
  const lockfiles = [
    { file: 'pnpm-lock.yaml', packageManager: 'pnpm' },
    { file: 'yarn.lock', packageManager: 'yarn' },
    { file: 'package-lock.json', packageManager: 'npm' },
  ];
  for (const entry of lockfiles) {
    if (await fileExists(path.join(projectPath, entry.file))) {
      return entry.packageManager;
    }
  }
  return 'npm';
}

function buildNodeScriptCommand(packageManager, scriptName) {
  if (!scriptName || typeof scriptName !== 'string') return '';
  if (packageManager === 'npm') {
    return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
  }
  if (packageManager === 'pnpm') {
    return scriptName === 'test' ? 'pnpm test' : `pnpm ${scriptName}`;
  }
  return scriptName === 'test' ? 'yarn test' : `yarn ${scriptName}`;
}

function buildNodeExecCommand(packageManager, executable, args = []) {
  const argList = Array.isArray(args) ? args.filter(Boolean) : [];
  if (packageManager === 'npm') {
    return ['npx', executable, ...argList].join(' ');
  }
  if (packageManager === 'pnpm') {
    return ['pnpm', 'exec', executable, ...argList].join(' ');
  }
  return ['yarn', executable, ...argList].join(' ');
}

function defaultCheckEnabled(kind) {
  return kind !== 'build' && kind !== 'e2e';
}

function createDetectedCheck({
  id,
  label,
  kind,
  command,
  workdir = '',
  enabled = defaultCheckEnabled(kind),
}) {
  return {
    id,
    label,
    kind,
    command,
    workdir,
    enabled,
    source: 'detected',
  };
}

async function detectSuggestedChecks(projectPath) {
  const projectInfo = await detectProjectType(projectPath);
  if (!projectInfo) {
    return [];
  }

  if (projectInfo.type === 'node') {
    const packageJson = await readPackageJson(projectPath);
    const scripts = (packageJson && packageJson.scripts) || {};
    const packageManager = await detectPackageManager(projectPath);
    const checks = [];

    if (scripts.lint) {
      checks.push(createDetectedCheck({
        id: 'lint',
        label: 'Lint',
        kind: 'lint',
        command: buildNodeScriptCommand(packageManager, 'lint'),
        enabled: true,
      }));
    }

    const typecheckScript = ['typecheck', 'check-types', 'types', 'tsc'].find((scriptName) => scriptName in scripts);
    if (typecheckScript) {
      checks.push(createDetectedCheck({
        id: 'typecheck',
        label: 'Type Check',
        kind: 'typecheck',
        command: buildNodeScriptCommand(packageManager, typecheckScript),
        enabled: true,
      }));
    } else {
      const hasTypescript = Boolean(
        packageJson?.dependencies?.typescript
        || packageJson?.devDependencies?.typescript
        || packageJson?.peerDependencies?.typescript
      );
      if (hasTypescript && await fileExists(path.join(projectPath, 'tsconfig.json'))) {
        checks.push(createDetectedCheck({
          id: 'typecheck',
          label: 'Type Check',
          kind: 'typecheck',
          command: buildNodeExecCommand(packageManager, 'tsc', ['--noEmit']),
          enabled: true,
        }));
      }
    }

    if (scripts.build) {
      checks.push(createDetectedCheck({
        id: 'build',
        label: 'Build',
        kind: 'build',
        command: buildNodeScriptCommand(packageManager, 'build'),
      }));
    }

    if (scripts.test) {
      checks.push(createDetectedCheck({
        id: 'unit',
        label: 'Unit Tests',
        kind: 'unit',
        command: buildNodeScriptCommand(packageManager, 'test'),
        enabled: true,
      }));
    }

    const e2eScript = ['test:e2e', 'e2e'].find((scriptName) => scriptName in scripts);
    if (e2eScript) {
      checks.push(createDetectedCheck({
        id: 'e2e',
        label: 'E2E Tests',
        kind: 'e2e',
        command: buildNodeScriptCommand(packageManager, e2eScript),
      }));
    }

    return checks;
  }

  if (projectInfo.type === 'rust') {
    return [
      createDetectedCheck({ id: 'lint', label: 'Lint', kind: 'lint', command: 'cargo clippy --all-targets --all-features', enabled: true }),
      createDetectedCheck({ id: 'unit', label: 'Unit Tests', kind: 'unit', command: 'cargo test', enabled: true }),
      createDetectedCheck({ id: 'build', label: 'Build', kind: 'build', command: 'cargo build' }),
    ];
  }

  if (projectInfo.type === 'python') {
    let pyprojectContent = '';
    try {
      pyprojectContent = await fs.readFile(path.join(projectPath, 'pyproject.toml'), 'utf-8');
    } catch {
      pyprojectContent = '';
    }

    const checks = [];
    if (/\bruff\b/i.test(pyprojectContent)) {
      checks.push(createDetectedCheck({ id: 'lint', label: 'Lint', kind: 'lint', command: 'ruff check .', enabled: true }));
    } else if (/\bflake8\b/i.test(pyprojectContent)) {
      checks.push(createDetectedCheck({ id: 'lint', label: 'Lint', kind: 'lint', command: 'flake8 .', enabled: true }));
    } else if (/\bpylint\b/i.test(pyprojectContent)) {
      checks.push(createDetectedCheck({ id: 'lint', label: 'Lint', kind: 'lint', command: 'pylint .', enabled: true }));
    }

    if (/\bmypy\b/i.test(pyprojectContent)) {
      checks.push(createDetectedCheck({ id: 'typecheck', label: 'Type Check', kind: 'typecheck', command: 'python -m mypy .', enabled: true }));
    } else if (/\bpyright\b/i.test(pyprojectContent)) {
      checks.push(createDetectedCheck({ id: 'typecheck', label: 'Type Check', kind: 'typecheck', command: 'python -m pyright', enabled: true }));
    }

    if (/\bpytest\b/i.test(pyprojectContent)) {
      checks.push(createDetectedCheck({ id: 'unit', label: 'Unit Tests', kind: 'unit', command: 'python -m pytest', enabled: true }));
    }

    if (/\[build-system\]/i.test(pyprojectContent)) {
      checks.push(createDetectedCheck({ id: 'build', label: 'Build', kind: 'build', command: 'python -m build' }));
    }

    return checks;
  }

  if (projectInfo.type === 'go') {
    const checks = [
      createDetectedCheck({ id: 'unit', label: 'Unit Tests', kind: 'unit', command: 'go test ./...', enabled: true }),
      createDetectedCheck({ id: 'build', label: 'Build', kind: 'build', command: 'go build ./...' }),
    ];
    if (
      await fileExists(path.join(projectPath, '.golangci.yml'))
      || await fileExists(path.join(projectPath, '.golangci.yaml'))
    ) {
      checks.unshift(createDetectedCheck({ id: 'lint', label: 'Lint', kind: 'lint', command: 'golangci-lint run', enabled: true }));
    }
    return checks;
  }

  return [];
}

/**
 * Detect available verification checks from project config files.
 * Supports: package.json (Node), Cargo.toml (Rust), pyproject.toml (Python)
 *
 * @param {string} projectPath - Path to the project
 * @returns {Promise<{lint: boolean, unit: boolean, e2e: boolean, projectType: string|null}>} Available checks
 */
async function detectAvailableChecks(projectPath) {
  const projectInfo = await detectProjectType(projectPath);
  const checks = await detectSuggestedChecks(projectPath);
  return {
    lint: checks.some((check) => check.kind === 'lint'),
    unit: checks.some((check) => check.kind === 'unit'),
    e2e: checks.some((check) => check.kind === 'e2e'),
    projectType: projectInfo?.type || null,
  };
}

function normalizeCheckFlags(checks = {}) {
  return {
    lint: checks?.lint === true,
    unit: checks?.unit === true,
    e2e: checks?.e2e === true,
  };
}

const VALID_VERIFICATION_STATUSES = new Set(['pass', 'fail', 'not_run']);

function normalizeVerificationStatusValue(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (VALID_VERIFICATION_STATUSES.has(normalized)) return normalized;
  return 'not_run';
}

function buildFailExcerptFromLog(logs, maxChars) {
  const normalizedMaxChars = Math.max(60, Math.trunc(Number(maxChars) || DEFAULT_FAIL_EXCERPT_MAX_CHARS));
  const text = String(logs || '')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\r/g, '\n');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const candidate = lines.find((line) => FAIL_SIGNAL_RE.test(line)) || lines[0];
  const compact = candidate.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const redacted = redactSensitiveFailExcerpt(compact).trim();
  if (!redacted) return null;
  if (redacted.length <= normalizedMaxChars) return redacted;
  return `${redacted.slice(0, Math.max(1, normalizedMaxChars - 3)).trimEnd()}...`;
}

function buildFailExcerptLines(statusSource = {}, {
  maxFailExcerptChars = DEFAULT_FAIL_EXCERPT_MAX_CHARS,
  maxFailExcerptLines = DEFAULT_FAIL_EXCERPT_MAX_LINES,
} = {}) {
  const normalizedMaxLines = Math.max(1, Math.trunc(Number(maxFailExcerptLines) || DEFAULT_FAIL_EXCERPT_MAX_LINES));
  const logs = statusSource.logs && typeof statusSource.logs === 'object'
    ? statusSource.logs
    : {};
  const lines = [];
  const expandedChecks = statusSource.checks && typeof statusSource.checks === 'object'
    ? Object.values(statusSource.checks).filter((check) => check && typeof check === 'object')
    : [];

  if (expandedChecks.length > 0) {
    for (const rawCheck of expandedChecks) {
      const check = rawCheck;
      if (normalizeVerificationStatusValue(check.status) !== 'fail') continue;
      const checkId = typeof check.id === 'string' && check.id.trim()
        ? check.id.trim()
        : (typeof check.kind === 'string' && check.kind.trim() ? check.kind.trim() : 'check');
      const excerpt = buildFailExcerptFromLog(logs[checkId], maxFailExcerptChars);
      if (!excerpt) continue;
      lines.push(`Fail excerpt (${checkId}): ${excerpt}`);
      if (lines.length >= normalizedMaxLines) break;
    }
    return lines;
  }

  for (const check of ['lint', 'unit', 'e2e']) {
    if (normalizeVerificationStatusValue(statusSource[check]) !== 'fail') continue;
    const excerpt = buildFailExcerptFromLog(logs[check], maxFailExcerptChars);
    if (!excerpt) continue;
    lines.push(`Fail excerpt (${check}): ${excerpt}`);
    if (lines.length >= normalizedMaxLines) break;
  }
  return lines;
}

function summarizeReviewVerificationStatus(verification = {}, options = {}) {
  const statusSource = verification && typeof verification === 'object'
    ? verification
    : {};
  const expandedChecks = statusSource.checks && typeof statusSource.checks === 'object'
    ? Object.values(statusSource.checks).filter((check) => check && typeof check === 'object')
    : [];
  const lint = normalizeVerificationStatusValue(statusSource.lint);
  const unit = normalizeVerificationStatusValue(statusSource.unit);
  const e2e = normalizeVerificationStatusValue(statusSource.e2e);
  const statusList = expandedChecks.length > 0
    ? expandedChecks.map((check) => normalizeVerificationStatusValue(check.status))
    : [lint, unit, e2e];
  const summaryLine = expandedChecks.length > 0
    ? `Checks: ${expandedChecks.map((check) => {
      const checkId = typeof check.id === 'string' && check.id.trim()
        ? check.id.trim()
        : (typeof check.kind === 'string' && check.kind.trim() ? check.kind.trim() : 'check');
      return `${checkId}=${normalizeVerificationStatusValue(check.status)}`;
    }).join(', ')}`
    : `Checks: lint=${lint}, unit=${unit}, e2e=${e2e}`;
  const anyFail = statusList.includes('fail');
  const allNotRun = statusList.every((status) => status === 'not_run');
  const allPass = statusList.every((status) => status === 'pass');
  const overallStatus = anyFail
    ? 'fail'
    : allNotRun
      ? 'not_run'
      : allPass
        ? 'pass'
        : 'partial';
  const lastRunAt = typeof statusSource.lastRunAt === 'string' && statusSource.lastRunAt.trim()
    ? statusSource.lastRunAt.trim()
    : null;
  const lines = allNotRun
    ? ['Verification checks not run yet.']
    : [summaryLine];
  if (!allNotRun) {
    lines.push(`Overall status: ${overallStatus}`);
  }
  if (lastRunAt) {
    lines.push(`Last run: ${lastRunAt}`);
  }
  const failExcerptLines = buildFailExcerptLines(statusSource, options);
  if (failExcerptLines.length > 0) {
    lines.push(...failExcerptLines);
  }

  return {
    lint,
    unit,
    e2e,
    overallStatus,
    lastRunAt,
    failExcerptLines,
    lines,
  };
}

async function getReviewProjectMetadata(projectPath) {
  const [projectInfo, checks] = await Promise.all([
    detectProjectType(projectPath),
    detectAvailableChecks(projectPath),
  ]);
  return {
    projectType: projectInfo?.type || checks?.projectType || null,
    configFile: projectInfo?.configFile || null,
    availableChecks: normalizeCheckFlags(checks),
  };
}

/**
 * Run a verification check
 * @param {string} projectPath - Path to the project
 * @param {'lint'|'unit'|'e2e'} checkType - Type of check to run
 * @returns {Promise<{status: 'pass'|'fail', exitCode: number, logs: string, duration: number}>}
 */
async function runCheck(projectPath, checkType) {
  const checks = await detectSuggestedChecks(projectPath);
  const match = checks.find((check) => check.id === checkType || check.kind === checkType);
  if (!match) {
    throw new Error(`Check "${checkType}" is not configured for this project`);
  }
  return runConfiguredCheck(projectPath, match);
}

/**
 * Run multiple verification checks sequentially
 * @param {string} projectPath - Path to the project
 * @param {Array<'lint'|'unit'|'e2e'>} checkTypes - Types of checks to run
 * @returns {Promise<Object>} Results for each check type
 */
async function runChecks(projectPath, checkTypes) {
  const results = {};

  for (const checkType of checkTypes) {
    try {
      results[checkType] = await runCheck(projectPath, checkType);
    } catch (error) {
      results[checkType] = {
        status: 'fail',
        exitCode: -1,
        logs: error.message,
        duration: 0,
      };
    }
  }

  return results;
}

function containsUnsupportedShellSyntax(command) {
  return /&&|\|\||[|<>`;\r\n]|\$\(/.test(command);
}

function tokenizeCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== '\'') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }

  if (quote) {
    throw new Error('Unterminated quote in check command');
  }

  if (current) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new Error('Check command is required');
  }

  return tokens;
}

function normalizeExecutableForPlatform(executable) {
  if (process.platform !== 'win32') {
    return executable;
  }

  const lower = executable.toLowerCase();
  if (!executable.includes('.') && ['npm', 'npx', 'pnpm', 'yarn'].includes(lower)) {
    return `${executable}.cmd`;
  }

  return executable;
}

function isWithinProjectRoot(projectPath, candidatePath) {
  const root = path.resolve(projectPath);
  const candidate = path.resolve(candidatePath);
  if (candidate === root) {
    return true;
  }

  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

async function runConfiguredCheck(projectPath, check) {
  if (!check?.command || typeof check.command !== 'string') {
    throw new Error('Check command is required');
  }

  const command = check.command.trim();
  if (!command) {
    throw new Error('Check command is required');
  }
  if (containsUnsupportedShellSyntax(command)) {
    throw new Error('Shell operators are not supported in verification commands');
  }

  const workdir = typeof check.workdir === 'string' && check.workdir.trim()
    ? path.resolve(projectPath, check.workdir.trim())
    : projectPath;
  if (!isWithinProjectRoot(projectPath, workdir)) {
    throw new Error('Check workdir must stay within the project root');
  }

  const [rawExecutable, ...args] = tokenizeCommand(command);
  const executable = normalizeExecutableForPlatform(rawExecutable);

  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(executable, args, {
      cwd: workdir,
      stdio: 'pipe',
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
      },
    });

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      let logs = '';
      if (stdout) logs += stdout;
      if (stderr) {
        if (logs) logs += '\n';
        logs += stderr;
      }
      if (logs.length > MAX_LOG_SIZE) {
        logs = logs.substring(0, MAX_LOG_SIZE) + '\n... [truncated]';
      }

      resolve({
        status: code === 0 ? 'pass' : 'fail',
        exitCode: code,
        logs,
        duration,
        checkId: check.id,
        kind: check.kind,
        label: check.label,
      });
    });

    child.on('error', (error) => {
      const duration = Date.now() - startTime;
      resolve({
        status: 'fail',
        exitCode: -1,
        logs: `Failed to run check: ${error.message}`,
        duration,
        checkId: check.id,
        kind: check.kind,
        label: check.label,
      });
    });
  });
}

export default {
  detectAvailableChecks,
  detectPackageManager,
  detectProjectType,
  detectSuggestedChecks,
  getReviewProjectMetadata,
  summarizeReviewVerificationStatus,
  runCheck,
  runConfiguredCheck,
  runChecks,
  readPackageJson,
};
