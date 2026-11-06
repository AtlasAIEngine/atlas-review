/**
 * Project Routes
 * CRUD operations for projects with memory initialization
 */

import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import {
  createProject,
  getProjectById,
  getProjectBySessionId,
  getProjectByPath,
  getUserProjects,
  updateProject,
  updateProjectLastAccessed,
  deleteProject,
  getActivePreview,
  clearChatHistory,
  getChatHistory
} from '../db/queries.js';
import db from '../db/connection.js';
import memoryService from '../services/memoryService.js';
import dockerService from '../services/dockerService.js';
import databaseService from '../services/databaseService.js';
import atlasHostingService from '../services/atlasHostingService.js';
import { enforceQuotas, checkBuildQuota, checkContainerQuota } from '../middleware/quotas.js';
import { normalizeUiEdits, normalizeUiSelection } from '../utils/uiSelection.js';
import changesetService from '../services/changesetService.js';
import projectInitService from '../services/projectInitService.js';
import gitService from '../services/gitService.js';
import gitWatcherService from '../services/gitWatcherService.js';
import { initIndex as initCodegraphIndex } from '../services/codegraphService.js';
import { getProjectStorageDir } from '../services/atlasProjectStorageService.js';
import { createGeneratedProjectReviewPolicyBaseline } from '../services/review/reviewPolicyService.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getTemplateById } from './templates.js';

const execFileAsync = promisify(execFile);

const router = express.Router();

// Base projects directory from environment
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(process.cwd(), '../projects');

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// Helper function to get effective user ID (supports anonymous access in MVP)
function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

// Helper function to check project ownership (supports anonymous access in MVP)
function checkOwnership(project, req) {
  const effectiveUserId = getEffectiveUserId(req);
  return project.user_id === effectiveUserId;
}

function parsePickerCancellation(error) {
  const message = String(error?.stderr || error?.stdout || error?.message || '').trim();
  if (
    message.includes('-128')
    || /user canceled/i.test(message)
    || /cancelled/i.test(message)
    || /canceled/i.test(message)
  ) {
    return true;
  }
  return false;
}

function bootstrapOpenedLocalProject({
  normalizedPath,
  commitSha,
  branch,
}) {
  setImmediate(async () => {
    try {
      await changesetService.createBaselineChangeset(normalizedPath, {
        commitSha,
        branch,
        importSource: 'local_folder',
      });
    } catch (csError) {
      console.warn('Could not create baseline changeset:', csError.message);
    }
  });
}

async function resolveStartupBaseBranch(projectPath) {
  try {
    const detected = await gitWatcherService.detectBaseBranch(projectPath);
    return typeof detected === 'string' && detected.trim() ? detected.trim() : null;
  } catch (error) {
    console.warn(`[projects] Failed to detect startup base branch for ${projectPath}:`, error.message);
    return null;
  }
}

async function persistDetectedProjectBaseBranch(projectId, baseBranch) {
  if (!baseBranch) return;
  try {
    await updateProject(projectId, {
      base_branch_display: baseBranch,
      base_branch_ref: `refs/heads/${baseBranch}`,
    });
  } catch (error) {
    console.warn(`[projects] Failed to persist detected base branch '${baseBranch}':`, error.message);
  }
}

// Walk up the directory tree from `startPath` looking for a `.git` entry.
// `.git` may be a directory (normal repo) or a file (git worktree linkfile).
// Returns the absolute path of the directory containing `.git`, or null.
async function findGitRootAtOrAbove(startPath) {
  let current = path.resolve(startPath);
  const fsRoot = path.parse(current).root;
  while (true) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch { /* keep walking */ }
    if (current === fsRoot) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function openNativeDirectoryPicker() {
  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose folder with prompt "Select project folder")';
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 120000 });
    return String(stdout || '').trim();
  }

  if (process.platform === 'win32') {
    const command = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Select project folder"',
      '$dialog.UseDescriptionForTitle = $true',
      '$result = $dialog.ShowDialog()',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath; exit 0 }',
      'Write-Error "User canceled folder picker"; exit 1',
    ].join('; ');
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 120000 }
    );
    return String(stdout || '').trim();
  }

  const linuxPickers = [
    ['zenity', ['--file-selection', '--directory', '--title=Select project folder']],
    ['kdialog', ['--getexistingdirectory', '.', '--title', 'Select project folder']],
  ];

  for (const [command, args] of linuxPickers) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 120000 });
      const selectedPath = String(stdout || '').trim();
      if (selectedPath) return selectedPath;
    } catch (error) {
      if (parsePickerCancellation(error)) {
        const cancelled = new Error('Folder picker canceled');
        cancelled.code = 'PICKER_CANCELED';
        throw cancelled;
      }
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  const unsupported = new Error(`Native folder picker is not supported on ${process.platform}`);
  unsupported.code = 'PICKER_UNSUPPORTED';
  throw unsupported;
}

function isBuilderEnabled() {
  const raw = String(process.env.ENABLE_BUILDER || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * POST /api/projects
 * Create a new project with memory initialization.
 * Gated on ENABLE_BUILDER — Atlas Review-only builds should leave this disabled.
 */
router.post('/', enforceQuotas, async (req, res) => {
  try {
    if (!isBuilderEnabled()) {
      return res.status(403).json({ error: 'Builder mode is disabled' });
    }
    const { name, description, framework, language, templateId } = req.body;
    // For MVP: Use anonymous user if not authenticated
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }

    // Validate templateId if provided
    let template = null;
    if (templateId) {
      template = await getTemplateById(templateId);
      if (!template) {
        return res.status(400).json({ error: `Unknown template: ${templateId}` });
      }
    }

    // Generate unique session ID
    const sessionId = uuidv4();

    // Create project directory
    const projectPath = path.join(PROJECTS_DIR, `${userId === '00000000-0000-0000-0000-000000000000' ? 'anonymous' : userId}_${sessionId}`);
    await fs.mkdir(projectPath, { recursive: true });

    // Clone template files if a template was specified
    if (template) {
      const repoUrl = `https://github.com/${template.githubRepo}.git`;
      const tmpClone = `${projectPath}__clone_tmp`;
      try {
        await execFileAsync('git', ['clone', '--depth', '1', repoUrl, tmpClone], { timeout: 30000 });
        // Remove .git from clone so the project starts fresh
        await fs.rm(path.join(tmpClone, '.git'), { recursive: true, force: true });
        // Copy all files from clone into project dir
        const entries = await fs.readdir(tmpClone, { withFileTypes: true });
        for (const entry of entries) {
          const src = path.join(tmpClone, entry.name);
          const dest = path.join(projectPath, entry.name);
          // Skip symlinks for security (per CLAUDE.md pattern)
          if (entry.isSymbolicLink()) continue;
          await fs.cp(src, dest, { recursive: true });
        }
      } catch (cloneErr) {
        console.error(`[projects] Template clone failed for ${templateId}:`, cloneErr.message);
        // Continue without template files — project still gets created
      } finally {
        await fs.rm(tmpClone, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Create project in database (prefer template's framework/language if set)
    const effectiveFramework = template?.framework || framework;
    const effectiveLanguage = template?.language || language;
    const generatedReviewPolicy = createGeneratedProjectReviewPolicyBaseline(projectPath);
    const project = await createProject({
      userId,
      sessionId,
      name,
      description,
      path: projectPath,
      framework: effectiveFramework,
      language: effectiveLanguage,
      source: 'builder',
      generatedReviewPolicyJson: generatedReviewPolicy.content.trim(),
      generatedReviewPolicyHash: generatedReviewPolicy.hash,
      generatedReviewPolicyVersion: generatedReviewPolicy.version,
      generatedReviewPolicyGeneratorVersion: generatedReviewPolicy.generatorVersion,
      generatedReviewPolicyGeneratedAt: generatedReviewPolicy.generatedAt,
    });

    // Initialize memory system
    await memoryService.initializeMemory(
      project.id,
      projectPath,
      name,
      userId,
      { framework: effectiveFramework, language: effectiveLanguage, description }
    );

    // Initialize the repo itself. Atlas runtime metadata stays in app data.
    const initResult = await projectInitService.initializeProject(projectPath, { framework: effectiveFramework, language: effectiveLanguage });
    console.log(
      `Project initialized: git=${initResult.git}, gitignore=${initResult.gitignore}, atlas=${initResult.atlasDir}, reviewPolicy=on_demand`
    );

    // Create CS-000 baseline changeset for new projects
    try {
      let commitSha = null;
      if (initResult.git) {
        try { commitSha = await gitService.getCurrentSHA(projectPath); } catch (_) { /* no commits yet */ }
      }
      await changesetService.createBaselineChangeset(projectPath, {
        commitSha,
        importSource: 'new_project',
      });
    } catch (csError) {
      console.warn('Could not create baseline changeset:', csError.message);
    }

    res.status(201).json({
      success: true,
      project: {
        id: project.id,
        sessionId: project.session_id,
        name: project.name,
        description: project.description,
        framework: project.framework,
        language: project.language,
        hasMemory: true,
        hasGit: initResult.git,
        hasAtlas: initResult.atlasDir,
        createdAt: project.created_at
      }
    });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

/**
 * GET /api/projects
 * List user's projects
 */
router.get('/', enforceQuotas, async (req, res) => {
  try {
    const userId = req.user?.id;

    // For MVP: Use anonymous user if not authenticated
    const effectiveUserId = userId || '00000000-0000-0000-0000-000000000000';

    const { limit = 50, offset = 0, status = 'active' } = req.query;

    const projects = await getUserProjects(effectiveUserId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      status
    });

    res.json({
      success: true,
      projects: projects.map(p => ({
        id: p.id,
        sessionId: p.session_id,
        name: p.name,
        description: p.description,
        path: p.path || null,
        framework: p.framework,
        language: p.language,
        hasMemory: p.has_memory,
        memorySize: p.memory_size,
        status: p.status,
        source: p.source || 'builder',
        github: p.github_repo_full_name ? {
          repoId: p.github_repo_id,
          repoFullName: p.github_repo_full_name,
          repoOwner: p.github_repo_owner,
          repoName: p.github_repo_name,
          syncEnabled: p.github_sync_enabled,
          syncStatus: p.github_sync_status
        } : null,
        baseBranchDisplay: p.base_branch_display || null,
        baseBranchRef: p.base_branch_ref || null,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        lastAccessed: p.last_accessed,
        // Card metadata for HomePage
        lastModified: p.last_accessed || p.updated_at,
        deploymentUrl: p.last_deployment_url || null,
        deploymentStatus: p.last_deployment_url ? 'deployed' : 'never'
      })),
      total: projects.length
    });
  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

/**
 * GET /api/projects/:id
 * Get project details
 */
router.get('/:id', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Update last accessed
    await updateProjectLastAccessed(id);

    // Build GitHub object if project has GitHub integration
    const github = project.github_repo_full_name ? {
      repoId: project.github_repo_id,
      repoFullName: project.github_repo_full_name,
      repoOwner: project.github_repo_owner,
      repoName: project.github_repo_name,
      installationId: project.github_installation_id,
      cloneUrl: project.github_clone_url,
      defaultBranch: project.github_default_branch,
      lastSyncSha: project.github_last_sync_sha,
      lastSyncAt: project.github_last_sync_at,
      webhookId: project.github_webhook_id,
      syncEnabled: project.github_sync_enabled,
      syncStatus: project.github_sync_status
    } : null;

    // Check if user has any GitHub App installation (for PR reviews)
    let hasGitHubIntegration = !!github;
    if (!hasGitHubIntegration) {
      const effectiveUserId = getEffectiveUserId(req);
      const integrationCheck = await db.query(
        'SELECT 1 FROM github_integrations WHERE user_id = $1 AND is_active = TRUE LIMIT 1',
        [effectiveUserId]
      );
      hasGitHubIntegration = integrationCheck.rows.length > 0;
    }

    res.json({
      success: true,
      project: {
        id: project.id,
        sessionId: project.session_id,
        name: project.name,
        description: project.description,
        framework: project.framework,
        language: project.language,
        path: project.path,
        hasMemory: project.has_memory,
        memorySize: project.memory_size,
        lastMemoryUpdate: project.last_memory_update,
        status: project.status,
        source: project.source || 'builder',
        baseBranchDisplay: project.base_branch_display || null,
        baseBranchRef: project.base_branch_ref || null,
        github,
        hasGitHubIntegration,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
        lastAccessed: project.last_accessed
      }
    });
  } catch (error) {
    console.error('Error getting project:', error);
    res.status(500).json({ error: 'Failed to get project' });
  }
});

/**
 * GET /api/projects/session/:sessionId
 * Get project by session ID
 */
router.get('/session/:sessionId', enforceQuotas, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id;

    const project = await getProjectBySessionId(sessionId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({
      success: true,
      project: {
        id: project.id,
        sessionId: project.session_id,
        name: project.name,
        description: project.description,
        framework: project.framework,
        language: project.language,
        hasMemory: project.has_memory,
        createdAt: project.created_at
      }
    });
  } catch (error) {
    console.error('Error getting project by session:', error);
    res.status(500).json({ error: 'Failed to get project' });
  }
});

/**
 * PATCH /api/projects/:id
 * Update project details
 */
router.patch('/:id', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { name, description, framework, language } = req.body;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updates = {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'Project name cannot be empty' });
      }
      if (trimmed.length > 50) {
        return res.status(400).json({ error: 'Project name must be 50 characters or less' });
      }
      updates.name = trimmed;
    }
    if (description !== undefined) updates.description = description;
    if (framework !== undefined) updates.framework = framework;
    if (language !== undefined) updates.language = language;

    if (Object.keys(updates).length > 0) {
      await updateProject(id, updates);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

/**
 * POST /api/projects/:id/generate-name
 * Generate an AI-powered project name from the project description
 */
router.post('/:id/generate-name', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { generateProjectName } = await import('../services/projectNamingService.js');

    // Gather first-turn context for better naming
    let userPrompt = '';
    let assistantResponse = '';
    try {
      const messages = await getChatHistory(id, 4, 0);
      const firstUser = messages.find((m) => m.role === 'user');
      const firstAssistant = messages.find((m) => m.role === 'assistant');
      if (firstUser) userPrompt = firstUser.content || '';
      if (firstAssistant) assistantResponse = firstAssistant.content || '';
    } catch {
      // Chat history unavailable — proceed with description only
    }

    const name = await generateProjectName({
      userPrompt,
      projectDescription: project.description || '',
      assistantResponse,
    });

    if (name) {
      await updateProject(id, { name });
    }

    res.json({ success: true, name: name || null });
  } catch (error) {
    console.error('Error generating project name:', error);
    res.status(500).json({ success: false, name: null, error: 'Failed to generate name' });
  }
});

/**
 * Get the uploads directory for a project.
 * Uploads are stored at <cwd>/projects/<projectId>/uploads (per multer config).
 */
function getUploadsDir(projectId) {
  return path.join(process.cwd(), 'projects', projectId, 'uploads');
}

function resolveUploadsPath(projectId, requestedPath) {
  const uploadsDir = path.resolve(getUploadsDir(projectId));
  const rawPath = String(requestedPath || '').trim();
  const normalizedRelativePath = rawPath.replace(/^uploads[\\/]/, '');
  const targetPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(uploadsDir, normalizedRelativePath);

  if (targetPath !== uploadsDir && !targetPath.startsWith(`${uploadsDir}${path.sep}`)) {
    return null;
  }

  return targetPath;
}

/**
 * Delete uploaded attachments for a project.
 * @param {string} projectId
 * @returns {{ deleted: boolean, count: number }}
 */
async function deleteProjectAttachments(projectId) {
  const uploadsDir = getUploadsDir(projectId);
  try {
    const entries = await fs.readdir(uploadsDir);
    let count = 0;
    for (const entry of entries) {
      await fs.unlink(path.join(uploadsDir, entry)).catch(() => {});
      count++;
    }
    return { deleted: true, count };
  } catch (err) {
    if (err.code === 'ENOENT') return { deleted: false, count: 0 };
    throw err;
  }
}

/**
 * POST /api/projects/:id/attachments/reveal
 * Open the attachments folder in the OS file manager
 */
/**
 * POST /api/projects/:id/reveal
 * Open the project folder in the OS file manager
 */
router.post('/:id/reveal', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const project = await getProjectById(id);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const projectPath = project.path;
    if (!projectPath) {
      return res.status(400).json({ success: false, error: 'Project has no local path' });
    }

    const { exec } = await import('child_process');
    const platform = process.platform;
    const cmd = platform === 'darwin' ? `open "${projectPath}"`
      : platform === 'win32' ? `explorer "${projectPath}"`
      : `xdg-open "${projectPath}"`;
    exec(cmd);

    res.json({ success: true, path: projectPath });
  } catch (error) {
    console.error(`Failed to reveal project folder: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/attachments/reveal', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const project = await getProjectById(id);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const uploadsDir = getUploadsDir(id);
    // Ensure the directory exists
    await fs.mkdir(uploadsDir, { recursive: true });

    const { exec } = await import('child_process');
    const platform = process.platform;
    const cmd = platform === 'darwin' ? `open "${uploadsDir}"`
      : platform === 'win32' ? `explorer "${uploadsDir}"`
      : `xdg-open "${uploadsDir}"`;
    exec(cmd);

    res.json({ success: true, path: uploadsDir });
  } catch (error) {
    console.error(`Failed to reveal attachments: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/projects/:id/attachments/raw
 * Serve an uploaded chat attachment as a raw binary response.
 */
router.get('/:id/attachments/raw', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const { path: attachmentPath } = req.query;

    if (!attachmentPath) {
      return res.status(400).json({ error: 'Attachment path is required' });
    }

    const project = await getProjectById(id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const targetPath = resolveUploadsPath(id, attachmentPath);
    if (!targetPath) {
      return res.status(403).json({ error: 'Invalid attachment path' });
    }

    await fs.access(targetPath);
    res.sendFile(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    console.error('Error serving attachment:', error);
    res.status(500).json({ error: 'Failed to serve attachment' });
  }
});

/**
 * DELETE /api/projects/:id/attachments
 * Delete uploaded attachments for a project
 */
router.delete('/:id/attachments', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const project = await getProjectById(id);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const result = await deleteProjectAttachments(id);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Failed to delete attachments: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project (soft delete) with full cleanup
 * - Stops running containers
 * - Deletes project folder from filesystem
 * - Cleans up database records (soft delete)
 * - Removes provisioned database
 */
router.delete('/:id', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const projectSource = project.source || 'builder';
    console.log(`🗑️  Starting deletion of project ${id} (${project.name}, source=${projectSource})...`);

    // Step 1: Stop git watcher if active
    try {
      gitWatcherService.stopWatching(id);
      console.log(`✅ Git watcher stopped`);
    } catch (watcherError) {
      console.error(`⚠️  Watcher cleanup failed (non-critical):`, watcherError.message);
    }

    // Step 2: Stop any running containers
    try {
      const activePreview = await getActivePreview(id);
      if (activePreview && activePreview.container_id) {
        console.log(`🛑 Stopping container ${activePreview.container_name}...`);
        await dockerService.stopContainer(activePreview.container_id);
        console.log(`✅ Container stopped successfully`);
      }
    } catch (containerError) {
      // Log but don't fail the delete if container cleanup fails
      console.error(`⚠️  Container cleanup failed (non-critical):`, containerError.message);
    }

    // Step 3: Delete pending GitHub sync queue entries
    try {
      await db.query(
        `DELETE FROM github_sync_queue
         WHERE project_id = $1 AND status = 'pending'`,
        [id]
      );
      console.log(`✅ Deleted pending GitHub sync jobs`);
    } catch (syncError) {
      console.error(`⚠️  GitHub sync cleanup failed (non-critical):`, syncError.message);
    }

    // Step 4: Delete branch reviews for this project
    try {
      const brResult = await db.query(
        `DELETE FROM branch_reviews WHERE project_id = $1`,
        [id]
      );
      console.log(`✅ Deleted ${brResult.rowCount ?? 0} branch reviews`);
    } catch (brError) {
      console.error(`⚠️  Branch review cleanup failed (non-critical):`, brError.message);
    }

    // Step 5: Soft delete chat messages
    try {
      const deletedCount = await clearChatHistory(id);
      console.log(`✅ Soft deleted ${deletedCount} chat messages`);
    } catch (chatError) {
      console.error(`⚠️  Chat cleanup failed (non-critical):`, chatError.message);
    }

    // Step 6: Filesystem cleanup
    // For local/github projects: only delete Atlas runtime metadata, NOT the user's repo folder
    // For builder projects: delete the repo folder we created after cleaning runtime metadata
    try {
      const projectPath = project.path;
      const atlasRuntimeDir = getProjectStorageDir(projectPath);
      await fs.rm(atlasRuntimeDir, { recursive: true, force: true });
      console.log(`✅ Deleted Atlas runtime metadata: ${atlasRuntimeDir}`);
      if (projectSource !== 'local' && projectSource !== 'github') {
        await fs.rm(projectPath, { recursive: true, force: true });
        console.log(`✅ Deleted project folder: ${projectPath}`);
      }
    } catch (fsError) {
      // Log but don't fail if folder already deleted or doesn't exist
      console.error(`⚠️  Filesystem cleanup failed (non-critical):`, fsError.message);
    }

    // Step 7: Cleanup provisioned database if exists
    try {
      console.log(`🗑️  Cleaning up provisioned database for project ${id}...`);
      const dbCleanup = await databaseService.dropDatabase(id);
      if (dbCleanup.success) {
        console.log(`✅ Provisioned database cleaned up successfully`);
      }
    } catch (dbError) {
      console.error(`⚠️  Database cleanup failed (non-critical):`, dbError.message);
    }

    // Note: Vercel project is NOT deleted automatically.
    // Users must explicitly delete hosting resources via separate API endpoint.
    // This prevents accidental deletion of production deployments.
    if (project.vercel_project_id) {
      console.log(`ℹ️  Vercel project "${project.vercel_project_id}" preserved. Delete hosting separately if needed.`);
    }

    // Step 6: Soft delete project in database (update status to 'deleted')
    await deleteProject(id);
    console.log(`✅ Project ${id} (${project.name}) deleted successfully`);

    res.json({
      success: true,
      message: 'Project deleted successfully',
      projectId: id
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

/**
 * POST /api/projects/:id/build
 * Trigger a build for the project
 */
router.post('/:id/build', enforceQuotas, checkBuildQuota, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Trigger build asynchronously
    const buildResult = await dockerService.buildProject(
      project.id,
      project.path,
      userId
    );

    res.json({
      success: buildResult.success,
      buildId: buildResult.buildId,
      message: buildResult.success ? 'Build completed successfully' : 'Build failed',
      logs: buildResult.logs,
      error: buildResult.error
    });
  } catch (error) {
    console.error('Error triggering build:', error);
    res.status(500).json({ error: 'Failed to trigger build' });
  }
});

/**
 * POST /api/projects/:id/deploy
 * Deploy a project
 */
router.post('/:id/deploy', enforceQuotas, checkContainerQuota, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { buildId } = req.body;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Deploy project
    const deployResult = await dockerService.deployProject(
      project.id,
      project.path,
      userId,
      buildId
    );

    res.json({
      success: deployResult.success,
      preview: {
        id: deployResult.previewId,
        containerId: deployResult.containerId,
        containerName: deployResult.containerName,
        port: deployResult.port,
        host: deployResult.host,
        url: deployResult.url
      }
    });
  } catch (error) {
    console.error('Error deploying project:', error);
    res.status(500).json({ error: 'Failed to deploy project' });
  }
});

/**
 * GET /api/projects/:id/files
 * List project files
 */
router.get('/:id/files', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { path: relativePath = '' } = req.query;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Update last_accessed when opening the project root (not subdirectory navigations)
    if (!relativePath) {
      updateProjectLastAccessed(id).catch(() => {});
    }

    const targetPath = path.join(project.path, relativePath);

    // Security check: ensure path is within project directory
    if (!targetPath.startsWith(project.path)) {
      return res.status(403).json({ error: 'Invalid path' });
    }

    const files = await fs.readdir(targetPath, { withFileTypes: true });

    // Filter out .git directory always, then use git check-ignore for gitignored files
    const ALWAYS_HIDDEN = new Set(['.git']);
    const visibleFiles = files.filter(f => !ALWAYS_HIDDEN.has(f.name));

    let ignoredSet = new Set();
    try {
      const { execSync } = await import('child_process');
      const filePaths = visibleFiles.map(f => path.join(relativePath || '.', f.name));
      if (filePaths.length > 0) {
        // git check-ignore returns ignored paths (one per line), exits 1 if none ignored
        const result = execSync(
          `git check-ignore ${filePaths.map(p => `"${p}"`).join(' ')}`,
          { cwd: project.path, encoding: 'utf-8', timeout: 5000 }
        ).trim();
        if (result) {
          for (const line of result.split('\n')) {
            const name = line.trim().split('/').pop();
            if (name) ignoredSet.add(name);
          }
        }
      }
    } catch {
      // Not a git repo or git not available — show all files
    }

    const fileList = visibleFiles
      .filter(f => !ignoredSet.has(f.name))
      .map(file => ({
        name: file.name,
        type: file.isDirectory() ? 'directory' : 'file',
        path: path.join(relativePath, file.name)
      }));

    res.json({
      success: true,
      files: fileList,
      currentPath: relativePath
    });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * GET /api/projects/:id/files/content
 * Get file content
 */
router.get('/:id/files/content', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { path: relativePath } = req.query;

    if (!relativePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const targetPath = path.join(project.path, relativePath);

    // Security check: ensure path is within project directory
    if (!targetPath.startsWith(project.path)) {
      return res.status(403).json({ error: 'Invalid path' });
    }

    const content = await fs.readFile(targetPath, 'utf8');

    res.json({
      success: true,
      content,
      path: relativePath
    });
  } catch (error) {
    console.error('Error reading file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

/**
 * GET /api/projects/:id/files/raw
 * Serve a project file as a raw binary response (for images, etc.)
 */
router.get('/:id/files/raw', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const { path: relativePath } = req.query;

    if (!relativePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const project = await getProjectById(id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const targetPath = path.join(project.path, relativePath);

    // Security: ensure path is within project directory
    if (!targetPath.startsWith(project.path)) {
      return res.status(403).json({ error: 'Invalid path' });
    }

    // Check the file exists
    await fs.access(targetPath);

    res.sendFile(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Error serving raw file:', error);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

/**
 * PUT /api/projects/:id/files/content
 * Update file content
 */
router.put('/:id/files/content', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { path: relativePath, content } = req.body;

    if (!relativePath || content === undefined) {
      return res.status(400).json({ error: 'File path and content are required' });
    }

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const targetPath = path.join(project.path, relativePath);

    // Security check: ensure path is within project directory
    if (!targetPath.startsWith(project.path)) {
      return res.status(403).json({ error: 'Invalid path' });
    }

    await fs.writeFile(targetPath, content, 'utf8');

    // Queue GitHub push sync if enabled (Phase 2: Auto-Push)
    // Uses 2-second debounce to batch rapid file saves
    if (project.github_sync_enabled && project.github_repo_owner && project.github_repo_name) {
      try {
        // Check for pending job in last 2 seconds (debounce)
        const recentJob = await db.query(
          `SELECT id FROM github_sync_queue
           WHERE project_id = $1 AND status = 'pending'
           AND created_at > NOW() - INTERVAL '2 seconds'`,
          [id]
        );

        if (recentJob.rows.length === 0) {
          // No recent pending job - queue new sync
          const fileName = path.basename(relativePath);
          await db.query(
            `INSERT INTO github_sync_queue (project_id, sync_type, commit_message, files_changed, status)
             VALUES ($1, 'push', $2, $3, 'pending')`,
            [
              id,
              `Update ${fileName}\n\nMade via AtlasEngine`,
              JSON.stringify([relativePath]),
            ]
          );
          console.log(`📤 Queued push sync for project ${id} (file: ${relativePath})`);
        } else {
          console.log(`⏳ Debounced sync for project ${id} - recent pending job exists`);
        }
      } catch (syncError) {
        // Log error but don't fail the file save
        console.error('Failed to queue GitHub sync:', syncError.message);
      }
    }

    res.json({
      success: true,
      message: 'File updated successfully',
      path: relativePath
    });
  } catch (error) {
    console.error('Error writing file:', error);
    res.status(500).json({ error: 'Failed to write file' });
  }
});

/**
 * POST /api/projects/:id/ui-edits
 * Persist local UI edits to a project file
 */
router.post('/:id/ui-edits', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const { selection, edits } = req.body;

    if (!selection || !edits) {
      return res.status(400).json({ error: 'Selection and edits are required' });
    }

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const normalizedSelection = normalizeUiSelection(selection);
    const normalizedEdits = normalizeUiEdits(edits);

    if (!normalizedSelection || !normalizedSelection.selector) {
      return res.status(400).json({ error: 'Selection selector is required' });
    }
    if (!normalizedEdits) {
      return res.status(400).json({ error: 'Edits are required' });
    }

    const publicDir = path.join(project.path, 'public');
    await fs.mkdir(publicDir, { recursive: true });

    const editsPath = path.join(publicDir, 'atlas-ui-edits.json');
    const relativePath = 'public/atlas-ui-edits.json';
    let editsFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      edits: [],
    };

    // Capture "before" content for changeset
    let beforeContent = null;
    try {
      const raw = await fs.readFile(editsPath, 'utf8');
      beforeContent = raw;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.edits)) {
        editsFile = parsed;
        editsFile.edits = Array.isArray(parsed.edits) ? parsed.edits : [];
      }
    } catch (error) {
      // File missing or invalid; we'll overwrite with a fresh structure
    }

    const now = new Date().toISOString();
    const entry = {
      selector: normalizedSelection.selector,
      locator: normalizedSelection.locator,
      tagName: normalizedSelection.tagName,
      elementType: normalizedSelection.elementType,
      pageUrl: normalizedSelection.pageUrl,
      edits: normalizedEdits,
      updatedAt: now,
    };

    const existingIndex = editsFile.edits.findIndex(
      (item) => item.selector === normalizedSelection.selector
    );
    if (existingIndex >= 0) {
      editsFile.edits[existingIndex] = {
        ...editsFile.edits[existingIndex],
        ...entry,
      };
    } else {
      editsFile.edits.push(entry);
    }

    editsFile.updatedAt = now;

    const afterContent = JSON.stringify(editsFile, null, 2);
    await fs.writeFile(editsPath, afterContent, 'utf8');

    // Create changeset for the UI edit
    try {
      const changesetTitle = `UI edit: ${normalizedSelection.selector}`;
      await changesetService.createChangeSet(project.path, {
        title: changesetTitle,
        source: 'visual_edit',
        files: [{
          path: relativePath,
          before: beforeContent,
          after: afterContent,
        }],
      });
      console.log(`📋 Created changeset for visual edit: ${changesetTitle}`);
    } catch (changesetErr) {
      console.error('Failed to create changeset for UI edit:', changesetErr.message);
      // Don't fail the request if changeset creation fails
    }

    res.json({
      success: true,
      path: path.relative(project.path, editsPath),
      edit: entry,
    });
  } catch (error) {
    console.error('Error saving UI edits:', error);
    res.status(500).json({ error: 'Failed to save UI edits' });
  }
});

// ============================================================================
// HOSTING MANAGEMENT ENDPOINTS
// These are separate, explicit operations for managing Vercel hosting resources.
// They are intentionally decoupled from project deletion to prevent accidental
// removal of production deployments.
// ============================================================================

/**
 * DELETE /api/projects/:id/hosting/domain
 * Disable production URL by removing the custom domain from Vercel project.
 * The app becomes inaccessible at *.atlasengine.dev but project/deployments remain.
 */
router.delete('/:id/hosting/domain', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!project.vercel_project_id) {
      return res.status(400).json({ error: 'Project has no hosting configured' });
    }

    const subdomain = atlasHostingService.generateSubdomain(project.name, project.id);

    console.log(`🔒 Disabling production URL for project ${id} (${subdomain})...`);

    const result = await atlasHostingService.removeDomainFromProject(
      project.vercel_project_id,
      subdomain
    );

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to disable production URL',
        details: result.error
      });
    }

    console.log(`✅ Production URL disabled for project ${id}`);

    res.json({
      success: true,
      message: 'Production URL disabled. The app is no longer accessible at the custom domain.',
      domain: `${subdomain}.atlasengine.dev`
    });
  } catch (error) {
    console.error('Error disabling production URL:', error);
    res.status(500).json({ error: 'Failed to disable production URL' });
  }
});

/**
 * DELETE /api/projects/:id/hosting
 * Delete Vercel project entirely (nuclear option).
 * Permanently removes the project, all deployments, and domain configurations.
 * Requires confirmation by providing the project slug in the request body.
 */
router.delete('/:id/hosting', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmSlug } = req.body;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!project.vercel_project_id) {
      return res.status(400).json({ error: 'Project has no hosting configured' });
    }

    // Require confirmation by typing the project slug
    const expectedSlug = atlasHostingService.generateSubdomain(project.name, project.id);

    if (!confirmSlug) {
      return res.status(400).json({
        error: 'Confirmation required',
        message: `To delete hosting resources, provide confirmSlug: "${expectedSlug}"`,
        expectedSlug
      });
    }

    if (confirmSlug !== expectedSlug) {
      return res.status(400).json({
        error: 'Confirmation mismatch',
        message: `Expected "${expectedSlug}" but received "${confirmSlug}"`,
        expectedSlug
      });
    }

    console.log(`🗑️ Deleting Vercel project for ${id} (${project.vercel_project_id})...`);

    const result = await atlasHostingService.deleteVercelProject(project.vercel_project_id);

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to delete hosting resources',
        details: result.error
      });
    }

    // Clear Vercel project info from database
    await db.query(
      `UPDATE projects
       SET vercel_project_id = NULL, vercel_project_name = NULL,
           last_deployment_url = NULL, last_deployment_at = NULL
       WHERE id = $1`,
      [id]
    );

    console.log(`✅ Vercel project deleted and database cleared for project ${id}`);

    res.json({
      success: true,
      message: 'Hosting resources permanently deleted. All deployments and domains have been removed.',
      deletedProject: project.vercel_project_id
    });
  } catch (error) {
    console.error('Error deleting hosting resources:', error);
    res.status(500).json({ error: 'Failed to delete hosting resources' });
  }
});

/**
 * GET /api/projects/:id/hosting
 * Get hosting status and information for a project.
 */
router.get('/:id/hosting', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!project.vercel_project_id) {
      return res.json({
        success: true,
        hosting: null,
        message: 'No hosting configured for this project'
      });
    }

    const subdomain = atlasHostingService.generateSubdomain(project.name, project.id);

    res.json({
      success: true,
      hosting: {
        vercelProjectId: project.vercel_project_id,
        vercelProjectName: project.vercel_project_name,
        customDomain: `${subdomain}.atlasengine.dev`,
        lastDeploymentUrl: project.last_deployment_url,
        lastDeploymentAt: project.last_deployment_at
      }
    });
  } catch (error) {
    console.error('Error getting hosting status:', error);
    res.status(500).json({ error: 'Failed to get hosting status' });
  }
});

/**
 * GET /api/projects/:id/git/status
 * Get Git status for a project (branch, dirty, ahead/behind, remote info).
 * Used by GitHub popover for real-time status display.
 */
router.get('/:id/git/status', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const projectPath = project.path;

    // Check if this is a git repository
    const isRepo = await gitService.isGitRepository(projectPath);

    if (!isRepo) {
      return res.json({
        success: true,
        isRepo: false,
        message: 'Not a git repository'
      });
    }

    // Get git status
    const status = await gitService.getStatus(projectPath);

    // Get remote URL (origin)
    let originUrl = null;
    let isGitHub = false;
    let owner = null;
    let repo = null;

    try {
      originUrl = await gitService.getRemoteUrl(projectPath, 'origin');
      // Check if it's a GitHub URL and extract owner/repo
      const githubMatch = originUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (githubMatch) {
        isGitHub = true;
        owner = githubMatch[1];
        repo = githubMatch[2];
      }
    } catch (err) {
      // No remote configured - that's fine
    }

    // Determine if there's an upstream configured
    const hasUpstream = status.ahead !== null && status.behind !== null;

    res.json({
      success: true,
      isRepo: true,
      branch: status.branch,
      originUrl,
      isGitHub,
      owner,
      repo,
      dirty: !status.isClean,
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      hasUpstream,
      modified: status.modified.length,
      created: status.created.length,
      deleted: status.deleted.length,
      staged: status.staged.length,
      conflicted: status.conflicted.length
    });
  } catch (error) {
    console.error('Error getting git status:', error);
    res.status(500).json({ error: 'Failed to get git status', details: error.message });
  }
});

// ============================================================================
// Open Local Folder
// ============================================================================

/**
 * POST /api/projects/open-local
 * Import a local folder as a project (for trust pipeline).
 * Detects git and creates the project record without mutating the user's repo.
 */
router.post('/open-local', async (req, res) => {
  try {
    const { localPath, name } = req.body;
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    if (!localPath) {
      return res.status(400).json({ error: 'localPath is required' });
    }

    // Normalize path to prevent duplicates from trailing slashes / relative segments
    const normalizedPath = path.resolve(localPath);

    // Validate path exists
    try {
      const stat = await fs.stat(normalizedPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
    } catch {
      return res.status(400).json({ error: 'Directory does not exist' });
    }

    // Check if a project with this path already exists
    const existing = await getProjectByPath(normalizedPath);
    if (existing) {
      await updateProjectLastAccessed(existing.id);
      let hasGit = false;
      try {
        await fs.access(path.join(normalizedPath, '.git'));
        hasGit = true;
      } catch { /* not a git repo */ }
      return res.json({
        success: true,
        alreadyExists: true,
        project: {
          id: existing.id,
          sessionId: existing.session_id,
          name: existing.name,
          description: existing.description,
          hasGit,
          branch: null,
          watching: false,
          createdAt: existing.created_at,
        },
      });
    }

    // Atlas only works with projects under git tracking. Require .git at the
    // selected path before creating a new project. If the user picked a
    // subfolder of a git repo, point them at the repo root.
    const gitRoot = await findGitRootAtOrAbove(normalizedPath);
    if (gitRoot !== normalizedPath) {
      if (gitRoot) {
        return res.status(400).json({
          error: `The selected folder is inside a git repository but is not its root. Please add the repository root instead: ${gitRoot}`,
          errorCode: 'NOT_GIT_ROOT',
          suggestedRoot: gitRoot,
        });
      }
      return res.status(400).json({
        error: 'This folder is not a git repository. Atlas only works with git-tracked projects. Please choose a folder that is a git repository, or run `git init` inside it first.',
        errorCode: 'NOT_A_GIT_REPO',
      });
    }

    // Selected path is a git repo root — gather branch/SHA for bootstrap.
    const isGitRepo = true;
    let branch = null;
    let commitSha = null;
    try {
      branch = await gitService.getCurrentBranch(normalizedPath);
      commitSha = await gitService.getCurrentSHA(normalizedPath);
    } catch (error) {
      console.warn(`[projects] git rev-parse failed for ${normalizedPath}:`, error.message);
    }

    let startupBaseBranch = null;
    if (isGitRepo) {
      startupBaseBranch = await resolveStartupBaseBranch(normalizedPath);
    }

    // Derive project name from folder name if not provided
    const projectName = name || path.basename(normalizedPath);
    const sessionId = uuidv4();

    // Create project in database pointing to the local path
    const generatedReviewPolicy = createGeneratedProjectReviewPolicyBaseline(normalizedPath);
    const project = await createProject({
      userId,
      sessionId,
      name: projectName,
      description: `Imported from local folder: ${normalizedPath}`,
      path: normalizedPath,
      framework: null,
      language: null,
      source: 'local',
      generatedReviewPolicyJson: generatedReviewPolicy.content.trim(),
      generatedReviewPolicyHash: generatedReviewPolicy.hash,
      generatedReviewPolicyVersion: generatedReviewPolicy.version,
      generatedReviewPolicyGeneratorVersion: generatedReviewPolicy.generatorVersion,
      generatedReviewPolicyGeneratedAt: generatedReviewPolicy.generatedAt,
    });

    await persistDetectedProjectBaseBranch(project.id, startupBaseBranch);

    if (project.codegraph_enabled) {
      initCodegraphIndex({ projectId: project.id, projectPath: normalizedPath })
        .then((result) => {
          if (!result?.ok) {
            console.warn(`[codegraph] auto-init prep failed for project ${project.id}: ${result?.error || 'unknown error'}`);
          }
        })
        .catch((err) => {
          console.warn(`[codegraph] auto-init threw for project ${project.id}: ${err?.message || err}`);
        });
    }

    bootstrapOpenedLocalProject({
      normalizedPath,
      branch,
      commitSha,
    });

    let watching = false;
    if (isGitRepo) {
      try {
        watching = await gitWatcherService.startWatching(project.id, normalizedPath, {
          branch,
          baseBranch: startupBaseBranch,
          awaitInitialBranchSwitch: true,
        });
      } catch (watchError) {
        console.warn('Could not start watcher:', watchError.message);
      }
    }

    res.status(201).json({
      success: true,
      project: {
        id: project.id,
        sessionId: project.session_id,
        name: project.name,
        description: project.description,
        hasGit: isGitRepo,
        branch,
        watching,
        createdAt: project.created_at,
      },
    });
  } catch (error) {
    console.error('Error opening local folder:', error);
    res.status(500).json({ error: 'Failed to open local folder', details: error.message });
  }
});

router.post('/open-local/dialog', async (_req, res) => {
  try {
    const localPath = await openNativeDirectoryPicker();
    if (!localPath) {
      return res.json({ success: true, cancelled: true, localPath: null });
    }
    res.json({ success: true, cancelled: false, localPath });
  } catch (error) {
    if (error?.code === 'PICKER_CANCELED' || parsePickerCancellation(error)) {
      return res.json({ success: true, cancelled: true, localPath: null });
    }
    if (error?.code === 'PICKER_UNSUPPORTED') {
      return res.status(501).json({ error: error.message });
    }
    console.error('Error opening native folder picker:', error);
    res.status(500).json({ error: 'Failed to open folder picker', details: error.message });
  }
});

// ============================================================================
// Git Watcher Routes
// ============================================================================

/**
 * POST /api/projects/:id/watcher/start
 * Start watching a project for git changes
 */
router.post('/:id/watcher/start', async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { branch } = req.body;
    const startupBaseBranch = project.base_branch_display || await resolveStartupBaseBranch(project.path);
    await persistDetectedProjectBaseBranch(project.id, startupBaseBranch);
    const started = await gitWatcherService.startWatching(project.id, project.path, {
      branch,
      baseBranch: startupBaseBranch,
      awaitInitialBranchSwitch: true,
    });

    res.json({
      success: true,
      watching: started,
      status: gitWatcherService.getStatus(project.id),
    });
  } catch (error) {
    console.error('Error starting watcher:', error);
    res.status(500).json({ error: 'Failed to start watcher', details: error.message });
  }
});

/**
 * POST /api/projects/:id/watcher/stop
 * Stop watching a project
 */
router.post('/:id/watcher/stop', async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const stopped = gitWatcherService.stopWatching(project.id);
    res.json({ success: true, stopped });
  } catch (error) {
    console.error('Error stopping watcher:', error);
    res.status(500).json({ error: 'Failed to stop watcher', details: error.message });
  }
});

/**
 * GET /api/projects/:id/watcher/status
 * Get watcher status for a project
 */
router.get('/:id/watcher/status', async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const status = gitWatcherService.getStatus(project.id);
    res.json({
      success: true,
      watching: !!status,
      status: status || { projectId: project.id, watching: false },
    });
  } catch (error) {
    console.error('Error getting watcher status:', error);
    res.status(500).json({ error: 'Failed to get watcher status', details: error.message });
  }
});

/**
 * POST /api/projects/:id/watcher/sync
 * Manual "Sync Now" — immediately poll for changes
 */
router.post('/:id/watcher/sync', async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // If not watching yet, start watching first
    if (!gitWatcherService.isWatching(project.id)) {
      const startupBaseBranch = project.base_branch_display || await resolveStartupBaseBranch(project.path);
      await persistDetectedProjectBaseBranch(project.id, startupBaseBranch);
      await gitWatcherService.startWatching(project.id, project.path, {
        baseBranch: startupBaseBranch,
        awaitInitialBranchSwitch: true,
      });
    }

    const synced = await gitWatcherService.syncNow(project.id);
    res.json({
      success: true,
      synced,
      status: gitWatcherService.getStatus(project.id),
    });
  } catch (error) {
    console.error('Error syncing watcher:', error);
    res.status(500).json({ error: 'Failed to sync', details: error.message });
  }
});

// GET /api/projects/:id/archive — Download project as tar.gz for cloud deployment
router.get('/:id/archive', async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Use the actual project path from DB, not a relative path
    const projectPath = project.path || path.join(process.cwd(), 'projects', project.id);

    const { execSync } = await import('child_process');
    const fs = await import('fs');
    const os = await import('os');

    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: 'Project directory not found' });
    }

    const tarPath = path.join(os.tmpdir(), `atlas-archive-${Date.now()}.tar.gz`);

    // Try git archive first, fall back to direct tar
    let useGit = false;
    try {
      if (fs.existsSync(path.join(projectPath, '.git'))) {
        execSync('git --version', { timeout: 5000 });
        useGit = true;
      }
    } catch { /* git not available, use direct tar */ }

    let archived = false;
    if (useGit) {
      try {
        const commitHash = req.query.commit || 'HEAD';
        // Validate commit hash to prevent shell injection (allow hex SHAs, HEAD, branch names)
        if (!/^[a-zA-Z0-9_.\-\/]+$/.test(commitHash)) {
          return res.status(400).json({ error: 'Invalid commit reference' });
        }
        // Use pipefail so the pipeline fails if git archive fails
        execSync(`set -o pipefail; git archive "${commitHash}" | gzip > "${tarPath}"`, {
          cwd: projectPath,
          timeout: 60000,
          shell: '/bin/bash',
        });
        // Double-check: empty gzip is ~20 bytes
        if (fs.statSync(tarPath).size > 100) {
          archived = true;
        }
      } catch {
        // git archive failed (e.g., no commits yet), fall through to direct tar
      }
    }

    if (!archived) {
      // Direct tar — exclude node_modules, .git, and other large dirs
      execSync(
        `tar czf "${tarPath}" --exclude=node_modules --exclude=.git --exclude=dist --exclude=build -C "${projectPath}" .`,
        { timeout: 60000 }
      );
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name || project.id}.tar.gz"`);

    const stream = fs.createReadStream(tarPath);
    stream.pipe(res);
    stream.on('end', async () => {
      try {
        const fsPromises = await import('fs/promises');
        await fsPromises.rm(tarPath, { force: true });
      } catch { /* cleanup best-effort */ }
    });
  } catch (error) {
    console.error('Error creating project archive:', error);
    res.status(500).json({ error: 'Failed to create archive', details: error.message });
  }
});

export default router;
