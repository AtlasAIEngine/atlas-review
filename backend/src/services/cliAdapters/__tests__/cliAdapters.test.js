/**
 * CLI Adapter Tests
 * Tests for the adapter registry, ClaudeAdapter, CodexAdapter, GeminiAdapter, and OpenCodeAdapter.
 */

import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getAdapter, hasAdapter, getAvailableAdapters, getSupportedAdapters } from '../index.js';
import claudeAdapter from '../ClaudeAdapter.js';
import codexAdapter from '../CodexAdapter.js';
import geminiAdapter from '../GeminiAdapter.js';
import openCodeAdapter from '../OpenCodeAdapter.js';
import cliInstallService from '../../cliInstallService.js';

describe('CLI Adapter Registry', () => {
  it('has adapters registered for anthropic, openai, google, opencode', () => {
    expect(hasAdapter('anthropic')).toBe(true);
    expect(hasAdapter('openai')).toBe(true);
    expect(hasAdapter('google')).toBe(true);
    expect(hasAdapter('opencode')).toBe(true);
  });

  it('returns correct adapter instances', () => {
    expect(getAdapter('anthropic')).toBe(claudeAdapter);
    expect(getAdapter('openai')).toBe(codexAdapter);
    expect(getAdapter('google')).toBe(geminiAdapter);
    expect(getAdapter('opencode')).toBe(openCodeAdapter);
  });

  it('throws for unknown provider types', () => {
    expect(() => getAdapter('unknown')).toThrow('No CLI adapter registered');
  });

  it('hasAdapter returns false for unknown types', () => {
    expect(hasAdapter('unknown')).toBe(false);
    expect(hasAdapter('')).toBe(false);
  });

  it('getAvailableAdapters returns array', async () => {
    const adapters = await getAvailableAdapters();
    expect(Array.isArray(adapters)).toBe(true);
    // Each entry should include provider + model metadata for the unified model picker.
    for (const a of adapters) {
      expect(a).toHaveProperty('type');
      expect(a).toHaveProperty('name');
      expect(a).toHaveProperty('supported');
      expect(a).toHaveProperty('defaultModel');
      expect(a).toHaveProperty('models');
      expect(Array.isArray(a.models)).toBe(true);
    }
  });

  it('getSupportedAdapters returns only adapters with isSupported() === true', () => {
    const supported = getSupportedAdapters();
    expect(Array.isArray(supported)).toBe(true);
    // Claude, Codex, Gemini, and OpenCode are all supported
    expect(supported).toContain(claudeAdapter);
    expect(supported).toContain(codexAdapter);
    expect(supported).toContain(geminiAdapter);
    expect(supported).toContain(openCodeAdapter);
    for (const a of supported) {
      expect(a.isSupported()).toBe(true);
    }
  });
});

describe('ClaudeAdapter', () => {
  afterEach(() => {
    claudeAdapter._cachedBinaryPath = null;
    claudeAdapter._supportsSettingSources = null;
    claudeAdapter._supportsTools = null;
    claudeAdapter._supportsSessionId = null;
    claudeAdapter._supportsResume = null;
    claudeAdapter._capabilityBinaryPath = null;
    vi.restoreAllMocks();
  });

  it('getName returns Claude Code', () => {
    expect(claudeAdapter.getName()).toBe('Claude Code');
  });

  it('getType returns anthropic', () => {
    expect(claudeAdapter.getType()).toBe('anthropic');
  });

  it('isSupported returns true', () => {
    expect(claudeAdapter.isSupported()).toBe(true);
  });

  it('getDefaultModel returns a Claude model', () => {
    const model = claudeAdapter.getDefaultModel();
    const aliases = claudeAdapter.getModels().map((m) => m.alias);
    expect(aliases).toContain(model);
  });

  it('getModels returns non-empty array with alias/name/description', () => {
    const models = claudeAdapter.getModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m).toHaveProperty('alias');
      expect(m).toHaveProperty('name');
      expect(m).toHaveProperty('description');
    }
  });

  it('aliases only catalog models that explicitly declare a Claude CLI alias', () => {
    const currentSonnet = claudeAdapter.buildArgs({
      message: 'review branch',
      sessionId: 'session-current-sonnet',
      model: 'claude-sonnet-4-6',
    });
    const pinnedSonnet = claudeAdapter.buildArgs({
      message: 'review branch',
      sessionId: 'session-pinned-sonnet',
      model: 'claude-sonnet-4-5-20250929',
    });
    const experimentalSonnet = claudeAdapter.buildArgs({
      message: 'review branch',
      sessionId: 'session-experimental-sonnet',
      model: 'claude-sonnet-experimental-foo',
    });

    expect(currentSonnet.args).toContain('claude-sonnet-4-6');
    expect(pinnedSonnet.args).toContain('claude-sonnet-4-5-20250929');
    expect(experimentalSonnet.args).toContain('claude-sonnet-experimental-foo');
  });

  it('probes settings-source support when CLAUDE_CLI_PATH overrides binary discovery', async () => {
    const originalClaudeCliPath = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = '/tmp/atlas-test-claude';
    const probeSpy = vi
      .spyOn(claudeAdapter, '_probeCliCapabilities')
      .mockImplementation(function mockProbeCliCapabilities() {
        this._supportsSettingSources = true;
        this._supportsTools = true;
      });

    try {
      const result = await claudeAdapter.findBinary();
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'review branch',
        sessionId: 'session-settings-env',
      });
      const settingSourcesIndex = args.indexOf('--setting-sources');

      expect(result).toBe('/tmp/atlas-test-claude');
      expect(probeSpy).toHaveBeenCalledWith('/tmp/atlas-test-claude');
      expect(settingSourcesIndex).toBeGreaterThan(-1);
      expect(args[settingSourcesIndex + 1]).toBe('project,local');
    } finally {
      if (originalClaudeCliPath === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalClaudeCliPath;
      }
    }
  });

  const itWindows = process.platform === 'win32' ? it : it.skip;

  itWindows('findBinary detects WinGet Claude shims before PATH lookup', async () => {
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join('C:', 'Users', 'tester', 'AppData', 'Local');
    const winGetCandidate = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'claude.exe');
    const accessSpy = vi.spyOn(fsSync, 'accessSync').mockImplementation((candidate) => {
      if (String(candidate) === winGetCandidate) {
        return undefined;
      }
      throw new Error('ENOENT');
    });

    try {
      const result = await claudeAdapter.findBinary();
      expect(result).toBe(winGetCandidate);
      expect(accessSpy).toHaveBeenCalled();
    } finally {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    }
  });

  describe('buildArgs', () => {
    it('produces correct args with model', () => {
      const { args, stdinMessage, message } = claudeAdapter.buildArgs({
        message: 'Hello world',
        sessionId: 'test-uuid',
        model: 'opus',
      });
      expect(stdinMessage).toBe(true);
      expect(message).toBe('Hello world');
      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--verbose');
      expect(args).toContain('--session-id');
      expect(args).toContain('test-uuid');
      expect(args).toContain('--model');
      expect(args).toContain('opus');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--');
      expect(args).not.toContain('Hello world');
    });

    it('omits --model when model is not provided', () => {
      const { args } = claudeAdapter.buildArgs({
        message: 'test',
        sessionId: 'id',
      });
      expect(args).not.toContain('--model');
    });

    it('normalizes current Claude model IDs to CLI aliases', () => {
      const { args } = claudeAdapter.buildArgs({
        message: 'test',
        sessionId: 'id',
        model: 'claude-sonnet-5-5',
      });
      const modelFlagIndex = args.indexOf('--model');
      expect(modelFlagIndex).toBeGreaterThan(-1);
      expect(args[modelFlagIndex + 1]).toBe('sonnet');
    });
  });

  describe('agentic capabilities', () => {
    it('declares cli-agentic modes when runtime is available', () => {
      const modes = claudeAdapter.getExecutionModes({ hasCliRuntime: true });
      expect(modes).toEqual(['cli-agentic', 'cli-agent', 'cli-pipe']);
    });

    it('builds agentic args with restricted tools (no --max-turns)', () => {
      claudeAdapter._supportsTools = true;
      const { args, stdinMessage, message } = claudeAdapter.buildAgenticArgs({
        message: 'review branch',
        sessionId: 'session-1',
        model: 'claude-sonnet-4-5',
        maxTurns: 12,
      });
      expect(stdinMessage).toBe(true);
      expect(message).toBe('review branch');
      // We intentionally do NOT pass --max-turns to the agentic CLI. The
      // flag caused production reviews to hang ("no output for 191s") at
      // the max-turns boundary; budget enforcement is handled by the
      // 3-minute liveness watcher in callCliAgentic instead.
      expect(args).not.toContain('--max-turns');
      expect(args).toContain('--tools');
      expect(args).toContain('Read,Grep,Glob,Bash');
    });

    it('omits --tools when the installed Claude CLI does not support it', () => {
      claudeAdapter._supportsTools = false;
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'review branch',
        sessionId: 'session-no-tools',
        model: 'claude-sonnet-4-6',
      });
      expect(args).not.toContain('--tools');
    });

    it('omits Claude agentic session flags when the installed CLI does not support them', () => {
      claudeAdapter._supportsTools = true;
      claudeAdapter._supportsSessionId = false;
      claudeAdapter._supportsResume = false;

      const first = claudeAdapter.buildAgenticArgs({
        message: 'review branch',
        sessionId: 'session-1',
      });
      expect(first.args).not.toContain('--session-id');
      expect(first.args).not.toContain('session-1');

      const resumed = claudeAdapter.buildAgenticArgs({
        message: 'review branch',
        sessionId: 'session-1',
        resumeSession: true,
      });
      expect(resumed.args).not.toContain('--resume');
      expect(resumed.args).not.toContain('session-1');
    });

    it('omits Claude agentic settings sources until the installed CLI support is known', () => {
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'review branch',
        sessionId: 'session-settings',
        model: 'claude-sonnet-4-6',
      });
      expect(args).not.toContain('--setting-sources');
    });

    it('limits Claude agentic settings sources to project and local when the CLI supports it', () => {
      claudeAdapter._supportsSettingSources = true;
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'review branch',
        sessionId: 'session-settings',
        model: 'claude-sonnet-4-6',
      });
      const settingSourcesIndex = args.indexOf('--setting-sources');
      expect(settingSourcesIndex).toBeGreaterThan(-1);
      expect(args[settingSourcesIndex + 1]).toBe('project,local');
    });

    it('resumes an existing Claude agentic session when requested', () => {
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'follow-up',
        sessionId: 'session-existing',
        resumeSession: true,
      });
      const resumeIndex = args.indexOf('--resume');
      expect(resumeIndex).toBeGreaterThan(-1);
      expect(args[resumeIndex + 1]).toBe('session-existing');
      expect(args).not.toContain('--session-id');
    });

    it('normalizes agentic catalog model IDs with explicit Claude CLI aliases', () => {
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'review branch',
        sessionId: 'session-2',
        model: 'claude-opus-5-5',
        maxTurns: 8,
      });
      const modelFlagIndex = args.indexOf('--model');
      expect(modelFlagIndex).toBeGreaterThan(-1);
      expect(args[modelFlagIndex + 1]).toBe('opus');
    });

    it('opts into Darwin sandbox profile', () => {
      expect(claudeAdapter.shouldUseDarwinSandboxProfile()).toBe(true);
    });

    it('uses --dangerously-skip-permissions by default (skip strategy)', () => {
      claudeAdapter._supportsTools = true;
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'review',
        sessionId: 'session-perm-skip',
        model: 'sonnet',
        maxTurns: 5,
      });
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--tools');
      expect(args).not.toContain('--allowedTools');
      expect(args).not.toContain('--add-dir');
    });

    it('uses --allowedTools with allowedTools strategy', () => {
      claudeAdapter._supportsTools = true;
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'review',
        sessionId: 'session-perm-at',
        model: 'sonnet',
        maxTurns: 5,
        permissionStrategy: 'allowedTools',
      });
      expect(args).toContain('--allowedTools');
      expect(args).toContain('Read,Grep,Glob,Bash(git:*)');
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--tools');
    });

    it('uses --add-dir with addDir strategy', () => {
      claudeAdapter._supportsTools = true;
      const { args } = claudeAdapter.buildAgenticArgs({
        message: 'review',
        sessionId: 'session-perm-ad',
        model: 'sonnet',
        maxTurns: 5,
        projectPath: '/tmp/my-project',
        permissionStrategy: 'addDir',
      });
      expect(args).toContain('--add-dir');
      expect(args).toContain('/tmp/my-project');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('supports CLI max-turns flag', () => {
      expect(claudeAdapter.supportsCliMaxTurns()).toBe(true);
    });

    describe('runtimeMcp wiring (Section R Phase B)', () => {
      const runtimeMcp = {
        binPath: '/abs/path/to/runtimeMcp/bin.js',
        projectRoot: '/abs/project',
        mergeBaseSha: 'abcd1234',
        headSha: 'beef5678',
      };

      it('omits --mcp-config and MCP tool names when runtimeMcp is not supplied', () => {
        claudeAdapter._supportsTools = true;
        const { args } = claudeAdapter.buildAgenticArgs({
          message: 'review',
          sessionId: 'session-no-mcp',
          model: 'sonnet',
        });
        expect(args).not.toContain('--mcp-config');
        const toolsArg = args[args.indexOf('--tools') + 1];
        expect(toolsArg).toBe('Read,Grep,Glob,Bash');
      });

      it('omits --mcp-config when runtimeMcp.enabled === false', () => {
        claudeAdapter._supportsTools = true;
        const { args } = claudeAdapter.buildAgenticArgs({
          message: 'review',
          sessionId: 'session-mcp-disabled',
          model: 'sonnet',
          runtimeMcp: { ...runtimeMcp, enabled: false },
        });
        expect(args).not.toContain('--mcp-config');
      });

      it('emits --mcp-config inline JSON and adds MCP tools when enabled', () => {
        claudeAdapter._supportsTools = true;
        const { args } = claudeAdapter.buildAgenticArgs({
          message: 'review',
          sessionId: 'session-mcp-on',
          model: 'sonnet',
          runtimeMcp,
        });
        expect(args).toContain('--mcp-config');
        const idx = args.indexOf('--mcp-config');
        expect(idx).toBeGreaterThan(-1);
        const inline = args[idx + 1];
        const parsed = JSON.parse(inline);
        expect(parsed.mcpServers['atlas-review-rt']).toEqual({
          command: 'node',
          args: ['/abs/path/to/runtimeMcp/bin.js'],
          env: {
            ATLAS_REVIEW_RT_PROJECT_PATH: '/abs/project',
            ATLAS_REVIEW_RT_BASE_SHA: 'abcd1234',
            ATLAS_REVIEW_RT_HEAD_SHA: 'beef5678',
          },
        });
        const toolsArg = args[args.indexOf('--tools') + 1];
        expect(toolsArg).toContain('mcp__atlas-review-rt__get_diff_for_file');
        expect(toolsArg).toContain('mcp__atlas-review-rt__read_file_slice');
        expect(toolsArg).toContain('mcp__atlas-review-rt__get_hunk_context');
      });

      it('keeps --strict-mcp-config alongside --mcp-config (compose: ignore user config + register ours)', () => {
        claudeAdapter._supportsTools = true;
        const { args } = claudeAdapter.buildAgenticArgs({
          message: 'review',
          sessionId: 'session-mcp-strict',
          model: 'sonnet',
          runtimeMcp,
        });
        expect(args).toContain('--strict-mcp-config');
        expect(args).toContain('--mcp-config');
      });

      it('extends --allowedTools list with MCP tool names under allowedTools strategy', () => {
        claudeAdapter._supportsTools = true;
        const { args } = claudeAdapter.buildAgenticArgs({
          message: 'review',
          sessionId: 'session-mcp-allowed',
          model: 'sonnet',
          permissionStrategy: 'allowedTools',
          runtimeMcp,
        });
        const idx = args.indexOf('--allowedTools');
        expect(idx).toBeGreaterThan(-1);
        const list = args[idx + 1];
        expect(list).toContain('Read');
        expect(list).toContain('Bash(git:*)');
        expect(list).toContain('mcp__atlas-review-rt__get_diff_for_file');
      });

      it('omits --mcp-config when any required field of runtimeMcp is missing', () => {
        claudeAdapter._supportsTools = true;
        const partial = { ...runtimeMcp, mergeBaseSha: null };
        const { args } = claudeAdapter.buildAgenticArgs({
          message: 'review',
          sessionId: 'session-mcp-partial',
          model: 'sonnet',
          runtimeMcp: partial,
        });
        expect(args).not.toContain('--mcp-config');
      });
    });
  });

  describe('parseStreamLine', () => {
    it('returns null for empty lines', () => {
      expect(claudeAdapter.parseStreamLine('')).toBeNull();
      expect(claudeAdapter.parseStreamLine('   ')).toBeNull();
    });

    it('returns null for non-JSON lines', () => {
      expect(claudeAdapter.parseStreamLine('some debug output')).toBeNull();
    });

    it('parses system event', () => {
      const line = JSON.stringify({ type: 'system', model: 'claude-opus-4-6' });
      const result = claudeAdapter.parseStreamLine(line);
      expect(result.type).toBe('system');
      expect(result.model).toBe('claude-opus-4-6');
    });

    it('parses assistant event with text content', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Hello!' }],
          usage: { output_tokens: 5 },
        },
      });
      const result = claudeAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.model).toBe('claude-sonnet-4-5');
      expect(result.tokensUsed).toBe(5);
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('text');
      expect(result.contentBlocks[0].text).toBe('Hello!');
    });

    it('parses assistant event with tool_use content', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Write',
            input: { file_path: '/tmp/test.js', content: 'hi' },
          }],
        },
      });
      const result = claudeAdapter.parseStreamLine(line);
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('tool_use');
      expect(result.contentBlocks[0].toolId).toBe('tool-1');
      expect(result.contentBlocks[0].toolName).toBe('Write');
    });

    it('parses result event with token usage', () => {
      const line = JSON.stringify({
        type: 'result',
        usage: { output_tokens: 100 },
      });
      const result = claudeAdapter.parseStreamLine(line);
      expect(result.type).toBe('result');
      expect(result.tokensUsed).toBe(100);
    });
  });

  describe('extractReviewText', () => {
    it('extracts final json text from mixed plain-text and stream-json payloads', () => {
      const mixedOutput = [
        'initial log line',
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Working through review...' }],
          },
        }),
        JSON.stringify({
          type: 'result',
          result: '{"summary":"ok","riskLevel":"low","changeGroups":[],"recommendations":[],"stats":{"filesAnalyzed":0,"totalAdditions":0,"totalDeletions":0,"estimatedComplexity":"simple"}}',
        }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(mixedOutput);
      expect(extracted).toContain('"summary":"ok"');
      expect(extracted).toContain('"riskLevel":"low"');
    });

    it('extracts review JSON from multi-turn agentic JSONL stream', () => {
      // Simulates a multi-turn agentic session where the review JSON is in the
      // last assistant text block, preceded by earlier planning/reasoning texts.
      const stream = [
        JSON.stringify({ type: 'system', model: 'claude-sonnet-4-6' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me review the code changes...' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git diff abc...def' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I can see changes in several files. Let me read them.' },
              { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/index.js' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '{"summary":"Review complete","riskLevel":"medium","changeGroups":[{"label":"Core","description":"Changes","risk":"low","files":[{"path":"src/index.js","additions":10,"deletions":2,"description":"Updated"}]}],"recommendations":[{"title":"Check null","type":"issue","severity":"low","file":"src/index.js","line":5,"description":"Missing null check"}],"stats":{"filesAnalyzed":1,"totalAdditions":10,"totalDeletions":2,"estimatedComplexity":"simple"}}' },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          cost_usd: 0.05,
          duration_ms: 30000,
          session_id: 'test-session',
        }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('Review complete');
      expect(parsed.changeGroups).toHaveLength(1);
      expect(parsed.recommendations).toHaveLength(1);
    });

    it('prefers result.result over assistant texts when available', () => {
      const reviewJson = '{"summary":"From result","riskLevel":"low","changeGroups":[],"recommendations":[]}';
      const stream = [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Thinking about the code...' }] },
        }),
        JSON.stringify({ type: 'result', result: reviewJson }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      expect(extracted).toBe(reviewJson);
    });

    it('finds review JSON in last assistant text when earlier texts are non-JSON', () => {
      const stream = [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Planning my approach...' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Reading files now...' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '{"summary":"Found issues","riskLevel":"high","changeGroups":[],"recommendations":[]}' }] },
        }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('Found issues');
      expect(parsed.riskLevel).toBe('high');
    });

    it('handles case where no result event has text and review JSON is in middle assistant message', () => {
      // Review JSON is in the second assistant message, followed by a closing remark
      const reviewJson = '{"summary":"Mid review","riskLevel":"medium","changeGroups":[],"recommendations":[]}';
      const stream = [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Starting review...' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: reviewJson }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Review complete.' }] },
        }),
        JSON.stringify({ type: 'result', subtype: 'success', cost_usd: 0.01 }),
      ].join('\n');

      // Should find the JSON by searching backward through assistant texts
      const extracted = claudeAdapter.extractReviewText(stream);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('Mid review');
    });

    it('returns empty string when JSONL stream has only system init event and no review content', () => {
      // Bug scenario: CLI outputs the system init event then exits with code 0
      // without producing any assistant or result content. The fallback should
      // NOT return the init JSON as "review text".
      const stream = [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/some/path',
          session_id: 'abc-123',
          tools: ['Bash', 'Glob', 'Grep', 'Read'],
          model: 'claude-sonnet-4-6',
        }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      expect(extracted).toBe('');
    });

    it('returns empty string when JSONL stream has system + empty result events', () => {
      const stream = [
        JSON.stringify({ type: 'system', subtype: 'init', cwd: '/path', tools: [] }),
        JSON.stringify({ type: 'result', subtype: 'success', cost_usd: 0 }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      expect(extracted).toBe('');
    });

    it('extracts review JSON from content_block_delta-only streams', () => {
      const stream = [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '{"summary":"Delta stream",' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '"riskLevel":"low","changeGroups":[],' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '"recommendations":[],"stats":{"filesAnalyzed":1,"totalAdditions":0,"totalDeletions":0,"estimatedComplexity":"simple"}}' },
        }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('Delta stream');
      expect(parsed.riskLevel).toBe('low');
      expect(Array.isArray(parsed.recommendations)).toBe(true);
    });

    it('recovers review JSON from plain-text lines when JSONL events are also present', () => {
      const stream = [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
        'INFO final payload => {"summary":"Recovered review","riskLevel":"low","changeGroups":[],"recommendations":[]}',
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('Recovered review');
      expect(parsed.riskLevel).toBe('low');
    });

    it('extracts review JSON from wrapped stream-json lines with prefixes', () => {
      const reviewJson = '{"summary":"Wrapped line","riskLevel":"medium","changeGroups":[],"recommendations":[]}';
      const wrappedAssistantLine = `data: ${JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: reviewJson }],
        },
      })}`;

      const stream = [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
        wrappedAssistantLine,
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('Wrapped line');
      expect(parsed.riskLevel).toBe('medium');
    });

    it('surfaces result error payload text when no review content is emitted', () => {
      const stream = [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
        JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          error: { message: 'Provider request was rejected.' },
        }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      expect(extracted).toContain('Provider request was rejected');
    });

    it('returns JSON from assistant texts when result.result is conversational prose', () => {
      // Bug scenario: in multi-turn agentic sessions, the result event contains
      // the last assistant message which may be conversational (e.g. "Good, the
      // changes look solid"). The actual review JSON is in an earlier assistant text.
      const reviewJson = '{"summary":"Agentic review","riskLevel":"low","changeGroups":[],"recommendations":[]}';
      const stream = [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Let me examine the files...' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: reviewJson }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Good, the changes look solid and well-structured.' }] },
        }),
        JSON.stringify({
          type: 'result',
          result: 'Good, the changes look solid and well-structured.',
        }),
      ].join('\n');

      const extracted = claudeAdapter.extractReviewText(stream);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('Agentic review');
    });
  });
});

describe('CodexAdapter', () => {
  afterEach(() => {
    codexAdapter._cachedBinaryPath = null;
    codexAdapter._defaultModelCache = { value: null, loadedAt: 0 };
    vi.restoreAllMocks();
  });

  it('getName returns Codex CLI', () => {
    expect(codexAdapter.getName()).toBe('Codex CLI');
  });

  it('getType returns openai', () => {
    expect(codexAdapter.getType()).toBe('openai');
  });

  it('isSupported returns true', () => {
    expect(codexAdapter.isSupported()).toBe(true);
  });

  it('getDefaultModel returns a Codex model', () => {
    const model = codexAdapter.getDefaultModel();
    expect(typeof model).toBe('string');
    expect(model.length).toBeGreaterThan(0);
  });

  it('getDefaultModel defaults Codex to GPT-5.5 when no local config overrides it', () => {
    const tempHome = fsSync.mkdtempSync(path.join(process.cwd(), '.tmp-codex-home-'));
    const originalHome = process.env.HOME;
    const originalCodexModel = process.env.CODEX_MODEL;
    const originalOpenAIModel = process.env.OPENAI_MODEL;
    process.env.HOME = tempHome;
    delete process.env.CODEX_MODEL;
    delete process.env.OPENAI_MODEL;
    codexAdapter._defaultModelCache = { value: null, loadedAt: 0 };
    try {
      expect(codexAdapter.getDefaultModel()).toBe('gpt-5.5');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalCodexModel === undefined) delete process.env.CODEX_MODEL;
      else process.env.CODEX_MODEL = originalCodexModel;
      if (originalOpenAIModel === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = originalOpenAIModel;
      fsSync.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('getDefaultModel reads ~/.codex/config.toml when JSON config is absent', () => {
    const tempHome = fsSync.mkdtempSync(path.join(process.cwd(), '.tmp-codex-home-'));
    const codexDir = path.join(tempHome, '.codex');
    fsSync.mkdirSync(codexDir, { recursive: true });
    fsSync.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "gpt-5.4"\n[features]\nmulti_agent = true\n');

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    codexAdapter._defaultModelCache = { value: null, loadedAt: 0 };
    try {
      expect(codexAdapter.getDefaultModel()).toBe('gpt-5.4');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fsSync.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('getModels returns non-empty array', () => {
    const models = codexAdapter.getModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m).toHaveProperty('alias');
      expect(m).toHaveProperty('name');
    }
  });

  it('findBinary ignores legacy Atlas-managed install paths', async () => {
    const originalHome = process.env.HOME;
    const tempHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'atlas-codex-home-'));
    const atlasCandidate = cliInstallService.getAdapterSearchPaths('codex')[0];
    const userCandidate = path.join(tempHome, '.local', 'bin', 'codex');
    process.env.HOME = tempHome;
    codexAdapter._cachedBinaryPath = null;
    const accessSpy = vi.spyOn(fsSync, 'accessSync').mockImplementation((candidate) => {
      if (String(candidate) === atlasCandidate || String(candidate) === userCandidate) {
        return undefined;
      }
      throw new Error('ENOENT');
    });

    try {
      const result = await codexAdapter.findBinary();

      expect(result).toBe(userCandidate);
      expect(accessSpy.mock.calls.some(([candidate]) => String(candidate) === atlasCandidate)).toBe(false);
    } finally {
      accessSpy.mockRestore();
      codexAdapter._cachedBinaryPath = null;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fsSync.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  describe('buildArgs', () => {
    const originalEffort = process.env.ATLAS_CODEX_REASONING_EFFORT;
    const originalUsername = process.env.USERNAME;
    const originalUserProfile = process.env.USERPROFILE;
    afterEach(() => {
      if (originalEffort === undefined) {
        delete process.env.ATLAS_CODEX_REASONING_EFFORT;
      } else {
        process.env.ATLAS_CODEX_REASONING_EFFORT = originalEffort;
      }
      if (originalUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalUsername;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    });

    it('produces codex exec args with stdinMessage true', () => {
      const result = codexAdapter.buildArgs({
        message: 'Build a todo app',
        sessionId: 'ignored',
        model: 'o3',
      });
      expect(result.stdinMessage).toBe(true);
      expect(result.structuredOutput).toBe(true);
      expect(result.message).toBe('Build a todo app');
      expect(result.args).toContain('exec');
      expect(result.args).toContain('--skip-git-repo-check');
      expect(result.args).not.toContain('--color');
      expect(result.args).toContain('-c');
      expect(result.args).toContain('model_reasoning_effort="medium"');
      expect(result.args).toContain('--json');
      expect(result.args).toContain('--model');
      expect(result.args).toContain('o3');
      expect(result.args).not.toContain('--notify');
      expect(result.args).not.toContain('-q');
    });

    it('omits --model when not provided', () => {
      const result = codexAdapter.buildArgs({
        message: 'test',
        sessionId: 'id',
      });
      expect(result.args).not.toContain('--model');
    });

    it('normalizes unsupported reasoning effort aliases to supported values', () => {
      process.env.ATLAS_CODEX_REASONING_EFFORT = 'xhigh';
      const result = codexAdapter.buildArgs({
        message: 'test',
        sessionId: 'id',
      });
      expect(result.args).toContain('model_reasoning_effort="high"');
    });

    it('bypasses the internal Codex sandbox inside Windows Sandbox', () => {
      vi.spyOn(cliInstallService, 'isWindowsSandboxEnvironment').mockReturnValue(true);
      const result = codexAdapter.buildArgs({
        message: 'test',
        sessionId: 'id',
      });
      expect(result.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('roots builder-mode Codex sessions in a workspace-write sandbox', () => {
      const result = codexAdapter.buildArgs({
        message: 'rename the app',
        sessionId: 'id',
        projectPath: '/tmp/project-root',
      });
      expect(result.args).toContain('--full-auto');
      expect(result.args).toContain('--sandbox');
      expect(result.args).toContain('workspace-write');
      expect(result.args).toContain('--cd');
      expect(result.args).toContain('/tmp/project-root');
    });

    it('uses only resume-supported flags when continuing a Codex session', () => {
      const result = codexAdapter.buildArgs({
        message: 'run review',
        sessionId: 'session-123',
        projectPath: '/tmp/project-root',
        resumeSession: true,
      });
      expect(result.args.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(result.args).toContain('--skip-git-repo-check');
      expect(result.args).toContain('--json');
      expect(result.args).toContain('--full-auto');
      expect(result.args).not.toContain('--sandbox');
      expect(result.args).not.toContain('--cd');
      expect(result.args.at(-1)).toBe('session-123');
    });
  });

  describe('agentic capabilities', () => {
    it('declares cli-agentic modes when runtime is available', () => {
      const modes = codexAdapter.getExecutionModes({ hasCliRuntime: true });
      expect(modes).toEqual(['cli-agentic', 'cli-agent', 'cli-pipe']);
    });

    it('builds agentic args with workspace sandbox and project root', () => {
      const { args, stdinMessage } = codexAdapter.buildAgenticArgs({
        message: 'review',
        sessionId: 'session-codex',
        model: 'gpt-5.3-codex',
        projectPath: '/tmp/project-root',
      });
      expect(stdinMessage).toBe(true);
      expect(args).toContain('--full-auto');
      expect(args).toContain('--sandbox');
      expect(args).toContain('workspace-write');
      expect(args).toContain('--cd');
      expect(args).toContain('/tmp/project-root');
    });

    it('bypasses internal sandbox when Atlas external sandbox is active', () => {
      const { args } = codexAdapter.buildAgenticArgs({
        message: 'review',
        sessionId: 'session-codex',
        model: 'gpt-5.3-codex',
        projectPath: '/tmp/project-root',
        externalSandbox: true,
      });
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('workspace-write');
      expect(args).not.toContain('--full-auto');
      expect(args).toContain('--cd');
      expect(args).toContain('/tmp/project-root');
    });

    it('opts into Darwin sandbox profile', () => {
      expect(codexAdapter.shouldUseDarwinSandboxProfile()).toBe(true);
    });

    it('passes systemPrompt through to stdin message', () => {
      const { message } = codexAdapter.buildAgenticArgs({
        message: 'review this PR',
        sessionId: 'session-sys',
        model: 'gpt-5.3-codex',
        systemPrompt: 'Respond with JSON only.',
        projectPath: '/tmp/project-root',
      });
      expect(message).toContain('Respond with JSON only.');
      expect(message).toContain('review this PR');
    });

    it('returns message from buildAgenticArgs for callCliAgentic stdin', () => {
      const result = codexAdapter.buildAgenticArgs({
        message: 'review code',
        sessionId: 'session-msg',
        systemPrompt: 'JSON only',
      });
      expect(result).toHaveProperty('message');
      expect(result.message).toContain('JSON only');
      expect(result.message).toContain('review code');
    });

    it('uses low reasoning effort for agentic mode by default', () => {
      const { args } = codexAdapter.buildAgenticArgs({
        message: 'review',
        sessionId: 'session-effort',
        model: 'gpt-5.3-codex',
      });
      const effortArg = args.find((a) => typeof a === 'string' && a.startsWith('model_reasoning_effort='));
      expect(effortArg).toBe('model_reasoning_effort="low"');
    });

    it('does not support CLI max-turns flag', () => {
      expect(codexAdapter.supportsCliMaxTurns()).toBe(false);
    });
  });

  describe('parseStreamLine', () => {
    it('parses codex JSON agent_message events', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: 'Hello from Codex',
        },
      });
      const result = codexAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('text');
      expect(result.contentBlocks[0].text).toBe('Hello from Codex');
    });

    it('parses codex JSON command_execution as tool_use events', () => {
      const line = JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: '/bin/zsh -lc "ls -la"',
          status: 'in_progress',
          exit_code: null,
        },
      });
      const result = codexAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('tool_use');
      expect(result.contentBlocks[0].toolName).toBe('Bash');
      expect(result.contentBlocks[0].toolInput.command).toContain('ls -la');
      expect(result.contentBlocks[0].toolInput.status).toBe('in_progress');
      expect(result.contentBlocks[0].toolInput.phase).toBe('started');
    });

    it('parses codex JSON turn.completed token usage', () => {
      const line = JSON.stringify({
        type: 'turn.completed',
        usage: { output_tokens: 42 },
      });
      const result = codexAdapter.parseStreamLine(line);
      expect(result.type).toBe('result');
      expect(result.tokensUsed).toBe(42);
    });

    it('returns assistant event with text for plain text lines', () => {
      const result = codexAdapter.parseStreamLine('Hello world');
      expect(result.type).toBe('assistant');
      expect(typeof result.model).toBe('string');
      expect(result.model.length).toBeGreaterThan(0);
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].text).toBe('Hello world\n');
    });

    it('maps codex status/warning lines to system events', () => {
      const result = codexAdapter.parseStreamLine('Reading prompt from stdin...');
      expect(result.type).toBe('system');
      expect(result.raw.type).toBe('status');
    });

    it('parses codex item.delta agent message updates', () => {
      const line = JSON.stringify({
        type: 'item.delta',
        item: {
          id: 'item_3',
          type: 'agent_message',
        },
        delta: { text: 'partial text' },
      });
      const result = codexAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('text');
      expect(result.contentBlocks[0].text).toBe('partial text');
    });

    it('parses reasoning updates as tool_use events', () => {
      const line = JSON.stringify({
        type: 'item.updated',
        item: {
          id: 'item_4',
          type: 'reasoning',
          status: 'in_progress',
          summary: [{ text: 'Investigating files' }],
        },
      });
      const result = codexAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('tool_use');
      expect(result.contentBlocks[0].toolName).toBe('Reasoning');
      expect(result.contentBlocks[0].toolInput.summary).toContain('Investigating files');
      expect(result.contentBlocks[0].toolInput.phase).toBe('updated');
    });

    it('parses codex error events', () => {
      const line = JSON.stringify({
        type: 'error',
        message: 'stream disconnected',
      });
      const result = codexAdapter.parseStreamLine(line);
      expect(result.type).toBe('error');
      expect(result.message).toContain('stream disconnected');
    });

    it('preserves blank lines', () => {
      const result = codexAdapter.parseStreamLine('');
      expect(result).not.toBeNull();
      expect(result.contentBlocks[0].text).toBe('\n');
    });

    it('returns null for null/undefined input', () => {
      expect(codexAdapter.parseStreamLine(null)).toBeNull();
      expect(codexAdapter.parseStreamLine(undefined)).toBeNull();
    });
  });

  describe('extractReviewText', () => {
    it('prefers output file content and extracts embedded JSON object', () => {
      const outputFileText = [
        'Review complete.',
        '{"summary":"from output","riskLevel":"low","changeGroups":[],"recommendations":[],"stats":{"filesAnalyzed":1,"totalAdditions":2,"totalDeletions":0,"estimatedComplexity":"simple"}}',
      ].join('\n');
      const extracted = codexAdapter.extractReviewText('{"type":"thread.started"}', outputFileText);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('from output');
      expect(parsed.riskLevel).toBe('low');
    });

    it('extracts review JSON from agent_message events in JSONL stdout fallback', () => {
      const stream = [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Planning review...',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: '{"summary":"from stream","riskLevel":"medium","changeGroups":[],"recommendations":[],"stats":{"filesAnalyzed":3,"totalAdditions":4,"totalDeletions":1,"estimatedComplexity":"simple"}}',
          },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 11 } }),
      ].join('\n');

      const extracted = codexAdapter.extractReviewText(stream, '');
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('from stream');
      expect(parsed.riskLevel).toBe('medium');
    });

    it('does not return JSONL metadata object when review JSON exists later in stream', () => {
      const stream = [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: '{"summary":"later","riskLevel":"high","changeGroups":[],"recommendations":[],"stats":{"filesAnalyzed":2,"totalAdditions":5,"totalDeletions":3,"estimatedComplexity":"moderate"}}',
          },
        }),
      ].join('\n');

      const extracted = codexAdapter.extractReviewText(stream, '');
      expect(extracted).toContain('"summary":"later"');
      expect(extracted).not.toContain('"type":"thread.started"');
    });

    it('surfaces reconnect stream errors instead of returning protocol JSONL', () => {
      const stream = [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: An error occurred)' }),
      ].join('\n');

      const extracted = codexAdapter.extractReviewText(stream, '');
      expect(extracted).toContain('Reconnecting... 2/5');
      expect(extracted).not.toContain('"type":"thread.started"');
    });
  });

  describe('extractDiscoveryText', () => {
    it('prefers plain output-file discovery text', () => {
      const outputFileText = [
        'Summary:',
        'Found meaningful regressions in the minimap update flow.',
        '',
        'Overall risk: high',
        '',
        'Issues:',
        '- [high] Divide by zero in edge clamp',
      ].join('\n');

      const extracted = codexAdapter.extractDiscoveryText(outputFileText);
      expect(extracted).toContain('Summary:');
      expect(extracted).toContain('Overall risk: high');
      expect(extracted).toContain('Divide by zero in edge clamp');
    });

    it('extracts discovery text from agent_message events in JSONL stdout fallback', () => {
      const stream = [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Summary:\nThe minimap update introduces a divide-by-zero path.\n\nOverall risk: high\n\nIssues:\n- [high] Divide by zero in edge clamp\n  file: Assets/BLACK/MiniMap/Scripts/View/MapViewBase.cs\n  line: 120\n  why: distance can be zero at the center\n  snippet: var xCoeff = radius / Mathf.Abs(point.x);\n  fix: guard the zero case before dividing',
          },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 11 } }),
      ].join('\n');

      const extracted = codexAdapter.extractDiscoveryText(stream);
      expect(extracted).toContain('Summary:');
      expect(extracted).toContain('Overall risk: high');
      expect(extracted).toContain('Divide by zero in edge clamp');
      expect(extracted).not.toContain('"type":"thread.started"');
    });
  });

  describe('createOutputCapture', () => {
    it('creates unique temp directories per invocation for collision-safe output files', async () => {
      const first = await codexAdapter.createOutputCapture();
      const second = await codexAdapter.createOutputCapture();

      try {
        expect(first.dir).toBeDefined();
        expect(second.dir).toBeDefined();
        expect(first.dir).not.toBe(second.dir);
        expect(first.outputFile.startsWith(first.dir)).toBe(true);
        expect(second.outputFile.startsWith(second.dir)).toBe(true);
      } finally {
        await first.cleanup();
        await second.cleanup();
      }
    });
  });
});

describe('GeminiAdapter', () => {
  afterEach(() => {
    geminiAdapter._cachedBinaryPath = null;
    vi.restoreAllMocks();
  });

  it('getName returns Gemini CLI', () => {
    expect(geminiAdapter.getName()).toBe('Gemini CLI');
  });

  it('getType returns google', () => {
    expect(geminiAdapter.getType()).toBe('google');
  });

  it('isSupported returns true', () => {
    expect(geminiAdapter.isSupported()).toBe(true);
  });

  it('getDefaultModel returns a Gemini model', () => {
    const model = geminiAdapter.getDefaultModel();
    expect(typeof model).toBe('string');
    expect(model.length).toBeGreaterThan(0);
    // Default should be gemini-3-flash-preview unless env/config overrides
    expect(model).toMatch(/^gemini/);
  });

  it('getModels returns non-empty array with alias/name/description including flash-lite', () => {
    const models = geminiAdapter.getModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    for (const m of models) {
      expect(m).toHaveProperty('alias');
      expect(m).toHaveProperty('name');
      expect(m).toHaveProperty('description');
    }
    const aliases = models.map((m) => m.alias);
    expect(aliases).toContain('gemini-3.1-pro-preview');
    expect(aliases).toContain('gemini-3.1-flash-lite-preview');
    expect(aliases).toContain('gemini-2.5-flash');
    expect(aliases).toContain('gemini-2.5-flash-lite');
    expect(aliases).toContain('gemini-2.5-pro');
  });

  const itWindows = process.platform === 'win32' ? it : it.skip;

  itWindows('findBinary resolves Windows shim candidates to a spawnable .cmd', async () => {
    const originalHome = process.env.HOME;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const localAppData = path.join('C:', 'Users', 'tester', 'AppData', 'Local');
    const cmdShim = path.join(localAppData, 'Microsoft', 'WindowsApps', 'gemini.cmd');

    process.env.HOME = path.join('C:', 'Users', 'tester');
    process.env.LOCALAPPDATA = localAppData;
    const accessSpy = vi.spyOn(fsSync, 'accessSync').mockImplementation((candidate) => {
      if (String(candidate) === cmdShim) {
        return undefined;
      }
      throw new Error('ENOENT');
    });

    try {
      const result = await geminiAdapter.findBinary();
      expect(result).toBe(cmdShim);
      expect(accessSpy).toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  describe('buildArgs', () => {
    it('produces correct args with stdinMessage true', () => {
      const result = geminiAdapter.buildArgs({
        message: 'Hello Gemini',
        sessionId: 'test-uuid',
        model: 'gemini-2.5-pro',
      });
      expect(result.stdinMessage).toBe(true);
      expect(result.message).toBe('Hello Gemini');
      expect(result.args).toContain('--prompt');
      expect(result.args).toContain('');
      expect(result.args).toContain('--output-format');
      expect(result.args).toContain('stream-json');
      expect(result.args).toContain('--yolo');
      expect(result.args).toContain('--model');
      expect(result.args).toContain('gemini-2.5-pro');
    });

    it('omits --model when model is not provided', () => {
      const result = geminiAdapter.buildArgs({
        message: 'test',
        sessionId: 'id',
      });
      expect(result.args).not.toContain('--model');
      expect(result.stdinMessage).toBe(true);
    });

    it('includes -r <sessionId> when resumeSession is true and sessionId is set', () => {
      const result = geminiAdapter.buildArgs({
        message: 'follow-up',
        sessionId: 'sess-456',
        resumeSession: true,
      });
      const rIdx = result.args.indexOf('-r');
      expect(rIdx).toBeGreaterThan(-1);
      expect(result.args[rIdx + 1]).toBe('sess-456');
    });

    it('omits -r when resumeSession is false', () => {
      const result = geminiAdapter.buildArgs({
        message: 'first msg',
        sessionId: 'sess-456',
        resumeSession: false,
      });
      expect(result.args).not.toContain('-r');
    });

    it('omits -r when resumeSession is true but sessionId is null', () => {
      const result = geminiAdapter.buildArgs({
        message: 'test',
        sessionId: null,
        resumeSession: true,
      });
      expect(result.args).not.toContain('-r');
    });
  });

  describe('parseStreamLine', () => {
    it('returns null for empty/null/undefined lines', () => {
      expect(geminiAdapter.parseStreamLine('')).toBeNull();
      expect(geminiAdapter.parseStreamLine('   ')).toBeNull();
      expect(geminiAdapter.parseStreamLine(null)).toBeNull();
      expect(geminiAdapter.parseStreamLine(undefined)).toBeNull();
    });

    it('parses JSON text events', () => {
      const line = JSON.stringify({ action: 'text', text: 'Hello from Gemini' });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('text');
      expect(result.contentBlocks[0].text).toBe('Hello from Gemini');
    });

    it('parses assistant role message events as assistant text', () => {
      const line = JSON.stringify({ type: 'message', role: 'assistant', content: 'Assistant reply', delta: true });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('text');
      expect(result.contentBlocks[0].text).toBe('Assistant reply');
    });

    it('maps user role message events to system metadata', () => {
      const line = JSON.stringify({ type: 'message', role: 'user', content: 'Prompt content' });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('system');
      expect(result.raw.role).toBe('user');
    });

    it('extracts session_id from init event as session_meta', () => {
      const line = JSON.stringify({ action: 'init', model: 'gemini-2.5-flash', session_id: 'abc-123' });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('session_meta');
      expect(result.sessionId).toBe('abc-123');
      expect(result.model).toBe('gemini-2.5-flash');
    });

    it('falls back to system for init event without session_id', () => {
      const line = JSON.stringify({ action: 'init', model: 'gemini-2.5-flash' });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('system');
      expect(result.model).toBe('gemini-2.5-flash');
    });

    it('parses JSON system/model_info events', () => {
      const line = JSON.stringify({ action: 'model_info', model: 'gemini-2.5-pro' });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('system');
      expect(result.model).toBe('gemini-2.5-pro');
    });

    it('parses JSON tool_call events', () => {
      const line = JSON.stringify({
        action: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        args: { path: '/tmp/test.js' },
      });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('tool_use');
      expect(result.contentBlocks[0].toolName).toBe('read_file');
      expect(result.contentBlocks[0].toolInput.path).toBe('/tmp/test.js');
    });

    it('parses JSON result/done events', () => {
      const line = JSON.stringify({ action: 'done', usage: { outputTokens: 42 } });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('result');
      expect(result.tokensUsed).toBe(42);
    });

    it('parses stream-json result stats output_tokens', () => {
      const line = JSON.stringify({ type: 'result', status: 'success', stats: { output_tokens: 77 } });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('result');
      expect(result.tokensUsed).toBe(77);
    });

    it('parses JSON error events', () => {
      const line = JSON.stringify({ action: 'error', message: 'stream disconnected' });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('error');
      expect(result.message).toContain('stream disconnected');
    });

    it('falls back to plain text for non-JSON lines', () => {
      const result = geminiAdapter.parseStreamLine('Hello world');
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].text).toBe('Hello world\n');
    });

    it('maps warning lines to system events', () => {
      const result = geminiAdapter.parseStreamLine('Warning: rate limit approaching');
      expect(result.type).toBe('system');
      expect(result.raw.type).toBe('status');
    });

    it('parses shell/command events as tool_use', () => {
      const line = JSON.stringify({
        action: 'shell',
        command: 'ls -la',
        status: 'completed',
        exitCode: 0,
      });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks[0].type).toBe('tool_use');
      expect(result.contentBlocks[0].toolName).toBe('Bash');
      expect(result.contentBlocks[0].toolInput.command).toBe('ls -la');
    });

    it('parses stream-json tool_use events with tool_name/parameters', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool_name: 'run_shell_command',
        tool_id: 'tool_123',
        parameters: { command: 'pwd && ls' },
      });
      const result = geminiAdapter.parseStreamLine(line);
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks[0].type).toBe('tool_use');
      expect(result.contentBlocks[0].toolId).toBe('tool_123');
      expect(result.contentBlocks[0].toolName).toBe('run_shell_command');
      expect(result.contentBlocks[0].toolInput.command).toBe('pwd && ls');
    });
  });

  describe('extractReviewText', () => {
    it('returns empty string for empty input', () => {
      expect(geminiAdapter.extractReviewText('')).toBe('');
      expect(geminiAdapter.extractReviewText(null)).toBe('');
    });

    it('extracts response from JSON output', () => {
      const output = JSON.stringify({
        response: '{"summary":"ok","riskLevel":"low","changeGroups":[],"recommendations":[],"stats":{}}',
      });
      const extracted = geminiAdapter.extractReviewText(output);
      expect(extracted).toContain('"summary":"ok"');
    });

    it('extracts text from JSONL stream events', () => {
      const output = [
        JSON.stringify({ action: 'text', text: 'Part 1' }),
        JSON.stringify({ action: 'text', text: 'Part 2' }),
        JSON.stringify({ action: 'done' }),
      ].join('\n');
      const extracted = geminiAdapter.extractReviewText(output);
      expect(extracted).toContain('Part 1');
      expect(extracted).toContain('Part 2');
    });

    it('prefers result event response over accumulated text', () => {
      const output = [
        JSON.stringify({ action: 'text', text: 'intermediate' }),
        JSON.stringify({ action: 'done', response: 'final answer' }),
      ].join('\n');
      const extracted = geminiAdapter.extractReviewText(output);
      expect(extracted).toBe('final answer');
    });

    it('falls back to raw text when no JSON is present', () => {
      const extracted = geminiAdapter.extractReviewText('plain text response');
      expect(extracted).toBe('plain text response');
    });

    it('ignores user envelope text and extracts assistant JSON in stream-json mode', () => {
      const output = [
        JSON.stringify({ type: 'init', model: 'auto-gemini-3' }),
        JSON.stringify({
          type: 'message',
          role: 'user',
          content: 'ATLAS_CLI_AGENT_REVIEW_REQUEST_START\n{"type":"object","required":["summary"]}\nATLAS_CLI_AGENT_REVIEW_REQUEST_END',
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: '{"summary":"ok","riskLevel":"low","changeGroups":[],"recommendations":[],"stats":{"filesAnalyzed":1,"totalAdditions":1,"totalDeletions":0,"estimatedComplexity":"simple"}}',
          delta: true,
        }),
        JSON.stringify({
          type: 'result',
          status: 'success',
          stats: { output_tokens: 42 },
        }),
      ].join('\n');

      const extracted = geminiAdapter.extractReviewText(output);
      const parsed = JSON.parse(extracted);
      expect(parsed.summary).toBe('ok');
      expect(parsed.riskLevel).toBe('low');
      expect(parsed.stats.filesAnalyzed).toBe(1);
    });

    it('extracts walkthrough changeGroups JSON from assistant stream chunks', () => {
      const walkthroughJson = JSON.stringify({
        changeGroups: [
          {
            label: 'UI flow',
            description: 'Adds a walkthrough-friendly UI flow.',
            risk: 'low',
            files: [
              {
                path: 'frontend/src/App.tsx',
                additions: 3,
                deletions: 1,
                description: 'Updates the app shell.',
              },
            ],
          },
        ],
      });
      const output = [
        JSON.stringify({
          type: 'message',
          role: 'user',
          content: 'Prompt echo with the walkthrough schema.',
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: walkthroughJson.slice(0, 80),
          delta: true,
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: walkthroughJson.slice(80),
          delta: true,
        }),
        JSON.stringify({ type: 'result', status: 'success' }),
      ].join('\n');

      expect(geminiAdapter.extractReviewText(output)).toBe(walkthroughJson);
    });
  });

  describe('agentic capabilities', () => {
    it('declares cli-agentic modes when runtime is available', () => {
      expect(geminiAdapter.getExecutionModes({ hasCliRuntime: true })).toEqual(['cli-agentic', 'cli-agent', 'cli-pipe']);
    });

    it('returns no execution modes when runtime is unavailable', () => {
      expect(geminiAdapter.getExecutionModes({ hasCliRuntime: false })).toEqual([]);
    });

    it('builds agentic args with system prompt prepended to stdin message', () => {
      const { args, stdinMessage, message } = geminiAdapter.buildAgenticArgs({
        message: 'review this code',
        sessionId: 'session-gemini',
        model: 'gemini-2.5-pro',
        systemPrompt: 'Respond with JSON only.',
      });
      expect(stdinMessage).toBe(true);
      expect(args).toContain('--prompt');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--yolo');
      expect(args).toContain('--model');
      expect(args).toContain('gemini-2.5-pro');
      expect(message).toContain('[SYSTEM INSTRUCTIONS]: Respond with JSON only.');
      expect(message).toContain('review this code');
    });

    it('builds agentic args without system prompt when not provided', () => {
      const { message } = geminiAdapter.buildAgenticArgs({
        message: 'just a prompt',
        sessionId: 'session-gemini',
      });
      expect(message).toBe('just a prompt');
      expect(message).not.toContain('[SYSTEM INSTRUCTIONS]');
    });

    it('does not opt into Darwin sandbox profile', () => {
      expect(geminiAdapter.shouldUseDarwinSandboxProfile()).toBe(false);
    });

    it('does not support CLI max-turns flag', () => {
      expect(geminiAdapter.supportsCliMaxTurns()).toBe(false);
    });
  });
});

describe('OpenCodeAdapter', () => {
  it('getName returns OpenCode', () => {
    expect(openCodeAdapter.getName()).toBe('OpenCode');
  });

  it('getType returns opencode', () => {
    expect(openCodeAdapter.getType()).toBe('opencode');
  });

  it('isSupported returns true', () => {
    expect(openCodeAdapter.isSupported()).toBe(true);
  });

  it('getModels returns non-empty array with alias/name/description', () => {
    const models = openCodeAdapter.getModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m).toHaveProperty('alias');
      expect(m).toHaveProperty('name');
      expect(m).toHaveProperty('description');
    }
  });

  it('getDefaultModel returns a string', () => {
    const model = openCodeAdapter.getDefaultModel();
    expect(typeof model).toBe('string');
    expect(model.length).toBeGreaterThan(0);
  });

  it('is registered in adapter registry', () => {
    expect(hasAdapter('opencode')).toBe(true);
    expect(getAdapter('opencode')).toBe(openCodeAdapter);
  });

  describe('buildArgs', () => {
    it('returns valid structure with run --format json', () => {
      const result = openCodeAdapter.buildArgs({
        message: 'Hello world',
        sessionId: 'test-session',
      });
      expect(result.args).toContain('run');
      expect(result.args).toContain('--format');
      expect(result.args).toContain('json');
      expect(result.stdinMessage).toBe(true);
      expect(result.structuredOutput).toBe(true);
      expect(result.message).toBe('Hello world');
    });

    it('includes model flag when model specified', () => {
      const result = openCodeAdapter.buildArgs({
        message: 'test',
        model: 'anthropic/claude-sonnet-4-6',
      });
      expect(result.args).toContain('-m');
      expect(result.args).toContain('anthropic/claude-sonnet-4-6');
    });

    it('omits model flag for opencode-default', () => {
      const result = openCodeAdapter.buildArgs({
        message: 'test',
        model: 'opencode-default',
      });
      expect(result.args).not.toContain('-m');
    });

    it('prefixes bare model names with anthropic/', () => {
      const result = openCodeAdapter.buildArgs({
        message: 'test',
        model: 'claude-sonnet-4-6',
      });
      expect(result.args).toContain('-m');
      expect(result.args).toContain('anthropic/claude-sonnet-4-6');
    });

    it('includes session flag when resumeSession is true', () => {
      const result = openCodeAdapter.buildArgs({
        message: 'test',
        sessionId: 'sess-123',
        resumeSession: true,
      });
      expect(result.args).toContain('-s');
      expect(result.args).toContain('sess-123');
    });

    it('prepends system prompt to message', () => {
      const result = openCodeAdapter.buildArgs({
        message: 'review this code',
        systemPrompt: 'You are a code reviewer',
      });
      expect(result.message).toContain('[SYSTEM INSTRUCTIONS]: You are a code reviewer');
      expect(result.message).toContain('review this code');
    });
  });

  describe('buildAgenticArgs', () => {
    it('returns valid structure with run --format json', () => {
      const result = openCodeAdapter.buildAgenticArgs({
        message: 'review code',
        projectPath: '/tmp/project',
      });
      expect(result.args).toContain('run');
      expect(result.args).toContain('--format');
      expect(result.args).toContain('json');
      expect(result.stdinMessage).toBe(true);
      expect(result.structuredOutput).toBe(true);
    });

    it('prepends system prompt to message', () => {
      const result = openCodeAdapter.buildAgenticArgs({
        message: 'review code',
        systemPrompt: 'You are a reviewer',
        projectPath: '/tmp',
      });
      expect(result.message).toContain('[SYSTEM INSTRUCTIONS]: You are a reviewer');
      expect(result.message).toContain('review code');
    });

    it('includes model flag but omits session flag (OpenCode -s resumes existing sessions)', () => {
      const result = openCodeAdapter.buildAgenticArgs({
        message: 'review',
        model: 'anthropic/claude-sonnet-4-6',
        sessionId: 'sess-456',
      });
      expect(result.args).toContain('-m');
      expect(result.args).toContain('anthropic/claude-sonnet-4-6');
      // OpenCode's -s flag is for resuming sessions, not creating new ones.
      // The review pipeline always creates fresh sessions, so -s is intentionally omitted.
      expect(result.args).not.toContain('-s');
    });
  });

  describe('parseStreamLine', () => {
    it('handles JSON text events', () => {
      const result = openCodeAdapter.parseStreamLine(
        JSON.stringify({ type: 'text', content: 'hello world' })
      );
      expect(result).not.toBeNull();
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0].type).toBe('text');
      expect(result.contentBlocks[0].text).toBe('hello world');
    });

    it('handles JSON error events', () => {
      const result = openCodeAdapter.parseStreamLine(
        JSON.stringify({ type: 'error', message: 'something went wrong' })
      );
      expect(result).not.toBeNull();
      expect(result.type).toBe('error');
      expect(result.message).toBe('something went wrong');
    });

    it('handles JSON result/done events', () => {
      const result = openCodeAdapter.parseStreamLine(
        JSON.stringify({ type: 'result', usage: { output_tokens: 150 } })
      );
      expect(result).not.toBeNull();
      expect(result.type).toBe('result');
      expect(result.tokensUsed).toBe(150);
    });

    it('handles JSON tool_use events', () => {
      const result = openCodeAdapter.parseStreamLine(
        JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/test.js' } })
      );
      expect(result).not.toBeNull();
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks[0].type).toBe('tool_use');
      expect(result.contentBlocks[0].toolName).toBe('Read');
    });

    it('handles JSON system/init events', () => {
      const result = openCodeAdapter.parseStreamLine(
        JSON.stringify({ type: 'init', model: 'anthropic/claude-sonnet-4-6' })
      );
      expect(result).not.toBeNull();
      expect(result.type).toBe('system');
      expect(result.model).toBe('anthropic/claude-sonnet-4-6');
    });

    it('handles plain text fallback', () => {
      const result = openCodeAdapter.parseStreamLine('Some plain text output');
      expect(result).not.toBeNull();
      expect(result.type).toBe('assistant');
      expect(result.contentBlocks[0].type).toBe('text');
      expect(result.contentBlocks[0].text).toBe('Some plain text output');
    });

    it('returns null for empty lines', () => {
      expect(openCodeAdapter.parseStreamLine('')).toBeNull();
      expect(openCodeAdapter.parseStreamLine('   ')).toBeNull();
      expect(openCodeAdapter.parseStreamLine(null)).toBeNull();
      expect(openCodeAdapter.parseStreamLine(undefined)).toBeNull();
    });

    it('filters warning/info lines as system events', () => {
      const result = openCodeAdapter.parseStreamLine('Warning: something happened');
      expect(result).not.toBeNull();
      expect(result.type).toBe('system');
    });
  });

  describe('extractToolPathFromToolUse', () => {
    it('extracts file_path', () => {
      expect(openCodeAdapter.extractToolPathFromToolUse('Read', { file_path: '/tmp/a.js' }))
        .toBe('/tmp/a.js');
    });

    it('extracts filePath', () => {
      expect(openCodeAdapter.extractToolPathFromToolUse('Edit', { filePath: '/tmp/b.js' }))
        .toBe('/tmp/b.js');
    });

    it('extracts path', () => {
      expect(openCodeAdapter.extractToolPathFromToolUse('Glob', { path: '/tmp' }))
        .toBe('/tmp');
    });

    it('returns null for empty/null input', () => {
      expect(openCodeAdapter.extractToolPathFromToolUse('Read', null)).toBeNull();
      expect(openCodeAdapter.extractToolPathFromToolUse('Read', {})).toBeNull();
    });
  });

  describe('getExecutionModes', () => {
    it('returns cli modes when hasCliRuntime is true', () => {
      const modes = openCodeAdapter.getExecutionModes({ hasCliRuntime: true });
      expect(modes).toEqual(['cli-agentic', 'cli-agent', 'api']);
      expect(modes).not.toContain('cli-pipe');
    });

    it('returns empty array when hasCliRuntime is false', () => {
      const modes = openCodeAdapter.getExecutionModes({ hasCliRuntime: false });
      expect(modes).toEqual([]);
    });

    it('returns empty array when called with no args', () => {
      const modes = openCodeAdapter.getExecutionModes();
      expect(modes).toEqual([]);
    });
  });

  it('does not opt into Darwin sandbox profile', () => {
    expect(openCodeAdapter.shouldUseDarwinSandboxProfile()).toBe(false);
  });

  it('does not support CLI max-turns flag', () => {
    expect(openCodeAdapter.supportsCliMaxTurns()).toBe(false);
  });

  describe('extractReviewText', () => {
    it('returns empty string for empty input', () => {
      expect(openCodeAdapter.extractReviewText('')).toBe('');
      expect(openCodeAdapter.extractReviewText(null)).toBe('');
    });

    it('extracts text from JSONL result events', () => {
      const lines = [
        JSON.stringify({ type: 'system', model: 'test' }),
        JSON.stringify({ type: 'text', content: 'partial' }),
        JSON.stringify({ type: 'result', text: 'final review output' }),
      ].join('\n');
      expect(openCodeAdapter.extractReviewText(lines)).toBe('final review output');
    });

    it('extracts text from assistant text events', () => {
      const lines = [
        JSON.stringify({ type: 'text', content: 'Here is my review' }),
      ].join('\n');
      expect(openCodeAdapter.extractReviewText(lines)).toBe('Here is my review');
    });

    it('extracts JSON object from mixed output', () => {
      const reviewJson = JSON.stringify({ summary: 'Good code', recommendations: [] });
      const lines = [
        JSON.stringify({ type: 'text', content: `Here is the review: ${reviewJson}` }),
      ].join('\n');
      const result = openCodeAdapter.extractReviewText(lines);
      expect(result).toContain('"summary"');
    });

    it('extracts text from OpenCode part.text events even when a trailing step_finish is present', () => {
      const reviewJson = JSON.stringify({ summary: 'Tiny diff review', recommendations: [] });
      const lines = [
        JSON.stringify({ type: 'text', part: { text: reviewJson } }),
        JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }),
      ].join('\n');
      expect(openCodeAdapter.extractReviewText(lines)).toBe(reviewJson);
    });
  });

  describe('extractDiscoveryText', () => {
    it('extracts prose findings from OpenCode text events and ignores step metadata', () => {
      const lines = [
        JSON.stringify({ type: 'step_start', part: { id: 'prt_1' } }),
        JSON.stringify({ type: 'text', part: { text: '1. High - src/foo.ts:10-12\\nProblem details here.' } }),
        JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }),
      ].join('\n');

      expect(openCodeAdapter.extractDiscoveryText(lines)).toContain('1. High - src/foo.ts:10-12');
    });

    it('returns OpenCode error text when discovery prose is unavailable', () => {
      const lines = [
        JSON.stringify({ type: 'step_start', part: { id: 'prt_1' } }),
        JSON.stringify({ type: 'error', message: 'Provider request was rejected. Verify selected model/provider settings.' }),
      ].join('\n');

      expect(openCodeAdapter.extractDiscoveryText(lines)).toBe(
        'Provider request was rejected. Verify selected model/provider settings.'
      );
    });
  });
});
