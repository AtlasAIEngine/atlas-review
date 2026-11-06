/**
 * Gemini CLI Adapter
 * Implements the CLI adapter interface for Google Gemini CLI.
 * Uses `gemini --prompt '' --output-format stream-json --yolo` with stdin-based message passing.
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
 * Gemini CLI models — sourced from providerService PROVIDER_CONFIGS.google.
 */
// Gemini CLI ≥0.31.0 hardcodes includeThoughts:true in every API request.
// Models without thinking support (e.g. gemini-2.0-flash) always fail with
// INVALID_ARGUMENT, so only thinking-capable models are listed here.
const GEMINI_MODELS = [
  { alias: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'Most capable, advanced reasoning' },
  { alias: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', description: 'Frontier-class at Flash speed' },
  { alias: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash-Lite', description: 'Cost-efficient workhorse for high-volume tasks' },
  { alias: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast with reasoning' },
  { alias: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', description: 'Fastest, lowest cost' },
  { alias: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Advanced reasoning (2.5 series)' },
];

class GeminiAdapter extends BaseCLIAdapter {
  constructor() {
    super();
    this._cachedBinaryPath = null;
    this._defaultModelCache = {
      value: null,
      loadedAt: 0,
    };
  }

  getName() {
    return 'Gemini CLI';
  }

  getType() {
    return 'google';
  }

  /**
   * Gemini CLI is fully supported for build mode.
   * @returns {true}
   */
  isSupported() {
    return true;
  }

  /**
   * Find the Gemini CLI binary.
   * Checks common absolute paths first (essential for desktop apps with
   * minimal PATH), then falls back to `which gemini`.
   * @returns {Promise<string>}
   * @throws {Error} if binary not found
   */
  async findBinary() {
    if (this._cachedBinaryPath) {
      return this._cachedBinaryPath;
    }

    const isWindows = process.platform === 'win32';
    const homeDir = process.env.HOME || os.homedir();
    const candidates = [];
    if (isWindows) {
      candidates.push(
        path.join(homeDir, '.local', 'bin', 'gemini.exe'),
        ...getWindowsCliShimCandidates('gemini'),
      );
    }
    candidates.push(
      path.join(homeDir, '.local', 'bin', 'gemini'),
      '/opt/homebrew/bin/gemini',
      '/usr/local/bin/gemini',
    );

    // npm global install path (e.g. /usr/lib/node_modules/../bin/gemini)
    const npmBin = resolveNpmGlobalBinPath('gemini');
    if (npmBin) candidates.push(npmBin);

    for (const candidate of candidates) {
      try {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        this._cachedBinaryPath = resolveWindowsCliExecutablePath(candidate);
        return this._cachedBinaryPath;
      } catch {
        // Not found, try next
      }
    }

    const lookupCmd = isWindows ? 'where gemini' : 'which gemini';
    try {
      const result = execSync(lookupCmd, { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0].trim();
      if (result) {
        this._cachedBinaryPath = resolveWindowsCliExecutablePath(result);
        return this._cachedBinaryPath;
      }
    } catch {
      // lookup failed
    }

    throw new Error('Gemini CLI not found. Install with: npm install -g @google/gemini-cli or see https://github.com/google-gemini/gemini-cli');
  }

  /**
   * Check Gemini CLI availability by running `gemini --version`.
   * @returns {Promise<{authenticated: boolean, error?: string}>}
   */
  async checkAuth() {
    try {
      const binaryPath = await this.findBinary();
      await execFileAsync(binaryPath, ['--version'], { timeout: 10000 });
      return { authenticated: true };
    } catch (error) {
      const message = error?.message || 'Gemini CLI not available.';
      return { authenticated: false, error: message };
    }
  }

  /**
   * Build Gemini CLI arguments for headless mode.
   * Gemini uses `gemini --prompt '' --output-format stream-json --yolo`
   * with the message sent via stdin.
   *
   * @param {Object} opts
   * @param {string} opts.message - The prompt (sent via stdin)
   * @param {string} opts.sessionId - Gemini session ID (used with -r for resume)
   * @param {string} [opts.model] - Model ID (e.g. 'gemini-2.5-pro')
   * @param {string} [opts.systemPrompt] - System prompt to prepend to stdin
   * @param {boolean} [opts.resumeSession=false] - If true and sessionId is present, use -r to resume
   * @returns {{args: string[], stdinMessage: true}}
   */
  buildArgs({ message, sessionId, model, systemPrompt, resumeSession = false }) {
    const args = [
      '--prompt', '',
      '--output-format', 'stream-json',
      '--yolo',
    ];

    if (resumeSession && sessionId) {
      args.push('-r', sessionId);
    }

    if (model) {
      args.push('--model', model);
    }

    // Gemini CLI lacks --append-system-prompt; prepend system prompt to stdin
    let stdinMsg = message;
    if (systemPrompt) {
      stdinMsg = `[SYSTEM INSTRUCTIONS]: ${systemPrompt}\n\n${message}`;
    }

    return { args, stdinMessage: true, structuredOutput: true, message: stdinMsg };
  }

  /**
   * Build Gemini CLI arguments for agentic (multi-turn) mode.
   * Gemini CLI lacks `--append-system-prompt`, so we prepend the system prompt
   * to the stdin message instead.
   *
   * @param {Object} opts
   * @param {string} opts.message - The prompt (sent via stdin)
   * @param {string} opts.sessionId - Gemini session ID (used with -r for resume)
   * @param {string} [opts.model] - Model ID
   * @param {number} [opts.maxTurns] - Max turns (unused — Gemini CLI handles internally)
   * @param {string} [opts.systemPrompt] - System prompt to prepend to stdin
   * @param {boolean} [opts.resumeSession=false] - If true and sessionId is present, use -r to resume
   * @returns {{args: string[], stdinMessage: boolean, structuredOutput: boolean, message: string}}
   */
  buildAgenticArgs({ message, sessionId, model, maxTurns, systemPrompt, resumeSession = false }) {
    const args = [
      '--prompt', '',
      '--output-format', 'stream-json',
      '--yolo',
    ];

    if (resumeSession && sessionId) {
      args.push('-r', sessionId);
    }

    if (model) {
      args.push('--model', model);
    }

    // Gemini CLI lacks --append-system-prompt; prepend system prompt to stdin
    let stdinMsg = message;
    if (systemPrompt) {
      stdinMsg = `[SYSTEM INSTRUCTIONS]: ${systemPrompt}\n\n${message}`;
    }

    return { args, stdinMessage: true, structuredOutput: true, message: stdinMsg };
  }

  /**
   * Parse a single line from Gemini's stream-json stdout into a normalized event.
   * Gemini stream-json emits JSONL events with various action types.
   *
   * @param {string} line - A single JSON line from Gemini CLI stdout
   * @returns {Object|null} Normalized event or null if line should be skipped
   */
  parseStreamLine(line) {
    if (line === undefined || line === null) return null;

    const trimmed = line.trim();
    if (!trimmed) return null;

    // Try to parse as JSON first
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const event = JSON.parse(trimmed);
        return this._parseJsonEvent(event);
      } catch {
        // Fall through to plain-text mode
      }
    }

    // Gemini can emit status/warning lines that should not appear as assistant prose
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('warning:')
      || lower.startsWith('reading prompt from stdin')
      || lower.startsWith('info:')
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
        text: line + '\n',
      }],
      raw: { type: 'text', text: line },
    };
  }

  /**
   * Parse Gemini JSONL stream events into normalized adapter events.
   * @private
   * @param {Object} event
   * @returns {Object|null}
   */
  _parseJsonEvent(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    // Gemini stream-json uses an `action` or `type` field
    const action = event.action || event.type || '';
    const role = typeof event.role === 'string' ? event.role.toLowerCase() : '';

    switch (action) {
      // Model/session initialization
      case 'init':
        // Capture session_id from Gemini CLI init event for session resume (-r)
        if (event.session_id) {
          return {
            type: 'session_meta',
            sessionId: event.session_id,
            model: event.model || event.modelId || null,
            raw: event,
          };
        }
        return {
          type: 'system',
          model: event.model || event.modelId || null,
          raw: event,
        };
      case 'model_info':
      case 'session_start':
      case 'system':
        return {
          type: 'system',
          model: event.model || event.modelId || null,
          raw: event,
        };

      // Text content from the model
      case 'text':
      case 'content':
        return this._parseTextEvent(event);
      case 'message':
        // Gemini stream-json emits user and assistant message events; only
        // assistant content should be treated as model output.
        if (role && role !== 'assistant') {
          return {
            type: 'system',
            model: event.model || this.getDefaultModel(),
            raw: event,
          };
        }
        return this._parseTextEvent(event);

      // Tool calls (function calling)
      case 'tool_use':
      case 'tool_call':
      case 'function_call':
        return {
          type: 'assistant',
          model: event.model || this.getDefaultModel(),
          tokensUsed: null,
          contentBlocks: [{
            type: 'tool_use',
            toolId: event.id || event.tool_id || event.callId || `gemini-tool-${Date.now()}`,
            toolName: event.tool_name || event.name || event.functionName || event.tool || 'GeminiTool',
            toolInput: event.parameters || event.args || event.arguments || event.input || {},
          }],
          raw: event,
        };

      // Tool result
      case 'tool_result':
      case 'function_response':
        return {
          type: 'system',
          model: this.getDefaultModel(),
          raw: event,
        };

      // Shell/command execution
      case 'shell':
      case 'command':
        return {
          type: 'assistant',
          model: this.getDefaultModel(),
          tokensUsed: null,
          contentBlocks: [{
            type: 'tool_use',
            toolId: event.id || `gemini-shell-${Date.now()}`,
            toolName: 'Bash',
            toolInput: {
              command: event.command || event.input || null,
              status: event.status || null,
              exit_code: event.exitCode ?? event.exit_code ?? null,
              output: event.output || event.stdout || null,
            },
          }],
          raw: event,
        };

      // File operations
      case 'file_edit':
      case 'file_write':
      case 'file_read':
        return {
          type: 'assistant',
          model: this.getDefaultModel(),
          tokensUsed: null,
          contentBlocks: [{
            type: 'tool_use',
            toolId: event.id || `gemini-file-${Date.now()}`,
            toolName: 'FileChange',
            toolInput: {
              path: event.path || event.filePath || null,
              action: action.replace('file_', ''),
              status: event.status || null,
            },
          }],
          raw: event,
        };

      // Turn/session completion
      case 'turn_complete':
      case 'result':
      case 'done':
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
          message: event.error?.message || event.message || 'Gemini stream error',
          raw: event,
        };

      // Thinking/reasoning
      case 'thinking':
      case 'thought':
        return {
          type: 'assistant',
          model: this.getDefaultModel(),
          tokensUsed: null,
          contentBlocks: [{
            type: 'tool_use',
            toolId: event.id || `gemini-thinking-${Date.now()}`,
            toolName: 'Reasoning',
            toolInput: {
              summary: event.text || event.thought || event.content || null,
              status: event.status || null,
            },
          }],
          raw: event,
        };

      default:
        // Check if the event has text/content fields even without a recognized action
        if (event.text || event.content || event.response) {
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
    const text = event.text || event.content || event.response || event.message || '';
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
   * Extract final review text from Gemini CLI output.
   * Handles mixed plain-text + JSON output and returns the most
   * deterministic final payload available.
   *
   * @param {string} rawOutput
   * @returns {string}
   */
  extractReviewText(rawOutput = '') {
    const raw = String(rawOutput || '');
    if (!raw.trim()) return '';

    // Try to parse as a single JSON response first (gemini --output-format json)
    const trimmedRaw = raw.trim();
    if (trimmedRaw.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmedRaw);
        // Gemini JSON mode wraps response in a `response` or `text` field
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

      const action = parsed?.action || parsed?.type || '';

      // Result/done events — use response field
      if (action === 'result' || action === 'done' || action === 'turn_complete') {
        const candidate = parsed.response || parsed.text || parsed.result || parsed.content;
        if (typeof candidate === 'string' && candidate.trim()) {
          resultText = candidate.trim();
        }
        continue;
      }

      // Text/content events — accumulate
      if (action === 'message') {
        const role = typeof parsed.role === 'string' ? parsed.role.toLowerCase() : '';
        // Skip user/system prompt echoes; they contain Atlas envelopes and JSON
        // schema metadata that can overshadow the real assistant review payload.
        if (role && role !== 'assistant') {
          continue;
        }
        const text = parsed.text || parsed.content || parsed.response;
        if (typeof text === 'string' && text.trim()) {
          assistantTextParts.push(text);
        }
        continue;
      }

      if (action === 'text' || action === 'content') {
        const text = parsed.text || parsed.content || parsed.response;
        if (typeof text === 'string' && text.trim()) {
          assistantTextParts.push(text);
          textParts.push(text);
        }
      }

      // Also check for partialText / response field on any event
      if (!action || action === '') {
        const text = parsed.text || parsed.content || parsed.response;
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
   * Extract the first complete JSON object from a string.
   * @private
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
    return ['cli-agentic', 'cli-agent', 'cli-pipe'];
  }

  extractToolPathFromToolUse(toolName, toolInput = {}) {
    if (!toolInput || typeof toolInput !== 'object') return null;
    const normalizedToolName = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
    if (normalizedToolName === 'run_shell_command' || normalizedToolName === 'bash') {
      return null;
    }
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
   * Get available Gemini models (for display in the dropdown).
   * @returns {Array<{alias: string, name: string, description: string}>}
   */
  getModels() {
    return GEMINI_MODELS;
  }

  /**
   * Get the default model identifier for Gemini CLI.
   * Checks GEMINI_MODEL env var, then ~/.gemini/settings.json, then falls back.
   * Uses TTL-cached pattern matching Claude/Codex adapters.
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

    let resolvedModel = 'gemini-3-flash-preview';

    // 1. Check GEMINI_MODEL env var
    const envModel = process.env.GEMINI_MODEL;
    if (envModel && envModel.trim()) {
      this._defaultModelCache = {
        value: envModel.trim(),
        loadedAt: now,
      };
      return this._defaultModelCache.value;
    }

    // 2. Check ~/.gemini/settings.json for configured model
    const homeDir = process.env.HOME || os.homedir();
    const settingsCandidates = [
      path.join(homeDir, '.gemini', 'settings.json'),
      path.join(homeDir, '.config', 'gemini', 'settings.json'),
    ];

    for (const settingsPath of settingsCandidates) {
      try {
        const content = fsSync.readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        // Gemini settings can store model as model.name or just model
        const configuredModel = typeof settings.model === 'string'
          ? settings.model.trim()
          : (typeof settings.model?.name === 'string' ? settings.model.name.trim() : '');
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
const geminiAdapter = new GeminiAdapter();
export default geminiAdapter;
