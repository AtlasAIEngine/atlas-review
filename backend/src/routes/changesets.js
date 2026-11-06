/**
 * ChangeSet Routes
 * API endpoints for listing, viewing, reverting, and committing changesets
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getProjectById } from '../db/queries.js';
import db from '../db/connection.js';
import changesetService from '../services/changesetService.js';
import gitService from '../services/gitService.js';
import projectVerificationService from '../services/projectVerificationService.js';
import publishService from '../services/publishService.js';
import atlasHostingService from '../services/atlasHostingService.js';
import actionService from '../services/actionService.js';
import { enforceQuotas } from '../middleware/quotas.js';
import { buildReviewLifecycle } from '../utils/reviewLifecycle.js';
import trustAnalyticsService from '../services/trustAnalyticsService.js';

const router = express.Router();

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// Helper function to check project ownership (supports anonymous access in MVP)
function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

function attachChangesetReviewLifecycle(changeset) {
  const status = changeset?.reviewStatus ?? changeset?.review_status ?? 'none';
  return {
    ...changeset,
    reviewLifecycle: buildReviewLifecycle({
      reviewStatus: status,
      sourceStatus: status,
      errorMessage: changeset?.reviewError || changeset?.review_error || null,
      reviewedAt: changeset?.reviewedAt || changeset?.reviewed_at || null,
      updatedAt: changeset?.updatedAt
        || changeset?.updated_at
        || changeset?.reviewedAt
        || changeset?.reviewed_at
        || changeset?.createdAt
        || changeset?.created_at
        || null,
    }),
  };
}

/**
 * GET /api/projects/:projectId/changesets
 * List all changesets for a project (index only, no file contents)
 */
router.get('/:projectId/changesets', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const changesets = await changesetService.getChangeSets(project.path);

    // Get deployment info for all changesets
    const changesetIds = changesets.map(cs => cs.id);
    const deploymentsMap = await atlasHostingService.getDeploymentsForChangesets(projectId, changesetIds);

    // Get the production changeset ID from the project
    const productionChangesetId = project.production_changeset_id || null;

    res.json({
      success: true,
      productionChangesetId,
      changesets: changesets.map(cs => attachChangesetReviewLifecycle({
        ...cs,
        projectId,
        deployment: deploymentsMap.get(cs.id) || null,
        isProduction: cs.id === productionChangesetId,
      })),
    });
  } catch (error) {
    console.error('Error listing changesets:', error);
    res.status(500).json({ error: 'Failed to list changesets' });
  }
});

/**
 * GET /api/projects/:projectId/changesets/:changesetId
 * Get a single changeset with full file contents
 */
router.get('/:projectId/changesets/:changesetId', enforceQuotas, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const changeset = await changesetService.getChangeSet(project.path, changesetId);

    if (!changeset) {
      return res.status(404).json({ error: 'Changeset not found' });
    }

    // If this changeset has a commit SHA, check for other changesets with same commit
    // This handles legacy multi-CS commits
    let alsoInChangesets = [];
    if (changeset.commitSha) {
      alsoInChangesets = await changesetService.getChangeSetsWithCommit(
        project.path,
        changeset.commitSha,
        changesetId
      );
    }

    const changesetWithLifecycle = attachChangesetReviewLifecycle({
      ...changeset,
      projectId,
      alsoInChangesets: alsoInChangesets.map(cs => ({
        id: cs.id,
        displayId: cs.displayId,
      })),
    });
    const trustAnalytics = await trustAnalyticsService.getChangesetTrustAnalytics({
      projectId,
      changeset: changesetWithLifecycle,
    });

    res.json({
      success: true,
      changeset: {
        ...changesetWithLifecycle,
        trustAnalytics,
      },
    });
  } catch (error) {
    console.error('Error getting changeset:', error);
    res.status(500).json({ error: 'Failed to get changeset' });
  }
});

/**
 * POST /api/projects/:projectId/changesets/:changesetId/revert
 * Revert a changeset by restoring files to their previous state
 */
router.post('/:projectId/changesets/:changesetId/revert', enforceQuotas, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await changesetService.revertChangeSet(project.path, changesetId);

    res.json({
      success: true,
      message: result.partialRevert
        ? 'Changeset partially reverted (some files failed)'
        : 'Changeset reverted successfully',
      revertedFiles: result.revertedFiles,
      errors: result.errors,
    });
  } catch (error) {
    console.error('Error reverting changeset:', error);

    // Handle specific error cases
    if (error.message === 'Changeset not found') {
      return res.status(404).json({ error: 'Changeset not found' });
    }

    if (error.message === 'Changeset is already reverted') {
      return res.status(400).json({ error: 'Changeset is already reverted' });
    }

    res.status(500).json({
      error: 'Failed to revert changeset',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/changesets/:changesetId/reapply
 * Reapply a reverted changeset by restoring files to their "after" state
 */
router.post('/:projectId/changesets/:changesetId/reapply', enforceQuotas, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await changesetService.reapplyChangeSet(project.path, changesetId);

    res.json({
      success: true,
      message: result.partialReapply
        ? 'Changeset partially reapplied (some files failed)'
        : 'Changeset reapplied successfully',
      reappliedFiles: result.reappliedFiles,
      errors: result.errors,
    });
  } catch (error) {
    console.error('Error reapplying changeset:', error);

    // Handle specific error cases
    if (error.message === 'Changeset not found') {
      return res.status(404).json({ error: 'Changeset not found' });
    }

    if (error.message === 'Only reverted changesets can be reapplied') {
      return res.status(400).json({ error: 'Only reverted changesets can be reapplied' });
    }

    res.status(500).json({
      error: 'Failed to reapply changeset',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/available-checks
 * Get available verification checks for a project
 */
router.get('/:projectId/available-checks', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const verifyConfig = await projectVerificationService.getProjectVerifyConfig(projectId, project.path);
    const checks = projectVerificationService.summarizeAvailableChecks(verifyConfig);

    res.json({
      success: true,
      ...checks,
    });
  } catch (error) {
    console.error('Error detecting available checks:', error);
    res.status(500).json({
      error: 'Failed to detect available checks',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/verify-config
 * Get per-project verification check configuration
 */
router.get('/:projectId/verify-config', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const verifyConfig = await projectVerificationService.getProjectVerifyConfig(projectId, project.path);
    res.json(verifyConfig);
  } catch (error) {
    console.error('Error getting verify config:', error);
    res.status(500).json({ error: 'Failed to get verify config' });
  }
});

/**
 * PUT /api/projects/:projectId/verify-config
 * Update per-project verification check configuration
 */
router.put('/:projectId/verify-config', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const updated = await projectVerificationService.updateProjectVerifyConfig(projectId, project.path, req.body);
    res.json(updated);
  } catch (error) {
    console.error('Error updating verify config:', error);
    res.status(500).json({ error: 'Failed to update verify config' });
  }
});

/**
 * POST /api/projects/:projectId/changesets/:changesetId/verify
 * Run verification checks on a changeset
 */
router.post('/:projectId/changesets/:changesetId/verify', enforceQuotas, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const { checks } = req.body;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Load changeset
    const changeset = await changesetService.getChangeSet(project.path, changesetId);
    if (!changeset) {
      return res.status(404).json({ error: 'Changeset not found' });
    }

    const requestedChecks = Array.isArray(checks) ? checks : undefined;
    const invalidChecks = Array.isArray(requestedChecks)
      ? requestedChecks.filter((entry) => typeof entry !== 'string' || !entry.trim())
      : [];
    if (invalidChecks.length > 0) {
      return res.status(400).json({
        error: 'Requested checks must be non-empty string identifiers',
      });
    }

    const verifyConfig = await projectVerificationService.getProjectVerifyConfig(projectId, project.path);
    if (Array.isArray(requestedChecks) && requestedChecks.length > 0) {
      const knownEnabledIdentifiers = new Set();
      for (const check of Array.isArray(verifyConfig?.checks) ? verifyConfig.checks : []) {
        if (check?.enabled === false) continue;
        if (typeof check?.id === 'string' && check.id.trim()) {
          knownEnabledIdentifiers.add(check.id.trim().toLowerCase());
        }
        if (typeof check?.kind === 'string' && check.kind.trim()) {
          knownEnabledIdentifiers.add(check.kind.trim().toLowerCase());
        }
      }

      const unknownChecks = requestedChecks.filter((entry) => !knownEnabledIdentifiers.has(entry.trim().toLowerCase()));
      if (unknownChecks.length > 0) {
        return res.status(400).json({
          error: `Unknown check identifiers: ${unknownChecks.join(', ')}`,
        });
      }
    }

    const { checksToRun, results } = await projectVerificationService.runProjectVerification(
      project.path,
      verifyConfig,
      requestedChecks
    );

    if (checksToRun.length === 0) {
      return res.json({
        success: true,
        message: 'No runnable checks found',
        verification: changeset.verification || {
          lint: 'not_run',
          unit: 'not_run',
          e2e: 'not_run',
          lastRunAt: null,
          logs: {},
          checks: {},
        },
        results: {},
      });
    }

    // Run checks sequentially and update changeset after each
    for (const check of checksToRun) {
      const result = results[check.id];
      await changesetService.updateChangeSetVerification(
        project.path,
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

    // Get updated changeset
    const updatedChangeset = await changesetService.getChangeSet(project.path, changesetId);

    const verification = updatedChangeset.verification || {};
    const gate = projectVerificationService.evaluateVerificationGate(verifyConfig, verification);
    const allAvailableChecksPassed = gate.enabledChecks.length > 0 && gate.failedChecks.length === 0 && gate.notRunChecks.length === 0;

    const hasAnyChecks = gate.enabledChecks.length > 0;

    const anyCheckFailed = gate.failedChecks.length > 0;

    if (allAvailableChecksPassed && hasAnyChecks && updatedChangeset.status === 'applied') {
      // Promote to verified when all checks pass
      await changesetService.updateChangeSetStatus(project.path, changesetId, 'verified');
      updatedChangeset.status = 'verified';

      // AUTO-COMMIT: Commit the changeset now that verification passed
      const isGitRepo = await gitService.isGitRepository(project.path);
      if (isGitRepo) {
        // Re-fetch changeset to check commitSha (race condition guard against parallel verification)
        const freshChangeset = await changesetService.getChangeSet(project.path, changesetId);
        if (freshChangeset && !freshChangeset.commitSha) {
          try {
            const commitMessage = freshChangeset.title || `Changeset ${changesetId}`;
            const filesToCommit = freshChangeset.files.map(f => f.path);

            const commitResult = await gitService.commitChanges(
              project.path,
              commitMessage,
              filesToCommit
            );

            if (commitResult.success || commitResult.commit) {
              await changesetService.updateChangeSetCommit(
                project.path,
                changesetId,
                commitResult.commit,
                commitMessage
              );
              await changesetService.updateChangeSetStatus(project.path, changesetId, 'committed');
              updatedChangeset.status = 'committed';
              updatedChangeset.commitSha = commitResult.commit;
              console.log(`✅ Auto-committed changeset ${changesetId}: ${commitResult.commit}`);
            }
          } catch (commitError) {
            console.error(`⚠️ Auto-commit failed (non-blocking):`, commitError.message);
            // Don't fail verification - commit can be done manually
          }
        } else if (freshChangeset?.commitSha) {
          // Already committed (by parallel auto-verification), update local state
          updatedChangeset.commitSha = freshChangeset.commitSha;
          updatedChangeset.status = freshChangeset.status;
        }
      }
    } else if (anyCheckFailed && updatedChangeset.status === 'verified') {
      // Demote back to applied when re-run checks fail
      await changesetService.updateChangeSetStatus(project.path, changesetId, 'applied');
      updatedChangeset.status = 'applied';
    }

    res.json({
      success: true,
      verification: updatedChangeset.verification,
      results,
      status: updatedChangeset.status,
      autoCommitted: !!updatedChangeset.commitSha,
      commitSha: updatedChangeset.commitSha || null,
    });
  } catch (error) {
    console.error('Error running verification:', error);
    res.status(500).json({
      error: 'Failed to run verification',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/git-status
 * Get git repository status for a project
 */
router.get('/:projectId/git-status', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const isGitRepo = await gitService.isGitRepository(project.path);

    let currentBranch = null;
    let originUrl = null;
    let isGitHub = false;
    let owner = null;
    let repo = null;
    let dirty = false;
    let ahead = 0;
    let behind = 0;
    let hasUpstream = false;
    let modified = 0;
    let created = 0;
    let deleted = 0;
    let staged = 0;
    let conflicted = 0;

    let headSha = null;
    if (isGitRepo) {
      try {
        const status = await gitService.getStatus(project.path);
        currentBranch = status?.branch || null;
        dirty = !status?.isClean;
        ahead = Number(status?.ahead || 0);
        behind = Number(status?.behind || 0);
        hasUpstream = status?.ahead !== null && status?.behind !== null;
        modified = Array.isArray(status?.modified) ? status.modified.length : 0;
        created = Array.isArray(status?.created) ? status.created.length : 0;
        deleted = Array.isArray(status?.deleted) ? status.deleted.length : 0;
        staged = Array.isArray(status?.staged) ? status.staged.length : 0;
        conflicted = Array.isArray(status?.conflicted) ? status.conflicted.length : 0;
      } catch (error) {
        console.error('Error getting git status details:', error);
      }

      try {
        headSha = await gitService.getCurrentSHA(project.path);
      } catch (error) {
        console.error('Error getting current HEAD SHA:', error);
      }

      try {
        originUrl = await gitService.getRemoteUrl(project.path, 'origin');
        const githubMatch = originUrl?.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
        if (githubMatch) {
          isGitHub = true;
          owner = githubMatch[1];
          repo = githubMatch[2];
        }
      } catch {
        // No remote configured is allowed
      }
    }

    res.json({
      success: true,
      isGitRepo,
      currentBranch,
      branch: currentBranch,
      originUrl,
      isGitHub,
      owner,
      repo,
      dirty,
      ahead,
      behind,
      hasUpstream,
      modified,
      created,
      deleted,
      staged,
      conflicted,
      headSha,
    });
  } catch (error) {
    console.error('Error getting git status:', error);
    res.status(500).json({
      error: 'Failed to get git status',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/changesets/:changesetId/commit
 * Commit a changeset's files to git
 */
router.post('/:projectId/changesets/:changesetId/commit', enforceQuotas, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const { message } = req.body;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Check if project is a git repository
    const isGitRepo = await gitService.isGitRepository(project.path);
    if (!isGitRepo) {
      return res.status(400).json({ error: 'Project is not a git repository' });
    }

    // Load changeset
    const changeset = await changesetService.getChangeSet(project.path, changesetId);
    if (!changeset) {
      return res.status(404).json({ error: 'Changeset not found' });
    }

    // Check if already committed
    if (changeset.commitSha) {
      return res.status(400).json({
        error: 'Changeset already committed',
        commitSha: changeset.commitSha,
      });
    }

    // Note: The "one-changeset-one-commit" policy means each changeset gets its own unique commit.
    // It's normal and expected to modify the same file across multiple changesets - each gets its own commit.
    // The "Also in: CS-XXX" tooltip on the UI handles cases where legacy data has shared commits.

    // Check if changeset is reverted
    if (changeset.status === 'reverted') {
      return res.status(400).json({ error: 'Cannot commit a reverted changeset' });
    }

    // Validate file contents match changeset "after" content
    const errors = [];
    const warnings = [];
    const filesToCommit = [];

    for (const file of changeset.files) {
      const fullPath = path.join(project.path, file.path);

      try {
        if (file.after === null) {
          // File was deleted - verify it doesn't exist
          try {
            await fs.access(fullPath);
            // File still exists but should be deleted
            errors.push(`File ${file.path} should be deleted but still exists`);
          } catch {
            // File doesn't exist - correct state for deletion
            filesToCommit.push(file.path);
          }
        } else {
          // File should exist with "after" content
          const currentContent = await fs.readFile(fullPath, 'utf8');
          if (currentContent !== file.after) {
            errors.push(`File ${file.path} content changed since changeset was created`);
          } else {
            filesToCommit.push(file.path);
          }
        }
      } catch (err) {
        if (err.code === 'ENOENT' && file.after !== null) {
          errors.push(`File ${file.path} does not exist`);
        } else if (err.code !== 'ENOENT') {
          errors.push(`Error reading ${file.path}: ${err.message}`);
        }
      }
    }

    // Check for external modifications using git status
    try {
      const gitStatus = await gitService.getStatus(project.path);
      const changesetFilePaths = new Set(changeset.files.map(f => f.path));

      // Check for modified files not in the changeset
      const allModified = [
        ...gitStatus.modified,
        ...gitStatus.created,
        ...gitStatus.deleted,
      ];

      const externalModifications = allModified.filter(f => !changesetFilePaths.has(f));
      if (externalModifications.length > 0) {
        warnings.push(`Other files modified in working tree: ${externalModifications.join(', ')}`);
      }
    } catch (err) {
      console.error('Error checking git status:', err);
      // Non-critical - continue with commit
    }

    // If there are errors, don't commit
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors,
        warnings,
        blockedReason: 'File contents do not match changeset',
      });
    }

    // Use provided message or default to changeset title
    const commitMessage = message || changeset.title;

    // All validations passed - proceed with commit
    if (filesToCommit.length === 0) {
      const headSha = await gitService.getCurrentSHA(project.path);
      if (headSha) {
        await changesetService.updateChangeSetCommit(project.path, changesetId, headSha, commitMessage);
        await changesetService.updateChangeSetStatus(project.path, changesetId, 'committed');
        return res.json({
          success: true,
          message: 'Changeset had no tracked files — adopted existing HEAD commit.',
          commitSha: headSha,
          alreadyCommitted: true,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      }

      const hasWorkingTreeChanges = await gitService.hasUncommittedChanges(project.path);
      if (hasWorkingTreeChanges) {
        const initialCommitResult = await gitService.commitChanges(project.path, commitMessage);

        if (!initialCommitResult.commit) {
          return res.status(400).json({
            success: false,
            errors: ['Git commit returned no SHA - nothing was committed'],
            warnings,
            blockedReason: 'No changes detected by git',
          });
        }

        await changesetService.updateChangeSetCommit(project.path, changesetId, initialCommitResult.commit, commitMessage);
        await changesetService.updateChangeSetStatus(project.path, changesetId, 'committed');

        return res.json({
          success: true,
          message: 'Committed working tree and linked it to the changeset.',
          commitSha: initialCommitResult.commit,
          branch: initialCommitResult.branch,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      }

      return res.status(400).json({
        success: false,
        errors: ['No files to commit'],
        warnings,
        blockedReason: 'No valid files found in changeset',
      });
    }

    // Check if any of the files are actually modified in git's view
    const gitStatus = await gitService.getStatus(project.path);
    // Include renamed files (both old and new paths)
    const renamedPaths = (gitStatus.renamed || []).flatMap(r => [r.from, r.to]);
    const modifiedInGit = new Set([
      ...gitStatus.modified,
      ...gitStatus.created,
      ...gitStatus.deleted,
      ...gitStatus.staged,
      ...renamedPaths,
      ...(gitStatus.notAdded || []), // Untracked files (new files not yet staged)
    ]);

    const filesToActuallyCommit = filesToCommit.filter(f => modifiedInGit.has(f));

    // If no files are modified in git, the changeset files might already be committed
    if (filesToActuallyCommit.length === 0) {
      // Check if changeset already has a commit SHA (was previously committed)
      if (changeset.commitSha) {
        // Already committed - just update status if needed
        if (changeset.status !== 'committed') {
          await changesetService.updateChangeSetStatus(project.path, changesetId, 'committed');
        }
        return res.json({
          success: true,
          message: 'Changeset already committed.',
          commitSha: changeset.commitSha,
          alreadyCommitted: true,
        });
      }

      // Files already match git state — adopt HEAD as the changeset commit.
      // This happens when files were committed outside the changeset flow
      // (e.g., via "Commit uncommitted changes" or manual git commit).
      const headSha = await gitService.getCurrentSHA(project.path);
      if (headSha) {
        await changesetService.updateChangeSetCommit(project.path, changesetId, headSha, commitMessage);
        await changesetService.updateChangeSetStatus(project.path, changesetId, 'committed');
        return res.json({
          success: true,
          message: 'Files already committed — adopted existing commit.',
          commitSha: headSha,
          alreadyCommitted: true,
        });
      }

      const hasWorkingTreeChanges = await gitService.hasUncommittedChanges(project.path);
      if (hasWorkingTreeChanges) {
        const initialCommitResult = await gitService.commitChanges(project.path, commitMessage);

        if (!initialCommitResult.commit) {
          return res.status(400).json({
            success: false,
            errors: ['Git commit returned no SHA - nothing was committed'],
            blockedReason: 'No changes detected by git',
          });
        }

        await changesetService.updateChangeSetCommit(project.path, changesetId, initialCommitResult.commit, commitMessage);
        await changesetService.updateChangeSetStatus(project.path, changesetId, 'committed');

        return res.json({
          success: true,
          message: 'Committed working tree and linked it to the changeset.',
          commitSha: initialCommitResult.commit,
          branch: initialCommitResult.branch,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      }

      return res.status(400).json({
        success: false,
        errors: ['No changes to commit and no HEAD commit found'],
        blockedReason: 'Files are already up to date in git but no commit SHA could be determined.',
      });
    }

    // Commit changes (only files that passed validation and are modified in git)
    const result = await gitService.commitChanges(project.path, commitMessage, filesToActuallyCommit);

    // Handle empty commit result
    if (!result.commit) {
      return res.status(400).json({
        success: false,
        errors: ['Git commit returned no SHA - nothing was committed'],
        blockedReason: 'No changes detected by git',
      });
    }

    // Update changeset with commit SHA, message, and status
    await changesetService.updateChangeSetCommit(project.path, changesetId, result.commit, commitMessage);
    await changesetService.updateChangeSetStatus(project.path, changesetId, 'committed');

    res.json({
      success: true,
      message: 'Changeset committed successfully',
      commitSha: result.commit,
      branch: result.branch,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (error) {
    console.error('Error committing changeset:', error);

    res.status(500).json({
      error: 'Failed to commit changeset',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/publish-status
 * Get publish gate status for a project
 */
router.get('/:projectId/publish-status', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Check publish gate (pass projectId for secrets check)
    const gateResult = await publishService.checkPublishGate(project.path, projectId);

    // Detect publish method
    const publishMethod = await publishService.detectPublishMethod(project.path);

    // Get preflight status
    const preflight = await publishService.getPublishPreflight(project.path, gateResult.changeset);

    // Get all eligible changesets for the dropdown
    const eligibleChangesets = await publishService.getEligibleChangesets(project.path);

    // Check database provisioning status
    const effectiveUserId = req.user?.id || '00000000-0000-0000-0000-000000000000';
    const databaseProvisioning = await publishService.checkDatabaseProvisioning(project.path, projectId, effectiveUserId);

    // Build response with changeset summary if available
    let latestChangeset = null;
    if (gateResult.changeset) {
      latestChangeset = {
        id: gateResult.changeset.id,
        displayId: gateResult.changeset.displayId || null,
        title: gateResult.changeset.title,
        createdAt: gateResult.changeset.createdAt,
        verification: gateResult.changeset.verification,
        commitSha: gateResult.changeset.commitSha,
      };
    }

    res.json({
      success: true,
      canPublish: gateResult.canPublish,
      reason: gateResult.reason,
      latestChangeset,
      eligibleChangesets,
      publishMethod,
      availableChecks: gateResult.availableChecks,
      preflight,
      secretsReady: gateResult.secretsReady,
      missingSecrets: gateResult.missingSecrets,
      databaseProvisioning,
    });
  } catch (error) {
    console.error('Error getting publish status:', error);
    res.status(500).json({
      error: 'Failed to get publish status',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/publish
 * Execute publish for a project
 */
router.post('/:projectId/publish', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { changesetId } = req.body;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let changesetToPublish;

    // If a specific changeset ID is provided, validate that changeset directly
    // (don't use checkPublishGate which checks the latest changeset)
    if (changesetId) {
      const specificChangeset = await changesetService.getChangeSet(project.path, changesetId);
      if (!specificChangeset) {
        return res.status(404).json({
          success: false,
          error: 'Specified changeset not found',
        });
      }

      // Validate status is at least applied/verified/committed/published (not draft/reverted)
      if (!['applied', 'verified', 'committed', 'published'].includes(specificChangeset.status)) {
        return res.status(400).json({
          success: false,
          error: 'Specified changeset is not eligible for publishing',
          reason: `Changeset status is '${specificChangeset.status}', must be applied, verified, committed, or published`,
        });
      }

      // Enforce verification checks - same logic as checkPublishGate
      const verifyConfig = await projectVerificationService.getProjectVerifyConfig(projectId, project.path);
      const gate = projectVerificationService.evaluateVerificationGate(verifyConfig, specificChangeset.verification || null);
      const hasAnyChecks = gate.enabledChecks.length > 0;

      // Check if the "require checks before publish" setting is enabled (default: true)
      const requireChecks = await db.query("SELECT value FROM settings WHERE id = 'require_checks_before_publish'");
      const checksRequired = !requireChecks.rows?.[0] || requireChecks.rows[0].value !== 'false';

      if (hasAnyChecks && checksRequired) {
        const failedChecks = gate.failedChecks.map((check) => check.label || check.id);
        const notRunChecks = gate.notRunChecks.map((check) => check.label || check.id);

        if (notRunChecks.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'Cannot publish - verification incomplete',
            reason: `Run all checks first (${notRunChecks.join(', ')} not run)`,
          });
        }

        if (failedChecks.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'Cannot publish - verification failed',
            reason: `Fix failing checks (${failedChecks.join(', ')})`,
          });
        }
      }

      changesetToPublish = specificChangeset;
    } else {
      // No specific changeset selected - use gate check on latest
      const gateResult = await publishService.checkPublishGate(project.path, projectId);

      if (!gateResult.canPublish) {
        return res.status(400).json({
          success: false,
          error: 'Cannot publish',
          reason: gateResult.reason,
        });
      }
      changesetToPublish = gateResult.changeset;
    }

    // Detect and run publish
    const publishMethod = await publishService.detectPublishMethod(project.path);

    if (publishMethod.method === 'manual') {
      return res.json({
        success: false,
        error: 'Manual deployment required',
        instructions: publishMethod.instructions,
      });
    }

    const result = await publishService.runPublish(project.path, publishMethod.method);

    if (result.success) {
      // Update the changeset to 'published' status (attach URL only if available)
      if (changesetToPublish) {
        await changesetService.updateChangeSetStatus(
          project.path,
          changesetToPublish.id,
          'published',
          result.url ? { publishedUrl: result.url } : undefined
        );
      }

      res.json({
        success: true,
        logs: result.logs,
        url: result.url,
        changesetId: changesetToPublish?.id,
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
        logs: result.logs,
      });
    }
  } catch (error) {
    console.error('Error publishing project:', error);
    res.status(500).json({
      error: 'Failed to publish project',
      details: error.message,
    });
  }
});

/**
 * PATCH /api/projects/:projectId/changesets/:changesetId/summary
 * Update a changeset's summary
 */
router.patch('/:projectId/changesets/:changesetId/summary', enforceQuotas, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const { summary } = req.body;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const changeset = await changesetService.updateChangeSetSummary(project.path, changesetId, summary);

    res.json({
      success: true,
      changeset: {
        id: changeset.id,
        summary: changeset.summary,
      },
    });
  } catch (error) {
    console.error('Error updating changeset summary:', error);

    if (error.message === 'Changeset not found') {
      return res.status(404).json({ error: 'Changeset not found' });
    }

    res.status(500).json({
      error: 'Failed to update changeset summary',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/commit-working-tree
 * Commit all uncommitted working tree changes (not tied to a changeset)
 */
router.post('/:projectId/commit-working-tree', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { message } = req.body;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Check if project is a git repository
    const isGitRepo = await gitService.isGitRepository(project.path);
    if (!isGitRepo) {
      return res.status(400).json({ error: 'Project is not a git repository' });
    }

    // Check if there are uncommitted changes
    const hasChanges = await gitService.hasUncommittedChanges(project.path);
    if (!hasChanges) {
      return res.status(400).json({ error: 'No uncommitted changes to commit' });
    }

    // Get list of changed files for the response
    const changedFiles = await gitService.getChangedFiles(project.path);

    // Use provided message or generate a default one
    const commitMessage = message || `Manual commit: ${changedFiles.length} file(s) changed`;

    // Commit all changes
    const result = await gitService.commitChanges(project.path, commitMessage);

    res.json({
      success: true,
      message: 'Working tree committed successfully',
      commitSha: result.commit,
      branch: result.branch,
      filesCommitted: changedFiles,
    });
  } catch (error) {
    console.error('Error committing working tree:', error);
    res.status(500).json({
      error: 'Failed to commit working tree',
      details: error.message,
    });
  }
});

// ============================================================================
// ACTIONS — Unified action execution interface
// ============================================================================

/**
 * POST /api/projects/:projectId/changesets/:changesetId/actions/:actionType
 * Execute an action (push, deploy, rollback, export, verify) against a changeset.
 */
router.post('/:projectId/changesets/:changesetId/actions/:actionType', enforceQuotas, async (req, res) => {
  try {
    const { projectId, changesetId, actionType } = req.params;

    // Validate action type
    if (!actionService.ACTION_TYPES.includes(actionType)) {
      return res.status(400).json({
        error: `Invalid action type: ${actionType}. Valid: ${actionService.ACTION_TYPES.join(', ')}`,
      });
    }

    // Get project
    const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
    const project = await getProjectById(projectId, effectiveUserId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectPath = project.project_path || path.resolve('projects', project.session_id);

    // Execute action
    const result = await actionService.execute(actionType, projectPath, changesetId, projectId, req.body || {});

    if (result.success) {
      res.json({ success: true, ...result });
    } else {
      res.status(400).json({ success: false, ...result });
    }
  } catch (error) {
    console.error(`Error executing action ${req.params.actionType}:`, error);
    res.status(500).json({
      error: 'Action execution failed',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/actions-log
 * Get action execution history for a project.
 */
router.get('/:projectId/actions-log', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { changesetId, actionType, limit } = req.query;

    const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
    const project = await getProjectById(projectId, effectiveUserId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const logs = await actionService.getActionsLog(projectId, {
      changesetId,
      actionType,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    res.json({ success: true, actions: logs });
  } catch (error) {
    console.error('Error fetching actions log:', error);
    res.status(500).json({ error: 'Failed to fetch actions log' });
  }
});

/**
 * GET /api/projects/:projectId/changesets/:changesetId/export-bundle
 * Download the export bundle zip for a changeset (triggers export if needed).
 */
router.get('/:projectId/changesets/:changesetId/export-bundle', enforceQuotas, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
    const project = await getProjectById(projectId, effectiveUserId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectPath = project.project_path || path.resolve('projects', project.session_id);

    // Execute export action
    const result = await actionService.executeExport(projectPath, changesetId, projectId);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Stream the zip file
    res.download(result.data.zipPath, result.data.zipName);
  } catch (error) {
    console.error('Error exporting bundle:', error);
    res.status(500).json({ error: 'Failed to export bundle' });
  }
});

export default router;
