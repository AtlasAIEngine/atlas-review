/**
 * Claude Code Service
 * Integration with Claude Code CLI for AI-powered development assistance
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import logger from '../utils/logger.js';
import memoryService from './memoryService.js';
import { getUserQuotas, logUsage, saveChatMessage, getChatHistory, updateProject, getProjectById } from '../db/queries.js';
import { getAdapter } from './cliAdapters/index.js';

class ClaudeService extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // projectId -> session data
    this.commandQueue = new Map(); // projectId -> queue of commands
  }

  /**
   * Initialize Claude Code session for a project
   * @param {string} projectId - Project ID
   * @param {string} projectPath - Absolute path to project directory
   * @param {string} userId - User ID for quota enforcement
   * @param {Object} [project] - Project row from DB (for reading cli_sessions / cli_session_id)
   * @returns {Promise<Object>} Session info
   */
  async initializeSession(projectId, projectPath, userId, project = null) {
    try {
      // Check if session already exists
      if (this.sessions.has(projectId)) {
        logger.info(`Claude session already exists for project ${projectId}`);
        return this.sessions.get(projectId);
      }

      // Check user quotas before starting (skip if no userId or no quotas found)
      if (userId) {
        const quotas = await getUserQuotas(userId);
        if (quotas && quotas.quota_exceeded) {
          throw new Error('User quota exceeded. Cannot start Claude session.');
        }
      }

      // Only auto-bootstrap CLAUDE.md for builder-source projects. Imported
      // projects (local folder / GitHub clone) are left untouched — users opt in
      // via the Agent Rules modal.
      let projectSource = project?.source;
      if (!projectSource) {
        try {
          const fetched = await getProjectById(projectId);
          projectSource = fetched?.source;
        } catch (lookupError) {
          logger.warn(`Could not resolve project source for ${projectId}: ${lookupError.message}`);
        }
      }
      if (projectSource === 'builder') {
        const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
        try {
          await fs.access(claudeMdPath);
        } catch (error) {
          logger.info(`CLAUDE.md not found, initializing for builder project ${projectId}`);
          await memoryService.initializeMemory(projectId, projectPath, path.basename(projectPath), userId);
        }
      }

      // Load per-provider session IDs from DB
      // cli_sessions is JSON: {"anthropic": "uuid-A", "openai": "uuid-B"}
      let cliSessionIds = {};
      const cliSessionReady = {};
      const rawCliSessions = project?.cli_sessions;
      if (rawCliSessions) {
        try {
          cliSessionIds = typeof rawCliSessions === 'string'
            ? JSON.parse(rawCliSessions)
            : rawCliSessions;
        } catch {
          cliSessionIds = {};
        }
      }

      // Backward compat: migrate cli_session_id → cli_sessions.anthropic
      if (!cliSessionIds.anthropic && project?.cli_session_id) {
        cliSessionIds.anthropic = project.cli_session_id;
        try {
          await updateProject(projectId, { cli_sessions: JSON.stringify(cliSessionIds) });
          logger.info(`Migrated cli_session_id to cli_sessions for project ${projectId}`);
        } catch (error) {
          logger.warn(`Failed to migrate cli_session_id: ${error.message}`);
        }
      }

      // Mark providers with existing session IDs as ready for --resume
      for (const provider of Object.keys(cliSessionIds)) {
        if (cliSessionIds[provider]) {
          cliSessionReady[provider] = true;
        }
      }

      logger.info(`Session IDs loaded for project ${projectId}: ${JSON.stringify(cliSessionIds)}`);

      // Create session data
      const now = Date.now();
      const session = {
        projectId,
        projectPath,
        userId,
        cliSessionIds,     // { anthropic: "uuid", openai: "uuid" }
        cliSessionReady,   // { anthropic: true, openai: false }
        lastCliProvider: project?.last_cli_provider || null,
        startedAt: new Date(),
        startTime: now,
        lastActivity: now,
        messageCount: 0,
        tokensUsed: 0,
        isActive: true,
        hasActiveRun: false,
        runStartedAt: null,
        claudeProcess: null,
        messageHistory: [],
        toolUseEvents: [],
      };

      this.sessions.set(projectId, session);
      this.commandQueue.set(projectId, []);

      logger.info(`Session initialized for project ${projectId}`);
      return session;
    } catch (error) {
      logger.error(`Failed to initialize session: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reset CLI session for a project (start a new conversation).
   * Resets ALL providers' sessions by default, or a specific provider.
   * @param {string} projectId - Project ID
   * @param {string} [providerType] - Specific provider to reset (e.g. 'anthropic', 'openai'), or null for all
   * @returns {Promise<void>}
   */
  async resetCliSession(projectId, providerType = null) {
    const session = this.sessions.get(projectId);

    if (session) {
      // Generate session summary before resetting
      if (session.toolUseEvents.length > 0) {
        try {
          await memoryService.analyzeAndUpdateFromToolUse(
            projectId,
            session.projectPath,
            session.userId,
            session.toolUseEvents,
            `Session reset after ${session.messageCount} messages`,
            ''
          );
        } catch (error) {
          logger.warn(`Failed to generate session summary on reset: ${error.message}`);
        }
      }

      if (providerType) {
        // Reset a single provider's session
        session.cliSessionIds[providerType] = null;
        session.cliSessionReady[providerType] = false;
      } else {
        // Reset all providers
        session.cliSessionIds = {};
        session.cliSessionReady = {};
      }

      session.messageHistory = [];
      session.messageCount = 0;
      session.tokensUsed = 0;
      session.toolUseEvents = [];
    }

    // Persist to DB
    try {
      const updates = {
        cli_sessions: JSON.stringify(session?.cliSessionIds || {}),
      };
      if (!providerType) {
        // Full reset: also clear legacy column
        updates.cli_session_id = null;
      }
      await updateProject(projectId, updates);
    } catch (error) {
      logger.warn(`Failed to persist session reset: ${error.message}`);
    }

    logger.info(`Reset CLI session for project ${projectId}${providerType ? ` (provider: ${providerType})` : ' (all providers)'}`);
  }

  /**
   * Clear only a provider's native resume handle without resetting Atlas chat
   * counters or tool-use memory. Used when switching providers: Atlas passes
   * recent chat context explicitly, while the new provider should start a
   * fresh native CLI thread.
   * @param {string} projectId - Project ID
   * @param {string} providerType - Provider type
   * @returns {Promise<void>}
   */
  async clearProviderSession(projectId, providerType) {
    const session = this.sessions.get(projectId);
    if (!session || !providerType) return;

    session.cliSessionIds[providerType] = null;
    session.cliSessionReady[providerType] = false;

    try {
      await updateProject(projectId, {
        cli_sessions: JSON.stringify(session.cliSessionIds || {}),
        cli_session_id: session.cliSessionIds?.anthropic || null,
      });
    } catch (error) {
      logger.warn(`Failed to persist cleared ${providerType} session: ${error.message}`);
    }

    logger.info(`Cleared ${providerType} CLI resume session for project ${projectId}`);
  }

  /**
   * Get or create a session ID for a specific provider.
   * For Claude (anthropic), generates a UUID upfront.
   * For Codex (openai), returns null — Codex generates its own session ID
   * which we capture from the session_meta stream event.
   * @param {string} projectId - Project ID
   * @param {string} providerType - Provider type ('anthropic', 'openai', 'google')
   * @returns {string|null} Session ID or null if provider manages its own
   */
  getOrCreateSessionId(projectId, providerType) {
    const session = this.sessions.get(projectId);
    if (!session) return null;

    const existing = session.cliSessionIds[providerType];
    if (existing) return existing;

    // Only pre-generate session IDs for Claude (it needs --session-id upfront)
    if (providerType === 'anthropic') {
      const newId = randomUUID();
      session.cliSessionIds[providerType] = newId;
      session.cliSessionReady[providerType] = false;
      // Persist asynchronously
      this._persistSessionIds(projectId, session.cliSessionIds);
      logger.info(`Generated new Claude session ID for project ${projectId}: ${newId}`);
      return newId;
    }

    // For Codex/other providers: no upfront session ID
    // The session ID comes from the CLI's stream output (session_meta event)
    return null;
  }

  /**
   * Store a provider-captured session ID (e.g., from Codex session_meta event).
   * @param {string} projectId - Project ID
   * @param {string} providerType - Provider type ('anthropic', 'openai', 'google')
   * @param {string} sessionId - Session ID captured from CLI output
   */
  setProviderSessionId(projectId, providerType, sessionId) {
    const session = this.sessions.get(projectId);
    if (!session) return;

    session.cliSessionIds[providerType] = sessionId;
    // Don't mark ready yet — that happens after the full message succeeds
    logger.info(`Captured ${providerType} session ID for project ${projectId}: ${sessionId}`);
    this._persistSessionIds(projectId, session.cliSessionIds);
  }

  /**
   * Mark a provider's session as ready for resume (after first successful message).
   * @param {string} projectId - Project ID
   * @param {string} providerType - Provider type
   */
  markProviderSessionReady(projectId, providerType) {
    const session = this.sessions.get(projectId);
    if (!session) return;
    session.cliSessionReady[providerType] = true;
  }

  /**
   * Check if a provider's session is ready for resume.
   * @param {string} projectId - Project ID
   * @param {string} providerType - Provider type
   * @returns {boolean}
   */
  isProviderSessionReady(projectId, providerType) {
    const session = this.sessions.get(projectId);
    if (!session) return false;
    return !!session.cliSessionReady[providerType];
  }

  /**
   * Persist per-provider session IDs to DB (fire-and-forget).
   * @private
   */
  _persistSessionIds(projectId, cliSessionIds) {
    updateProject(projectId, {
      cli_sessions: JSON.stringify(cliSessionIds),
      // Also keep legacy cli_session_id in sync for backward compat
      cli_session_id: cliSessionIds.anthropic || null,
    }).catch(error => {
      logger.warn(`Failed to persist session IDs: ${error.message}`);
    });
  }

  /**
   * Send a message to Claude Code CLI
   * @param {string} projectId - Project ID
   * @param {string} message - User message
   * @param {Array<string>} attachments - Optional array of file paths (images)
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Response from Claude
   */
  async sendMessage(projectId, message, attachments = [], options = {}) {
    try {
      const session = this.sessions.get(projectId);
      if (!session) {
        throw new Error('Session not initialized. Call initializeSession first.');
      }

      if (!session.isActive) {
        throw new Error('Session is not active');
      }

      // Check quotas before processing (skip if no userId or no quotas found)
      if (session.userId) {
        const quotas = await getUserQuotas(session.userId);
        if (quotas && quotas.quota_exceeded) {
          throw new Error('Quota exceeded');
        }
      }

      this.setRunActive(projectId, true);

      // Add user message to history
      const userMessage = {
        role: 'user',
        content: message,
        timestamp: new Date(),
        attachments: attachments || [],
      };
      session.messageHistory.push(userMessage);

      // Persist user message to database
      try {
        await saveChatMessage({
          projectId,
          userId: session.userId,
          role: 'user',
          content: message,
          tokensUsed: 0, // User messages don't consume tokens
          model: null,
          meta: attachments && attachments.length > 0 ? { attachments } : null,
        });
      } catch (error) {
        logger.error(`Failed to save user message to database: ${error.message}`);
        // Continue even if database save fails
      }

      // Emit typing event
      this.emit('ai-typing', { projectId });

      // Execute Claude Code CLI command with attachments
      const response = await this._executeClaudeCommand(projectId, message, attachments, options);

      // Add assistant response to history
      const assistantMessage = {
        role: 'assistant',
        content: response.content,
        timestamp: new Date(),
      };
      session.messageHistory.push(assistantMessage);

      // Persist assistant message to database
      try {
        await saveChatMessage({
          projectId,
          userId: session.userId,
          role: 'assistant',
          content: response.content,
          tokensUsed: response.tokensUsed || 0,
          model: response.model || 'claude-3-sonnet',
          meta: null,
        });
      } catch (error) {
        logger.error(`Failed to save assistant message to database: ${error.message}`);
        // Continue even if database save fails
      }

      // Update session stats
      session.messageCount++;
      session.tokensUsed += response.tokensUsed || 0;
      this.markSessionActivity(projectId);
      this.setRunActive(projectId, false);

      // Log usage
      await logUsage({
        userId: session.userId,
        projectId,
        kind: 'tokens',
        amount: response.tokensUsed || 0,
        cost: (response.tokensUsed || 0) * 0.000001, // Approximate cost
        meta: {
          model: response.model || 'claude-3-sonnet',
          messageLength: message.length,
        },
      });

      // Update CLAUDE.md via intelligent tool-use analysis periodically
      if (session.messageCount % 5 === 0 && session.toolUseEvents.length > 0) {
        try {
          await memoryService.analyzeAndUpdateFromToolUse(
            projectId,
            session.projectPath,
            session.userId,
            session.toolUseEvents,
            message,
            response.content
          );
          session.toolUseEvents = []; // Reset after analysis
        } catch (error) {
          logger.warn(`Failed to update memory from tool use: ${error.message}`);
        }
      }

      return {
        success: true,
        message: response.content,
        tokensUsed: response.tokensUsed,
        model: response.model,
      };
    } catch (error) {
      this.setRunActive(projectId, false);
      logger.error(`Failed to send message to Claude: ${error.message}`);
      this.emit('ai-error', { projectId, error: error.message });
      throw error;
    }
  }

  /**
   * Execute CLI command using the adapter pattern.
   * Resolves the correct CLI adapter based on providerType, uses findBinary + buildArgs,
   * and handles stdin-based message passing for adapters that require it.
   * @private
   * @param {string} projectId - Project ID
   * @param {string} message - User message
   * @param {Array<string>} attachments - Optional file path attachments
   * @param {Object} options - { timeout, model, permissionMode, providerType }
   */
  async _executeClaudeCommand(projectId, message, attachments = [], options = {}) {
    const session = this.sessions.get(projectId);
    const { timeout: timeoutMs, model, permissionMode, providerType } = options;

    // Resolve the adapter for the requested provider (default: anthropic)
    const resolvedProvider = providerType || 'anthropic';
    const adapter = getAdapter(resolvedProvider);

    // Find the CLI binary via the adapter
    const binaryPath = await adapter.findBinary();

    // Get or create session ID for this provider
    const sessionId = this.getOrCreateSessionId(projectId, resolvedProvider);
    const resumeSession = this.isProviderSessionReady(projectId, resolvedProvider);

    // Build CLI args via the adapter
    const adapterResult = adapter.buildArgs({
      message,
      sessionId,
      model,
      resumeSession,
    });

    return new Promise((resolve, reject) => {
      const timeout = timeoutMs || 120000; // 2 minutes default
      let response = '';
      let errorOutput = '';

      logger.info(`Spawning ${adapter.getName()} CLI: ${binaryPath} ${adapterResult.args.join(' ')}`);

      const cliProcess = spawn(binaryPath, adapterResult.args, {
        cwd: session.projectPath,
        env: {
          ...process.env,
        },
      });

      // Prefer adapter-provided stdin payload, but fall back to the original
      // message so stdin-based adapters cannot silently drop prompts.
      if (adapterResult.stdinMessage) {
        cliProcess.stdin.on('error', () => {}); // Prevent unhandled stream error if child exits early
        cliProcess.stdin.write(adapterResult.message ?? message);
        cliProcess.stdin.end();
      }

      const timeoutHandle = setTimeout(() => {
        cliProcess.kill();
        reject(new Error(`${adapter.getName()} command timed out`));
      }, timeout);

      cliProcess.stdout.on('data', (data) => {
        response += data.toString();
      });

      cliProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
        logger.warn(`${adapter.getName()} stderr: ${data.toString()}`);
      });

      cliProcess.on('close', (code) => {
        clearTimeout(timeoutHandle);

        if (code !== 0) {
          reject(new Error(`${adapter.getName()} process exited with code ${code}: ${errorOutput}`));
          return;
        }

        // Mark session as ready for resume after first successful message
        this.markProviderSessionReady(projectId, resolvedProvider);

        try {
          // Parse JSON response
          const parsed = JSON.parse(response);
          resolve({
            content: parsed.message || parsed.content || parsed.response || parsed.text || response,
            tokensUsed: parsed.tokensUsed || parsed.usage?.output_tokens || this._estimateTokens(message + response),
            model: parsed.model || adapter.getDefaultModel() || 'unknown',
          });
        } catch (parseErr) {
          // If not JSON, try adapter's extractReviewText, then fall back to raw text
          const extracted = adapter.extractReviewText ? adapter.extractReviewText(response) : response.trim();
          resolve({
            content: extracted || response.trim(),
            tokensUsed: this._estimateTokens(message + response),
            model: adapter.getDefaultModel() || 'unknown',
          });
        }
      });

      cliProcess.on('error', (error) => {
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to spawn ${adapter.getName()} process: ${error.message}`));
      });
    });
  }

  /**
   * Record a tool use event for memory analysis
   * @param {string} projectId - Project ID
   * @param {Object} toolEvent - Tool use event { name, input, id }
   */
  recordToolUseEvent(projectId, toolEvent) {
    const session = this.sessions.get(projectId);
    if (session && session.toolUseEvents.length < 500) {
      session.toolUseEvents.push(toolEvent);
    }
  }

  /**
   * Estimate token count (rough approximation)
   * @private
   */
  _estimateTokens(text) {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Get session info
   * @param {string} projectId - Project ID
   * @returns {Object|null} Session data
   */
  getSession(projectId) {
    return this.sessions.get(projectId) || null;
  }

  /**
   * Get message history for a project
   * @param {string} projectId - Project ID
   * @param {number} limit - Number of messages to return
   * @returns {Array} Message history
   */
  getMessageHistory(projectId, limit = 50) {
    const session = this.sessions.get(projectId);
    if (!session) return [];

    return session.messageHistory.slice(-limit);
  }

  markSessionActivity(projectId, timestamp = Date.now()) {
    const session = this.sessions.get(projectId);
    if (!session) return;
    session.lastActivity = timestamp;
  }

  setRunActive(projectId, isActive, timestamp = Date.now()) {
    const session = this.sessions.get(projectId);
    if (!session) return;

    session.hasActiveRun = Boolean(isActive);
    session.lastActivity = timestamp;
    if (isActive) {
      session.runStartedAt = timestamp;
    } else {
      session.runStartedAt = null;
    }
  }

  /**
   * Clear message history
   * @param {string} projectId - Project ID
   */
  clearHistory(projectId) {
    const session = this.sessions.get(projectId);
    if (session) {
      session.messageHistory = [];
      session.messageCount = 0;
      session.lastActivity = Date.now();
      logger.info(`Cleared message history for project ${projectId}`);
    }
  }

  /**
   * End Claude session
   * @param {string} projectId - Project ID
   */
  async endSession(projectId) {
    try {
      const session = this.sessions.get(projectId);
      if (!session) return;

      // Generate session summary from tool use events
      if (session.toolUseEvents.length > 0) {
        try {
          await memoryService.analyzeAndUpdateFromToolUse(
            projectId,
            session.projectPath,
            session.userId,
            session.toolUseEvents,
            `Session ended after ${session.messageCount} messages`,
            ''
          );
        } catch (error) {
          logger.warn(`Failed to generate session summary on end: ${error.message}`);
        }
      }

      // Mark session as inactive
      session.isActive = false;
      session.hasActiveRun = false;
      session.runStartedAt = null;
      session.lastActivity = Date.now();

      // Kill any running process
      if (session.claudeProcess) {
        session.claudeProcess.kill();
      }

      // Remove from active sessions
      this.sessions.delete(projectId);
      this.commandQueue.delete(projectId);

      logger.info(`Claude session ended for project ${projectId}`);
    } catch (error) {
      logger.error(`Failed to end Claude session: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get session statistics
   * @param {string} projectId - Project ID
   * @returns {Object} Session stats
   */
  getSessionStats(projectId) {
    const session = this.sessions.get(projectId);
    if (!session) {
      return null;
    }

    return {
      projectId: session.projectId,
      startedAt: session.startedAt,
      messageCount: session.messageCount,
      tokensUsed: session.tokensUsed,
      isActive: session.isActive,
      historyLength: session.messageHistory.length,
    };
  }

  /**
   * Check if session is active
   * @param {string} projectId - Project ID
   * @returns {boolean}
   */
  isSessionActive(projectId) {
    const session = this.sessions.get(projectId);
    return session ? session.isActive : false;
  }

  /**
   * Get all active sessions
   * @returns {Array} List of active sessions with stats
   */
  getAllSessions() {
    const sessions = [];
    for (const [projectId, session] of this.sessions.entries()) {
      sessions.push({
        projectId,
        userId: session.userId,
        projectPath: session.projectPath,
        isActive: Boolean(session.hasActiveRun),
        messageCount: session.messageCount,
        tokensUsed: session.tokensUsed,
        startTime: session.runStartedAt || session.startTime || session.startedAt?.getTime?.() || Date.now(),
        lastActivity: session.lastActivity || session.startTime || session.startedAt?.getTime?.() || Date.now(),
        uptime: session.hasActiveRun && (session.runStartedAt || session.startTime)
          ? Date.now() - (session.runStartedAt || session.startTime)
          : 0,
      });
    }
    return sessions;
  }
}

// Export singleton instance
const claudeService = new ClaudeService();
export default claudeService;
