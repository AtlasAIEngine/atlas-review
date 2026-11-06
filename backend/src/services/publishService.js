/**
 * Publish Service
 * Manages publish gates and deployment for projects
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import db from '../db/connection.js';
import changesetService from './changesetService.js';
import projectVerificationService from './projectVerificationService.js';
import verificationService from './verificationService.js';
import gitService from './gitService.js';
import integrationsService from './integrationsService.js';
import secretsService from './secretsService.js';
import databaseService from './databaseService.js';
import supabaseService from './supabaseService.js';

const execAsync = promisify(exec);

/**
 * Get the latest applied or committed changeset for a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object|null>} - Latest changeset or null if none found
 */
async function getLatestAppliedChangeset(projectPath) {
  const changesets = await changesetService.getChangeSets(projectPath);

  // Find the most recent changeset with status 'applied', 'verified', or 'committed'
  const latestApplied = changesets.find(
    cs => cs.status === 'applied' || cs.status === 'verified' || cs.status === 'committed'
  );

  if (!latestApplied) {
    return null;
  }

  // Get full changeset with verification data
  return changesetService.getChangeSet(projectPath, latestApplied.id);
}

/**
 * Get all eligible changesets for publishing (verified or committed)
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - Array of eligible changesets with summary info
 */
async function getEligibleChangesets(projectPath) {
  const changesets = await changesetService.getChangeSets(projectPath);

  // Filter to changesets that can be published/republished
  // - applied: can be published after committing
  // - committed: can be published
  // - verified: committed + passed checks, can be published
  // - published: can be republished (e.g., after domain changes or to redeploy)
  const eligible = changesets.filter(
    cs => cs.status === 'verified' || cs.status === 'committed' || cs.status === 'applied' || cs.status === 'published'
  );

  // Return summary info for each eligible changeset
  return eligible.map(cs => ({
    id: cs.id,
    displayId: cs.displayId || null,
    title: cs.title,
    commitMessage: cs.commitMessage || null,
    status: cs.status,
    createdAt: cs.createdAt,
    fileCount: cs.fileCount || 0,
    commitSha: cs.commitSha || null,
    verification: cs.verification || null,
  }));
}

/**
 * Check if a project can be published based on verification status and secrets
 * @param {string} projectPath - Path to the project
 * @param {string} projectId - Project UUID (optional, for secrets check)
 * @returns {Promise<{canPublish: boolean, reason?: string, changeset?: Object, availableChecks: {lint: boolean, unit: boolean, e2e: boolean}, secretsReady: boolean, missingSecrets: Array}>}
 */
async function checkPublishGate(projectPath, projectId = null) {
  const verifyConfig = await projectVerificationService.getProjectVerifyConfig(projectId, projectPath);
  const availableChecks = projectVerificationService.summarizeAvailableChecks(verifyConfig);
  const requireChecksResult = await db.query("SELECT value FROM settings WHERE id = 'require_checks_before_publish'");
  const checksRequired = !requireChecksResult.rows?.[0] || requireChecksResult.rows[0].value !== 'false';

  // Check secrets readiness if projectId is provided
  let secretsCheck = { ready: true, missingVars: [] };
  if (projectId) {
    secretsCheck = await checkSecretsReady(projectPath, projectId);
  }

  // Get latest applied changeset
  const changeset = await getLatestAppliedChangeset(projectPath);

  if (!changeset) {
    return {
      canPublish: false,
      reason: 'No applied changeset exists. Make changes first.',
      changeset: null,
      availableChecks,
      secretsReady: secretsCheck.ready,
      missingSecrets: secretsCheck.missingVars,
    };
  }

  const gate = projectVerificationService.evaluateVerificationGate(verifyConfig, changeset.verification || null);
  const hasAnyChecks = gate.enabledChecks.length > 0;

  if (!checksRequired) {
    const canPublish = secretsCheck.ready;
    return {
      canPublish,
      reason: canPublish ? 'Verification checks optional for publish.' : 'Missing required environment variables.',
      changeset,
      availableChecks,
      secretsReady: secretsCheck.ready,
      missingSecrets: secretsCheck.missingVars,
    };
  }

  // If no checks are available, check secrets only
  if (!hasAnyChecks) {
    const canPublish = secretsCheck.ready;
    return {
      canPublish,
      reason: canPublish ? 'No verification checks configured.' : 'Missing required environment variables.',
      changeset,
      availableChecks,
      secretsReady: secretsCheck.ready,
      missingSecrets: secretsCheck.missingVars,
    };
  }

  const notRunChecks = gate.notRunChecks;
  if (notRunChecks.length > 0) {
    const checkNames = notRunChecks.map((check) => check.label || check.id).join(', ');
    return {
      canPublish: false,
      reason: `Run all checks first (${checkNames} not run)`,
      changeset,
      availableChecks,
      secretsReady: secretsCheck.ready,
      missingSecrets: secretsCheck.missingVars,
    };
  }

  // Check for any failed checks
  const failedChecks = gate.failedChecks;
  if (failedChecks.length > 0) {
    const checkNames = failedChecks.map((check) => check.label || check.id).join(', ');
    return {
      canPublish: false,
      reason: `Fix failing checks (${checkNames})`,
      changeset,
      availableChecks,
      secretsReady: secretsCheck.ready,
      missingSecrets: secretsCheck.missingVars,
    };
  }

  // All configured checks passed - now check secrets
  const canPublish = secretsCheck.ready;
  return {
    canPublish,
    reason: canPublish ? 'All configured checks passed' : 'Missing required environment variables.',
    changeset,
    availableChecks,
    secretsReady: secretsCheck.ready,
    missingSecrets: secretsCheck.missingVars,
  };
}

/**
 * Detect the package manager used by a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<'pnpm'|'yarn'|'npm'>} - Detected package manager
 */
async function detectPackageManager(projectPath) {
  // Check for pnpm-lock.yaml
  try {
    await fs.access(path.join(projectPath, 'pnpm-lock.yaml'));
    return 'pnpm';
  } catch {
    // Not pnpm
  }

  // Check for yarn.lock
  try {
    await fs.access(path.join(projectPath, 'yarn.lock'));
    return 'yarn';
  } catch {
    // Not yarn
  }

  // Default to npm
  return 'npm';
}

/**
 * Generate deploy commands based on package manager
 * @param {'pnpm'|'yarn'|'npm'} packageManager - The package manager
 * @returns {{install: string, deploy: string}} - Commands for installing and deploying
 */
function getDeployCommands(packageManager) {
  switch (packageManager) {
    case 'pnpm':
      return {
        install: 'pnpm add -g vercel',
        deploy: 'pnpm dlx vercel --prod',
      };
    case 'yarn':
      return {
        install: 'yarn global add vercel',
        deploy: 'yarn dlx vercel --prod',
      };
    default:
      return {
        install: 'npm i -g vercel',
        deploy: 'npx vercel --prod',
      };
  }
}

/**
 * Detect available publish method for a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<{method: 'vercel'|'script'|'manual', command?: string, instructions?: string[], packageManager?: string, deployCommands?: {install: string, deploy: string}}>}
 */
async function detectPublishMethod(projectPath) {
  // Detect package manager first
  const packageManager = await detectPackageManager(projectPath);
  const deployCommands = getDeployCommands(packageManager);

  // Check for vercel CLI (only local binary, avoid npx network calls)
  let vercelInstalled = false;
  try {
    await execAsync('which vercel');
    vercelInstalled = true;
  } catch {
    // Vercel not in PATH - don't try npx as it can trigger network installs
  }

  // Check for vercel.json in project (indicates vercel project, can use npx at deploy time)
  let hasVercelConfig = false;
  try {
    await fs.access(path.join(projectPath, 'vercel.json'));
    hasVercelConfig = true;
  } catch {
    // No vercel.json
  }

  // Check for deploy script in package.json
  const packageJson = await verificationService.readPackageJson(projectPath);
  const hasDeployScript = packageJson?.scripts?.deploy !== undefined;

  // Priority: vercel installed > deploy script > vercel config (npx) > manual
  if (vercelInstalled) {
    return {
      method: 'vercel',
      command: 'vercel --prod --yes',
      packageManager,
    };
  }

  // If vercel.json exists but vercel not installed, prefer deploy script if available
  if (hasDeployScript) {
    return {
      method: 'script',
      command: packageManager === 'pnpm' ? 'pnpm run deploy' :
               packageManager === 'yarn' ? 'yarn deploy' :
               'npm run deploy',
      packageManager,
    };
  }

  // Fall back to npx vercel if config exists (will use npx at deploy time)
  if (hasVercelConfig) {
    return {
      method: 'vercel',
      command: 'vercel --prod --yes',
      packageManager,
    };
  }

  // Manual fallback with package-manager-specific commands
  return {
    method: 'manual',
    packageManager,
    deployCommands,
    hasDeployScript: false,
    instructions: [
      'No automated deploy method detected.',
      '',
      'Option 1: Install Vercel CLI',
      `  ${deployCommands.install}`,
      `  ${deployCommands.deploy}`,
      '',
      'Option 2: Add deploy script',
      '  Add "deploy" to scripts in package.json',
    ],
  };
}

/**
 * Run publish command for a project
 * @param {string} projectPath - Path to the project
 * @param {'vercel'|'script'|'manual'} method - Publish method to use
 * @returns {Promise<{success: boolean, logs: string, url?: string, error?: string}>}
 */
async function runPublish(projectPath, method) {
  // If manual, return instructions
  if (method === 'manual') {
    return {
      success: false,
      logs: '',
      error: 'Manual deployment required. No automated method available.',
    };
  }

  // Determine command based on method
  let command;
  let args;

  if (method === 'vercel') {
    command = 'npx';
    args = ['vercel', '--prod', '--yes'];
  } else if (method === 'script') {
    // Use the correct package manager for deploy script
    const packageManager = await detectPackageManager(projectPath);
    if (packageManager === 'pnpm') {
      command = 'pnpm';
      args = ['run', 'deploy'];
    } else if (packageManager === 'yarn') {
      command = 'yarn';
      args = ['deploy'];
    } else {
      command = 'npm';
      args = ['run', 'deploy'];
    }
  } else {
    return {
      success: false,
      logs: '',
      error: `Unknown publish method: ${method}`,
    };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(command, args, {
      cwd: projectPath,
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
      const logs = stdout + (stderr ? '\n' + stderr : '');

      // Try to extract deploy URL from logs (Vercel format)
      let url = null;
      const urlMatch = logs.match(/https:\/\/[^\s]+\.vercel\.app/);
      if (urlMatch) {
        url = urlMatch[0];
      }

      // Also check for Production URL format
      const prodUrlMatch = logs.match(/Production:\s+(https:\/\/[^\s]+)/);
      if (prodUrlMatch) {
        url = prodUrlMatch[1];
      }

      if (code === 0) {
        resolve({
          success: true,
          logs,
          url,
        });
      } else {
        resolve({
          success: false,
          logs,
          error: `Publish failed with exit code ${code}`,
        });
      }
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        logs: '',
        error: `Failed to run publish command: ${error.message}`,
      });
    });
  });
}

/**
 * Check if required secrets are configured for detected integrations
 * @param {string} projectPath - Path to the project
 * @param {string} projectId - Project UUID
 * @returns {Promise<{ready: boolean, missingVars: Array<{integration: string, key: string, docsUrl: string}>}>}
 */
async function checkSecretsReady(projectPath, projectId) {
  try {
    // Detect integrations from package.json
    const detectedIntegrations = await integrationsService.detectIntegrations(projectPath);

    if (detectedIntegrations.length === 0) {
      // No integrations detected, secrets are "ready" (nothing required)
      return { ready: true, missingVars: [] };
    }

    // Get configured secrets for this project
    const configuredSecrets = await secretsService.listSecrets(projectId, 'production');

    // Check for missing required variables
    const integrationChecks = integrationsService.checkMissingVars(detectedIntegrations, configuredSecrets);

    // Flatten missing vars from all integrations
    const missingVars = [];
    for (const check of integrationChecks) {
      for (const varInfo of check.requiredVars) {
        if (!varInfo.configured) {
          missingVars.push({
            integration: check.name,
            key: varInfo.key,
            docsUrl: check.docsUrl,
          });
        }
      }
    }

    return {
      ready: missingVars.length === 0,
      missingVars,
    };
  } catch (error) {
    console.error('Error checking secrets readiness:', error);
    // On error, don't block publishing - just warn
    return { ready: true, missingVars: [] };
  }
}

/**
 * Get preflight status for publishing (git repo status, working tree, commit status)
 * @param {string} projectPath - Path to the project
 * @param {Object|null} latestChangeset - The latest applied/committed changeset
 * @returns {Promise<{isGitRepo: boolean, workingTreeClean: boolean, changesetCommitted: boolean, changesetCommitSha: string|null}>}
 */
async function getPublishPreflight(projectPath, latestChangeset) {
  // Check if project is a git repo
  const isGitRepo = await gitService.isGitRepository(projectPath);

  if (!isGitRepo) {
    return {
      isGitRepo: false,
      workingTreeClean: true, // N/A when not a git repo
      changesetCommitted: false,
      changesetCommitSha: null,
    };
  }

  // Get working tree status
  // Exclude AtlasEngine internal files from "uncommitted changes" check:
  // - .atlas/ (changeset metadata)
  // - CLAUDE.md (memory file)
  // - .claude/ (Claude config)
  // - .planning/ (planning files)
  let workingTreeClean = true;
  try {
    const status = await gitService.getStatus(projectPath);

    // Filter out AtlasEngine system files from the modified/created/deleted lists
    const isSystemFile = (file) =>
      file.startsWith('.atlas/') ||
      file.startsWith('.atlas\\') ||
      file === 'CLAUDE.md' ||
      file.startsWith('.claude/') ||
      file.startsWith('.claude\\') ||
      file.startsWith('.planning/') ||
      file.startsWith('.planning\\');

    const isNotSystemFile = (file) => !isSystemFile(file);

    const relevantModified = status.modified.filter(isNotSystemFile);
    const relevantCreated = status.created.filter(isNotSystemFile);
    const relevantDeleted = status.deleted.filter(isNotSystemFile);
    const relevantStaged = status.staged.filter(isNotSystemFile);
    const relevantConflicted = status.conflicted.filter(isNotSystemFile);
    // Include renamed files (both from and to paths)
    const renamedPaths = (status.renamed || []).flatMap(r => [r.from, r.to]);
    const relevantRenamed = renamedPaths.filter(isNotSystemFile);
    // Include untracked files (new files not yet staged)
    const relevantNotAdded = (status.notAdded || []).filter(isNotSystemFile);

    // Working tree is clean if no relevant files are modified (excluding system files)
    workingTreeClean =
      relevantModified.length === 0 &&
      relevantCreated.length === 0 &&
      relevantDeleted.length === 0 &&
      relevantStaged.length === 0 &&
      relevantConflicted.length === 0 &&
      relevantRenamed.length === 0 &&
      relevantNotAdded.length === 0;
  } catch (error) {
    console.error('Error getting git status for preflight:', error);
    // Default to not clean if we can't determine
    workingTreeClean = false;
  }

  // Check if changeset is committed
  const changesetCommitted = latestChangeset?.commitSha ? true : false;
  const changesetCommitSha = latestChangeset?.commitSha || null;

  return {
    isGitRepo,
    workingTreeClean,
    changesetCommitted,
    changesetCommitSha,
  };
}

/**
 * Check if a project needs a production database and whether Supabase is provisioned
 * @param {string} projectPath - Path to the project
 * @param {string} projectId - Project UUID
 * @param {string} userId - User UUID (for Supabase connection check)
 * @returns {Promise<Object>} Database provisioning status
 */
async function checkDatabaseProvisioning(projectPath, projectId, userId) {
  try {
    // Read package.json to detect database need
    const packageJsonPath = path.join(projectPath, 'package.json');
    let packageJsonContent;
    try {
      packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    } catch {
      return { needsDatabase: false };
    }

    const dbNeed = databaseService.detectDatabaseNeed(packageJsonContent);

    // Also check for @supabase/supabase-js (not covered by databaseService)
    let needsDatabase = dbNeed.needsDatabase;
    let dbType = dbNeed.type || null;
    let dbPackage = dbNeed.package || null;

    if (!needsDatabase) {
      try {
        const pkg = JSON.parse(packageJsonContent);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps['@supabase/supabase-js']) {
          needsDatabase = true;
          dbType = 'supabase';
          dbPackage = '@supabase/supabase-js';
        }
      } catch {
        // Invalid package.json, skip
      }
    }

    if (!needsDatabase) {
      return { needsDatabase: false };
    }

    // Check Supabase connection status
    let supabaseConnected = false;
    try {
      const integration = await supabaseService.getIntegration(userId);
      supabaseConnected = !!integration;
    } catch {
      // Not connected
    }

    // Check if a Supabase project is linked
    let supabaseLinked = false;
    let supabaseProjectRef = null;
    let supabaseProjectName = null;
    try {
      const linked = await supabaseService.getLinkedProject(projectId);
      if (linked) {
        supabaseLinked = true;
        supabaseProjectRef = linked.supabase_project_ref;
        supabaseProjectName = linked.supabase_project_name;
      }
    } catch {
      // Not linked
    }

    return {
      needsDatabase,
      dbType,
      dbPackage,
      supabaseConnected,
      supabaseLinked,
      supabaseProjectRef,
      supabaseProjectName,
    };
  } catch (error) {
    console.error('Error checking database provisioning:', error);
    return { needsDatabase: false };
  }
}

export default {
  getLatestAppliedChangeset,
  getEligibleChangesets,
  checkPublishGate,
  checkSecretsReady,
  checkDatabaseProvisioning,
  detectPublishMethod,
  runPublish,
  getPublishPreflight,
};
