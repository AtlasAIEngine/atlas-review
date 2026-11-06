/**
 * OpenCode CLI Adapter
 * Implements the CLI adapter interface for the OpenCode CLI.
 * Uses `opencode run --format json` with stdin-based message passing.
 */

import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { BaseCLIAdapter, resolveNpmGlobalBinPath } from './BaseCLIAdapter.js';
import { getWindowsCliShimCandidates, resolveWindowsCliExecutablePath } from '../../utils/windowsCliPaths.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL_CACHE_TTL_MS = 5000;

/**
 * OpenCode CLI models — initial hardcoded list.
 * Future: could shell out to `opencode models --verbose`.
 */
const OPENCODE_MODELS = [
  { alias: 'opencode-default', name: 'OpenCode Default', description: 'Default model via OpenCode' },
];

class OpenCodeAdapter extends BaseCLIAdapter {
  constructor() {
    super();
    this._cachedBinaryPath = null;
    this._defaultModelCache = {
      value: null,
      loadedAt: 0,
    };
  }

  getName() {
    return 'OpenCode';
  }

  getType() {
    return 'opencode';
  }

  /**
   * OpenCode CLI is fully supported.
   * @returns {true}
   */
  isSupported() {
    return true;
  }

  /**
   * Find the OpenCode CLI binary.
   * Checks OPENCODE_CLI_PATH env var, then common absolute paths,
   * then falls back to `which opencode`.
   * @returns {Promise<string>}
   * @throws {Error} if binary not found
   */
  async findBinary() {
    // Check environment override
    if (process.env.OPENCODE_CLI_PATH) {
      return process.env.OPENCODE_CLI_PATH;
    }

    // Return cached path if available
    if (this._cachedBinaryPath) {
      return this._cachedBinaryPath;
    }

    const isWindows = process.platform === 'win32';
    const homeDir = process.env.HOME || os.homedir();
    const candidates = [];
    if (isWindows) {
      candidates.push(
        path.join(homeDir, '.local', 'bin', 'opencode.exe'),
        ...getWindowsCliShimCandidates('opencode'),
      );
    }
    candidates.push(
      path.join(homeDir, '.opencode', 'bin', 'opencode'),
      path.join(homeDir, '.local', 'bin', 'opencode'),
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
      path.join(homeDir, 'go', 'bin', 'opencode'),
    );

    const npmBin = resolveNpmGlobalBinPath('opencode');
    if (npmBin) candidates.push(npmBin);

    for (const candidate of candidates) {
      try {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        this._cachedBinaryPath = resolveWindowsCliExecutablePath(candidate);
        return this._cachedBinaryPath;
      } catch {
        // Not found or not executable, try next
      }
    }

    // Fall back to PATH lookup: `where` on Windows, `which` on Unix
    const lookupCmd = isWindows ? 'where opencode' : 'which opencode';
    try {
      const result = execSync(lookupCmd, { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0].trim();
      if (result) {
        this._cachedBinaryPath = resolveWindowsCliExecutablePath(result);
        return this._cachedBinaryPath;
      }
    } catch {
      // lookup failed
    }

    throw new Error('OpenCode CLI not found. Install from: https://github.com/opencode-ai/opencode');
  }

  /**
   * Check OpenCode CLI authentication by running `opencode auth list`.
   * @returns {Promise<{authenticated: boolean, error?: string}>}
   */
  async checkAuth() {
    try {
      const binaryPath = await this.findBinary();
      await execFileAsync(binaryPath, ['auth', 'list'], { timeout: 10000 });
      return { authenticated: true };
    } catch (error) {
      const message = error?.message || 'OpenCode CLI not available.';
      return { authenticated: false, error: message };
    }
  }

  /**
   * Build OpenCode CLI arguments for single-turn pipe/agent mode.
   * Produces: ['run', '--format', 'json', '-m', model]
   * with the message sent via stdin.
   *
   * @param {Object} opts
   * @param {string} opts.message - The prompt (sent via stdin)
   * @param {string} [opts.sessionId] - Session ID for resume
   * @param {string} [opts.model] - Model ID (e.g. 'anthropic/claude-sonnet-4-6')
   * @param {string} [opts.systemPrompt] - System prompt to prepend to message
   * @param {boolean} [opts.resumeSession=false] - If true, resume existing session
   * @returns {{args: string[], stdinMessage: boolean, structuredOutput: boolean, message: string}}
   */
  buildArgs({ message, sessionId, model, systemPrompt, resumeSession = false }) {
    const args = ['run', '--format', 'json'];

    const resolvedModel = this._resolveCliModel(model);
    if (resolvedModel) {
      args.push('-m', resolvedModel);
    }

    if (resumeSession && sessionId) {
      args.push('-s', sessionId);
    }

    // OpenCode has no --system-prompt flag; prepend to message
    let composedMessage = message;
    if (systemPrompt) {
      composedMessage = `[SYSTEM INSTRUCTIONS]: ${systemPrompt}\n\n${message}`;
    }

    return { args, stdinMessage: true, structuredOutput: true, message: composedMessage };
  }

  /**
   * Build OpenCode CLI arguments for agentic (multi-turn) review mode.
   * OpenCode lacks --append-system-prompt, so system prompt is prepended to stdin.
   *
   * @param {Object} opts
   * @param {string} opts.message - The prompt (sent via stdin)
   * @param {string} [opts.sessionId] - Session ID for resume
   * @param {string} [opts.model] - Model ID
   * @param {number} [opts.maxTurns] - Max turns (unused — OpenCode handles internally)
   * @param {string} [opts.systemPrompt] - System prompt to prepend to stdin
   * @param {string} [opts.projectPath] - Project root directory
   * @returns {{args: string[], stdinMessage: boolean, structuredOutput: boolean, message: string}}
   */
  buildAgenticArgs({ message, sessionId, model, maxTurns, systemPrompt, projectPath }) {
    const args = ['run', '--format', 'json'];

    const resolvedModel = this._resolveCliModel(model);
    if (resolvedModel) {
      args.push('-m', resolvedModel);
    }

    // Note: OpenCode's -s flag resumes an existing session by ID (requires ses_ prefix
    // and a matching session file on disk). The review pipeline creates fresh sessions,
    // so we intentionally omit -s to let OpenCode create a new session automatically.

    // OpenCode has no --system-prompt flag; prepend to message
    let composedMessage = message;
    if (systemPrompt) {
      composedMessage = `[SYSTEM INSTRUCTIONS]: ${systemPrompt}\n\n${message}`;
    }

    return { args, stdinMessage: true, structuredOutput: true, message: composedMessage };
  }

  /**
   * Resolve a model identifier for the OpenCode CLI -m flag.
   * - 'opencode-default' or falsy → null (let OpenCode use its configured default)
   * - 'provider/model' format → pass through
   * - bare model name → attempt 'anthropic/{model}' prefix
   *
   * @private
   * @param {string} [model]
   * @returns {string|null}
   */
  _resolveCliModel(model) {
    const raw = typeof model === 'string' ? model.trim() : '';
    if (!raw || raw === 'opencode-default') return null;

    // Already in provider/model format
    if (raw.includes('/')) return raw;

    // Bare model name — prefix with anthropic (most common)
    return `anthropic/${raw}`;
  }

  /**
   * Parse a single line from OpenCode's --format json stdout into a normalized event.
   * Handles JSONL events with plain-text fallback.
   *
   * @param {string} line - A single line from OpenCode CLI stdout
   * @returns {Object|null} Normalized event or null if line should be skipped
   */
  parseStreamLine(line) {
    if (line === undefined || line === null) return null;

    const trimmed = line.trim();
    if (!trimmed) return null;

    // Try to parse as JSON first (JSONL from --format json)
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const event = JSON.parse(trimmed);
        return this._parseJsonEvent(event);
      } catch {
        // Fall through to plain-text mode
      }
    }

    // Filter out status/warning lines
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('warning:')
      || lower.startsWith('info:')
      || lower.startsWith('reading prompt from stdin')
      || (/^\d{4}-\d{2}-\d{2}t/.test(lower) && (lower.includes(' error ') || lower.includes(' warn ')))
    ) {
      return {
        type: 'system',
        model: this.getDefaultModel(),
        raw: { type: 'status', text: line },
      };
    }

    // Plain text fallback — treat as assistant text
    return {
      type: 'assistant',
      model: this.getDefaultModel(),
      tokensUsed: null,
      contentBlocks: [{
        type: 'text',
        text: line,
      }],
      raw: { type: 'text', text: line },
    };
  }

  /**
   * Parse agentic stream output — delegates to parseStreamLine.
   * @param {string} line
   * @returns {Object|null}
   */
  parseAgenticStreamLine(line) {
    return this.parseStreamLine(line);
  }

  /**
   * Parse OpenCode JSONL stream events into normalized adapter events.
   * Uses defensive multi-field parsing since the exact --format json schema
   * may vary across versions.
   *
   * @private
   * @param {Object} event
   * @returns {Object|null}
   */
  _parseJsonEvent(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const action = event.type || event.action || event.event || '';

    switch (action) {
      // Initialization / system events
      case 'init':
      case 'system':
      case 'session_start':
      case 'model_info':
      case 'step_start':
        return {
          type: 'system',
          model: event.model || event.modelId || null,
          raw: event,
        };

      // Step finish — carries token counts
      case 'step_finish':
        return {
          type: 'result',
          model: event.model || this.getDefaultModel(),
          tokensUsed:
            (event.part?.tokens?.input || 0) + (event.part?.tokens?.output || 0)
            || event.usage?.outputTokens
            || event.usage?.output_tokens
            || null,
          raw: event,
        };

      // Text/content from the model
      case 'text':
      case 'content':
      case 'message':
      case 'assistant':
        return this._parseTextEvent(event);

      // Tool use events
      case 'tool_use':
      case 'tool_call':
      case 'function_call': {
        // OpenCode JSONL nests tool data inside event.part:
        //   {"type":"tool_use","part":{"callID":"...","tool":"write","state":{"input":{...}}}}
        const part = event.part || {};
        return {
          type: 'assistant',
          model: event.model || this.getDefaultModel(),
          tokensUsed: null,
          contentBlocks: [{
            type: 'tool_use',
            toolId: event.id || event.tool_id || event.callId || part.callID || `opencode-tool-${Date.now()}`,
            toolName: event.tool_name || event.name || event.functionName || event.tool || part.tool || 'OpenCodeTool',
            toolInput: event.parameters || event.args || event.arguments || event.input || part.state?.input || {},
          }],
          raw: event,
        };
      }

      // Tool result
      case 'tool_result':
      case 'function_response':
        return {
          type: 'system',
          model: this.getDefaultModel(),
          raw: event,
        };

      // Completion events
      case 'result':
      case 'done':
      case 'turn_complete':
        return {
          type: 'result',
          model: event.model || this.getDefaultModel(),
          tokensUsed:
            event.usage?.outputTokens
            || event.usage?.output_tokens
            || event.stats?.output_tokens
            || event.stats?.outputTokens
            || null,
          raw: event,
        };

      // Error events
      case 'error':
        return {
          type: 'error',
          model: this.getDefaultModel(),
          message: event.error?.message || event.message || 'OpenCode stream error',
          raw: event,
        };

      default:
        // Check if the event has text/content fields even without a recognized action
        if (event.text || event.part?.text || event.content || event.response) {
          return this._parseTextEvent(event);
        }
        // Unknown event type — pass through as system
        return {
          type: 'system',
          model: this.getDefaultModel(),
          raw: event,
        };
    }
  }

  /**
   * Parse a text/content event into normalized assistant text.
   * @private
   * @param {Object} event
   * @returns {Object}
   */
  _parseTextEvent(event) {
    // Handle assistant event format with message.content array (Claude-style)
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const contentBlocks = [];
      for (const block of event.message.content) {
        if (block?.type === 'text' && typeof block?.text === 'string') {
          contentBlocks.push({ type: 'text', text: block.text });
        } else if (block?.type === 'tool_use') {
          contentBlocks.push({
            type: 'tool_use',
            toolId: block.id || `opencode-tool-${Date.now()}`,
            toolName: block.name || 'OpenCodeTool',
            toolInput: block.input || {},
          });
        }
      }
      if (contentBlocks.length > 0) {
        return {
          type: 'assistant',
          model: event.model || event.message?.model || this.getDefaultModel(),
          tokensUsed: event.message?.usage?.output_tokens || null,
          contentBlocks,
          raw: event,
        };
      }
    }

    // OpenCode JSONL nests text inside event.part: {"type":"text","part":{"text":"..."}}
    const text = event.text || event.part?.text || event.content || event.response || event.message || '';
    const textStr = typeof text === 'string' ? text : JSON.stringify(text);
    return {
      type: 'assistant',
      model: event.model || this.getDefaultModel(),
      tokensUsed:
        event.usage?.outputTokens
        || event.usage?.output_tokens
        || event.stats?.output_tokens
        || event.stats?.outputTokens
        || null,
      contentBlocks: [{
        type: 'text',
        text: textStr,
      }],
      raw: event,
    };
  }

  /**
   * Extract file target path from normalized tool-use payload.
   * Checks common field names across different CLI tool conventions.
   *
   * @param {string} _toolName
   * @param {Object} toolInput
   * @returns {string|null}
   */
  extractToolPathFromToolUse(_toolName, toolInput = {}) {
    if (!toolInput || typeof toolInput !== 'object') return null;
    const candidates = [
      toolInput.file_path,
      toolInput.filePath,
      toolInput.path,
      toolInput.directory,
      toolInput.target_file,
      toolInput.targetPath,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    return null;
  }

  /**
   * Extract final review text from OpenCode CLI output.
   * Handles mixed plain-text + JSON output and returns the most
   * deterministic final payload available.
   *
   * @param {string} rawOutput
   * @returns {string}
   */
  extractReviewText(rawOutput = '') {
    const raw = String(rawOutput || '');
    if (!raw.trim()) return '';

    // Try to parse as a single JSON response first
    const trimmedRaw = raw.trim();
    if (trimmedRaw.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmedRaw);
        const candidate = parsed.response || parsed.text || parsed.content || parsed.result;
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }
      } catch {
        // Not a single JSON object, try JSONL
      }
    }

    // Parse JSONL stream output
    const assistantTextParts = [];
    const textParts = [];
    let resultText = '';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const action = parsed?.type || parsed?.action || parsed?.event || '';

      // Result/done events
      if (action === 'result' || action === 'done' || action === 'turn_complete') {
        const candidate = parsed.response
          || parsed.text
          || parsed.result
          || parsed.content
          || parsed.part?.text
          || parsed.part?.content
          || parsed.part?.response;
        if (typeof candidate === 'string' && candidate.trim()) {
          resultText = candidate.trim();
        }
        continue;
      }

      // Assistant message events
      if (action === 'assistant' && Array.isArray(parsed?.message?.content)) {
        for (const block of parsed.message.content) {
          if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
            assistantTextParts.push(block.text);
          }
        }
        continue;
      }

      // Text/content events
      if (action === 'text' || action === 'content' || action === 'message') {
        const text = parsed.text
          || parsed.content
          || parsed.response
          || parsed.part?.text
          || parsed.part?.content
          || parsed.part?.response;
        if (typeof text === 'string' && text.trim()) {
          assistantTextParts.push(text);
          textParts.push(text);
        }
        continue;
      }

      // Untyped events with text
      if (!action) {
        const text = parsed.text
          || parsed.content
          || parsed.response
          || parsed.part?.text
          || parsed.part?.content
          || parsed.part?.response;
        if (typeof text === 'string' && text.trim()) {
          textParts.push(text);
        }
      }
    }

    if (resultText) {
      return this._extractLastJsonObject(resultText) || resultText;
    }
    if (assistantTextParts.length > 0) {
      const merged = assistantTextParts.join('').trim();
      return this._extractLastJsonObject(merged) || merged;
    }
    if (textParts.length > 0) {
      const merged = textParts.join('').trim();
      return this._extractLastJsonObject(merged) || merged;
    }

    return this._extractLastJsonObject(raw) || this._extractFirstJsonObject(raw) || raw.trim();
  }

  /**
   * Extract freeform discovery text from OpenCode CLI JSONL output.
   * Unlike review extraction, discovery mode should preserve prose findings
   * rather than looking for a final structured JSON object.
   *
   * @param {string} rawOutput
   * @returns {string}
   */
  extractDiscoveryText(rawOutput = '') {
    const raw = String(rawOutput || '');
    if (!raw.trim()) return '';

    const assistantTextParts = [];
    const errorParts = [];
    const textParts = [];

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        textParts.push(trimmed);
        continue;
      }

      const action = parsed?.type || parsed?.action || parsed?.event || '';

      if (action === 'assistant' && Array.isArray(parsed?.message?.content)) {
        for (const block of parsed.message.content) {
          if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
            assistantTextParts.push(block.text.trim());
          }
        }
        continue;
      }

      if (action === 'text' || action === 'content' || action === 'message' || action === 'assistant') {
        const text = parsed.text
          || parsed.content
          || parsed.response
          || parsed.part?.text
          || parsed.part?.content
          || parsed.part?.response;
        if (typeof text === 'string' && text.trim()) {
          assistantTextParts.push(text.trim());
        }
        continue;
      }

      if (action === 'error') {
        const message = parsed.error?.message
          || parsed.message
          || parsed.part?.text
          || parsed.part?.content
          || parsed.part?.response;
        if (typeof message === 'string' && message.trim()) {
          errorParts.push(message.trim());
        }
        continue;
      }

      if (!action) {
        const text = parsed.text
          || parsed.content
          || parsed.response
          || parsed.part?.text
          || parsed.part?.content
          || parsed.part?.response;
        if (typeof text === 'string' && text.trim()) {
          textParts.push(text.trim());
        }
      }
    }

    if (assistantTextParts.length > 0) {
      return assistantTextParts.join('\n').trim();
    }
    if (errorParts.length > 0) {
      return errorParts.join('\n').trim();
    }
    if (textParts.length > 0) {
      return textParts.join('\n').trim();
    }

    return raw.trim();
  }

  /**
   * Extract the first complete JSON object from a string.
   * @private
   * @param {string} input
   * @returns {string|null}
   */
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
   * Extract the last complete JSON object from a string.
   * @private
   * @param {string} input
   * @returns {string|null}
   */
  _extractLastJsonObject(input) {
    const text = String(input || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let last = null;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (start === -1) {
        if (ch === '{') {
          start = i;
          depth = 1;
          inString = false;
          escapeNext = false;
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
          last = text.slice(start, i + 1).trim();
          start = -1;
        }
      }
    }

    return last;
  }

  getExecutionModes({ hasCliRuntime } = {}) {
    if (!hasCliRuntime) return [];
    // CLI first: if a user picked OpenCode for review, prefer their working
    // `opencode run` path before falling back to Atlas's direct API resolver.
    // Keep cli-pipe omitted; agent and agentic cover the CLI review paths.
    return ['cli-agentic', 'cli-agent', 'api'];
  }

  /**
   * OpenCode does not support a native --max-turns flag.
   * @returns {false}
   */
  supportsCliMaxTurns() {
    return false;
  }

  /**
   * OpenCode handles its own sandboxing.
   * @returns {false}
   */
  shouldUseDarwinSandboxProfile() {
    return false;
  }

  /**
   * Get available models for OpenCode CLI.
   * @returns {Array<{alias: string, name: string, description: string}>}
   */
  getModels() {
    return OPENCODE_MODELS;
  }

  /**
   * Get the default model identifier for OpenCode CLI.
   * Checks OPENCODE_MODEL env var, then ~/.opencode/config.json, then falls back.
   * Uses TTL-cached pattern matching other adapters.
   * @returns {string}
   */
  getDefaultModel() {
    const now = Date.now();
    if (
      this._defaultModelCache.value
      && now - this._defaultModelCache.loadedAt < DEFAULT_MODEL_CACHE_TTL_MS
    ) {
      return this._defaultModelCache.value;
    }

    let resolvedModel = 'opencode-default';

    // 1. Check OPENCODE_MODEL env var
    const envModel = process.env.OPENCODE_MODEL;
    if (envModel && envModel.trim()) {
      this._defaultModelCache = {
        value: envModel.trim(),
        loadedAt: now,
      };
      return this._defaultModelCache.value;
    }

    // 2. Check ~/.opencode/config.json for configured model
    const homeDir = process.env.HOME || os.homedir();
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    const configCandidates = [
      path.join(xdgConfig, 'opencode', 'opencode.json'),
      path.join(xdgConfig, 'opencode', 'opencode.jsonc'),
      path.join(homeDir, '.opencode', 'config.json'),
      path.join(homeDir, '.config', 'opencode', 'config.json'),
    ];

    for (const configPath of configCandidates) {
      try {
        const content = fsSync.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        const configuredModel = typeof config.model === 'string'
          ? config.model.trim()
          : (typeof config.model?.name === 'string' ? config.model.name.trim() : '');
        if (configuredModel) {
          resolvedModel = configuredModel;
          break;
        }
      } catch {
        // Ignore parse/read failures
      }
    }

    this._defaultModelCache = {
      value: resolvedModel,
      loadedAt: now,
    };
    return this._defaultModelCache.value;
  }
}

// Singleton export
const openCodeAdapter = new OpenCodeAdapter();
export default openCodeAdapter;
