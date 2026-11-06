/**
 * Claude CLI Adapter
 * Implements the CLI adapter interface for Claude Code CLI.
 * Extracts and centralizes logic previously hardcoded in server.js.
 */

import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import providerService from '../providerService.js';
import { BaseCLIAdapter, resolveNpmGlobalBinPath } from './BaseCLIAdapter.js';
import { findClaudeBinary, isAtlasManagedClaudeBinaryPath } from '../../utils/claudeBinary.js';
import { getWindowsCliShimCandidates } from '../../utils/windowsCliPaths.js';
const DEFAULT_MODEL_CACHE_TTL_MS = 5000;

class ClaudeAdapter extends BaseCLIAdapter {
  constructor() {
    super();
    this._cachedBinaryPath = null;
    this._defaultModelCache = {
      value: null,
      loadedAt: 0,
    };
    this._supportsSettingSources = null;
    this._supportsTools = null;
    this._supportsSessionId = null;
    this._supportsResume = null;
    this._capabilityBinaryPath = null;
  }

  getName() {
    return 'Claude Code';
  }

  getType() {
    return 'anthropic';
  }

  /**
   * Find the Claude CLI binary.
   * Checks common absolute paths first (essential for desktop apps with
   * minimal PATH), then falls back to `which claude`.
   * @returns {Promise<string>}
   * @throws {Error} if binary not found
   */
  async findBinary() {
    // Check environment override
    if (process.env.CLAUDE_CLI_PATH && !isAtlasManagedClaudeBinaryPath(process.env.CLAUDE_CLI_PATH)) {
      this._probeCliCapabilities(process.env.CLAUDE_CLI_PATH);
      return process.env.CLAUDE_CLI_PATH;
    }

    // Return cached path if available
    if (this._cachedBinaryPath && !isAtlasManagedClaudeBinaryPath(this._cachedBinaryPath)) {
      this._probeCliCapabilities(this._cachedBinaryPath);
      return this._cachedBinaryPath;
    }
    if (this._cachedBinaryPath && isAtlasManagedClaudeBinaryPath(this._cachedBinaryPath)) {
      this._cachedBinaryPath = null;
    }

    const isWindows = process.platform === 'win32';
    if (!isWindows) {
      const result = await findClaudeBinary({ allowNpx: false, preferredFlags: ['--tools'] });
      this._cachedBinaryPath = result.binary;
      this._applyCliCapabilities(result);
      return result.binary;
    }

    const homeDir = process.env.HOME || os.homedir();
    const candidates = [];
    if (isWindows) {
      candidates.push(
        path.join(homeDir, '.local', 'bin', 'claude.exe'),
        ...getWindowsCliShimCandidates('claude'),
      );
    }
    candidates.push(
      path.join(homeDir, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    );

    // npm global install path
    const npmBin = resolveNpmGlobalBinPath('claude');
    if (npmBin) candidates.push(npmBin);

    for (const candidate of candidates) {
      if (isAtlasManagedClaudeBinaryPath(candidate)) continue;
      try {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        this._cachedBinaryPath = candidate;
        this._probeCliCapabilities(candidate);
        return candidate;
      } catch {
        // Not found or not executable, try next
      }
    }

    // Fall back to PATH lookup: `where` on Windows, `which` on Unix
    const lookupCmd = isWindows ? 'where claude' : 'which claude';
    try {
      const result = execSync(lookupCmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
      if (result && !isAtlasManagedClaudeBinaryPath(result)) {
        this._cachedBinaryPath = result;
        this._probeCliCapabilities(result);
        return result;
      }
    } catch {
      // lookup failed
    }

    throw new Error('Claude CLI not found. Please install Claude Code CLI.');
  }

  /**
   * Check Claude CLI authentication using the unified provider detector so
   * stored OAuth tokens and Windows prerequisites are honored consistently.
   * @returns {Promise<{authenticated: boolean, error?: string}>}
   */
  async checkAuth() {
    try {
      const status = await providerService.getCliAuthStatus();
      const claude = status?.['claude-code'];

      if (claude?.authenticated) {
        return {
          authenticated: true,
          provider: this.getType(),
          source: claude.source || null,
          binaryPath: claude.binaryPath || null,
        };
      }

      if (claude?.prerequisite?.status && claude.prerequisite.status !== 'ok') {
        return {
          authenticated: false,
          error: claude.prerequisite.message || 'Claude Code requires Git Bash on Windows.',
          prerequisite: claude.prerequisite,
        };
      }

      const binaryPath = claude?.binaryPath || await this.findBinary();
      return {
        authenticated: false,
        error: `Claude Code is installed at ${binaryPath} but is not authenticated. Run \`claude login\` or save a Claude OAuth token.`,
        binaryPath,
      };
    } catch (error) {
      const message = error?.message || 'Claude CLI not available.';
      return { authenticated: false, error: message };
    }
  }

  /**
   * Build Claude CLI arguments for a build-mode message.
   * Produces: ['--print', '--output-format', 'stream-json', '--verbose',
   *   '--session-id'|'--resume', id, '--dangerously-skip-permissions', '--', prompt]
   * with optional --model and --append-system-prompt.
   *
   * @param {Object} opts
   * @param {string} opts.message - The prompt to send
   * @param {string} opts.sessionId - UUID session ID
   * @param {string} [opts.model] - Model alias (e.g. 'sonnet', 'opus')
   * @param {string} [opts.systemPrompt] - System prompt to append via --append-system-prompt
   * @param {boolean} [opts.resumeSession=false] - If true, use --resume instead of --session-id
   * @returns {{args: string[], stdinMessage: true, message: string}}
   */
  buildArgs({ message, sessionId, model, systemPrompt, resumeSession = false }) {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      // Builder chat does not use MCP tools — Atlas owns the tool surface.
      // Without this, Claude Code auto-loads the user's global MCP servers
      // (~/.claude/settings.json) and starts a child process for each one
      // before the first token, adding ~1–2s per server. Skip them entirely.
      '--strict-mcp-config',
    ];

    this._appendSessionArgs(args, sessionId, resumeSession);

    const resolvedModel = this._resolveCliModel(model);
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    // Always skip permissions — plan mode restrictions enforced via prompt
    args.push('--dangerously-skip-permissions');

    // Prompt delivered via stdin to avoid ENAMETOOLONG (E2BIG) when the
    // review prompt exceeds the OS arg-length limit (~32KB on Windows,
    // ~256KB on macOS).
    return { args, stdinMessage: true, message };
  }

  /**
   * Build args for CLI-agentic (multi-turn) review execution.
   *
   * @param {Object} opts
   * @param {string} opts.message
   * @param {string} opts.sessionId
   * @param {string} [opts.model]
   * @param {number} [opts.maxTurns]
   * @param {string} [opts.systemPrompt]
   * @param {boolean} [opts.resumeSession=false] - If true, use --resume instead of --session-id
   * @param {string} [opts.projectPath] - Project root; used with 'addDir' strategy
   * @param {string} [opts.permissionStrategy] - Permission/isolation strategy:
   *   'skip' (default) — uses --dangerously-skip-permissions
   *   'allowedTools'   — uses --allowedTools with explicit tool allowlist
   *   'addDir'         — uses --add-dir <projectPath> without skip-permissions
   * @param {Object} [opts.runtimeMcp] - Section R Phase B per-review MCP config.
   *   When provided and `enabled !== false`, the spawned CLI gets
   *   `--mcp-config '{"mcpServers":{"atlas-review-rt":{...}}}'` and the
   *   3 mcp__atlas-review-rt__* tools are added to the tool allowlist.
   *   Required fields: binPath, projectRoot, mergeBaseSha, headSha.
   * @param {Object} [opts.codegraphMcp] - CodeGraph experiment per-review
   *   MCP config. When provided and `enabled !== false`, the spawned CLI
   *   gets a `codegraph` MCP server entry alongside `atlas-review-rt` and
   *   the 9 mcp__codegraph__* tools are added to the tool allowlist. The
   *   server is launched via the CodeGraph CLI (`codegraph serve --mcp`)
   *   from the project working directory; the index must already exist
   *   (we don't index on the spawn hot path).
   *   Required fields: projectRoot. Optional: binPath (defaults to
   *   `codegraph` on PATH).
   */
  buildAgenticArgs({ message, sessionId, model, maxTurns, systemPrompt, projectPath, permissionStrategy, runtimeMcp, codegraphMcp, resumeSession = false }) {
    const strategy = permissionStrategy || 'skip';
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      // Atlas owns the tool surface (--allowedTools / --tools below) and does
      // not rely on MCP servers from the user's config. Without this, Claude
      // Code starts every MCP server defined in ~/.claude.json on each spawn
      // (posthog/pencil/atlas-review/etc.), adding several seconds before the
      // first token arrives. Review's full-isolation path strips MCP via a
      // sanitized HOME (see reviewProviderExecution.js); this flag is the
      // lighter equivalent for the agentic chat path used by Ask Atlas.
      // Compatible with --mcp-config below: --strict-mcp-config means
      // "ignore user MCP config", and --mcp-config explicitly registers
      // the per-review runtime MCP server (Section R Phase B).
      '--strict-mcp-config',
    ];

    const runtimeMcpConfig = this._buildRuntimeMcpConfig(runtimeMcp, codegraphMcp);
    if (runtimeMcpConfig) {
      args.push('--mcp-config', runtimeMcpConfig.inlineJson);
    }

    const settingSources = this._resolveSettingSourcesArg();
    if (settingSources) {
      args.push('--setting-sources', settingSources);
    }

    this._appendSessionArgs(args, sessionId, resumeSession);

    // Tool restriction: --tools for skip/addDir, --allowedTools for allowedTools strategy
    // permissionPrompt doesn't restrict tools — it uses the permission prompt tool instead
    const runtimeMcpToolNames = runtimeMcpConfig ? runtimeMcpConfig.toolNames : [];
    if (strategy === 'allowedTools') {
      const list = ['Read', 'Grep', 'Glob', 'Bash(git:*)', ...runtimeMcpToolNames].join(',');
      args.push('--allowedTools', list);
    } else if (strategy !== 'permissionPrompt' && this._supportsTools !== false) {
      const list = ['Read', 'Grep', 'Glob', 'Bash', ...runtimeMcpToolNames].join(',');
      args.push('--tools', list);
    }

    const resolvedModel = this._resolveCliModel(model);
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    // NOTE: We deliberately do NOT pass `--max-turns` to the agentic CLI.
    // Adding it caused production reviews to hang ("no output for 191s")
    // — the CLI appears to stall at the max-turns boundary instead of
    // exiting cleanly. The 3-minute liveness watcher in callCliAgentic is
    // the real safety net. The streaming-counted actualTurns is reported
    // honestly (so users see "9 of 7" if the run overrunneth) but we
    // don't try to enforce the budget at the CLI level.
    void maxTurns;

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    // Permission strategy determines how the CLI gates tool access.
    switch (strategy) {
      case 'permissionPrompt':
        // Use --permission-prompt-tool for pre-execution gating
        // The server handles control_request events on stdout and writes
        // control_response to stdin to allow/deny tool use.
        args.push('--permission-prompt-tool', 'stdio');
        break;
      case 'allowedTools':
        // CLI uses its permission system; tools are pre-approved via --allowedTools.
        // No --dangerously-skip-permissions needed.
        break;
      case 'addDir':
        // Restrict CLI to specified project directory without full permission bypass.
        if (projectPath) {
          args.push('--add-dir', projectPath);
        }
        break;
      case 'skip':
      default:
        args.push('--dangerously-skip-permissions');
        break;
    }

    // Prompt delivered via stdin to avoid E2BIG when the directive prompt
    // exceeds the OS arg-length limit (~256KB on macOS).
    // Do NOT append '--' — it causes the CLI to expect a positional arg
    // and ignore stdin entirely, resulting in an empty prompt.
    return { args, stdinMessage: true, structuredOutput: true, message };
  }

  /**
   * Assemble the inline --mcp-config payload registering per-review MCP
   * servers. Two opt-in servers may be present in the result:
   *
   *   - `atlas-review-rt` (Section R Phase B): server-curated diff/file
   *     retrieval tools. Added when `runtimeMcp` is supplied with
   *     `enabled !== false` and all four required fields present.
   *   - `codegraph` (CodeGraph experiment): external @colbymchenry/codegraph
   *     MCP server. Added when `codegraphMcp` is supplied with
   *     `enabled !== false` and `projectRoot` present. The server is
   *     launched via the CodeGraph CLI from the project working directory;
   *     the `.codegraph/` index must already exist (this method does not
   *     index — initialization happens via the codegraphService lifecycle).
   *
   * Returns null when neither server qualifies (zero changes to the spawn
   * args — byte-stable with pre-Phase-B for the baseline path).
   *
   * Tool names returned here are the canonical MCP-namespaced names the
   * Claude CLI expects in --allowedTools: `mcp__<server>__<tool>`.
   *
   * The server keys are distinct from any consumer-side MCP names so this
   * config never collides with the user's ~/.claude.json server entries.
   */
  _buildRuntimeMcpConfig(runtimeMcp, codegraphMcp) {
    const mcpServers = {};
    const toolNames = [];

    if (runtimeMcp && runtimeMcp.enabled !== false) {
      const { binPath, projectRoot, mergeBaseSha, headSha } = runtimeMcp;
      if (binPath && projectRoot && mergeBaseSha && headSha) {
        const serverName = 'atlas-review-rt';
        mcpServers[serverName] = {
          command: 'node',
          args: [binPath],
          env: {
            ATLAS_REVIEW_RT_PROJECT_PATH: projectRoot,
            ATLAS_REVIEW_RT_BASE_SHA: mergeBaseSha,
            ATLAS_REVIEW_RT_HEAD_SHA: headSha,
          },
        };
        toolNames.push(
          `mcp__${serverName}__get_diff_for_file`,
          `mcp__${serverName}__read_file_slice`,
          `mcp__${serverName}__get_hunk_context`,
        );
      }
    }

    if (codegraphMcp && codegraphMcp.enabled !== false) {
      const { projectRoot, binPath } = codegraphMcp;
      if (projectRoot) {
        const serverName = 'codegraph';
        const command = binPath || 'codegraph';
        mcpServers[serverName] = {
          command,
          args: ['serve', '--mcp'],
          // Launch with the project as cwd so CodeGraph picks up the
          // .codegraph/ index alongside the source it indexed.
          cwd: projectRoot,
        };
        // Explicit allowlist — no wildcard. Per the CodeGraph 0.9.x
        // README, this is the documented tool set: 8 listed + the
        // codegraph_explore tool referenced in the CodeGraph instructions
        // block. Allowed but not forced — adoption is driven by the
        // prompt nudge in reviewProviderExecution.js.
        toolNames.push(
          `mcp__${serverName}__codegraph_search`,
          `mcp__${serverName}__codegraph_context`,
          `mcp__${serverName}__codegraph_callers`,
          `mcp__${serverName}__codegraph_callees`,
          `mcp__${serverName}__codegraph_impact`,
          `mcp__${serverName}__codegraph_node`,
          `mcp__${serverName}__codegraph_explore`,
          `mcp__${serverName}__codegraph_status`,
          `mcp__${serverName}__codegraph_files`,
        );
      }
    }

    if (Object.keys(mcpServers).length === 0) return null;
    return {
      inlineJson: JSON.stringify({ mcpServers }),
      toolNames,
    };
  }

  _probeCliCapabilities(binaryPath) {
    if (
      this._capabilityBinaryPath === binaryPath
      &&
      this._supportsSettingSources !== null
      && this._supportsTools !== null
      && this._supportsSessionId !== null
      && this._supportsResume !== null
    ) {
      return;
    }
    if (!binaryPath) {
      return;
    }

    try {
      const ext = path.extname(String(binaryPath || '')).toLowerCase();
      const isWindowsShim = process.platform === 'win32' && (ext === '.cmd' || ext === '.bat');
      const help = execFileSync(binaryPath, ['--help'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        ...(isWindowsShim ? { shell: true } : {}),
      });
      const helpText = String(help || '');
      this._supportsSettingSources = helpText.includes('--setting-sources');
      this._supportsTools = helpText.includes('--tools');
      this._supportsSessionId = helpText.includes('--session-id');
      this._supportsResume = helpText.includes('--resume');
      this._capabilityBinaryPath = binaryPath;
    } catch {
      this._supportsSettingSources = false;
      this._supportsTools = false;
      this._supportsSessionId = false;
      this._supportsResume = false;
      this._capabilityBinaryPath = binaryPath;
    }
  }

  _applyCliCapabilities(result) {
    if (result && typeof result.supportsSettingSources === 'boolean') {
      this._supportsSettingSources = result.supportsSettingSources;
    }
    if (result && typeof result.supportsTools === 'boolean') {
      this._supportsTools = result.supportsTools;
    }
    if (result && typeof result.supportsSessionId === 'boolean') {
      this._supportsSessionId = result.supportsSessionId;
    }
    if (result && typeof result.supportsResume === 'boolean') {
      this._supportsResume = result.supportsResume;
    }
    if (result?.binary) {
      this._capabilityBinaryPath = result.binary;
    }
    if (
      this._supportsSettingSources === null
      || this._supportsTools === null
      || this._supportsSessionId === null
      || this._supportsResume === null
    ) {
      this._probeCliCapabilities(result?.binary);
    }
  }

  _resolveSettingSourcesArg() {
    const override = String(process.env.ATLAS_CLAUDE_SETTING_SOURCES || '').trim();
    if (override) return override;
    return this._supportsSettingSources === true ? 'project,local' : null;
  }

  _appendSessionArgs(args, sessionId, resumeSession = false) {
    if (resumeSession) {
      if (this._supportsResume !== false) {
        args.push('--resume', sessionId);
      }
      return;
    }

    if (this._supportsSessionId !== false) {
      args.push('--session-id', sessionId);
    }
  }

  _resolveCliModel(model) {
    return providerService.resolveAnthropicCliModelArg(model);
  }

  getExecutionModes({ hasCliRuntime } = {}) {
    if (!hasCliRuntime) return [];
    return ['cli-agentic', 'cli-agent', 'cli-pipe'];
  }

  supportsCliMaxTurns() {
    return true;
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
        return typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
      case 'Grep':
      case 'Glob':
        return typeof toolInput.path === 'string' ? toolInput.path : null;
      default:
        return null;
    }
  }

  /**
   * Parse a single line from Claude's stream-json stdout into a normalized event.
   * Claude stream-json emits JSON objects with types: system, assistant, result,
   * content_block_delta, etc.
   *
   * @param {string} line - A single JSON line from Claude CLI stdout
   * @returns {Object|null} Normalized event or null if line should be skipped
   */
  parseStreamLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON line (verbose debug output) — skip
      return null;
    }

    switch (event.type) {
      case 'system':
        return {
          type: 'system',
          model: event.model || null,
          raw: event,
        };

      case 'assistant':
        return this._parseAssistantEvent(event);

      case 'result':
        return this._parseResultEvent(event);

      case 'control_request':
        // Permission prompt tool event — the CLI is asking whether a tool
        // invocation should be allowed or denied.
        return {
          type: 'control_request',
          toolName: event.tool?.name || null,
          toolInput: event.tool?.input || null,
          requestId: event.id || null,
          raw: event,
        };

      default:
        // Unknown event type — pass through as raw
        return {
          type: event.type || 'unknown',
          raw: event,
        };
    }
  }

  /**
   * Parse a Claude 'assistant' event into normalized sub-events.
   * Returns an array since one assistant event can contain multiple content blocks.
   * @private
   */
  _parseAssistantEvent(event) {
    const result = {
      type: 'assistant',
      model: event.message?.model || null,
      tokensUsed: event.message?.usage?.output_tokens || null,
      contentBlocks: [],
      raw: event,
    };

    if (event.message?.content && Array.isArray(event.message.content)) {
      for (const content of event.message.content) {
        if (content.type === 'text' && content.text) {
          result.contentBlocks.push({
            type: 'text',
            text: content.text,
          });
        } else if (content.type === 'tool_use') {
          result.contentBlocks.push({
            type: 'tool_use',
            toolId: content.id,
            toolName: content.name,
            toolInput: content.input,
          });
        }
      }
    }

    return result;
  }

  /**
   * Parse a Claude 'result' event.
   * @private
   */
  _parseResultEvent(event) {
    let tokensUsed = null;
    if (event.usage?.output_tokens) {
      tokensUsed = event.usage.output_tokens;
    }
    // Also check modelUsage for detailed per-model counts
    if (event.modelUsage) {
      for (const modelKey of Object.keys(event.modelUsage)) {
        if (event.modelUsage[modelKey]?.outputTokens) {
          tokensUsed = event.modelUsage[modelKey].outputTokens;
        }
      }
    }

    return {
      type: 'result',
      tokensUsed,
      raw: event,
    };
  }

  /**
   * Extract final review text from Claude CLI output.
   * Handles mixed plain-text + stream-json output and returns the most
   * deterministic final payload available.
   *
   * @param {string} rawOutput
   * @returns {string}
   */
  extractReviewText(rawOutput = '') {
    const raw = String(rawOutput || '');
    if (!raw.trim()) return '';

    const assistantTexts = [];
    const deltaTextParts = [];
    const plainTextLines = [];
    let resultText = '';
    let resultErrorText = '';
    let fallbackReviewJson = '';
    let hasJsonlEvents = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const wrappedJson = this._extractFirstJsonObject(trimmed);
        if (!wrappedJson) {
          plainTextLines.push(trimmed);
          continue;
        }
        try {
          parsed = JSON.parse(wrappedJson);
        } catch {
          plainTextLines.push(trimmed);
          continue;
        }
      }
      const typedEvent = typeof parsed?.type === 'string' ? parsed.type : '';
      if (
        !typedEvent
        || typedEvent === 'assistant'
        || typedEvent === 'result'
        || typedEvent === 'content_block_start'
        || typedEvent === 'content_block_delta'
      ) {
        const reviewJsonFromEvent = this._extractReviewJsonFromValue(parsed);
        if (reviewJsonFromEvent) {
          fallbackReviewJson = reviewJsonFromEvent;
        }
      }
      // Track whether we found any typed JSONL stream events (system, assistant, result, etc.).
      // If so, we're in JSONL mode and the final raw-fallback should NOT return random JSON metadata.
      if (parsed?.type) hasJsonlEvents = true;
      if (parsed?.type === 'result') {
        const candidate = this._coerceEventText(parsed.result)
          || this._coerceEventText(parsed.content)
          || this._coerceEventText(parsed.response)
          || this._coerceEventText(parsed.output);
        if (parsed?.is_error === true || String(parsed?.subtype || '').toLowerCase() === 'error') {
          const maybeError = this._coerceEventText(parsed.error) || candidate;
          if (maybeError) resultErrorText = maybeError;
        }
        if (candidate) {
          resultText = candidate;
        }
        continue;
      }
      if (parsed?.type === 'assistant' && Array.isArray(parsed?.message?.content)) {
        for (const block of parsed.message.content) {
          if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
            assistantTexts.push(block.text);
          }
        }
      }
      if (parsed?.type === 'content_block_start') {
        const block = parsed?.content_block || parsed?.contentBlock;
        if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
          deltaTextParts.push(block.text);
        }
      }
      if (parsed?.type === 'content_block_delta') {
        const delta = parsed?.delta || parsed?.content_block_delta || parsed?.contentBlockDelta;
        const deltaText = this._coerceEventText(delta?.text)
          || this._coerceEventText(delta?.delta)
          || this._coerceEventText(parsed?.text);
        if (deltaText) {
          deltaTextParts.push(deltaText);
        }
      }
      if (parsed?.type === 'error') {
        const maybeError = this._coerceEventText(parsed?.error) || this._coerceEventText(parsed?.message);
        if (maybeError) resultErrorText = maybeError;
      }
    }

    // Prefer resultText if it looks like JSON; otherwise search assistantTexts
    // for the actual review JSON (in multi-turn agentic sessions, the result
    // event may contain conversational prose from the last assistant turn).
    if (resultText) {
      if (resultText.trimStart().startsWith('{')) return resultText;
      const resultJson = this._extractFirstJsonObject(resultText);
      if (resultJson) return resultJson;
      // resultText is prose — fall through to search assistantTexts
    }

    if (assistantTexts.length > 0) {
      // Search backward: the review JSON is typically in the last assistant text.
      // In multi-turn sessions, earlier texts are planning/reasoning, not the review.
      for (let i = assistantTexts.length - 1; i >= 0; i--) {
        const extracted = this._extractFirstJsonObject(assistantTexts[i]);
        if (extracted) return extracted;
      }
      // No JSON found in any individual text — try merged as last resort
      const merged = assistantTexts.join('\n').trim();
      const mergedJson = this._extractFirstJsonObject(merged);
      if (mergedJson) return mergedJson;
    }

    if (deltaTextParts.length > 0) {
      const mergedDelta = deltaTextParts.join('').trim();
      const deltaJson = this._extractFirstJsonObject(mergedDelta);
      if (deltaJson) return deltaJson;
      if (mergedDelta) resultText = resultText || mergedDelta;
    }

    if (fallbackReviewJson) {
      return fallbackReviewJson;
    }

    if (plainTextLines.length > 0) {
      const plainJson = this._extractLikelyReviewJsonFromText(plainTextLines.join('\n'));
      if (plainJson) return plainJson;
    }

    const rawReviewJson = this._extractLikelyReviewJsonFromText(raw);
    if (rawReviewJson) return rawReviewJson;

    if (!resultText && resultErrorText) {
      return resultErrorText;
    }

    // Final fallback: if the output was in JSONL stream format (had typed events
    // like system/init) but yielded no assistant/result content, the CLI produced
    // no review — return empty so the caller surfaces a clear error.
    if (hasJsonlEvents) return resultText || resultErrorText || '';
    // Non-JSONL output (e.g. plain-text JSON from older CLI): try raw extraction.
    return this._extractFirstJsonObject(raw) || resultText || resultErrorText || raw.trim();
  }

  /**
   * Extract free-form discovery text from Claude CLI output.
   * This is used for terminal-like PR discovery flows where we want the
   * assistant's natural review notes, not a JSON payload.
   *
   * @param {string} rawOutput
   * @returns {string}
   */
  extractDiscoveryText(rawOutput = '') {
    const raw = String(rawOutput || '');
    if (!raw.trim()) return '';

    const assistantTexts = [];
    const deltaTextParts = [];
    const plainTextLines = [];
    let resultText = '';
    let resultErrorText = '';

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        plainTextLines.push(trimmed);
        continue;
      }

      if (parsed?.type === 'result') {
        const candidate = this._coerceEventText(parsed.result)
          || this._coerceEventText(parsed.content)
          || this._coerceEventText(parsed.response)
          || this._coerceEventText(parsed.output);
        if (parsed?.is_error === true || String(parsed?.subtype || '').toLowerCase() === 'error') {
          const maybeError = this._coerceEventText(parsed.error) || candidate;
          if (maybeError) resultErrorText = maybeError;
        }
        if (candidate) {
          resultText = candidate;
        }
        continue;
      }

      if (parsed?.type === 'assistant' && Array.isArray(parsed?.message?.content)) {
        for (const block of parsed.message.content) {
          if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
            assistantTexts.push(block.text.trim());
          }
        }
        continue;
      }

      if (parsed?.type === 'content_block_start') {
        const block = parsed?.content_block || parsed?.contentBlock;
        if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
          deltaTextParts.push(block.text);
        }
        continue;
      }

      if (parsed?.type === 'content_block_delta') {
        const delta = parsed?.delta || parsed?.content_block_delta || parsed?.contentBlockDelta;
        const deltaText = this._coerceEventText(delta?.text)
          || this._coerceEventText(delta?.delta)
          || this._coerceEventText(parsed?.text);
        if (deltaText) {
          deltaTextParts.push(deltaText);
        }
        continue;
      }

      if (parsed?.type === 'error') {
        const maybeError = this._coerceEventText(parsed?.error) || this._coerceEventText(parsed?.message);
        if (maybeError) resultErrorText = maybeError;
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

    if (deltaTextParts.length > 0) {
      const mergedDelta = deltaTextParts.join('').trim();
      if (mergedDelta) return mergedDelta;
    }

    if (resultText) {
      return resultText.trim();
    }

    if (plainTextLines.length > 0) {
      return plainTextLines.join('\n').trim();
    }

    return resultErrorText || raw.trim();
  }

  _coerceEventText(value) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed || '';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      const merged = value
        .map((entry) => this._coerceEventText(entry))
        .filter(Boolean)
        .join('\n')
        .trim();
      return merged || '';
    }
    if (!value || typeof value !== 'object') {
      return '';
    }

    const looksLikeReviewPayload = (
      Object.prototype.hasOwnProperty.call(value, 'summary')
      || Object.prototype.hasOwnProperty.call(value, 'recommendations')
      || Object.prototype.hasOwnProperty.call(value, 'changeGroups')
      || Object.prototype.hasOwnProperty.call(value, 'riskLevel')
    );
    if (looksLikeReviewPayload) {
      try {
        return JSON.stringify(value);
      } catch {
        // Continue field-based extraction if serialization fails.
      }
    }

    const keys = ['message', 'error', 'result', 'response', 'content', 'text', 'detail', 'details', 'reason'];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = this._coerceEventText(value[key]);
      if (nested) return nested;
    }
    return '';
  }

  _extractLikelyReviewJsonFromText(input) {
    const text = String(input || '');
    if (!text.includes('{')) return null;

    let start = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let latestReviewJson = null;

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
          const candidate = text.slice(start, i + 1).trim();
          start = -1;
          if (!candidate) continue;
          const candidateLower = candidate.toLowerCase();
          if (
            !candidateLower.includes('"summary"')
            && !candidateLower.includes('"recommendations"')
            && !candidateLower.includes('"changegroups"')
            && !candidateLower.includes('"risklevel"')
          ) {
            continue;
          }
          try {
            const parsed = JSON.parse(candidate);
            const reviewJson = this._extractReviewJsonFromValue(parsed);
            if (reviewJson) latestReviewJson = reviewJson;
          } catch {
            // Ignore malformed candidate fragments and continue scanning.
          }
        }
      }
    }

    return latestReviewJson;
  }

  _extractReviewJsonFromValue(value, depth = 0) {
    if (depth > 8 || value == null) return null;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || !trimmed.includes('{')) return null;
      const lower = trimmed.toLowerCase();
      if (
        !lower.includes('"summary"')
        && !lower.includes('"recommendations"')
        && !lower.includes('"changegroups"')
        && !lower.includes('"risklevel"')
      ) {
        return null;
      }
      const extracted = this._extractLikelyReviewJsonFromText(value);
      return extracted || null;
    }

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) {
        const nested = this._extractReviewJsonFromValue(value[i], depth + 1);
        if (nested) return nested;
      }
      return null;
    }

    if (typeof value !== 'object') return null;

    const hasReviewFields = (
      Object.prototype.hasOwnProperty.call(value, 'summary')
      || Object.prototype.hasOwnProperty.call(value, 'recommendations')
      || Object.prototype.hasOwnProperty.call(value, 'changeGroups')
      || Object.prototype.hasOwnProperty.call(value, 'riskLevel')
    );
    if (hasReviewFields) {
      try {
        return JSON.stringify(value);
      } catch {
        // Fall through to nested extraction when stringify fails.
      }
    }

    const preferredKeys = ['result', 'response', 'output', 'content', 'message', 'text', 'delta', 'data', 'payload'];
    for (const key of preferredKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = this._extractReviewJsonFromValue(value[key], depth + 1);
      if (nested) return nested;
    }

    for (const nestedValue of Object.values(value)) {
      if (!nestedValue || typeof nestedValue !== 'object') continue;
      const nested = this._extractReviewJsonFromValue(nestedValue, depth + 1);
      if (nested) return nested;
    }

    return null;
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
   * Get available models for the Claude CLI.
   * Delegates to providerService.getAnthropicCLIModels().
   * @returns {Array<{alias: string, name: string, description: string}>}
   */
  getModels() {
    return providerService.getAnthropicCLIModels();
  }

  getDefaultModel() {
    const now = Date.now();
    if (
      this._defaultModelCache.value
      && now - this._defaultModelCache.loadedAt < DEFAULT_MODEL_CACHE_TTL_MS
    ) {
      return this._defaultModelCache.value;
    }

    let resolvedModel = 'sonnet';

    // Mirror Claude CLI user preference from ~/.claude/settings.json when present.
    // Falls back to Sonnet alias to keep behavior deterministic.
    try {
      const settingsPath = path.join(process.env.HOME || os.homedir(), '.claude', 'settings.json');
      const content = fsSync.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      const configuredModel = typeof settings.model === 'string' ? settings.model.trim() : '';
      if (!configuredModel) {
        resolvedModel = 'sonnet';
      } else {
        const lower = configuredModel.toLowerCase();
        if (lower.includes('opus')) {
          resolvedModel = 'opus';
        } else if (lower.includes('haiku')) {
          resolvedModel = 'haiku';
        } else if (lower.includes('sonnet')) {
          resolvedModel = 'sonnet';
        } else {
          const aliases = this.getModels().map((m) => m.alias);
          if (aliases.includes(configuredModel)) {
            resolvedModel = configuredModel;
          }
        }
      }
    } catch {
      // Ignore parse/read failures and use default alias.
    }

    this._defaultModelCache = {
      value: resolvedModel,
      loadedAt: now,
    };
    return this._defaultModelCache.value;
  }
}

// Singleton export
const claudeAdapter = new ClaudeAdapter();
export default claudeAdapter;
