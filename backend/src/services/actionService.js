/**
 * Action Service
 *
 * Central registry for changeset actions: push, deploy, rollback, export, verify.
 * Each action follows a standard interface:
 *   execute(projectPath, changesetId, options) → ActionResult
 *
 * All executions are logged to the actions_log database table.
 */

import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import db from '../db/index.js';
import gitService from './gitService.js';
import changesetService from './changesetService.js';
import projectVerificationService from './projectVerificationService.js';
import atlasHostingService from './atlasHostingService.js';
import { getProjectStoragePath } from './atlasProjectStorageService.js';

// ============================================================================
// Action Result Type
// ============================================================================

/**
 * @typedef {Object} ActionResult
 * @property {boolean} success
 * @property {string} actionId - UUID from actions_log
 * @property {string} type - Action type
 * @property {Object} [data] - Action-specific output
 * @property {string} [error] - Error message if failed
 */

// ============================================================================
// Actions Log — Database Operations
// ============================================================================

async function createLogEntry(projectId, changesetId, actionType, input = {}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO actions_log (id, project_id, changeset_id, action_type, action_status, input, triggered_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, projectId, changesetId, actionType, 'running', JSON.stringify(input), now, now]
  );
  return id;
}

async function completeLogEntry(id, status, output = null, errorMessage = null) {
  const now = new Date().toISOString();
  await db.query(
    `UPDATE actions_log SET action_status = $1, output = $2, error_message = $3, completed_at = $4 WHERE id = $5`,
    [status, output ? JSON.stringify(output) : null, errorMessage, now, id]
  );
}

async function getActionsLog(projectId, { changesetId, actionType, limit = 50 } = {}) {
  let sql = 'SELECT * FROM actions_log WHERE project_id = $1';
  const params = [projectId];
  let idx = 2;

  if (changesetId) {
    sql += ` AND changeset_id = $${idx++}`;
    params.push(changesetId);
  }
  if (actionType) {
    sql += ` AND action_type = $${idx++}`;
    params.push(actionType);
  }

  sql += ` ORDER BY triggered_at DESC LIMIT $${idx}`;
  params.push(limit);

  const result = await db.query(sql, params);
  return result.rows.map(row => ({
    ...row,
    input: typeof row.input === 'string' ? JSON.parse(row.input) : row.input,
    output: typeof row.output === 'string' ? JSON.parse(row.output) : row.output,
  }));
}

// ============================================================================
// Action: Push (Approve & Push)
// ============================================================================

async function executePush(projectPath, changesetId, projectId, options = {}) {
  const actionId = await createLogEntry(projectId, changesetId, 'push', options);

  try {
    // Load changeset to verify it's committed
    const changeset = await changesetService.getChangeSet(projectPath, changesetId);
    if (!changeset) {
      throw new Error('Changeset not found');
    }
    if (!changeset.commitSha) {
      throw new Error('Changeset has no commit — commit before pushing');
    }

    // Pre-check: get git status
    const status = await gitService.getStatus(projectPath);
    const branch = options.branch || status.branch;

    if (status.conflicted && status.conflicted.length > 0) {
      throw new Error(`Merge conflicts detected in: ${status.conflicted.join(', ')}`);
    }

    // Check if remote exists
    const git = gitService.getGitInstance(projectPath);
    let remotes;
    try {
      remotes = await git.getRemotes(true);
    } catch {
      remotes = [];
    }

    const remote = options.remote || 'origin';
    const hasRemote = remotes.some(r => r.name === remote);
    if (!hasRemote) {
      throw new Error(`No remote '${remote}' configured. Add a remote first.`);
    }

    // Check for diverged branch (fetch first)
    try {
      await git.fetch(remote, branch);
    } catch {
      // Fetch may fail if remote branch doesn't exist yet — that's OK
    }

    // Push
    const pushResult = await gitService.push(projectPath, remote, branch, {
      setUpstream: true,
    });

    const output = {
      remote,
      branch,
      commitSha: changeset.commitSha,
      pushed: true,
    };

    await completeLogEntry(actionId, 'completed', output);

    return {
      success: true,
      actionId,
      type: 'push',
      data: output,
    };
  } catch (err) {
    await completeLogEntry(actionId, 'failed', null, err.message);
    return {
      success: false,
      actionId,
      type: 'push',
      error: err.message,
    };
  }
}

// ============================================================================
// Action: Deploy (Approve & Deploy)
// ============================================================================

async function executeDeploy(projectPath, changesetId, projectId, options = {}) {
  const actionId = await createLogEntry(projectId, changesetId, 'deploy', options);

  try {
    const changeset = await changesetService.getChangeSet(projectPath, changesetId);
    if (!changeset) {
      throw new Error('Changeset not found');
    }

    const commitHash = changeset.commitSha || await gitService.getCurrentSHA(projectPath);
    const projectName = options.projectName || path.basename(projectPath);

    const logs = [];
    const onLog = (msg) => logs.push(msg);

    // Delegate to existing atlasHostingService
    const result = await atlasHostingService.publishToAtlasHosting(
      projectPath,
      projectId,
      projectName,
      changesetId,
      commitHash,
      onLog,
    );

    // Update changeset status to published
    if (result && result.deployment_url) {
      await changesetService.updateChangeSetStatus(projectPath, changesetId, 'published', {
        publishedUrl: result.deployment_url,
      });
    }

    const output = {
      deploymentUrl: result?.deployment_url || null,
      vercelUrl: result?.vercel_url || null,
      deploymentId: result?.deployment_id || null,
      logs,
    };

    await completeLogEntry(actionId, 'completed', output);

    return {
      success: true,
      actionId,
      type: 'deploy',
      data: output,
    };
  } catch (err) {
    await completeLogEntry(actionId, 'failed', null, err.message);
    return {
      success: false,
      actionId,
      type: 'deploy',
      error: err.message,
    };
  }
}

// ============================================================================
// Action: Rollback
// ============================================================================

async function executeRollback(projectPath, changesetId, projectId, options = {}) {
  const actionId = await createLogEntry(projectId, changesetId, 'rollback', options);

  try {
    const changeset = await changesetService.getChangeSet(projectPath, changesetId);
    if (!changeset) {
      throw new Error('Changeset not found');
    }
    if (!changeset.commitSha) {
      throw new Error('Changeset has no commit to revert');
    }

    const git = gitService.getGitInstance(projectPath);

    // git revert <sha> --no-edit
    try {
      await git.revert(changeset.commitSha, ['--no-edit']);
    } catch (revertErr) {
      // Check for conflicts
      const status = await gitService.getStatus(projectPath);
      if (status.conflicted && status.conflicted.length > 0) {
        // Abort the revert so we don't leave a dirty state
        try { await git.raw(['revert', '--abort']); } catch { /* ignore */ }
        throw new Error(`Revert conflicts in: ${status.conflicted.join(', ')}. Revert aborted.`);
      }
      throw revertErr;
    }

    // Get the revert commit SHA
    const revertSha = await gitService.getCurrentSHA(projectPath);

    // Create a revert changeset (source: 'manual')
    const revertChangeset = await changesetService.createChangeSet(projectPath, {
      title: `Rollback — reverts ${changeset.displayId || changesetId}`,
      summary: `Reverts commit ${changeset.commitSha.slice(0, 7)} from "${changeset.title}"`,
      source: 'manual',
      files: [],
    });

    // Mark revert changeset as committed
    await changesetService.updateChangeSetCommit(
      projectPath, revertChangeset.id, revertSha, `Revert "${changeset.title}"`
    );
    await changesetService.updateChangeSetStatus(projectPath, revertChangeset.id, 'committed');

    // Mark original changeset as reverted
    await changesetService.updateChangeSetStatus(projectPath, changesetId, 'reverted');

    // Auto-push if the original was already pushed
    let autoPushed = false;
    if (options.autoPush) {
      try {
        const status = await gitService.getStatus(projectPath);
        await gitService.push(projectPath, 'origin', status.branch);
        autoPushed = true;
      } catch {
        // Push failed — not critical, user can push manually
      }
    }

    const output = {
      revertSha,
      revertChangesetId: revertChangeset.id,
      revertDisplayId: revertChangeset.displayId,
      originalCommitSha: changeset.commitSha,
      autoPushed,
    };

    await completeLogEntry(actionId, 'completed', output);

    return {
      success: true,
      actionId,
      type: 'rollback',
      data: output,
    };
  } catch (err) {
    await completeLogEntry(actionId, 'failed', null, err.message);
    return {
      success: false,
      actionId,
      type: 'rollback',
      error: err.message,
    };
  }
}

// ============================================================================
// Action: Export Bundle
// ============================================================================

async function executeExport(projectPath, changesetId, projectId, options = {}) {
  const actionId = await createLogEntry(projectId, changesetId, 'export', options);

  try {
    const changeset = await changesetService.getChangeSet(projectPath, changesetId);
    if (!changeset) {
      throw new Error('Changeset not found');
    }

    // Build bundle contents
    const metadata = {
      changesetId: changeset.id,
      displayId: changeset.displayId,
      title: changeset.title,
      summary: changeset.summary,
      source: changeset.source,
      status: changeset.status,
      commitSha: changeset.commitSha,
      commitMessage: changeset.commitMessage,
      createdAt: changeset.createdAt,
      riskFlags: changeset.riskFlags,
      verification: changeset.verification,
      exportedAt: new Date().toISOString(),
    };

    const review = changeset.reviewData || null;

    // Generate unified diff patch
    let diffPatch = '';
    if (changeset.files && changeset.files.length > 0) {
      for (const file of changeset.files) {
        diffPatch += `--- a/${file.path}\n+++ b/${file.path}\n`;
        const beforeLines = (file.before || '').split('\n');
        const afterLines = (file.after || '').split('\n');
        for (const line of beforeLines) {
          diffPatch += `-${line}\n`;
        }
        for (const line of afterLines) {
          diffPatch += `+${line}\n`;
        }
        diffPatch += '\n';
      }
    }

    // Write zip to temp file
    const tempDir = getProjectStoragePath(projectPath, 'exports');
    await fs.mkdir(tempDir, { recursive: true });
    const zipName = `${changeset.displayId || changeset.id}-bundle.zip`;
    const zipPath = path.join(tempDir, zipName);

    await new Promise((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);
      archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });
      if (review) {
        archive.append(JSON.stringify(review, null, 2), { name: 'review.json' });
      }
      if (diffPatch) {
        archive.append(diffPatch, { name: 'diff.patch' });
      }
      archive.finalize();
    });

    const stat = await fs.stat(zipPath);

    const outputData = {
      zipPath,
      zipName,
      sizeBytes: stat.size,
      files: ['metadata.json', review ? 'review.json' : null, diffPatch ? 'diff.patch' : null].filter(Boolean),
    };

    await completeLogEntry(actionId, 'completed', outputData);

    return {
      success: true,
      actionId,
      type: 'export',
      data: outputData,
    };
  } catch (err) {
    await completeLogEntry(actionId, 'failed', null, err.message);
    return {
      success: false,
      actionId,
      type: 'export',
      error: err.message,
    };
  }
}

// ============================================================================
// Action: Verify
// ============================================================================

async function executeVerify(projectPath, changesetId, projectId, options = {}) {
  const actionId = await createLogEntry(projectId, changesetId, 'verify', options);

  try {
    const changeset = await changesetService.getChangeSet(projectPath, changesetId);
    if (!changeset) {
      throw new Error('Changeset not found');
    }

    const verifyConfig = await projectVerificationService.getProjectVerifyConfig(projectId, projectPath);
    const { checksToRun, results } = await projectVerificationService.runProjectVerification(
      projectPath,
      verifyConfig,
      options.checks
    );

    if (checksToRun.length === 0) {
      const output = { checks: [], message: 'No checks available for this project' };
      await completeLogEntry(actionId, 'completed', output);
      return { success: true, actionId, type: 'verify', data: output };
    }

    // Update changeset verification for each check
    for (const check of checksToRun) {
      const result = results[check.id];
      await changesetService.updateChangeSetVerification(
        projectPath,
        changesetId,
        check.id,
        result.status,
        result.logs,
        {
          kind: check.kind,
          label: check.label,
          command: check.command,
          duration: result.duration,
          exitCode: result.exitCode,
        }
      );
    }

    // Check if all passed
    const allPassed = Object.values(results).every(r => r.status === 'pass');
    if (allPassed) {
      await changesetService.updateChangeSetStatus(projectPath, changesetId, 'verified');
    }

    const output = {
      checks: checksToRun.map((check) => check.id),
      results,
      allPassed,
    };

    await completeLogEntry(actionId, 'completed', output);

    return {
      success: true,
      actionId,
      type: 'verify',
      data: output,
    };
  } catch (err) {
    await completeLogEntry(actionId, 'failed', null, err.message);
    return {
      success: false,
      actionId,
      type: 'verify',
      error: err.message,
    };
  }
}

// ============================================================================
// Action Registry
// ============================================================================

const ACTION_TYPES = new Set(['push', 'deploy', 'rollback', 'export', 'verify']);

const actionHandlers = {
  push: executePush,
  deploy: executeDeploy,
  rollback: executeRollback,
  export: executeExport,
  verify: executeVerify,
};

/**
 * Execute a named action against a changeset.
 *
 * @param {string} actionType - One of: push, deploy, rollback, export, verify
 * @param {string} projectPath - Absolute path to the project
 * @param {string} changesetId - Changeset ID
 * @param {string} projectId - Project ID (for DB logging)
 * @param {Object} options - Action-specific options
 * @returns {Promise<ActionResult>}
 */
async function execute(actionType, projectPath, changesetId, projectId, options = {}) {
  if (!ACTION_TYPES.has(actionType)) {
    return {
      success: false,
      actionId: null,
      type: actionType,
      error: `Unknown action type: ${actionType}. Valid: ${[...ACTION_TYPES].join(', ')}`,
    };
  }

  return actionHandlers[actionType](projectPath, changesetId, projectId, options);
}

export default {
  execute,
  executePush,
  executeDeploy,
  executeRollback,
  executeExport,
  executeVerify,
  getActionsLog,
  ACTION_TYPES: [...ACTION_TYPES],
};
