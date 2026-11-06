/**
 * Codex CLI Adapter
 * Implements the CLI adapter interface for OpenAI Codex CLI.
 * Uses `codex exec --json` mode with stdin-based message passing.
 */

import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BaseCLIAdapter } from './BaseCLIAdapter.js';
import providerService from '../providerService.js';
import cliInstallService from '../cliInstallService.js';
import { findCodexBinary } from '../../utils/codexBinary.js';

const execFileAsync = promisify(execFile);

/**
 * Codex CLI models — sourced from providerService PROVIDER_CONFIGS.openai.
 * Mapped to CLI-friendly format with aliases.
 */
const CODEX_MODELS = [
  { alias: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', description: 'Available through compatible Codex CLI accounts' },
  { alias: 'gpt-6-astra', name: 'GPT-6 Astra', description: 'Available through compatible Codex CLI accounts' },
  { alias: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', description: 'Available through compatible Codex CLI accounts' },
  { alias: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'Available through compatible Codex CLI accounts' },
  { alias: 'gpt-6-sol', name: 'GPT-6 Sol', description: 'Available through compatible Codex CLI accounts' },

  { alias: 'gpt-5.5', name: 'GPT-5.5', description: 'Latest GPT-5 model available in Codex' },
  { alias: 'gpt-5.4', name: 'GPT-5.4', description: 'Previous GPT-5 model available in Codex' },
  { alias: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', description: 'Lowest-cost GPT-5.4 variant' },
  { alias: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', description: 'Faster lower-cost GPT-5.4 variant' },
  { alias: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: 'Previous Codex model' },
];
const DEFAULT_MODEL_CACHE_TTL_MS = 5000;
const VALID_CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const DEFAULT_CODEX_REASONING_EFFORT_AGENTIC = 'low';

function extractCodexTomlModel(rawConfig = '') {
  const match = String(rawConfig || '').match(/^\s*model\s*=\s*["']([^"'\n]+)["']/m);
  return typeof match?.[1] === 'string' ? match[1].trim() : '';
}

function resolveCodexReasoningEffort(rawValue = process.env.ATLAS_CODEX_REASONING_EFFORT) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_CODEX_REASONING_EFFORT;
  if (VALID_CODEX_REASONING_EFFORTS.has(normalized)) return normalized;
  if (normalized === 'minimal' || normalized === 'xlow') return 'low';
  if (normalized === 'xmedium') return 'medium';
  if (normalized === 'xhigh' || normalized === 'max' || normalized === 'maximum') return 'high';
  return DEFAULT_CODEX_REASONING_EFFORT;
}

function resolveCodexReasoningEffortAgentic(rawValue = process.env.ATLAS_CODEX_REASONING_EFFORT_AGENTIC) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_CODEX_REASONING_EFFORT_AGENTIC;
  if (VALID_CODEX_REASONING_EFFORTS.has(normalized)) return normalized;
  return DEFAULT_CODEX_REASONING_EFFORT_AGENTIC;
}

class CodexAdapter extends BaseCLIAdapter {
  constructor() {
    super();
    this._cachedBinaryPath = null;
    this._defaultModelCache = {
      value: null,
      loadedAt: 0,
    };
  }

  getName() {
    return 'Codex CLI';
  }

  getType() {
    return 'openai';
  }

  /**
   * Find the Codex CLI binary.
   * Checks common absolute paths first, then falls back to `which codex`.
   * @returns {Promise<string>}
   * @throws {Error} if binary not found
   */
  async findBinary() {
    if (this._cachedBinaryPath) {
      return this._cachedBinaryPath;
    }

    const binaryPath = await findCodexBinary();
    if (binaryPath) {
      this._cachedBinaryPath = binaryPath;
      return this._cachedBinaryPath;
    }

    throw new Error('Codex CLI not found. Install with: npm install -g @openai/codex');
  }

  /**
   * Check Codex CLI auth using the unified provider detector so Atlas-managed
   * installs and stored Codex credentials are handled consistently.
   * @returns {Promise<{authenticated: boolean, error?: string}>}
   */
  async checkAuth() {
    try {
      const status = await providerService.getCliAuthStatus();
      const codex = status?.codex;

      if (codex?.authenticated) {
        return {
          authenticated: true,
          provider: this.getType(),
          source: codex.source || null,
          binaryPath: codex.binaryPath || null,
        };
      }

      const binaryPath = codex?.binaryPath || await this.findBinary();
      return {
        authenticated: false,
        error: `Codex CLI is installed at ${binaryPath} but is not authenticated. Run \`codex login\` or add an OpenAI API key.`,
        binaryPath,
      };
    } catch (error) {
      const message = error?.message || 'Codex CLI not available.';
      return { authenticated: false, error: message };
    }
  }

  /**
   * Build Codex CLI arguments for exec mode.
   * Codex uses `codex exec --json` with the message sent via stdin.
   *
   * When `resumeSession` is true and `sessionId` is provided, uses
   * `codex exec resume <sessionId>` to continue a previous conversation.
   * Otherwise starts a fresh session with `codex exec`.
   *
   * Codex does not support `--append-system-prompt`, so `systemPrompt`
   * is prepended to the stdin message.
   *
   * @param {Object} opts
   * @param {string} opts.message - The prompt (sent via stdin)
   * @param {string} [opts.sessionId] - Codex session ID (for resume)
   * @param {string} [opts.model] - Model ID
   * @param {string} [opts.outputFile] - Optional output file path for deterministic final text capture
   * @param {string} [opts.projectPath] - Project root for workspace-write sandboxing
   * @param {string} [opts.systemPrompt] - System prompt (prepended to stdin message)
   * @param {boolean} [opts.resumeSession=false] - If true, use `exec resume <sessionId>`
   * @returns {{args: string[], stdinMessage: true, structuredOutput: true}}
   */
  buildArgs({
    message,
    sessionId,
    model,
    outputFile,
    projectPath,
    systemPrompt,
    resumeSession = false,
    readOnly = false,
  }) {
    const reasoningEffort = resolveCodexReasoningEffort();
    const shouldBypassInternalSandbox = cliInstallService.isWindowsSandboxEnvironment();

    // Base command: 'exec' for new sessions, 'exec resume <id>' for continuing.
    // Codex resume supports a narrower flag set than fresh exec: it accepts
    // --full-auto, --json, --model, etc., but not --sandbox or --cd.
    const args = [];
    const isResume = Boolean(resumeSession && sessionId);
    if (isResume) {
      args.push('exec', 'resume');
    } else {
      args.push('exec');
    }

    args.push(
      '--skip-git-repo-check',
      '-c', `model_reasoning_effort="${reasoningEffort}"`,
      '--json',
    );

    if (shouldBypassInternalSandbox && !readOnly && !args.includes('--dangerously-bypass-approvals-and-sandbox')) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    if (!shouldBypassInternalSandbox && readOnly && !isResume) {
      if (!args.includes('--sandbox')) args.push('--sandbox', 'read-only');
      if (projectPath && String(projectPath).trim()) {
        args.push('--cd', String(projectPath).trim());
      }
    } else if (!shouldBypassInternalSandbox && projectPath && String(projectPath).trim()) {
      // Builder chat is non-interactive, so Codex must run without approval prompts
      // and with its writable sandbox scoped to the active project root.
      if (!args.includes('--full-auto')) args.push('--full-auto');
      if (!isResume) {
        if (!args.includes('--sandbox')) args.push('--sandbox', 'workspace-write');
        args.push('--cd', String(projectPath).trim());
      }
    }

    if (outputFile && String(outputFile).trim()) {
      args.push('-o', String(outputFile).trim());
    }

    if (model) {
      args.push('--model', model);
    }

    if (isResume) {
      args.push(sessionId);
    }

    // Codex has no --append-system-prompt flag, so prepend to the message
    const stdinMessage = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${message}`
      : message;

    return { args, stdinMessage: true, structuredOutput: true, message: stdinMessage };
  }

  buildAgenticArgs({
    message,
    sessionId,
    model,
    outputFile,
    projectPath,
    maxTurns,
    systemPrompt,
    externalSandbox = false,
    readOnly = false,
  }) {
    const base = this.buildArgs({
      message,
      sessionId,
      model,
      outputFile,
      projectPath: readOnly ? projectPath : undefined,
      systemPrompt,
      readOnly,
    });
    const args = Array.isArray(base.args) ? [...base.args] : ['exec', '--json'];
    if (!args.includes('--json')) args.push('--json');
    if (!args.includes('--skip-git-repo-check')) args.push('--skip-git-repo-check');

    // Override reasoning effort for agentic mode (default 'low' vs 'medium' for non-agentic)
    const agenticEffort = resolveCodexReasoningEffortAgentic();
    const effortIdx = args.findIndex(
      (a) => typeof a === 'string' && a.startsWith('model_reasoning_effort=')
    );
    if (effortIdx !== -1) {
      args[effortIdx] = `model_reasoning_effort="${agenticEffort}"`;
    }

    // When Atlas wraps Codex in an external OS sandbox (Darwin sandbox-exec),
    // disable Codex's internal approval/sandbox layer so shell commands needed
    // for git/diff exploration are not blocked.
    if (readOnly) {
      if (!args.includes('--sandbox')) args.push('--sandbox', 'read-only');
    } else if (externalSandbox) {
      if (!args.includes('--dangerously-bypass-approvals-and-sandbox')) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
    } else {
      // Non-interactive reviews should not block on shell-approval prompts.
      // full-auto keeps sandboxed execution (workspace-write) but allows in-sandbox commands.
      if (!args.includes('--full-auto')) args.push('--full-auto');
      if (!args.includes('--sandbox')) args.push('--sandbox', 'workspace-write');
    }
    if (!readOnly && projectPath && String(projectPath).trim()) {
      args.push('--cd', String(projectPath).trim());
    }
    return {
      args,
      stdinMessage: base.stdinMessage,
      structuredOutput: true,
      message: base.message,
    };
  }

  getExecutionModes({ hasCliRuntime } = {}) {
    if (!hasCliRuntime) return [];
    return ['cli-agentic', 'cli-agent', 'cli-pipe'];
  }

  shouldUseDarwinSandboxProfile() {
    return true;
  }

  extractToolPathFromToolUse(toolName, toolInput = {}) {
    if (!toolInput || typeof toolInput !== 'object') return null;
    switch (toolName) {
      case 'Read':
      case 'Edit':
      case 'Write':
      case 'FileChange':
      case 'file_change':
        return typeof toolInput.file_path === 'string'
          ? toolInput.file_path
          : (typeof toolInput.path === 'string' ? toolInput.path : null);
      case 'Grep':
      case 'Glob':
        return typeof toolInput.path === 'string' ? toolInput.path : null;
      default:
        return null;
    }
  }

  /**
   * Parse a line of Codex CLI stdout into a normalized event.
   * Preferred format is JSONL from `codex exec --json`.
   * Falls back to plain text parsing for older CLI behavior.
   *
   * @param {string} line - A single line from stdout
   * @returns {Object|null}
   */
  parseStreamLine(line) {
    if (line === undefined || line === null) return null;

    const trimmed = line.trim();

    // Prefer Codex JSONL stream when available (`codex exec --json`).
    // Fallback to plain text parsing for compatibility with older CLI versions.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const event = JSON.parse(trimmed);
        return this._parseJsonEvent(event);
      } catch {
        // Fall through to plain-text mode if JSON parsing fails.
      }
    }

    // In --json mode Codex can emit status/warning lines that should not appear
    // as assistant prose in chat history.
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('warning:')
      || lower.startsWith('reading prompt from stdin')
      || (/^\d{4}-\d{2}-\d{2}t/.test(lower) && (lower.includes(' error ') || lower.includes(' warn ')))
    ) {
      return {
        type: 'system',
        model: this.getDefaultModel(),
        raw: { type: 'status', text: line },
      };
    }

    return {
      type: 'assistant',
      model: this.getDefaultModel(),
      tokensUsed: null,
      contentBlocks: [{
        type: 'text',
        text: line + '\n',
      }],
      raw: { type: 'text', text: line },
    };
  }

  /**
   * Parse Codex JSONL stream events into normalized adapter events.
   * @private
   * @param {Object} event
   * @returns {Object|null}
   */
  _parseJsonEvent(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    switch (event.type) {
      case 'session_meta':
        // First event in a Codex session — contains the native session UUID
        return {
          type: 'session_meta',
          sessionId: event.payload?.id || null,
          model: this.getDefaultModel(),
          raw: event,
        };

      case 'thread.started':
      case 'turn.started':
        return {
          type: 'system',
          model: this.getDefaultModel(),
          raw: event,
        };

      case 'turn.completed':
        return {
          type: 'result',
          model: this.getDefaultModel(),
          tokensUsed: event.usage?.output_tokens || null,
          raw: event,
        };

      case 'turn.failed':
      case 'error':
        return {
          type: 'error',
          model: this.getDefaultModel(),
          message: event.error?.message || event.message || 'Codex stream error',
          raw: event,
        };

      case 'item.started':
      case 'item.updated':
      case 'item.completed':
      case 'item.delta':
        return this._parseJsonItem(event);

      default:
        return {
          type: 'system',
          model: this.getDefaultModel(),
          raw: event,
        };
    }
  }

  /**
   * Parse Codex item events.
   * @private
   * @param {Object} event
   * @returns {Object|null}
   */
  _parseJsonItem(event) {
    const item = event?.item;
    const eventType = typeof event?.type === 'string' ? event.type : '';
    const eventPhase = eventType.startsWith('item.') ? eventType.slice('item.'.length) : null;

    const textDelta = this._extractText(event?.delta);
    if ((!item || typeof item !== 'object') && textDelta) {
      return this._buildTextEvent(textDelta, event);
    }

    if (!item || !item.type) return null;

    // Agent text stream can arrive via item.text, item.content, or delta payload.
    if (item.type === 'agent_message') {
      const text = this._extractAgentMessageText(item, eventPhase, textDelta);
      if (text) {
        return this._buildTextEvent(text, event);
      }
      return null;
    }

    // Command execution and other work-item events provide intermediate progress.
    if (item.type === 'command_execution') {
      return {
        type: 'assistant',
        model: this.getDefaultModel(),
        tokensUsed: null,
        contentBlocks: [{
          type: 'tool_use',
          toolId: item.id || `${eventType}-command`,
          toolName: 'Bash',
          toolInput: {
            command: item.command,
            status: item.status,
            exit_code: item.exit_code,
            output: this._extractText(item.output || item.stdout),
            stderr: this._extractText(item.stderr),
            phase: eventPhase,
          },
        }],
        raw: event,
      };
    }

    if (item.type === 'reasoning') {
      const summary = this._extractText(item.summary || item.text || item.content || event?.delta);
      return {
        type: 'assistant',
        model: this.getDefaultModel(),
        tokensUsed: null,
        contentBlocks: [{
          type: 'tool_use',
          toolId: item.id || `${eventType}-reasoning`,
          toolName: 'Reasoning',
          toolInput: {
            summary: summary || null,
            status: item.status,
            phase: eventPhase,
          },
        }],
        raw: event,
      };
    }

    if (item.type === 'todo_list') {
      return {
        type: 'assistant',
        model: this.getDefaultModel(),
        tokensUsed: null,
        contentBlocks: [{
          type: 'tool_use',
          toolId: item.id || `${eventType}-todo`,
          toolName: 'TodoList',
          toolInput: {
            status: item.status,
            phase: eventPhase,
            items: item.items || item.todos || item.tasks || [],
          },
        }],
        raw: event,
      };
    }

    if (item.type === 'web_search') {
      return {
        type: 'assistant',
        model: this.getDefaultModel(),
        tokensUsed: null,
        contentBlocks: [{
          type: 'tool_use',
          toolId: item.id || `${eventType}-web-search`,
          toolName: 'WebSearch',
          toolInput: {
            query: item.query || item.input?.query || null,
            status: item.status,
            phase: eventPhase,
          },
        }],
        raw: event,
      };
    }

    if (item.type === 'mcp_tool_call') {
      return {
        type: 'assistant',
        model: this.getDefaultModel(),
        tokensUsed: null,
        contentBlocks: [{
          type: 'tool_use',
          toolId: item.id || `${eventType}-mcp`,
          toolName: item.name || item.tool_name || item.toolName || 'MCPTool',
          toolInput: {
            server: item.server || item.server_name || null,
            arguments: item.arguments || item.args || item.input || null,
            status: item.status,
            phase: eventPhase,
          },
        }],
        raw: event,
      };
    }

    if (item.type === 'file_change') {
      return {
        type: 'assistant',
        model: this.getDefaultModel(),
        tokensUsed: null,
        contentBlocks: [{
          type: 'tool_use',
          toolId: item.id || `${eventType}-file-change`,
          toolName: 'FileChange',
          toolInput: {
            path: item.path || item.file_path || null,
            action: item.action || item.operation || item.change_type || null,
            status: item.status,
            phase: eventPhase,
          },
        }],
        raw: event,
      };
    }

    return null;
  }

  /**
   * Build normalized assistant text event.
   * @private
   * @param {string} text
   * @param {Object} raw
   * @returns {Object}
   */
  _buildTextEvent(text, raw) {
    return {
      type: 'assistant',
      model: this.getDefaultModel(),
      tokensUsed: null,
      contentBlocks: [{
        type: 'text',
        text,
      }],
      raw,
    };
  }

  /**
   * Extract text from codex event payloads that can be string/object/array.
   * @private
   * @param {*} value
   * @returns {string}
   */
  _extractText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map((entry) => this._extractText(entry)).filter(Boolean).join('');
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') return value.text;
      if (typeof value.content === 'string') return value.content;
      if (Array.isArray(value.content)) return this._extractText(value.content);
      if (typeof value.delta === 'string') return value.delta;
    }
    return '';
  }

  /**
   * Extract agent message text while avoiding duplicate output on delta events.
   * @private
   * @param {Object} item
   * @param {string|null} eventPhase
   * @param {string} textDelta
   * @returns {string}
   */
  _extractAgentMessageText(item, eventPhase, textDelta) {
    if (eventPhase === 'delta') {
      return textDelta || this._extractText(item.delta);
    }
    return this._extractText(item.text || item.content || textDelta);
  }

  /**
   * Create a unique temp output capture directory for one Codex invocation.
   * This avoids collisions when multiple review calls run in parallel.
   *
   * @returns {Promise<{dir: string, outputFile: string, cleanup: () => Promise<void>}>}
   */
  async createOutputCapture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-codex-review-'));
    const outputFile = path.join(dir, 'output.txt');
    return {
      dir,
      outputFile,
      cleanup: async () => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  /**
   * Resolve final review text from codex execution output.
   * Prefer captured output-file content and fall back to stdout.
   *
   * @param {string} stdoutText
   * @param {string} outputFileText
   * @returns {string}
   */
  extractReviewText(stdoutText = '', outputFileText = '') {
    const captured = String(outputFileText || '').trim();
    if (captured) {
      const capturedJson = this._extractFirstJsonObject(captured);
      return capturedJson || captured;
    }

    const raw = String(stdoutText || '');
    if (!raw.trim()) return '';

    const assistantTexts = [];
    const errorTexts = [];
    let resultText = '';
    const plainTextLines = [];

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        plainTextLines.push(line);
        continue;
      }

      if (parsed?.type === 'result') {
        if (parsed?.is_error || String(parsed?.subtype || '').toLowerCase() === 'error') {
          const errorMessage = typeof parsed?.error?.message === 'string'
            ? parsed.error.message.trim()
            : '';
          if (errorMessage) {
            errorTexts.push(errorMessage);
          }
        }
        const candidate = typeof parsed.result === 'string'
          ? parsed.result.trim()
          : (typeof parsed.content === 'string' ? parsed.content.trim() : '');
        if (candidate) {
          resultText = candidate;
        }
        continue;
      }

      if (parsed?.type === 'error') {
        const errorMessage = typeof parsed?.message === 'string'
          ? parsed.message.trim()
          : (typeof parsed?.error?.message === 'string' ? parsed.error.message.trim() : '');
        if (errorMessage) {
          errorTexts.push(errorMessage);
        }
        continue;
      }

      const eventType = typeof parsed?.type === 'string' ? parsed.type : '';
      if (!eventType.startsWith('item.')) continue;
      const phase = eventType.slice('item.'.length) || null;
      const item = parsed?.item;
      if (!item || item?.type !== 'agent_message') continue;
      const textDelta = this._extractText(parsed?.delta);
      const assistantText = this._extractAgentMessageText(item, phase, textDelta);
      if (assistantText && assistantText.trim()) {
        assistantTexts.push(assistantText);
      }
    }

    if (resultText) {
      const resultJson = this._extractFirstJsonObject(resultText);
      if (resultJson) return resultJson;
    }

    if (assistantTexts.length > 0) {
      for (let i = assistantTexts.length - 1; i >= 0; i -= 1) {
        const extracted = this._extractFirstJsonObject(assistantTexts[i]);
        if (extracted) return extracted;
      }
      const lastAssistant = String(assistantTexts[assistantTexts.length - 1] || '').trim();
      if (lastAssistant) return lastAssistant;
    }

    if (resultText) return resultText;
    if (errorTexts.length > 0) return errorTexts[errorTexts.length - 1];
    if (plainTextLines.length > 0) return plainTextLines.join('\n').trim();

    return raw.trim();
  }

  /**
   * Extract free-form discovery text from Codex execution output.
   * This is used for terminal-like PR discovery flows where the model
   * returns natural review notes instead of structured JSON.
   *
   * @param {string} rawOutput
   * @returns {string}
   */
  extractDiscoveryText(rawOutput = '') {
    const raw = String(rawOutput || '');
    if (!raw.trim()) return '';

    const assistantTexts = [];
    const errorTexts = [];
    let resultText = '';
    const plainTextLines = [];

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        plainTextLines.push(line);
        continue;
      }

      if (parsed?.type === 'result') {
        if (parsed?.is_error || String(parsed?.subtype || '').toLowerCase() === 'error') {
          const errorMessage = typeof parsed?.error?.message === 'string'
            ? parsed.error.message.trim()
            : '';
          if (errorMessage) errorTexts.push(errorMessage);
        }
        const candidate = typeof parsed.result === 'string'
          ? parsed.result.trim()
          : (typeof parsed.content === 'string' ? parsed.content.trim() : '');
        if (candidate) resultText = candidate;
        continue;
      }

      if (parsed?.type === 'error') {
        const errorMessage = typeof parsed?.message === 'string'
          ? parsed.message.trim()
          : (typeof parsed?.error?.message === 'string' ? parsed.error.message.trim() : '');
        if (errorMessage) errorTexts.push(errorMessage);
        continue;
      }

      const eventType = typeof parsed?.type === 'string' ? parsed.type : '';
      if (!eventType.startsWith('item.')) continue;
      const phase = eventType.slice('item.'.length) || null;
      const item = parsed?.item;
      if (!item || item?.type !== 'agent_message') continue;
      const textDelta = this._extractText(parsed?.delta);
      const assistantText = this._extractAgentMessageText(item, phase, textDelta);
      if (assistantText && assistantText.trim()) {
        assistantTexts.push(assistantText.trim());
      }
    }

    if (assistantTexts.length > 0) {
      for (let i = assistantTexts.length - 1; i >= 0; i -= 1) {
        const candidate = assistantTexts[i];
        if (/^summary:\s*/im.test(candidate) || /^issues:\s*/im.test(candidate)) {
          return candidate;
        }
      }
      return assistantTexts[assistantTexts.length - 1];
    }

    if (resultText) return resultText;
    if (plainTextLines.length > 0) return plainTextLines.join('\n').trim();
    if (errorTexts.length > 0) return errorTexts[errorTexts.length - 1];
    return raw.trim();
  }

  _extractFirstJsonObject(input) {
    const text = String(input || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];

      if (start === -1) {
        if (ch === '{') {
          start = i;
          depth = 1;
        }
        continue;
      }

      if (inString) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (ch === '\\') {
          escapeNext = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        continue;
      }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1).trim();
        }
      }
    }

    return null;
  }

  /**
   * Get available Codex CLI models.
   * @returns {Array<{alias: string, name: string, description: string}>}
   */
  getModels() {
    return CODEX_MODELS;
  }

  getDefaultModel() {
    const now = Date.now();
    if (
      this._defaultModelCache.value
      && now - this._defaultModelCache.loadedAt < DEFAULT_MODEL_CACHE_TTL_MS
    ) {
      return this._defaultModelCache.value;
    }

    // Respect explicit environment overrides first.
    const envModel = process.env.CODEX_MODEL || process.env.OPENAI_MODEL;
    if (envModel && envModel.trim()) {
      this._defaultModelCache = {
        value: envModel.trim(),
        loadedAt: now,
      };
      return this._defaultModelCache.value;
    }

    // Best-effort read of local Codex config when available.
    const homeDir = process.env.HOME || os.homedir();
    const configCandidates = [
      path.join(homeDir, '.codex', 'config.json'),
      path.join(homeDir, '.config', 'codex', 'config.json'),
    ];

    for (const configPath of configCandidates) {
      try {
        const content = fsSync.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        const model = typeof config.model === 'string' ? config.model.trim() : '';
        if (model) {
          this._defaultModelCache = {
            value: model,
            loadedAt: now,
          };
          return this._defaultModelCache.value;
        }
      } catch {
        // Ignore invalid/missing files.
      }
    }

    const tomlConfigPath = path.join(homeDir, '.codex', 'config.toml');
    try {
      const content = fsSync.readFileSync(tomlConfigPath, 'utf-8');
      const model = extractCodexTomlModel(content);
      if (model) {
        this._defaultModelCache = {
          value: model,
          loadedAt: now,
        };
        return this._defaultModelCache.value;
      }
    } catch {
      // Ignore invalid/missing files.
    }

    this._defaultModelCache = {
      value: 'gpt-5.5',
      loadedAt: now,
    };
    return this._defaultModelCache.value;
  }
}

// Singleton export
const codexAdapter = new CodexAdapter();
export default codexAdapter;
