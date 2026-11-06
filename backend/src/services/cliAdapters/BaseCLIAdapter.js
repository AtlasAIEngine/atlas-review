/**
 * Base CLI Adapter
 * Abstract base class for CLI tool adapters (Claude, Codex, Gemini, etc.)
 * Each adapter implements binary discovery, auth checking, arg construction,
 * and stream parsing for its respective CLI tool.
 */

import { execSync } from 'child_process';
import path from 'path';

/**
 * Module-level cache for npm global bin path.
 * undefined = not checked, null = checked and npm unavailable, string = the root path.
 * Ensures `npm root -g` runs at most once per process.
 * @type {undefined|null|string}
 */
let _npmGlobalBinCache;

/**
 * Resolve the npm global bin directory path for a given binary name.
 * Runs `npm root -g` (cached) and returns `<root>/../bin/<binaryName>` or null.
 *
 * @param {string} binaryName - The binary name (e.g. 'gemini', 'claude', 'codex')
 * @returns {string|null} Absolute path to the binary or null if unavailable
 */
export function resolveNpmGlobalBinPath(binaryName) {
  if (_npmGlobalBinCache === undefined) {
    try {
      _npmGlobalBinCache = execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      _npmGlobalBinCache = null;
    }
  }
  if (!_npmGlobalBinCache) return null;
  return path.join(_npmGlobalBinCache, '..', 'bin', binaryName);
}

export class BaseCLIAdapter {
  /**
   * Human-readable name for this CLI adapter
   * @returns {string}
   */
  getName() {
    throw new Error('getName() not implemented');
  }

  /**
   * Provider type key (matches providerService PROVIDER_CONFIGS keys)
   * @returns {string} e.g. 'anthropic', 'openai', 'google'
   */
  getType() {
    throw new Error('getType() not implemented');
  }

  /**
   * Whether this adapter is fully supported for build mode.
   * Placeholder adapters (e.g. Gemini) return false.
   * @returns {boolean}
   */
  isSupported() {
    return true;
  }

  /**
   * Find the CLI binary on the local machine.
   * @returns {Promise<string>} Absolute path to binary
   * @throws {Error} if binary not found
   */
  async findBinary() {
    throw new Error('findBinary() not implemented');
  }

  /**
   * Check if the CLI is authenticated and ready to use.
   * @returns {Promise<{authenticated: boolean, error?: string}>}
   */
  async checkAuth() {
    throw new Error('checkAuth() not implemented');
  }

  /**
   * Build CLI arguments for a build-mode message.
   * @param {Object} opts
   * @param {string} opts.message - The prompt/message to send
   * @param {string} opts.sessionId - Unique session ID
   * @param {string} [opts.model] - Model alias or ID
   * @param {string} [opts.permissionMode] - Permission mode
   * @returns {{args: string[], stdinMessage?: boolean, structuredOutput?: boolean}}
   *   args: CLI argument array to pass to spawn
   *   stdinMessage: if true, the message should be written to stdin instead of args
   *   structuredOutput: if true, stdout is structured (JSONL) and blank lines can be ignored
   */
  buildArgs(opts) {
    throw new Error('buildArgs() not implemented');
  }

  /**
   * Build CLI arguments for agentic review mode.
   * Default implementation reuses buildArgs().
   *
   * @param {Object} opts
   * @param {string} opts.message
   * @param {string} opts.sessionId
   * @param {string} [opts.model]
   * @param {number} [opts.maxTurns]
   * @param {string} [opts.projectPath]
   * @param {string} [opts.outputFile]
   * @returns {{args: string[], stdinMessage?: boolean, structuredOutput?: boolean}}
   */
  buildAgenticArgs(opts) {
    return this.buildArgs(opts);
  }

  /**
   * Parse a single line from the CLI's stdout stream into a normalized event.
   * @param {string} line - A single line of stdout output
   * @returns {Object|null} Normalized event or null if line should be skipped
   *   { type: 'text'|'tool_use'|'tool_result'|'system'|'result'|'error',
   *     text?, model?, tokensUsed?, toolName?, toolInput?, toolId?,
   *     raw? }
   */
  parseStreamLine(line) {
    throw new Error('parseStreamLine() not implemented');
  }

  /**
   * Parse a line from agentic stream output.
   * Default implementation reuses parseStreamLine().
   *
   * @param {string} line
   * @returns {Object|null}
   */
  parseAgenticStreamLine(line) {
    return this.parseStreamLine(line);
  }

  /**
   * Resolve available execution modes for this adapter.
   * Adapters can override this to declare capability matrix.
   *
   * @param {Object} context
   * @param {boolean} context.hasCliRuntime
   * @param {boolean} context.forcedCli
   * @param {boolean} context.hasApi
   * @returns {string[]}
   */
  getExecutionModes({ hasCliRuntime } = {}) {
    if (!hasCliRuntime) return [];
    return ['cli-agent', 'cli-pipe'];
  }

  /**
   * Whether the CLI supports a native --max-turns flag.
   * When false, the server enforces turn limits by counting stream events and
   * killing the process when the budget is exhausted.
   * @returns {boolean}
   */
  supportsCliMaxTurns() {
    return false;
  }

  /**
   * Whether this adapter should be wrapped in a Darwin sandbox-exec profile for agentic mode.
   * @returns {boolean}
   */
  shouldUseDarwinSandboxProfile() {
    return false;
  }

  /**
   * Extract file target path from normalized tool-use payload.
   * Adapters can override for provider-specific schemas.
   *
   * @param {string} _toolName
   * @param {Object} _toolInput
   * @returns {string|null}
   */
  extractToolPathFromToolUse(_toolName, _toolInput) {
    return null;
  }

  /**
   * Get available models for this CLI provider.
   * @returns {Array<{alias: string, name: string, description: string}>}
   */
  getModels() {
    throw new Error('getModels() not implemented');
  }

  /**
   * Get the default model identifier for this CLI provider.
   * Used to initialize model metadata before any stream events arrive.
   * @returns {string}
   */
  getDefaultModel() {
    throw new Error('getDefaultModel() not implemented');
  }
}
