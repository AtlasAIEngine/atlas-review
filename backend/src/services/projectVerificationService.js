import db from '../db/connection.js';
import verificationService from './verificationService.js';

const VERIFY_CONFIG_VERSION = 2;
const VERIFY_CONFIG_PREFIX = 'verify_config:';
const AUTO_RUN_MODES = new Set(['never', 'on_changeset']);
const CHECK_KINDS = new Set(['lint', 'typecheck', 'build', 'unit', 'integration', 'e2e', 'custom']);
const LEGACY_KINDS = ['lint', 'unit', 'e2e'];
const CHECK_ORDER = ['lint', 'typecheck', 'build', 'unit', 'integration', 'e2e', 'custom'];

function verifyConfigKey(projectId) {
  return `${VERIFY_CONFIG_PREFIX}${projectId}`;
}

async function resolveProjectId(projectId, projectPath) {
  if (projectId) return projectId;
  if (!projectPath) return null;
  try {
    const result = await db.query(
      'SELECT id FROM projects WHERE path = $1 ORDER BY updated_at DESC, created_at DESC LIMIT 1',
      [projectPath]
    );
    const resolvedId = result.rows?.[0]?.id;
    return typeof resolvedId === 'string' && resolvedId.trim() ? resolvedId : null;
  } catch {
    return null;
  }
}

function normalizeAutoRun(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return AUTO_RUN_MODES.has(normalized) ? normalized : 'on_changeset';
}

function normalizeCheckId(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeCheckKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (CHECK_KINDS.has(normalized)) return normalized;
  return 'custom';
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function deriveEnabledKindFlags(checks) {
  const normalizedChecks = Array.isArray(checks) ? checks : [];
  return {
    lint: normalizedChecks.some((check) => check.kind === 'lint' && check.enabled !== false),
    unit: normalizedChecks.some((check) => check.kind === 'unit' && check.enabled !== false),
    e2e: normalizedChecks.some((check) => check.kind === 'e2e' && check.enabled !== false),
  };
}

function sortChecks(checks) {
  return [...checks].sort((a, b) => {
    const aIdx = CHECK_ORDER.indexOf(a.kind);
    const bIdx = CHECK_ORDER.indexOf(b.kind);
    if (aIdx !== bIdx) return aIdx - bIdx;
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
  });
}

function normalizeCheck(rawCheck, { index, detectedById }) {
  const fallbackId = `custom_${index + 1}`;
  const normalizedRawId = normalizeCheckId(rawCheck?.id, '');
  const detected = detectedById.get(normalizedRawId) || detectedById.get(String(rawCheck?.id || ''));
  const kind = normalizeCheckKind(rawCheck?.kind || detected?.kind || 'custom');
  const id = normalizeCheckId(rawCheck?.id, detected?.id || fallbackId);
  const label = normalizeOptionalString(rawCheck?.label) || detected?.label || `Check ${index + 1}`;
  const command = normalizeOptionalString(rawCheck?.command) || detected?.command || '';
  const workdir = normalizeOptionalString(rawCheck?.workdir) || detected?.workdir || '';

  return {
    id,
    label,
    kind,
    command,
    workdir,
    enabled: rawCheck?.enabled !== false,
    source: detected ? 'detected' : (normalizeOptionalString(rawCheck?.source) || 'custom'),
  };
}

function normalizeVerifyConfig(rawConfig, { detectedChecks = [], projectType = null } = {}) {
  const detectedById = new Map(detectedChecks.map((check) => [normalizeCheckId(check.id, check.id), { ...check }]));
  const checks = [];

  if (rawConfig && Array.isArray(rawConfig.checks)) {
    rawConfig.checks.forEach((check, index) => {
      const normalized = normalizeCheck(check, { index, detectedById });
      checks.push(normalized);
      detectedById.delete(normalized.id);
    });
  } else {
    const legacyFlags = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    detectedChecks.forEach((check, index) => {
      const isLegacyKind = LEGACY_KINDS.includes(check.kind);
      const enabledOverride = isLegacyKind && typeof legacyFlags[check.kind] === 'boolean'
        ? legacyFlags[check.kind]
        : check.enabled !== false;
      const normalizedLegacy = normalizeCheck({ ...check, enabled: enabledOverride }, { index, detectedById });
      checks.push(normalizedLegacy);
      detectedById.delete(normalizedLegacy.id);
    });
  }

  const extraDetected = Array.from(detectedById.values())
    .map((check, index) => normalizeCheck(check, { index: checks.length + index, detectedById: new Map() }));

  const mergedChecks = sortChecks([...checks, ...extraDetected]).filter((check) => check.command);
  const enabledFlags = deriveEnabledKindFlags(mergedChecks);

  return {
    version: VERIFY_CONFIG_VERSION,
    projectType,
    autoRun: normalizeAutoRun(rawConfig?.autoRun),
    checks: mergedChecks,
    ...enabledFlags,
  };
}

async function resolveStoredConfig(projectId) {
  const result = await db.query('SELECT value FROM settings WHERE id = $1', [verifyConfigKey(projectId)]);
  if (!result.rows?.[0]?.value) return null;
  try {
    return JSON.parse(result.rows[0].value);
  } catch {
    return null;
  }
}

async function saveProjectVerifyConfig(projectId, config) {
  const jsonValue = JSON.stringify(config);
  const dbType = db.getDbType ? db.getDbType() : 'postgres';
  if (dbType === 'sqlite') {
    await db.query(
      `INSERT INTO settings (id, value, updated_at) VALUES ($1, $2, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [verifyConfigKey(projectId), jsonValue]
    );
    return;
  }

  await db.query(
    `INSERT INTO settings (id, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [verifyConfigKey(projectId), jsonValue]
  );
}

function applyLegacyKindToggle(config, kind, enabled) {
  return {
    ...config,
    checks: config.checks.map((check) => (
      check.kind === kind
        ? { ...check, enabled }
        : check
    )),
  };
}

function mergeVerifyConfig(currentConfig, updates, detectedChecks = currentConfig.checks) {
  let nextConfig = { ...currentConfig };

  if (typeof updates.autoRun === 'string') {
    nextConfig.autoRun = normalizeAutoRun(updates.autoRun);
  }

  if (Array.isArray(updates.checks)) {
    nextConfig = normalizeVerifyConfig(
      { ...nextConfig, checks: updates.checks, autoRun: nextConfig.autoRun },
      { detectedChecks, projectType: currentConfig.projectType }
    );
  }

  for (const kind of LEGACY_KINDS) {
    if (typeof updates[kind] === 'boolean') {
      nextConfig = applyLegacyKindToggle(nextConfig, kind, updates[kind]);
    }
  }

  const enabledFlags = deriveEnabledKindFlags(nextConfig.checks);
  return {
    ...nextConfig,
    ...enabledFlags,
  };
}

async function getProjectVerifyConfig(projectId, projectPath) {
  const resolvedProjectId = await resolveProjectId(projectId, projectPath);
  const [projectInfo, detectedChecks, storedConfig] = await Promise.all([
    verificationService.detectProjectType(projectPath),
    verificationService.detectSuggestedChecks(projectPath),
    resolvedProjectId ? resolveStoredConfig(resolvedProjectId) : Promise.resolve(null),
  ]);

  return normalizeVerifyConfig(storedConfig, {
    detectedChecks,
    projectType: projectInfo?.type || null,
  });
}

async function updateProjectVerifyConfig(projectId, projectPath, updates) {
  const resolvedProjectId = await resolveProjectId(projectId, projectPath);
  if (!resolvedProjectId) {
    throw new Error('Project not found for verification config');
  }

  const [currentConfig, detectedChecks] = await Promise.all([
    getProjectVerifyConfig(resolvedProjectId, projectPath),
    verificationService.detectSuggestedChecks(projectPath),
  ]);
  const merged = mergeVerifyConfig(currentConfig, updates && typeof updates === 'object' ? updates : {}, detectedChecks);
  await saveProjectVerifyConfig(resolvedProjectId, merged);
  return merged;
}

function summarizeAvailableChecks(config) {
  const checks = Array.isArray(config?.checks) ? config.checks : [];
  return {
    lint: checks.some((check) => check.kind === 'lint'),
    unit: checks.some((check) => check.kind === 'unit'),
    e2e: checks.some((check) => check.kind === 'e2e'),
    hasChecks: checks.length > 0,
    checks,
    projectType: config?.projectType || null,
  };
}

function resolveRequestedChecks(config, requestedChecks) {
  const checks = Array.isArray(config?.checks) ? config.checks.filter((check) => check.enabled !== false) : [];
  if (!Array.isArray(requestedChecks) || requestedChecks.length === 0) {
    return checks;
  }

  const selected = [];
  const seen = new Set();
  for (const token of requestedChecks) {
    const normalizedToken = String(token || '').trim().toLowerCase();
    if (!normalizedToken) continue;
    const matches = checks.filter((check) => check.id === normalizedToken || check.kind === normalizedToken);
    for (const check of matches) {
      if (seen.has(check.id)) continue;
      seen.add(check.id);
      selected.push(check);
    }
  }
  return selected;
}

async function runProjectVerification(projectPath, config, requestedChecks) {
  const checksToRun = resolveRequestedChecks(config, requestedChecks);
  const results = {};

  for (const check of checksToRun) {
    try {
      results[check.id] = await verificationService.runConfiguredCheck(projectPath, check);
    } catch (error) {
      results[check.id] = {
        status: 'fail',
        exitCode: -1,
        logs: error.message,
        duration: 0,
        checkId: check.id,
        kind: check.kind,
        label: check.label,
      };
    }
  }

  return {
    checksToRun,
    results,
  };
}

function getVerificationStatusForCheck(verification, check) {
  const checkState = verification?.checks?.[check.id];
  if (checkState?.status) {
    return checkState.status;
  }

  if (LEGACY_KINDS.includes(check.kind) && verification?.[check.kind]) {
    return verification[check.kind];
  }

  return 'not_run';
}

function evaluateVerificationGate(config, verification) {
  const enabledChecks = Array.isArray(config?.checks)
    ? config.checks.filter((check) => check.enabled !== false)
    : [];

  const failedChecks = [];
  const notRunChecks = [];

  for (const check of enabledChecks) {
    const status = getVerificationStatusForCheck(verification, check);
    if (status === 'fail') {
      failedChecks.push(check);
    } else if (status !== 'pass') {
      notRunChecks.push(check);
    }
  }

  return {
    enabledChecks,
    failedChecks,
    notRunChecks,
  };
}

function shouldAutoRunVerification(config) {
  return normalizeAutoRun(config?.autoRun) === 'on_changeset';
}

export default {
  evaluateVerificationGate,
  getProjectVerifyConfig,
  runProjectVerification,
  shouldAutoRunVerification,
  summarizeAvailableChecks,
  updateProjectVerifyConfig,
};
