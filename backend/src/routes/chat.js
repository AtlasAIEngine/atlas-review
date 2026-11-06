/**
 * Chat API Routes
 * Endpoints for Claude Code chat functionality
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import claudeService from '../services/claudeService.js';
import reviewSyncService from '../services/reviewSyncService.js';
import gitService from '../services/gitService.js';
import { getSlashCommands, resolveSlashCommand } from '../services/slashCommandService.js';
import {
  getProjectById,
  getChatHistory,
  clearChatHistory,
  getChatStats,
  saveChatMessage,
  searchChatMessages
} from '../db/queries.js';
import logger from '../utils/logger.js';
import {
  formatUiEditsContext,
  formatUiSelectionContext,
  normalizeUiEdits,
  normalizeUiSelection,
} from '../utils/uiSelection.js';

const router = express.Router();

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const { projectId } = req.params;
      const uploadDir = path.join(process.cwd(), 'projects', projectId, 'uploads');

      // Create uploads directory if it doesn't exist
      await fs.mkdir(uploadDir, { recursive: true });

      cb(null, uploadDir);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: (req, file, cb) => {
    // Use timestamp + original filename to avoid collisions
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

// File filter: Allow images and documents
const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  // Documents
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
  'application/pdf',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: images (JPEG, PNG, GIF, WebP) and documents (TXT, MD, PDF, DOC, DOCX, CSV, JSON, HTML, CSS, XLS, XLSX).'), false);
  }
};

// Multer upload middleware
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB limit
    files: 20 // Max 20 files per request
  }
});

/**
 * POST /api/chat/sessions/:projectId/init
 * Initialize a Claude Code session for a project
 */
router.post('/sessions/:projectId/init', async (req, res) => {
  try {
    const { projectId } = req.params;
    // Use anonymous user ID for MVP mode when not authenticated
    const userId = req.user?.id || req.body.userId || '00000000-0000-0000-0000-000000000000';

    // Get project details
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Verify user owns the project (use user_id from database, not userId)
    if (project.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Initialize session (use 'path' from database, not 'projectPath')
    const projectPath = project.path || `/var/atlasengine/projects/${projectId}`;
    const session = await claudeService.initializeSession(projectId, projectPath, userId);

    res.json({
      success: true,
      session: {
        projectId: session.projectId,
        startedAt: session.startedAt,
        isActive: session.isActive,
      },
    });
  } catch (error) {
    logger.error(`Failed to initialize chat session: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/chat/sessions/:projectId/upload
 * Upload files (images) for use in chat messages
 */
router.post('/sessions/:projectId/upload', upload.array('files', 20), async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id || req.body.userId || '00000000-0000-0000-0000-000000000000'; // Default to all-zeros UUID for MVP

    // Verify project exists and user owns it
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Database uses snake_case (user_id) not camelCase (userId)
    // For MVP, also accept if project uses the default all-zeros UUID
    const isAuthorized = project.user_id === userId ||
                         project.user_id === '00000000-0000-0000-0000-000000000000';

    if (!isAuthorized) {
      logger.warn(`Upload auth failed: project.user_id=${project.user_id}, userId=${userId}`);
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    // Return file metadata
    const files = req.files.map((file) => ({
      filename: file.filename,
      originalName: file.originalname,
      path: file.path,
      mimetype: file.mimetype,
      size: file.size,
      // Relative path for easier frontend access
      relativePath: path.join('uploads', file.filename),
    }));

    logger.info(`Uploaded ${files.length} file(s) for project ${projectId}`);

    res.json({
      success: true,
      files,
      count: files.length,
    });
  } catch (error) {
    logger.error(`Failed to upload files: ${error.message}`);

    // Handle multer errors
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File size exceeds 3.75 MB limit',
      });
    }

    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Too many files. Maximum 20 files allowed per upload',
      });
    }

    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/chat/sessions/:projectId/system-message
 * Persist a system message without invoking Claude
 */
router.post('/sessions/:projectId/system-message', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { content, tone, meta } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ success: false, error: 'Content is required' });
    }

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const normalizedTone =
      tone && ['success', 'error'].includes(tone) ? tone : null;
    const mergedMeta = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      ...(normalizedTone ? { tone: normalizedTone } : {}),
    };

    const saved = await saveChatMessage({
      projectId,
      userId: project.user_id,
      role: 'system',
      content,
      tokensUsed: 0,
      model: null,
      meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : null,
    });

    res.json({ success: true, message: saved });
  } catch (error) {
    logger.error(`Failed to save system message: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/chat/sessions/:projectId/message
 * Send a message to Claude (with optional file attachments)
 */
router.post('/sessions/:projectId/message', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { message, attachments, uiSelection, uiEdits, model, providerType } = req.body; // attachments is an array of file paths, model and providerType are optional
    const userId = req.user?.id || req.body.userId;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    // Check if session exists, initialize if needed
    if (!claudeService.isSessionActive(projectId)) {
      const project = await getProjectById(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const projectPath = project.path || project.projectPath || `/var/atlasengine/projects/${projectId}`;
      await claudeService.initializeSession(projectId, projectPath, userId);
    }

    const project = await getProjectById(projectId);
    const projectPath = project?.path || project?.projectPath || `/var/atlasengine/projects/${projectId}`;
    const commandResolution = await resolveSlashCommand({ input: message, projectPath });
    if (commandResolution.isCommand && commandResolution.type === 'builtin') {
      return res.status(400).json({
        success: false,
        error: `Built-in command ${commandResolution.command} is not supported in AtlasEngine chat yet.`,
      });
    }

    const resolvedMessage = commandResolution.isCommand ? commandResolution.prompt : message;
    const normalizedSelection = normalizeUiSelection(uiSelection);
    const normalizedEdits = normalizeUiEdits(uiEdits);
    const selectionContext = formatUiSelectionContext(normalizedSelection);
    const editsContext = formatUiEditsContext(normalizedEdits);
    const contextBlocks = [selectionContext, editsContext].filter(Boolean);
    const finalMessage =
      contextBlocks.length > 0
        ? `${resolvedMessage}\n\n${contextBlocks.join('\n\n')}`
        : resolvedMessage;

    // Send message with optional attachments, model selection, and provider type
    const response = await claudeService.sendMessage(projectId, finalMessage, attachments, { model, providerType });

    // Fire-and-forget analytics: queue a chat_message_sent event so the
    // admin dashboard can surface AI Chat usage. Never block the response
    // on this; never fail the request if analytics has a hiccup.
    Promise.resolve().then(async () => {
      try {
        let repoRemoteUrl = null;
        if (project?.path) {
          try { repoRemoteUrl = await gitService.getRemoteUrl(project.path); } catch { /* no remote */ }
        }
        await reviewSyncService.queueEvent(
          reviewSyncService.buildChatMessageSentEvent({
            userId: project?.user_id || userId || null,
            projectId,
            projectName: project?.name || null,
            projectPath: project?.path || null,
            providerType: providerType || null,
            providerModel: model || null,
            messageLength: typeof message === 'string' ? message.length : 0,
            attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
            hasUiSelection: Boolean(normalizedSelection),
            hasUiEdits: Boolean(normalizedEdits),
            isSlashCommand: Boolean(commandResolution.isCommand),
            repoRemoteUrl,
          })
        );
      } catch (analyticsError) {
        logger.warn(`[chat-analytics] Failed to queue chat_message_sent: ${analyticsError?.message || analyticsError}`);
      }
    });

    res.json(response);
  } catch (error) {
    logger.error(`Failed to send message: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/chat/sessions/:projectId/history
 * Get message history for a session (from database)
 */
router.get('/sessions/:projectId/history', async (req, res) => {
  try {
    const { projectId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offsetParam = parseInt(req.query.offset) || 0;
    const latest = req.query.latest === 'true' || req.query.latest === '1';

    const stats = await getChatStats(projectId);
    const totalMessages = Number(stats?.total_messages) || 0;
    const offset = latest ? Math.max(totalMessages - limit, 0) : offsetParam;

    // Get persistent history from database
    const history = await getChatHistory(projectId, limit, offset);

    res.json({
      success: true,
      messages: history,
      count: history.length,
      total: totalMessages,
      offset,
    });
  } catch (error) {
    logger.error(`Failed to get message history: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/chat/sessions/:projectId/search
 * Search chat messages for a project
 */
router.get('/sessions/:projectId/search', async (req, res) => {
  try {
    const { projectId } = req.params;
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ success: true, results: [] });
    }
    const results = await searchChatMessages(projectId, q, 50);
    res.json({ success: true, results });
  } catch (error) {
    logger.error(`Failed to search messages: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/chat/sessions/:projectId/commands
 * Get available slash commands (built-in + custom) for a project
 */
router.get('/sessions/:projectId/commands', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const projectPath = project.path || project.projectPath || `/var/atlasengine/projects/${projectId}`;
    const commands = (await getSlashCommands(projectPath)).map(
      ({ prompt, allowedTools, hooks, sourcePath, model, disableModelInvocation, ...rest }) => rest
    );
    res.json({ success: true, commands });
  } catch (error) {
    logger.error(`Failed to load slash commands: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/chat/sessions/:projectId/history
 * Clear message history for a session (both database and in-memory)
 */
router.delete('/sessions/:projectId/history', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Clear in-memory history
    claudeService.clearHistory(projectId);

    // Clear persistent history from database
    const deletedCount = await clearChatHistory(projectId);

    // Also delete uploaded attachments
    try {
      const uploadsDir = path.join(process.cwd(), 'projects', projectId, 'uploads');
      const entries = await fs.readdir(uploadsDir).catch(() => []);
      for (const entry of entries) {
        await fs.unlink(path.join(uploadsDir, entry)).catch(() => {});
      }
      if (entries.length > 0) {
        logger.info(`Deleted ${entries.length} attachment(s) for project ${projectId}`);
      }
    } catch (attachErr) {
      logger.warn(`Failed to delete attachments for ${projectId}: ${attachErr.message}`);
    }

    let cliContextReset = false;
    try {
      // Also reset provider CLI sessions so the next message starts fresh for Claude/Codex/Gemini.
      await claudeService.resetCliSession(projectId);
      cliContextReset = true;
    } catch (resetError) {
      logger.warn(`Chat history cleared but failed to reset CLI session for ${projectId}: ${resetError.message}`);
    }

    res.json({
      success: true,
      message: cliContextReset
        ? 'Message history cleared and CLI context reset'
        : 'Message history cleared',
      deletedCount,
      cliContextReset,
    });
  } catch (error) {
    logger.error(`Failed to clear message history: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/chat/sessions/:projectId/stats
 * Get session statistics (from database and active session)
 */
router.get('/sessions/:projectId/stats', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get persistent stats from database
    const dbStats = await getChatStats(projectId);

    // Get active session stats if session exists
    const sessionStats = claudeService.getSessionStats(projectId);

    res.json({
      success: true,
      stats: {
        // Persistent stats (database)
        persistent: dbStats,
        // Active session stats (in-memory)
        session: sessionStats,
      },
    });
  } catch (error) {
    logger.error(`Failed to get session stats: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/chat/sessions/:projectId
 * End a Claude Code session
 */
router.delete('/sessions/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    await claudeService.endSession(projectId);

    res.json({
      success: true,
      message: 'Session ended',
    });
  } catch (error) {
    logger.error(`Failed to end session: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
