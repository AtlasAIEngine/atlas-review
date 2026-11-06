/**
 * Atlas Hosting Service
 * Manages deployments to Atlas Hosting (Vercel-based)
 *
 * Features:
 * - Project creation and management via Vercel API
 * - Source snapshot from git archive
 * - Deployment with streaming logs
 * - Custom subdomain aliasing (*.atlasengine.dev)
 * - Quota enforcement (max deployments per day)
 * - Concurrency control via semaphore
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { query, getDbType } from '../db/connection.js';
import secretsService from './secretsService.js';
import gitService from './gitService.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Read Vercel credentials dynamically so tokens set after server start (e.g. via
// the desktop deployment-settings API) are picked up immediately.
function getVercelToken() { return process.env.VERCEL_TOKEN || null; }
function getVercelTeamId() { return process.env.VERCEL_TEAM_ID || null; }
const ATLAS_HOSTING_ROOT_DOMAIN = process.env.ATLAS_HOSTING_ROOT_DOMAIN || 'atlasengine.dev';
const PUBLISH_MAX_PER_DAY = parseInt(process.env.PUBLISH_MAX_PER_DAY || '20', 10);
const PUBLISH_CONCURRENCY = parseInt(process.env.PUBLISH_CONCURRENCY || '2', 10);
const MAX_SOURCE_SIZE_MB = parseInt(process.env.MAX_SOURCE_SIZE_MB || '100', 10);
const MAX_LOG_SIZE = 500 * 1024; // 500KB max logs

// SQL helper: NOW() equivalent for current database type
function sqlNow() { return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()'; }

// SQLite stores arrays as JSON strings; deserialize secrets_keys when reading
function deserializeSecretsKeys(row) {
  if (row && getDbType() === 'sqlite' && typeof row.secrets_keys === 'string') {
    try { row.secrets_keys = JSON.parse(row.secrets_keys); } catch { row.secrets_keys = []; }
  }
  return row;
}

// ============================================================================
// SIMPLE SEMAPHORE FOR CONCURRENCY CONTROL
// ============================================================================

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    await new Promise((resolve) => {
      this.queue.push(resolve);
    });
    this.current++;
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    }
  }
}

const deploySemaphore = new Semaphore(PUBLISH_CONCURRENCY);

// ============================================================================
// SERVICE FUNCTIONS
// ============================================================================

/**
 * Check if Atlas Hosting is configured
 * @returns {{ enabled: boolean, reason?: string }}
 */
function isConfigured() {
  if (!getVercelToken()) {
    return {
      enabled: false,
      reason: 'VERCEL_TOKEN environment variable not set',
    };
  }

  // Team ID is required in cloud mode but optional in desktop mode
  // (desktop users typically deploy to personal Vercel accounts)
  const isDesktop = process.env.ATLAS_DESKTOP_MODE === 'true';
  if (!isDesktop && !getVercelTeamId()) {
    return {
      enabled: false,
      reason: 'VERCEL_TEAM_ID environment variable not set',
    };
  }

  return { enabled: true };
}

/**
 * Generate a subdomain for a project
 * Format: <sanitized-name>-<shortId> (max 63 chars for DNS)
 *
 * @param {string} projectName - Project name
 * @param {string} projectId - Project UUID
 * @returns {string} - Subdomain
 */
function generateSubdomain(projectName, projectId) {
  // Sanitize project name: lowercase, alphanumeric + hyphens only
  let sanitized = (projectName || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')  // Replace invalid chars with hyphen
    .replace(/-+/g, '-')          // Collapse multiple hyphens
    .replace(/^-|-$/g, '');       // Remove leading/trailing hyphens

  // Guard against empty result (e.g., projectName was "!!!" or "---")
  if (!sanitized) {
    sanitized = 'project';
  }

  // Use first 6 chars of project ID
  const shortId = (projectId || 'unknown').substring(0, 6);

  // Combine with max length 63 (DNS limit)
  const combined = `${sanitized}-${shortId}`;

  if (combined.length <= 63) {
    return combined;
  }

  // Truncate name part if too long
  const maxNameLen = 63 - 1 - shortId.length; // -1 for hyphen
  return `${sanitized.substring(0, maxNameLen)}-${shortId}`;
}

/**
 * Create a source snapshot from git archive
 *
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Git commit hash to archive
 * @returns {Promise<string>} - Path to temp directory with source
 */
async function createSourceSnapshot(projectPath, commitHash) {
  const tmpDir = path.join(os.tmpdir(), `atlas-deploy-${Date.now()}-${Math.random().toString(36).substring(7)}`);

  await fs.mkdir(tmpDir, { recursive: true });

  return new Promise((resolve, reject) => {
    // Use git archive | tar to extract to temp dir
    const gitArchive = spawn('git', ['archive', commitHash], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const tar = spawn('tar', ['-x', '-C', tmpDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    gitArchive.stdout.pipe(tar.stdin);

    let stderr = '';
    gitArchive.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    tar.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitArchive.on('error', (err) => {
      reject(new Error(`Git archive failed: ${err.message}`));
    });

    tar.on('error', (err) => {
      reject(new Error(`Tar extraction failed: ${err.message}`));
    });

    tar.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Source snapshot failed: ${stderr}`));
        return;
      }

      // Check extracted size
      try {
        const size = await getDirSize(tmpDir);
        const sizeMB = size / (1024 * 1024);

        if (sizeMB > MAX_SOURCE_SIZE_MB) {
          await cleanupTempDir(tmpDir);
          reject(new Error(`Source size ${sizeMB.toFixed(1)}MB exceeds limit of ${MAX_SOURCE_SIZE_MB}MB`));
          return;
        }

        resolve(tmpDir);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Ensure vercel.json exists with proper configuration for the detected framework
 * Auto-generates config for common frameworks if missing
 *
 * @param {string} sourceDir - Path to the source directory
 * @param {Function} onLog - Callback for log streaming
 */
async function ensureVercelConfig(sourceDir, onLog) {
  const vercelJsonPath = path.join(sourceDir, 'vercel.json');

  // Check if vercel.json already exists
  try {
    await fs.access(vercelJsonPath);
    return; // Already exists, don't overwrite
  } catch {
    // File doesn't exist, continue to auto-generate
  }

  // Try to detect framework from package.json
  let framework = null;
  let buildCommand = 'npm run build';
  let outputDir = 'dist';

  try {
    const packageJsonPath = path.join(sourceDir, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    // Detect framework
    if (deps['next']) {
      framework = 'nextjs';
      outputDir = '.next';
    } else if (deps['vite']) {
      framework = 'vite';
      outputDir = 'dist';
    } else if (deps['react-scripts']) {
      framework = 'create-react-app';
      outputDir = 'build';
    } else if (deps['@remix-run/dev']) {
      framework = 'remix';
      outputDir = 'build';
    } else if (deps['astro']) {
      framework = 'astro';
      outputDir = 'dist';
    } else if (deps['nuxt']) {
      framework = 'nuxt';
      outputDir = '.output';
    } else if (deps['svelte'] || deps['@sveltejs/kit']) {
      framework = 'svelte';
      outputDir = 'build';
    }

    // Check for custom build script
    if (packageJson.scripts?.build) {
      buildCommand = 'npm run build';
    }
  } catch {
    // No package.json or invalid - try to use defaults
  }

  // Generate vercel.json for detected framework
  const vercelConfig = {
    buildCommand,
    outputDirectory: outputDir,
  };

  // Add framework hint if detected
  if (framework) {
    vercelConfig.framework = framework;
  }

  // Add SPA rewrites for frontend frameworks (not Next.js which handles routing itself)
  if (framework && !['nextjs', 'remix', 'nuxt'].includes(framework)) {
    vercelConfig.rewrites = [
      { source: '/(.*)', destination: '/index.html' }
    ];
  }

  // Write vercel.json
  await fs.writeFile(vercelJsonPath, JSON.stringify(vercelConfig, null, 2), 'utf8');

  if (onLog) {
    onLog(`Auto-generated vercel.json for ${framework || 'static'} project.\n`);
  }

  console.log(`Generated vercel.json for ${framework || 'unknown'} framework`);
}

/**
 * Get directory size recursively
 */
async function getDirSize(dirPath) {
  let totalSize = 0;
  const files = await fs.readdir(dirPath, { withFileTypes: true });

  for (const file of files) {
    const filePath = path.join(dirPath, file.name);
    if (file.isDirectory()) {
      totalSize += await getDirSize(filePath);
    } else {
      const stat = await fs.stat(filePath);
      totalSize += stat.size;
    }
  }

  return totalSize;
}

/**
 * Cleanup temp directory
 */
async function cleanupTempDir(tmpDir) {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`Failed to cleanup temp dir ${tmpDir}:`, err.message);
  }
}

/**
 * Check if project is within daily quota
 *
 * @param {string} projectId - Project UUID
 * @throws {Error} If quota exceeded
 */
async function checkQuota(projectId) {
  const dbType = getDbType();
  const dateExpr = dbType === 'sqlite'
    ? "datetime('now', '-1 day')"
    : "NOW() - INTERVAL '1 day'";
  const result = await query(
    `SELECT COUNT(*) as count
     FROM publish_attempts
     WHERE project_id = $1
       AND created_at >= ${dateExpr}
       AND status IN ('queued', 'running', 'succeeded')`,
    [projectId]
  );

  const count = parseInt(result.rows[0].count, 10);

  if (count >= PUBLISH_MAX_PER_DAY) {
    throw new Error(`Quota exceeded: ${count}/${PUBLISH_MAX_PER_DAY} deployments today. Try again tomorrow.`);
  }
}

/**
 * Ensure Vercel project exists, create if not
 * Also adds the custom domain to the project for *.atlasengine.dev routing
 *
 * @param {string} projectId - AtlasEngine project UUID
 * @param {string} projectName - Project name
 * @param {Function} onLog - Optional callback for log streaming
 * @returns {Promise<string>} - Vercel project ID
 */
async function ensureVercelProject(projectId, projectName, onLog = null) {
  // Check if project already has Vercel project ID
  const result = await query(
    `SELECT vercel_project_id, vercel_project_name FROM projects WHERE id = $1`,
    [projectId]
  );

  const project = result.rows[0];

  if (project && project.vercel_project_id) {
    // Project exists, but ensure custom domain is configured (cloud mode only)
    if (process.env.ATLAS_DESKTOP_MODE !== 'true') {
      const subdomain = generateSubdomain(projectName, projectId);
      await addDomainToProject(project.vercel_project_id, subdomain, onLog);
    }
    return project.vercel_project_id;
  }

  // Create new Vercel project
  const vercelName = generateSubdomain(projectName, projectId);

  console.log(`Creating Vercel project: ${vercelName}`);
  if (onLog) onLog(`Creating Vercel project: ${vercelName}...\n`);

  return new Promise((resolve, reject) => {
    const token = getVercelToken();
    const teamId = getVercelTeamId();
    const args = ['project', 'add', vercelName, '--token', token];
    if (teamId) args.push('--scope', teamId);

    const child = spawn('vercel', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VERCEL_TOKEN: token },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        // Check if project already exists (error message pattern)
        if (stderr.includes('already exists') || stdout.includes('already exists')) {
          console.log(`Vercel project ${vercelName} already exists, using existing`);
          if (onLog) onLog(`Vercel project ${vercelName} already exists.\n`);
        } else {
          reject(new Error(`Failed to create Vercel project: ${stderr}`));
          return;
        }
      }

      // Store Vercel project info in database
      // Note: We use the name as the ID since that's how Vercel CLI refers to it
      await query(
        `UPDATE projects
         SET vercel_project_id = $1, vercel_project_name = $2
         WHERE id = $3`,
        [vercelName, vercelName, projectId]
      );

      // Add custom domain to the project for *.atlasengine.dev routing (cloud mode only)
      if (process.env.ATLAS_DESKTOP_MODE !== 'true') {
        await addDomainToProject(vercelName, vercelName, onLog);
      }

      resolve(vercelName);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn vercel CLI: ${err.message}`));
    });
  });
}

/**
 * Run Vercel deployment
 *
 * @param {string} sourceDir - Path to source directory
 * @param {string} vercelProjectId - Vercel project ID
 * @param {Function} onLog - Callback for log streaming
 * @returns {Promise<{ deploymentUrl: string, deploymentId: string }>}
 */
async function runVercelDeploy(sourceDir, vercelProjectId, onLog) {
  return new Promise((resolve, reject) => {
    const token = getVercelToken();
    const teamId = getVercelTeamId();
    const args = [
      'deploy',
      '--prod',
      '--yes',
      '--token', token,
    ];
    if (teamId) args.push('--scope', teamId);
    args.push('--name', vercelProjectId);

    const child = spawn('vercel', args, {
      cwd: sourceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VERCEL_TOKEN: token },
    });

    let allOutput = '';
    let deploymentUrl = null;
    let deploymentId = null;
    let inspectUrl = null;

    const processOutput = (data, isStderr = false) => {
      const text = data.toString();
      allOutput += text;

      // Stream to callback
      if (onLog) {
        onLog(text);
      }

      // Strip ANSI escape codes for reliable matching
      const cleanText = text.replace(/\x1B\[[0-9;]*m/g, '');

      // Try to extract deployment URL
      // Vercel outputs URLs in various formats:
      // - https://project-xxx.vercel.app
      // - Production: https://xxx.vercel.app
      const urlMatch = cleanText.match(/https:\/\/[^\s]+\.vercel\.app/);
      if (urlMatch) {
        deploymentUrl = urlMatch[0];
      }

      const prodMatch = cleanText.match(/Production:\s*(https:\/\/[^\s]+)/);
      if (prodMatch) {
        deploymentUrl = prodMatch[1];
      }

      // Try to extract deployment ID from various sources:
      // 1. dpl_xxx format (rare in CLI output)
      // 2. Inspect URL: https://vercel.com/team/project/DEPLOYMENT_ID
      const dplMatch = cleanText.match(/dpl_[a-zA-Z0-9]+/);
      if (dplMatch) {
        deploymentId = dplMatch[0];
      }

      // Extract Inspect URL and deployment ID (most reliable source)
      const inspectMatch = cleanText.match(/Inspect:\s*(https:\/\/vercel\.com\/[^\/]+\/[^\/]+\/([a-zA-Z0-9]+))/);
      if (inspectMatch) {
        inspectUrl = inspectMatch[1];
        if (!deploymentId) {
          deploymentId = inspectMatch[2];
        }
      }
    };

    child.stdout.on('data', (data) => processOutput(data, false));
    child.stderr.on('data', (data) => processOutput(data, true));

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Vercel deployment failed with code ${code}`));
        return;
      }

      if (!deploymentUrl) {
        reject(new Error('Deployment completed but no URL found in output'));
        return;
      }

      resolve({
        deploymentUrl,
        deploymentId: deploymentId || 'unknown',
        inspectUrl: inspectUrl || null,
      });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn vercel CLI: ${err.message}`));
    });
  });
}

/**
 * Add custom domain to Vercel project via API
 * This is more reliable than `vercel alias set` as it adds the domain to the project's
 * domain settings, enabling automatic SSL certificate generation and routing.
 *
 * @param {string} vercelProjectId - Vercel project ID/name
 * @param {string} subdomain - Custom subdomain (without domain)
 * @param {Function} onLog - Callback for log streaming
 * @returns {Promise<string|null>} - Full domain URL or null if failed
 */
async function addDomainToProject(vercelProjectId, subdomain, onLog) {
  const fullDomain = `${subdomain}.${ATLAS_HOSTING_ROOT_DOMAIN}`;
  const token = getVercelToken();
  const teamId = getVercelTeamId();

  try {
    if (onLog) onLog(`Adding domain ${fullDomain} to project...\n`);

    const teamQuery = teamId ? `?teamId=${teamId}` : '';
    const response = await fetch(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(vercelProjectId)}/domains${teamQuery}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: fullDomain }),
      }
    );

    const data = await response.json();

    if (response.ok) {
      if (onLog) onLog(`Domain ${fullDomain} added successfully.\n`);
      return `https://${fullDomain}`;
    }

    // Handle specific error cases
    if (response.status === 409 || (data.error && data.error.code === 'domain_already_in_use')) {
      // Domain already exists on this project - that's fine
      if (onLog) onLog(`Domain ${fullDomain} already configured.\n`);
      return `https://${fullDomain}`;
    }

    // Log the error but don't fail the deployment
    console.warn(`Failed to add domain ${fullDomain}:`, data);
    if (onLog) {
      onLog(`Warning: Could not add custom domain (${data.error?.message || 'unknown error'}). Using Vercel URL.\n`);
    }
    return null;

  } catch (err) {
    console.warn(`Error adding domain ${fullDomain}:`, err.message);
    if (onLog) {
      onLog(`Warning: Failed to add custom domain. Using Vercel URL instead.\n`);
    }
    return null;
  }
}

/**
 * Set custom alias for deployment (legacy - kept for compatibility)
 * @deprecated Use addDomainToProject instead
 */
async function setAlias(deploymentUrl, subdomain, onLog) {
  // Now delegates to addDomainToProject for project-level domain configuration
  // Note: We don't need the deploymentUrl anymore since we're adding to the project
  const vercelProjectId = subdomain; // The subdomain IS the vercel project name
  return addDomainToProject(vercelProjectId, subdomain, onLog);
}

/**
 * Sync secrets to Vercel project as environment variables
 * Uses Vercel API to upsert environment variables for production
 *
 * @param {string} vercelProjectId - Vercel project ID/name
 * @param {Array<{key: string, value: string}>} secrets - Secrets to sync
 * @param {Function} onLog - Callback for log streaming
 * @returns {Promise<{synced: number, errors: string[], keys: string[]}>}
 */
async function syncSecretsToVercel(vercelProjectId, secrets, onLog = null) {
  const token = getVercelToken();
  const teamId = getVercelTeamId();
  if (!token) {
    return { synced: 0, errors: ['Vercel not configured'], keys: [] };
  }

  if (!secrets || secrets.length === 0) {
    if (onLog) onLog('No secrets to sync.\n');
    return { synced: 0, errors: [], keys: [] };
  }

  if (onLog) onLog(`Syncing ${secrets.length} environment variable${secrets.length !== 1 ? 's' : ''} to Vercel...\n`);

  const results = { synced: 0, errors: [], keys: [] };

  const teamQuery = teamId ? `?teamId=${teamId}` : '';
  for (const secret of secrets) {
    try {
      // First, try to get existing env var to see if we need to update
      const getResponse = await fetch(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(vercelProjectId)}/env${teamQuery}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );

      let existingEnvId = null;
      if (getResponse.ok) {
        const envData = await getResponse.json();
        const existing = envData.envs?.find(e => e.key === secret.key && e.target?.includes('production'));
        existingEnvId = existing?.id;
      }

      if (existingEnvId) {
        // Update existing env var
        const updateResponse = await fetch(
          `https://api.vercel.com/v9/projects/${encodeURIComponent(vercelProjectId)}/env/${existingEnvId}${teamQuery}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              value: secret.value,
              target: ['production'],
              type: 'encrypted',
            }),
          }
        );

        if (updateResponse.ok) {
          results.synced++;
          results.keys.push(secret.key);
        } else {
          const error = await updateResponse.json();
          results.errors.push(`${secret.key}: ${error.error?.message || 'Update failed'}`);
        }
      } else {
        // Create new env var
        const createResponse = await fetch(
          `https://api.vercel.com/v10/projects/${encodeURIComponent(vercelProjectId)}/env${teamQuery}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              key: secret.key,
              value: secret.value,
              target: ['production'],
              type: 'encrypted',
            }),
          }
        );

        if (createResponse.ok) {
          results.synced++;
          results.keys.push(secret.key);
        } else {
          const error = await createResponse.json();
          // Ignore "already exists" errors since we might have missed it in the check
          if (error.error?.code === 'ENV_ALREADY_EXISTS') {
            results.synced++;
            results.keys.push(secret.key);
          } else {
            results.errors.push(`${secret.key}: ${error.error?.message || 'Create failed'}`);
          }
        }
      }
    } catch (err) {
      results.errors.push(`${secret.key}: ${err.message}`);
    }
  }

  if (onLog) {
    if (results.synced > 0) {
      onLog(`Synced ${results.synced} environment variable${results.synced !== 1 ? 's' : ''}.\n`);
    }
    if (results.errors.length > 0) {
      onLog(`Warning: ${results.errors.length} sync error${results.errors.length !== 1 ? 's' : ''}: ${results.errors.join(', ')}\n`);
    }
  }

  return results;
}

/**
 * Main publish pipeline for Atlas Hosting
 *
 * @param {string} projectPath - Path to the project
 * @param {string} projectId - Project UUID
 * @param {string} projectName - Project name
 * @param {string} changesetId - ChangeSet ID
 * @param {string} commitHash - Git commit hash
 * @param {Function} onLog - Callback for log streaming
 * @returns {Promise<{ success: boolean, url: string, vercelUrl: string, deploymentId: string, secretsKeys: string[] }>}
 */
async function publishToAtlasHosting(projectPath, projectId, projectName, changesetId, commitHash, onLog) {
  const config = isConfigured();
  if (!config.enabled) {
    throw new Error(`Atlas Hosting not configured: ${config.reason}`);
  }

  let tmpDir = null;

  try {
    // Acquire semaphore
    await deploySemaphore.acquire();

    onLog('Starting Atlas Hosting deployment...\n');

    // Step 0: Ensure all project files are committed before archiving.
    // Changeset commits only include files Claude touched. Tool-generated
    // files (tsconfig.json, vite.config.ts, etc.) may be untracked.
    let effectiveCommitHash = commitHash;
    try {
      const status = await gitService.getStatus(projectPath);
      if (!status.isClean) {
        const fileCount = (status.notAdded?.length || 0) + (status.modified?.length || 0)
          + (status.created?.length || 0) + (status.deleted?.length || 0);
        onLog(`Found ${fileCount} uncommitted file(s), auto-committing for deploy...\n`);
        const result = await gitService.commitChanges(
          projectPath,
          'chore: include all project files for deployment'
        );
        if (result.commit) {
          effectiveCommitHash = result.commit;
          onLog(`Auto-committed: ${effectiveCommitHash.substring(0, 7)}\n`);
        }
      }
    } catch (err) {
      onLog(`Warning: Could not auto-commit uncommitted files: ${err.message}\n`);
      // Continue with original commitHash — archive may still work
    }

    // Step 1: Create source snapshot
    onLog(`Creating source snapshot from commit ${effectiveCommitHash.substring(0, 7)}...\n`);
    tmpDir = await createSourceSnapshot(projectPath, effectiveCommitHash);
    onLog('Source snapshot created.\n');

    // Step 1.5: Ensure vercel.json exists for proper deployment
    await ensureVercelConfig(tmpDir, onLog);
    onLog('\n');

    // Note: Quota check is done in the route handler before creating the attempt.
    // We skip it here to avoid double-counting the queued attempt.

    // Step 2: Ensure Vercel project exists and has custom domain configured
    onLog('Ensuring Vercel project exists...\n');
    const vercelProjectId = await ensureVercelProject(projectId, projectName, onLog);
    onLog(`Using Vercel project: ${vercelProjectId}\n\n`);

    // Step 2.5: Sync secrets to Vercel as environment variables
    const secrets = await secretsService.getSecretsForDeploy(projectId, 'production');
    const secretsResult = await syncSecretsToVercel(vercelProjectId, secrets, onLog);
    // Note: We don't fail on sync errors - user may have set vars manually in Vercel
    onLog('\n');

    // Step 3: Run Vercel deployment
    onLog('Deploying to Vercel...\n');
    onLog('-------------------------------------------\n');
    const { deploymentUrl, deploymentId, inspectUrl } = await runVercelDeploy(tmpDir, vercelProjectId, onLog);
    onLog('-------------------------------------------\n');
    onLog(`Deployment complete: ${deploymentUrl}\n\n`);

    // Step 4: Compute final URL
    // In desktop mode, use the Vercel deployment URL directly (no custom domain)
    // In cloud mode, use the custom *.atlasengine.dev domain
    const isDesktop = process.env.ATLAS_DESKTOP_MODE === 'true';
    let finalUrl;

    if (isDesktop) {
      finalUrl = deploymentUrl;
      onLog(`\nPublished successfully!\n`);
      onLog(`  URL: ${deploymentUrl}\n`);
    } else {
      const subdomain = generateSubdomain(projectName, projectId);
      const customDomainUrl = `https://${subdomain}.${ATLAS_HOSTING_ROOT_DOMAIN}`;
      finalUrl = customDomainUrl;
      onLog(`\nPublished successfully!\n`);
      onLog(`  Custom URL: ${customDomainUrl}\n`);
      onLog(`  Vercel URL: ${deploymentUrl}\n`);
    }

    return {
      success: true,
      url: finalUrl,
      vercelUrl: deploymentUrl,
      deploymentId,
      inspectUrl,
      secretsKeys: secretsResult.keys,
    };
  } finally {
    // Always release semaphore
    deploySemaphore.release();

    // Always cleanup temp directory
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  }
}

/**
 * Get recent publish attempts for a project
 *
 * @param {string} projectId - Project UUID
 * @param {number} limit - Max results (default 10)
 * @returns {Promise<Array>}
 */
async function getPublishHistory(projectId, limit = 10) {
  const result = await query(
    `SELECT id, changeset_id, commit_hash, status, deployment_url,
            started_at, finished_at, error_message, created_at
     FROM publish_attempts
     WHERE project_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [projectId, limit]
  );

  result.rows.forEach(deserializeSecretsKeys);
  return result.rows;
}

/**
 * Get a single publish attempt
 *
 * @param {string} attemptId - Publish attempt UUID
 * @returns {Promise<Object|null>}
 */
async function getPublishAttempt(attemptId) {
  const result = await query(
    `SELECT * FROM publish_attempts WHERE id = $1`,
    [attemptId]
  );

  return deserializeSecretsKeys(result.rows[0]) || null;
}

/**
 * Mark interrupted in-flight publish attempts as failed.
 * Publish workers run in-process, so app/server restarts can leave queued/running
 * rows stranded forever without a terminal status.
 *
 * @returns {Promise<number>} Number of recovered attempts
 */
async function markInterruptedAttemptsAsFailed() {
  const pendingResult = await query(
    `SELECT COUNT(*) AS cnt
     FROM publish_attempts
     WHERE status IN ('queued', 'running')`
  );
  const pendingCount = Number(pendingResult.rows?.[0]?.cnt || 0);
  if (pendingCount === 0) return 0;

  await query(
    `UPDATE publish_attempts
     SET status = 'failed',
         finished_at = COALESCE(finished_at, ${sqlNow()}),
         error_message = CASE
           WHEN error_message IS NULL OR trim(error_message) = ''
             THEN 'Deployment interrupted after app restart. Please publish again.'
           ELSE error_message
         END
     WHERE status IN ('queued', 'running')`
  );

  return pendingCount;
}

/**
 * Create a new publish attempt record
 *
 * @param {Object} params
 * @param {string} params.projectId - Project UUID
 * @param {string} params.changesetId - Changeset ID
 * @param {string} params.commitHash - Git commit hash
 * @param {string} params.vercelProjectId - Vercel project ID
 * @param {string[]} params.secretsKeys - Array of secret keys synced (optional)
 * @returns {Promise<Object>}
 */
async function createPublishAttempt({ projectId, changesetId, commitHash, vercelProjectId, secretsKeys = [] }) {
  const dbType = getDbType();
  if (dbType === 'sqlite') {
    // SQLite: generate ID manually, insert, then fetch
    const id = crypto.randomUUID();
    const secretsJson = JSON.stringify(secretsKeys);
    await query(
      `INSERT INTO publish_attempts (id, project_id, changeset_id, commit_hash, vercel_project_id, secrets_keys, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued')`,
      [id, projectId, changesetId, commitHash, vercelProjectId, secretsJson]
    );
    const result = await query('SELECT * FROM publish_attempts WHERE id = $1', [id]);
    return deserializeSecretsKeys(result.rows[0]);
  }

  const result = await query(
    `INSERT INTO publish_attempts (project_id, changeset_id, commit_hash, vercel_project_id, secrets_keys, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     RETURNING *`,
    [projectId, changesetId, commitHash, vercelProjectId, secretsKeys]
  );

  return result.rows[0];
}

/**
 * Update publish attempt status
 *
 * @param {string} attemptId - Publish attempt UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
async function updatePublishAttempt(attemptId, updates) {
  const setClause = [];
  const values = [];
  let paramIndex = 1;
  const dbType = getDbType();

  const allowedFields = ['status', 'started_at', 'finished_at', 'deployment_url', 'vercel_url', 'deployment_id', 'inspect_url', 'logs', 'error_message', 'secrets_keys'];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClause.push(`${key} = $${paramIndex}`);
      // SQLite can't bind arrays — serialize to JSON string
      values.push(dbType === 'sqlite' && Array.isArray(value) ? JSON.stringify(value) : value);
      paramIndex++;
    }
  }

  if (setClause.length === 0) {
    throw new Error('No valid fields to update');
  }

  values.push(attemptId);

  if (dbType === 'sqlite') {
    await query(
      `UPDATE publish_attempts
       SET ${setClause.join(', ')}
       WHERE id = $${paramIndex}`,
      values
    );
    const result = await query('SELECT * FROM publish_attempts WHERE id = $1', [attemptId]);
    return deserializeSecretsKeys(result.rows[0]);
  }

  const result = await query(
    `UPDATE publish_attempts
     SET ${setClause.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );

  return result.rows[0];
}

/**
 * Get deployments for multiple changesets
 *
 * @param {string} projectId - Project UUID
 * @param {string[]} changesetIds - Array of changeset IDs
 * @returns {Promise<Map<string, Object>>} - Map of changesetId to deployment info
 */
async function getDeploymentsForChangesets(projectId, changesetIds) {
  if (!changesetIds || changesetIds.length === 0) {
    return new Map();
  }

  const deploymentMap = new Map();
  const dbType = getDbType();

  try {
    if (dbType === 'sqlite') {
      // SQLite doesn't support DISTINCT ON / ANY($n), so fetch and reduce in JS
      const placeholders = changesetIds.map((_, index) => `$${index + 2}`).join(', ');
      const result = await query(
        `SELECT changeset_id, deployment_url, status, finished_at, error_message
         FROM publish_attempts
         WHERE project_id = $1 AND changeset_id IN (${placeholders})
         ORDER BY changeset_id,
                  CASE status WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
                  CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END, finished_at DESC`,
        [projectId, ...changesetIds]
      );

      for (const row of result.rows) {
        if (deploymentMap.has(row.changeset_id)) {
          continue;
        }
        deploymentMap.set(row.changeset_id, {
          url: row.deployment_url,
          status: row.status,
          deployedAt: row.finished_at,
          errorMessage: row.error_message,
        });
      }

      return deploymentMap;
    }

    // PostgreSQL: Get the latest deployment for each changeset (prefer succeeded, then most recent)
    const result = await query(
      `SELECT DISTINCT ON (changeset_id)
              changeset_id, deployment_url, status, finished_at, error_message
       FROM publish_attempts
       WHERE project_id = $1 AND changeset_id = ANY($2)
       ORDER BY changeset_id,
                CASE status WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
                finished_at DESC NULLS LAST`,
      [projectId, changesetIds]
    );

    for (const row of result.rows) {
      deploymentMap.set(row.changeset_id, {
        url: row.deployment_url,
        status: row.status,
        deployedAt: row.finished_at,
        errorMessage: row.error_message,
      });
    }

    return deploymentMap;
  } catch (error) {
    // In desktop mode, deployments table may not exist yet; treat as no deployments
    if (dbType === 'sqlite') {
      console.warn('Deployments lookup skipped (sqlite):', error.message);
      return deploymentMap;
    }
    throw error;
  }
}

/**
 * Get the latest successful deployment for a project
 *
 * @param {string} projectId - Project UUID
 * @returns {Promise<Object|null>} - Latest successful deployment or null
 */
async function getLatestSuccessfulDeployment(projectId) {
  const result = await query(
    `SELECT id, changeset_id, commit_hash, status, deployment_url,
            started_at, finished_at, created_at
     FROM publish_attempts
     WHERE project_id = $1 AND status = 'succeeded'
     ORDER BY finished_at DESC
     LIMIT 1`,
    [projectId]
  );

  return result.rows[0] || null;
}

/**
 * Update project's last deployment info
 *
 * @param {string} projectId - Project UUID
 * @param {string} deploymentUrl - Deployment URL
 * @returns {Promise<void>}
 */
async function updateProjectDeployment(projectId, deploymentUrl) {
  await query(
    `UPDATE projects
     SET last_deployment_url = $1, last_deployment_at = ${sqlNow()}
     WHERE id = $2`,
    [deploymentUrl, projectId]
  );
}

/**
 * Get the current production deployment pointer for a project
 *
 * @param {string} projectId - Project UUID
 * @returns {Promise<Object|null>} - Production pointer info or null
 */
async function getProductionPointer(projectId) {
  const result = await query(
    `SELECT production_deployment_id, production_commit_hash, production_changeset_id,
            production_url, production_updated_at
     FROM projects
     WHERE id = $1`,
    [projectId]
  );

  const row = result.rows[0];
  if (!row || !row.production_deployment_id) {
    return null;
  }

  return {
    deploymentId: row.production_deployment_id,
    commitHash: row.production_commit_hash,
    changesetId: row.production_changeset_id,
    url: row.production_url,
    updatedAt: row.production_updated_at,
  };
}

/**
 * Update the production deployment pointer for a project
 *
 * @param {string} projectId - Project UUID
 * @param {string} deploymentAttemptId - Publish attempt ID to set as production
 * @returns {Promise<void>}
 */
async function updateProductionPointer(projectId, deploymentAttemptId) {
  // Get the deployment attempt details
  const attempt = await getPublishAttempt(deploymentAttemptId);
  if (!attempt) {
    throw new Error('Deployment attempt not found');
  }

  if (attempt.status !== 'succeeded') {
    throw new Error('Can only set successful deployments as production');
  }

  // Update the production pointer
  await query(
    `UPDATE projects
     SET production_deployment_id = $1,
         production_commit_hash = $2,
         production_changeset_id = $3,
         production_url = $4,
         production_updated_at = ${sqlNow()}
     WHERE id = $5`,
    [
      deploymentAttemptId,
      attempt.commit_hash,
      attempt.changeset_id,
      attempt.deployment_url,
      projectId,
    ]
  );
}

/**
 * Remove custom domain from a Vercel project
 * This disables the production URL (*.atlasengine.dev) without deleting the project.
 * The app becomes inaccessible at that URL, but project history and deployments remain.
 *
 * @param {string} vercelProjectId - Vercel project ID/name
 * @param {string} subdomain - Subdomain to remove (without domain suffix)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function removeDomainFromProject(vercelProjectId, subdomain) {
  if (!vercelProjectId || !subdomain) {
    return { success: false, error: 'Missing project ID or subdomain' };
  }

  // Check if Vercel is configured
  const token = getVercelToken();
  const teamId = getVercelTeamId();
  if (!token) {
    return { success: false, error: 'Vercel not configured' };
  }

  const fullDomain = `${subdomain}.${ATLAS_HOSTING_ROOT_DOMAIN}`;
  const teamQuery = teamId ? `?teamId=${teamId}` : '';

  try {
    const response = await fetch(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(vercelProjectId)}/domains/${encodeURIComponent(fullDomain)}${teamQuery}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      }
    );

    if (response.ok) {
      console.log(`✅ Removed domain ${fullDomain} from project ${vercelProjectId}`);
      return { success: true };
    }

    // Handle specific error cases
    if (response.status === 404) {
      // Domain doesn't exist - that's fine
      console.log(`ℹ️ Domain ${fullDomain} not found on project (already removed)`);
      return { success: true };
    }

    const data = await response.json();
    console.warn(`Failed to remove domain ${fullDomain}:`, data);
    return { success: false, error: data.error?.message || 'Unknown error' };

  } catch (err) {
    console.error(`Error removing domain ${fullDomain}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Promote a previous deployment to production
 * Re-points the production alias to an older deployment's vercel_url
 * This is effectively a "rollback" operation - no rebuild needed
 *
 * @param {string} projectId - AtlasEngine project UUID
 * @param {string} deploymentAttemptId - The publish attempt ID to promote
 * @param {Function} onLog - Optional callback for log streaming
 * @returns {Promise<{ success: boolean, production: Object }>}
 */
async function promoteDeployment(projectId, deploymentAttemptId, onLog = null) {
  // Get the deployment attempt details
  const attempt = await getPublishAttempt(deploymentAttemptId);
  if (!attempt) {
    throw new Error('Deployment not found');
  }

  if (attempt.project_id !== projectId) {
    throw new Error('Deployment does not belong to this project');
  }

  if (attempt.status !== 'succeeded') {
    throw new Error('Can only promote successful deployments');
  }

  if (!attempt.vercel_url) {
    throw new Error('Deployment has no Vercel URL - cannot promote');
  }

  // Get project details for subdomain generation
  const projectResult = await query(
    `SELECT name, vercel_project_id FROM projects WHERE id = $1`,
    [projectId]
  );

  if (!projectResult.rows[0]) {
    throw new Error('Project not found');
  }

  const project = projectResult.rows[0];
  const subdomain = generateSubdomain(project.name, projectId);
  const fullDomain = `${subdomain}.${ATLAS_HOSTING_ROOT_DOMAIN}`;

  if (onLog) onLog(`Promoting deployment to production...\n`);
  if (onLog) onLog(`Target URL: ${attempt.vercel_url}\n`);
  if (onLog) onLog(`Production domain: ${fullDomain}\n\n`);

  // Use Vercel CLI to set alias - this points the custom domain to the old deployment
  // `vercel alias set <deployment_url> <custom_domain>`
  return new Promise((resolve, reject) => {
    const token = getVercelToken();
    const teamId = getVercelTeamId();
    const args = [
      'alias', 'set',
      attempt.vercel_url,
      fullDomain,
      '--token', token,
    ];
    if (teamId) args.push('--scope', teamId);

    if (onLog) onLog(`Running: vercel alias set ${attempt.vercel_url} ${fullDomain}\n`);

    const child = spawn('vercel', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VERCEL_TOKEN: token },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (onLog) onLog(text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (onLog) onLog(text);
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        // Check if it's a "certificate pending" warning - this is expected for first-time aliases
        if (stderr.includes('Certificate') || stdout.includes('Certificate')) {
          if (onLog) onLog(`\nNote: SSL certificate is being provisioned. Site may take a few minutes to be fully accessible.\n`);
        } else {
          reject(new Error(`Failed to set alias: ${stderr || stdout}`));
          return;
        }
      }

      try {
        // Update the production pointer in database
        await query(
          `UPDATE projects
           SET production_deployment_id = $1,
               production_commit_hash = $2,
               production_changeset_id = $3,
               production_url = $4,
               production_updated_at = ${sqlNow()}
           WHERE id = $5`,
          [
            deploymentAttemptId,
            attempt.commit_hash,
            attempt.changeset_id,
            attempt.deployment_url,
            projectId,
          ]
        );

        if (onLog) onLog(`\nPromotion complete!\n`);
        if (onLog) onLog(`Production URL: https://${fullDomain}\n`);

        // Return the new production pointer
        const production = await getProductionPointer(projectId);
        resolve({
          success: true,
          production,
        });
      } catch (dbError) {
        reject(new Error(`Alias set succeeded but database update failed: ${dbError.message}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn vercel CLI: ${err.message}`));
    });
  });
}

/**
 * Delete a Vercel project (nuclear option)
 * Permanently deletes the project, all deployments, and domain configurations.
 * This action is irreversible.
 *
 * @param {string} vercelProjectId - Vercel project ID/name to delete
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteVercelProject(vercelProjectId) {
  if (!vercelProjectId) {
    return { success: true }; // Nothing to delete
  }

  // Check if Vercel is configured
  const token = getVercelToken();
  const teamId = getVercelTeamId();
  if (!token) {
    console.warn('⚠️ Vercel not configured, skipping project cleanup');
    return { success: true };
  }

  // Use Vercel API directly instead of CLI to avoid interactive prompts
  const teamQuery = teamId ? `?teamId=${teamId}` : '';
  try {
    const response = await fetch(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(vercelProjectId)}${teamQuery}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      }
    );

    if (response.ok || response.status === 204) {
      console.log(`✅ Deleted Vercel project: ${vercelProjectId}`);
      return { success: true };
    }

    // Handle specific error cases
    if (response.status === 404) {
      // Project doesn't exist - that's fine (already deleted)
      console.log(`ℹ️ Vercel project ${vercelProjectId} not found (already deleted)`);
      return { success: true };
    }

    const data = await response.json().catch(() => ({}));
    const errorMsg = data.error?.message || `HTTP ${response.status}`;
    console.warn(`⚠️ Failed to delete Vercel project ${vercelProjectId}: ${errorMsg}`);
    return { success: false, error: errorMsg };

  } catch (err) {
    console.warn(`⚠️ Vercel project delete error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Configuration
  isConfigured,
  generateSubdomain,

  // Core functions
  createSourceSnapshot,
  checkQuota,
  ensureVercelProject,
  runVercelDeploy,
  addDomainToProject,
  removeDomainFromProject,
  setAlias, // Deprecated, use addDomainToProject
  syncSecretsToVercel,
  publishToAtlasHosting,
  deleteVercelProject,
  promoteDeployment,

  // Database operations
  getPublishHistory,
  getPublishAttempt,
  markInterruptedAttemptsAsFailed,
  getLatestSuccessfulDeployment,
  getDeploymentsForChangesets,
  createPublishAttempt,
  updatePublishAttempt,
  updateProjectDeployment,
  getProductionPointer,
  updateProductionPointer,

  // Constants for testing
  MAX_SOURCE_SIZE_MB,
  PUBLISH_MAX_PER_DAY,
  PUBLISH_CONCURRENCY,
};

// Also export for ES module usage
export {
  isConfigured,
  generateSubdomain,
  createSourceSnapshot,
  checkQuota,
  ensureVercelProject,
  runVercelDeploy,
  addDomainToProject,
  removeDomainFromProject,
  setAlias, // Deprecated, use addDomainToProject
  syncSecretsToVercel,
  publishToAtlasHosting,
  deleteVercelProject,
  promoteDeployment,
  getPublishHistory,
  getPublishAttempt,
  markInterruptedAttemptsAsFailed,
  getLatestSuccessfulDeployment,
  getDeploymentsForChangesets,
  createPublishAttempt,
  updatePublishAttempt,
  updateProjectDeployment,
  getProductionPointer,
  updateProductionPointer,
};
