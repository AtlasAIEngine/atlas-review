/**
 * Memory Management Service
 * Manages CLAUDE.md files for persistent AI context across sessions
 *
 * This is the core differentiator of AtlasEngine - enables unlimited session continuity
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  createMemorySnapshot,
  getProjectMemorySnapshots,
  updateProjectMemory
} from '../db/queries.js';
import { renderAtlasInstructionBlock } from './agentInstructionTemplate.js';

class MemoryService {
  constructor() {
    this.claudeFileName = 'CLAUDE.md';
    this.claudeDir = '.claude';
    this.atlasClaudeGuidanceBlockStart = '<!-- atlas-review-mcp:claude:start -->';
    this.atlasClaudeGuidanceBlockEnd = '<!-- atlas-review-mcp:claude:end -->';
  }

  normalizeMemorySummaryLine(value, maxChars = 180) {
    const collapsed = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!collapsed) return '';
    const normalizedMax = Math.max(24, Math.trunc(Number(maxChars) || 180));
    if (collapsed.length <= normalizedMax) return collapsed;
    return `${collapsed.slice(0, Math.max(0, normalizedMax - 3)).trimEnd()}...`;
  }

  extractConventionsFromClaudeContent(content, options = {}) {
    const maxItems = Math.max(1, Math.trunc(Number(options.maxItems) || 6));
    const maxCharsPerItem = Math.max(24, Math.trunc(Number(options.maxCharsPerItem) || 180));
    const text = this.stripAtlasClaudeGuidanceBlock(String(content || ''));
    if (!text.trim()) return [];

    const sectionPatterns = [
      /##\s+Coding Conventions\s*([\s\S]*?)(?=\n##\s+|\n---|\s*$)/i,
      /##\s+Code Patterns(?:\s*\(Learned from Reviews\))?\s*([\s\S]*?)(?=\n##\s+|\n---|\s*$)/i,
    ];
    const conventions = [];
    const seen = new Set();

    for (const pattern of sectionPatterns) {
      const sectionMatch = text.match(pattern);
      if (!sectionMatch?.[1]) continue;
      const sectionLines = sectionMatch[1].split('\n');
      for (const rawLine of sectionLines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        if (/^\[[^\]]*\]$/.test(trimmed)) continue;
        const candidate = this.normalizeMemorySummaryLine(
          trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''),
          maxCharsPerItem
        );
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        conventions.push(candidate);
        if (conventions.length >= maxItems) {
          return conventions;
        }
      }
    }

    return conventions;
  }

  /**
   * Initialize CLAUDE.md for a new project
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Filesystem path to project
   * @param {string} projectName - Human-readable project name
   * @param {string} userId - User UUID
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Initialization result
   */
  async initializeMemory(projectId, projectPath, projectName, userId, options = {}) {
    try {
      const claudeMdPath = path.join(projectPath, this.claudeFileName);
      const claudeDirPath = path.join(projectPath, this.claudeDir);

      // Create .claude directory for additional memory files
      await fs.mkdir(claudeDirPath, { recursive: true });

      // Check if CLAUDE.md already exists (e.g., cloned from a repo that has one)
      let content;
      let isExisting = false;
      try {
        content = await fs.readFile(claudeMdPath, 'utf8');
        isExisting = true;
        console.log(`📋 Preserving existing CLAUDE.md for project ${projectId}`);
      } catch (readError) {
        // File doesn't exist, generate new template
        content = this.generateTemplate(projectName, options);
        await fs.writeFile(claudeMdPath, content, 'utf8');
      }

      // Calculate size
      const stats = await fs.stat(claudeMdPath);
      const sizeBytes = stats.size;

      // Create snapshot in database
      const contentHash = this.hashContent(content);
      await createMemorySnapshot({
        projectId,
        userId,
        kind: 'claude_md',
        path: this.claudeFileName,
        content: content,
        contentHash,
        notes: isExisting ? 'Preserved existing CLAUDE.md from repository' : 'Initial memory initialization'
      });

      // Update project memory status
      await updateProjectMemory(projectId, sizeBytes);

      console.log(`✅ Memory ${isExisting ? 'preserved' : 'initialized'} for project ${projectId}`);

      return {
        success: true,
        path: claudeMdPath,
        size: sizeBytes,
        snapshot: true,
        preserved: isExisting
      };
    } catch (error) {
      console.error('Error initializing memory:', error);
      throw error;
    }
  }

  /**
   * Generate CLAUDE.md template
   * @param {string} projectName - Project name
   * @param {Object} options - Template options
   * @returns {string} Template content
   */
  generateTemplate(projectName, options = {}) {
    const timestamp = new Date().toISOString();
    const { framework, language, description } = options;

    return `# Project: ${projectName}

## Overview
${description || 'AI will analyze and fill this section after initial code scan'}

## Tech Stack
${framework ? `- Framework: ${framework}` : '- Framework: To be detected'}
${language ? `- Language: ${language}` : '- Language: To be detected'}
- Additional dependencies will be documented as discovered

## Architecture
[High-level architecture will be documented as we build]

## Key Decisions
- ${timestamp}: Project initialized with AtlasEngine
${framework ? `- ${timestamp}: Using ${framework} as primary framework` : ''}

## Coding Conventions
[To be established during development based on codebase patterns]

## Quality Standards
**IMPORTANT: Follow these standards for all code changes:**

1. **Preserve tooling configs** - Never remove or skip:
   - ESLint config (\`eslint.config.js\` or \`.eslintrc.*\`)
   - TypeScript config (\`tsconfig.json\`)
   - Test configs (jest.config.js, vitest.config.ts, etc.)

2. **Complete setup** - When scaffolding projects:
   - If adding ESLint deps, MUST create eslint.config.js
   - If adding test deps, MUST create test config
   - Run \`npm install\` after adding dependencies

3. **Verify before done** - After completing changes:
   - Run \`npm run lint\` and fix any errors
   - Run \`npm run test\` if tests exist
   - Ensure \`npm run build\` succeeds

4. **Don't disable checks** - Never:
   - Add \`// eslint-disable\` without good reason
   - Skip TypeScript strict checks
   - Remove existing test coverage

## Current Status
Last updated: ${timestamp}
- 🚧 Project just started
- 📋 Ready for initial implementation

## Known Issues
[None yet - will be documented as discovered]

## Dependencies
[Package dependencies will be listed here after installation]

## Environment Variables
[Required environment variables will be documented here]

## Build & Deploy
[Build and deployment instructions to be added]

## Development Notes
- Project created via AtlasEngine MVP
- Memory system active for session continuity
- AI context preserved across unlimited sessions

---
*This file is automatically managed by AtlasEngine's memory system*
*Last memory snapshot: ${timestamp}*
`;
  }

  /**
   * Update CLAUDE.md with new information
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Filesystem path to project
   * @param {string} userId - User UUID
   * @param {Object} updates - Updates to apply
   * @returns {Promise<boolean>} Success status
   */
  async updateMemory(projectId, projectPath, userId, updates) {
    try {
      const claudeMdPath = path.join(projectPath, this.claudeFileName);

      // Read current content
      let content = await fs.readFile(claudeMdPath, 'utf8');

      // Apply updates
      if (updates.decisions) {
        const decision = `- ${new Date().toISOString()}: ${updates.decisions}`;
        content = this.appendToSection(content, '## Key Decisions', decision);
      }

      if (updates.status) {
        const statusUpdate = `Last updated: ${new Date().toISOString()}\n${updates.status}`;
        content = this.updateSection(content, '## Current Status', statusUpdate);
      }

      if (updates.issues) {
        const issue = `- ${updates.issues}`;
        content = this.appendToSection(content, '## Known Issues', issue);
      }

      if (updates.conventions) {
        const convention = `- ${updates.conventions}`;
        content = this.appendToSection(content, '## Coding Conventions', convention);
      }

      if (updates.architecture) {
        content = this.updateSection(content, '## Architecture', updates.architecture);
      }

      if (updates.dependencies) {
        content = this.updateSection(content, '## Dependencies', updates.dependencies);
      }

      if (updates.techStack) {
        content = this.updateSection(content, '## Tech Stack', updates.techStack);
      }

      if (updates.overview) {
        content = this.updateSection(content, '## Overview', updates.overview);
      }

      if (updates.supabase) {
        const supabaseSection = [
          '### Environment Variables',
          '- `SUPABASE_URL` — Project API URL',
          '- `SUPABASE_ANON_KEY` — Public anon key (safe for client-side)',
          '- `SUPABASE_SERVICE_ROLE_KEY` — Admin key (server-side only, never expose to client)',
          '',
          '### Usage Pattern',
          '```js',
          "import { createClient } from '@supabase/supabase-js';",
          "const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);",
          '```',
        ].join('\n');
        content = this.updateSection(content, '## Supabase Integration', supabaseSection);
      }

      // Update memory snapshot timestamp footer
      content = content.replace(
        /\*Last memory snapshot: .*\*/,
        `*Last memory snapshot: ${new Date().toISOString()}*`
      );

      // Write updated content
      await fs.writeFile(claudeMdPath, content, 'utf8');

      // Calculate new size
      const stats = await fs.stat(claudeMdPath);
      const sizeBytes = stats.size;

      // Create auto-snapshot
      const contentHash = this.hashContent(content);
      await createMemorySnapshot({
        projectId,
        userId,
        kind: 'auto',
        path: this.claudeFileName,
        content,
        contentHash,
        notes: 'Automatic update snapshot'
      });

      // Update project memory size
      await updateProjectMemory(projectId, sizeBytes);

      console.log(`✅ Memory updated for project ${projectId}`);

      return true;
    } catch (error) {
      console.error('Error updating memory:', error);
      return false;
    }
  }

  /**
   * Create a named checkpoint
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Filesystem path to project
   * @param {string} userId - User UUID
   * @param {string} checkpointName - Name for this checkpoint
   * @param {string} notes - Optional notes
   * @returns {Promise<Object>} Checkpoint result
   */
  async createCheckpoint(projectId, projectPath, userId, checkpointName, notes = '') {
    try {
      const claudeMdPath = path.join(projectPath, this.claudeFileName);
      const content = await fs.readFile(claudeMdPath, 'utf8');
      const contentHash = this.hashContent(content);

      const snapshot = await createMemorySnapshot({
        projectId,
        userId,
        kind: 'checkpoint',
        path: this.claudeFileName,
        content,
        contentHash,
        notes: `Checkpoint: ${checkpointName}${notes ? ' - ' + notes : ''}`
      });

      console.log(`✅ Checkpoint created: ${checkpointName}`);

      return {
        success: true,
        checkpointName,
        snapshotId: snapshot.id,
        timestamp: snapshot.created_at
      };
    } catch (error) {
      console.error('Error creating checkpoint:', error);
      throw error;
    }
  }

  /**
   * Get memory content
   * @param {string} projectPath - Filesystem path to project
   * @returns {Promise<string|null>} Memory content or null
   */
  async getMemoryContent(projectPath) {
    try {
      const claudeMdPath = path.join(projectPath, this.claudeFileName);
      const content = await fs.readFile(claudeMdPath, 'utf8');
      return content;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // File doesn't exist
      }
      console.error('Error reading memory:', error);
      throw error;
    }
  }

  async getReviewConventions(projectPath, options = {}) {
    const maxItems = Math.max(1, Math.trunc(Number(options.maxItems) || 6));
    const maxCharsPerItem = Math.max(24, Math.trunc(Number(options.maxCharsPerItem) || 180));
    const content = await this.getMemoryContent(projectPath);
    if (!content) return [];
    return this.extractConventionsFromClaudeContent(content, {
      maxItems,
      maxCharsPerItem,
    });
  }

  buildAtlasClaudeGuidanceBlock() {
    return renderAtlasInstructionBlock({
      blockStart: this.atlasClaudeGuidanceBlockStart,
      blockEnd: this.atlasClaudeGuidanceBlockEnd,
    });
  }

  stripAtlasClaudeGuidanceBlock(content) {
    const normalized = String(content || '');
    const blockRegex = new RegExp(
      `\\s*${escapeRegex(this.atlasClaudeGuidanceBlockStart)}[\\s\\S]*?${escapeRegex(this.atlasClaudeGuidanceBlockEnd)}\\s*`,
      'gm'
    );
    if (!blockRegex.test(normalized)) {
      return normalized;
    }
    return normalizeDocumentWhitespace(normalized.replace(blockRegex, '\n'));
  }

  upsertAtlasClaudeGuidanceBlock(content) {
    const normalized = this.stripAtlasClaudeGuidanceBlock(content);
    const block = this.buildAtlasClaudeGuidanceBlock();
    const trimmed = normalized.trimEnd();
    if (!trimmed) {
      return `${block}\n`;
    }

    const footerRegex = /\n---\n\*This file is automatically managed by AtlasEngine's memory system\*[\s\S]*$/m;
    const footerMatch = trimmed.match(footerRegex);
    if (footerMatch?.index != null) {
      const beforeFooter = trimmed.slice(0, footerMatch.index).trimEnd();
      const footer = trimmed.slice(footerMatch.index).trimStart();
      return `${beforeFooter}\n\n${block}\n\n${footer}\n`;
    }

    return `${trimmed}\n\n${block}\n`;
  }

  async previewAtlasClaudeGuidance(projectPath) {
    const claudeMdPath = path.join(projectPath, this.claudeFileName);
    const block = this.buildAtlasClaudeGuidanceBlock();
    return {
      instructionBlock: block,
      preview: {
        target: 'claude',
        label: 'Claude Code',
        filePath: claudeMdPath,
        relativeFilePath: this.claudeFileName,
        content: block,
      },
    };
  }

  async upsertAtlasClaudeGuidance(projectId, projectPath, projectName, userId, options = {}) {
    const dryRun = options.dryRun === true;
    const claudeMdPath = path.join(projectPath, this.claudeFileName);
    const exists = await this.memoryExists(projectPath);
    let existingContent = exists ? await this.getMemoryContent(projectPath) : null;
    const created = !exists;

    if (!existingContent) {
      existingContent = this.generateTemplate(projectName || path.basename(projectPath));
    }

    let nextContent = this.upsertAtlasClaudeGuidanceBlock(existingContent);
    let changed = nextContent !== existingContent;
    let backupPath = null;

    if (changed && !dryRun) {
      if (!exists) {
        await this.initializeMemory(projectId, projectPath, projectName || path.basename(projectPath), userId);
        const initializedContent = await this.getMemoryContent(projectPath);
        existingContent = initializedContent || existingContent;
        nextContent = this.upsertAtlasClaudeGuidanceBlock(existingContent);
        changed = nextContent !== existingContent;
      }
      backupPath = await this.persistMemoryContent(projectId, projectPath, userId, nextContent, {
        createBackup: false,
        backupLabel: 'atlas-claude-guidance',
        note: created ? 'Initialized CLAUDE.md with Atlas-managed Claude review guidance' : 'Updated Atlas-managed Claude review guidance',
      });
    }

    return {
      instructionBlock: this.buildAtlasClaudeGuidanceBlock(),
      result: {
        target: 'claude',
        label: 'Claude Code',
        filePath: claudeMdPath,
        relativeFilePath: this.claudeFileName,
        changed,
        created,
        backupPath,
        dryRun: Boolean(dryRun),
      },
      failures: [],
    };
  }

  async removeAtlasClaudeGuidance(projectId, projectPath, userId, options = {}) {
    const dryRun = options.dryRun === true;
    const claudeMdPath = path.join(projectPath, this.claudeFileName);
    const existingContent = await this.getMemoryContent(projectPath);

    if (existingContent == null) {
      return {
        result: {
          target: 'claude',
          label: 'Claude Code',
          filePath: claudeMdPath,
          relativeFilePath: this.claudeFileName,
          changed: false,
          removed: false,
          backupPath: null,
          dryRun: Boolean(dryRun),
        },
        failures: [],
      };
    }

    const nextContent = this.stripAtlasClaudeGuidanceBlock(existingContent);
    const changed = nextContent !== existingContent;
    let backupPath = null;

    if (changed && !dryRun) {
      backupPath = await this.persistMemoryContent(projectId, projectPath, userId, nextContent, {
        createBackup: false,
        backupLabel: 'atlas-claude-guidance',
        note: 'Removed Atlas-managed Claude review guidance',
      });
    }

    return {
      result: {
        target: 'claude',
        label: 'Claude Code',
        filePath: claudeMdPath,
        relativeFilePath: this.claudeFileName,
        changed,
        removed: changed,
        backupPath,
        dryRun: Boolean(dryRun),
      },
      failures: [],
    };
  }

  /**
   * Get memory statistics
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Filesystem path to project
   * @returns {Promise<Object>} Memory statistics
   */
  async getMemoryStats(projectId, projectPath) {
    try {
      const snapshots = await getProjectMemorySnapshots(projectId, 100);

      const stats = {
        totalSnapshots: snapshots.length,
        checkpoints: snapshots.filter(s => s.kind === 'checkpoint').length,
        autoSnapshots: snapshots.filter(s => s.kind === 'auto').length,
        totalSize: snapshots.reduce((sum, s) => sum + s.size_bytes, 0),
        lastUpdate: snapshots.length > 0 ? snapshots[0].created_at : null,
        oldestSnapshot: snapshots.length > 0 ? snapshots[snapshots.length - 1].created_at : null
      };

      // Get current file size
      try {
        const claudeMdPath = path.join(projectPath, this.claudeFileName);
        const fileStats = await fs.stat(claudeMdPath);
        stats.currentSize = fileStats.size;
      } catch (error) {
        stats.currentSize = 0;
      }

      return stats;
    } catch (error) {
      console.error('Error getting memory stats:', error);
      throw error;
    }
  }

  async persistMemoryContent(projectId, projectPath, userId, content, options = {}) {
    const claudeMdPath = path.join(projectPath, this.claudeFileName);
    const claudeDirPath = path.join(projectPath, this.claudeDir);
    await fs.mkdir(claudeDirPath, { recursive: true });

    let backupPath = null;
    if (options.createBackup) {
      try {
        const existing = await fs.readFile(claudeMdPath, 'utf8');
        backupPath = path.join(
          claudeDirPath,
          `${options.backupLabel || 'CLAUDE'}.backup.${Date.now()}.md`
        );
        await fs.writeFile(backupPath, existing, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    await fs.writeFile(claudeMdPath, content, 'utf8');

    const stats = await fs.stat(claudeMdPath);
    const contentHash = this.hashContent(content);
    await createMemorySnapshot({
      projectId,
      userId,
      kind: 'auto',
      path: this.claudeFileName,
      content,
      contentHash,
      notes: options.note || 'Automatic update snapshot',
    });
    await updateProjectMemory(projectId, stats.size);

    return backupPath;
  }

  /**
   * Compact memory (remove old auto-snapshots, keep checkpoints)
   * @param {string} projectId - Project UUID
   * @param {number} keepLastN - Number of auto-snapshots to keep
   * @returns {Promise<number>} Number of snapshots removed
   */
  async compactMemory(projectId, keepLastN = 5) {
    try {
      const snapshots = await getProjectMemorySnapshots(projectId, 1000);

      // Separate auto-snapshots from checkpoints
      const autoSnapshots = snapshots.filter(s => s.kind === 'auto');
      const checkpoints = snapshots.filter(s => s.kind === 'checkpoint');

      // Keep only last N auto-snapshots
      const toDelete = autoSnapshots.slice(keepLastN);

      // Delete old auto-snapshots
      // Note: In a full implementation, we'd need a deleteMemorySnapshot function in queries.js
      // For now, we'll just log the intent
      console.log(`Would delete ${toDelete.length} old auto-snapshots`);
      console.log(`Keeping ${keepLastN} recent auto-snapshots and all ${checkpoints.length} checkpoints`);

      return toDelete.length;
    } catch (error) {
      console.error('Error compacting memory:', error);
      throw error;
    }
  }

  /**
   * Restore memory from a snapshot
   * @param {string} projectPath - Filesystem path to project
   * @param {Object} snapshot - Snapshot object from database
   * @returns {Promise<boolean>} Success status
   */
  async restoreFromSnapshot(projectPath, snapshot) {
    try {
      const claudeMdPath = path.join(projectPath, this.claudeFileName);

      // Create backup of current version
      try {
        const currentContent = await fs.readFile(claudeMdPath, 'utf8');
        const backupPath = path.join(projectPath, this.claudeDir, `CLAUDE.backup.${Date.now()}.md`);
        await fs.writeFile(backupPath, currentContent, 'utf8');
        console.log(`Created backup at ${backupPath}`);
      } catch (error) {
        // Backup failed but continue with restore
        console.warn('Could not create backup:', error.message);
      }

      // Restore from snapshot
      await fs.writeFile(claudeMdPath, snapshot.content, 'utf8');

      console.log(`✅ Memory restored from snapshot ${snapshot.id}`);

      return true;
    } catch (error) {
      console.error('Error restoring memory:', error);
      throw error;
    }
  }

  /**
   * Append content to a section
   * @param {string} content - Full document content
   * @param {string} sectionHeader - Section header (e.g., "## Key Decisions")
   * @param {string} newLine - Line to append
   * @returns {string} Updated content
   */
  appendToSection(content, sectionHeader, newLine) {
    const sectionRegex = new RegExp(`(${sectionHeader}[\\s\\S]*?)(\n## |$)`, 'm');
    const match = content.match(sectionRegex);

    if (match) {
      const updatedSection = match[1].trimEnd() + '\n' + newLine + '\n';
      return content.replace(match[1], updatedSection);
    }

    // Section not found, append at end
    return content + `\n${sectionHeader}\n${newLine}\n`;
  }

  /**
   * Update entire section
   * @param {string} content - Full document content
   * @param {string} sectionHeader - Section header
   * @param {string} newContent - New section content
   * @returns {string} Updated content
   */
  updateSection(content, sectionHeader, newContent) {
    const sectionRegex = new RegExp(
      `(${sectionHeader})([\\s\\S]*?)(\n## |$)`,
      'm'
    );

    const match = content.match(sectionRegex);

    if (match) {
      return content.replace(sectionRegex, `$1\n${newContent}\n\n$3`);
    }

    // Section not found, append at end
    return content + `\n${sectionHeader}\n${newContent}\n`;
  }

  /**
   * Hash content for deduplication
   * @param {string} content - Content to hash
   * @returns {string} SHA256 hash
   */
  hashContent(content) {
    return crypto
      .createHash('sha256')
      .update(content, 'utf8')
      .digest('hex');
  }

  /**
   * Check if memory exists for a project
   * @param {string} projectPath - Filesystem path to project
   * @returns {Promise<boolean>} True if memory exists
   */
  async memoryExists(projectPath) {
    try {
      const claudeMdPath = path.join(projectPath, this.claudeFileName);
      await fs.access(claudeMdPath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Analyze memory health
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Filesystem path to project
   * @returns {Promise<Object>} Health analysis
   */
  async analyzeMemoryHealth(projectId, projectPath) {
    try {
      const exists = await this.memoryExists(projectPath);

      if (!exists) {
        return {
          healthy: false,
          reason: 'CLAUDE.md file not found',
          recommendations: ['Initialize memory with memoryService.initializeMemory()']
        };
      }

      const content = await this.getMemoryContent(projectPath);
      const stats = await this.getMemoryStats(projectId, projectPath);

      const analysis = {
        healthy: true,
        fileSize: stats.currentSize,
        totalSnapshots: stats.totalSnapshots,
        lastUpdate: stats.lastUpdate,
        recommendations: []
      };

      // Check if file is too large
      if (stats.currentSize > 100000) { // 100KB
        analysis.recommendations.push('Consider compacting memory - file is getting large');
      }

      // Check if no recent updates
      const daysSinceUpdate = stats.lastUpdate
        ? (Date.now() - new Date(stats.lastUpdate).getTime()) / (1000 * 60 * 60 * 24)
        : null;

      if (daysSinceUpdate && daysSinceUpdate > 7) {
        analysis.recommendations.push('No updates in 7+ days - consider refreshing project status');
      }

      // Check if few checkpoints
      if (stats.checkpoints < 3 && stats.totalSnapshots > 10) {
        analysis.recommendations.push('Create more named checkpoints for important milestones');
      }

      // Check if too many auto-snapshots
      if (stats.autoSnapshots > 20) {
        analysis.recommendations.push('Run compactMemory() to clean up old auto-snapshots');
      }

      return analysis;
    } catch (error) {
      console.error('Error analyzing memory health:', error);
      throw error;
    }
  }

  /**
   * Analyze tool use events and generate intelligent memory updates
   * @param {string} projectId - Project UUID
   * @param {string} projectPath - Filesystem path to project
   * @param {string} userId - User UUID
   * @param {Array} toolUseEvents - Array of tool use events from Claude
   * @param {string} userMessage - Original user message
   * @param {string} assistantMessage - Claude's response
   * @returns {Promise<Object>} Analysis results with suggested updates
   */
  async analyzeAndUpdateFromToolUse(projectId, projectPath, userId, toolUseEvents, userMessage, assistantMessage) {
    try {
      if (!toolUseEvents || toolUseEvents.length === 0) {
        return { updated: false, reason: 'No tool use events to analyze' };
      }

      const updates = {};
      const insights = [];

      // Analyze each tool use event
      for (const toolEvent of toolUseEvents) {
        const { name, input } = toolEvent;

        switch (name) {
          case 'Write':
            // New file created
            if (input && input.file_path) {
              const fileName = input.file_path.split('/').pop();
              const fileExt = fileName.split('.').pop();

              insights.push(`Created new file: ${fileName}`);

              // Detect file type and update appropriate sections
              if (fileExt === 'json' && fileName.includes('package')) {
                insights.push(`Added dependencies via ${fileName}`);
              } else if (fileExt === 'tsx' || fileExt === 'jsx') {
                insights.push(`Created React component: ${fileName}`);
              } else if (fileExt === 'ts' || fileExt === 'js') {
                insights.push(`Created module: ${fileName}`);
              } else if (fileExt === 'md') {
                insights.push(`Created documentation: ${fileName}`);
              }
            }
            break;

          case 'Edit':
            // File modified
            if (input && input.file_path) {
              const fileName = input.file_path.split('/').pop();
              insights.push(`Modified file: ${fileName}`);
            }
            break;

          case 'Bash':
            // Command executed
            if (input && input.command) {
              const cmd = input.command;

              if (cmd.includes('npm install') || cmd.includes('yarn add')) {
                const match = cmd.match(/(npm install|yarn add)\s+(.+)/);
                if (match) {
                  insights.push(`Installed dependencies: ${match[2]}`);
                }
              } else if (cmd.includes('git')) {
                insights.push(`Executed git command: ${cmd.substring(0, 50)}...`);
              } else if (cmd.includes('npm run') || cmd.includes('yarn')) {
                insights.push(`Executed build/test command`);
              }
            }
            break;

          case 'Read':
            // File read - generally doesn't need memory update
            break;

          case 'Glob':
          case 'Grep':
            // Search operations - doesn't need memory update
            break;

          default:
            // Other tools
            insights.push(`Used tool: ${name}`);
        }
      }

      // Generate status update from insights and conversation
      if (insights.length > 0) {
        const timestamp = new Date().toISOString();
        const statusUpdate = `Last updated: ${timestamp}\n- ${insights.join('\n- ')}\n- Activity: ${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}`;
        updates.status = statusUpdate;
      }

      // Count files created
      const filesCreated = toolUseEvents.filter(e => e.name === 'Write').length;

      // Auto-checkpoint on significant milestones
      let checkpointCreated = false;
      if (filesCreated >= 3) {
        // Multiple files created - significant work
        await this.createCheckpoint(
          projectId,
          projectPath,
          userId,
          `Milestone: Created ${filesCreated} files`,
          { toolUseEvents, insights }
        );
        checkpointCreated = true;
      }

      // Apply updates if any
      if (Object.keys(updates).length > 0) {
        await this.updateMemory(projectId, projectPath, userId, updates);
      }

      return {
        updated: Object.keys(updates).length > 0,
        insights,
        checkpointCreated,
        updates
      };

    } catch (error) {
      console.error('Error analyzing tool use for memory update:', error);
      return { updated: false, error: error.message };
    }
  }
}

function normalizeDocumentWhitespace(content) {
  const normalized = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized ? `${normalized}\n` : '';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Export singleton instance
const memoryService = new MemoryService();
export default memoryService;
