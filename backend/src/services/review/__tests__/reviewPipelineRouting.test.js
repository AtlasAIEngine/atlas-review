/**
 * Review Pipeline Routing Tests — OpenCode Integration
 *
 * Verifies that OpenCode providers are correctly routed through the review
 * pipeline's limit resolvers, timeout resolver, execution mode resolver,
 * and CLI label/login command helpers.
 */

import { describe, it, expect } from 'vitest';

import {
  PROVIDER_REQUEST_TIMEOUT_API_MS,
  PROVIDER_REQUEST_TIMEOUT_CLAUDE_CLI_MS,
  PROVIDER_REQUEST_TIMEOUT_CODEX_CLI_MS,
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS,
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_MEDIUM,
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_LARGE,
  PROVIDER_REQUEST_TIMEOUT_GEMINI_CLI_MS,
  PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS,
  REVIEW_CHUNK_CHAR_LIMIT,
  REVIEW_CHUNK_CHAR_LIMIT_CODEX_CLI,
  REVIEW_CHUNK_CHAR_LIMIT_CLAUDE_CLI,
  REVIEW_CHUNK_CHAR_LIMIT_GEMINI_CLI,
  REVIEW_CHUNK_CHAR_LIMIT_OPENCODE_CLI,
  REVIEW_PROMPT_HARD_LIMIT_DEFAULT,
  REVIEW_PROMPT_HARD_LIMIT_CLAUDE_CLI,
  REVIEW_PROMPT_HARD_LIMIT_CODEX_CLI,
  REVIEW_PROMPT_HARD_LIMIT_GEMINI_CLI,
  REVIEW_PROMPT_HARD_LIMIT_OPENCODE_CLI,
  SINGLE_REVIEW_DIFF_LIMIT_DEFAULT,
  SINGLE_REVIEW_DIFF_LIMIT_CLAUDE_CLI,
  SINGLE_REVIEW_DIFF_LIMIT_CODEX_CLI,
  SINGLE_REVIEW_DIFF_LIMIT_GEMINI_CLI,
  SINGLE_REVIEW_DIFF_LIMIT_OPENCODE_CLI,
  REVIEW_CHUNK_CONCURRENCY_CLI,
} from '../reviewConstants.js';

import {
  resolveProviderRequestTimeoutMs,
  resolveProviderExecutionModes,
  getCliProviderLabel,
  getCliLoginCommand,
} from '../reviewProviderExecution.js';

import reviewService from '../../reviewService.js';

const {
  resolveChunkCharLimit,
  resolveChunkConcurrency,
  resolvePromptHardLimit,
  resolveSingleReviewDiffLimit,
  shouldUseChunkedReviewPath,
} = reviewService.__testing;

// ---------------------------------------------------------------------------
// reviewService.js — Limit resolvers
// ---------------------------------------------------------------------------

describe('resolveChunkCharLimit', () => {
  it('returns OpenCode constant for useOpenCodeCLI', () => {
    expect(resolveChunkCharLimit({ useOpenCodeCLI: true })).toBe(REVIEW_CHUNK_CHAR_LIMIT_OPENCODE_CLI);
  });

  it('returns Claude constant for useClaudeCLI (regression)', () => {
    expect(resolveChunkCharLimit({ useClaudeCLI: true })).toBe(REVIEW_CHUNK_CHAR_LIMIT_CLAUDE_CLI);
  });

  it('returns Codex constant for useCodexCLI (regression)', () => {
    expect(resolveChunkCharLimit({ useCodexCLI: true })).toBe(REVIEW_CHUNK_CHAR_LIMIT_CODEX_CLI);
  });

  it('returns Gemini constant for useGeminiCLI (regression)', () => {
    expect(resolveChunkCharLimit({ useGeminiCLI: true })).toBe(REVIEW_CHUNK_CHAR_LIMIT_GEMINI_CLI);
  });

  it('returns default for API provider', () => {
    expect(resolveChunkCharLimit({ apiKey: 'sk-test' })).toBe(REVIEW_CHUNK_CHAR_LIMIT);
  });

  it('returns default for null providerData', () => {
    expect(resolveChunkCharLimit(null)).toBe(REVIEW_CHUNK_CHAR_LIMIT);
  });
});

describe('resolvePromptHardLimit', () => {
  it('returns OpenCode constant for useOpenCodeCLI', () => {
    expect(resolvePromptHardLimit({ useOpenCodeCLI: true })).toBe(REVIEW_PROMPT_HARD_LIMIT_OPENCODE_CLI);
  });

  it('returns Claude constant for useClaudeCLI (regression)', () => {
    expect(resolvePromptHardLimit({ useClaudeCLI: true })).toBe(REVIEW_PROMPT_HARD_LIMIT_CLAUDE_CLI);
  });

  it('returns Codex constant for useCodexCLI (regression)', () => {
    expect(resolvePromptHardLimit({ useCodexCLI: true })).toBe(REVIEW_PROMPT_HARD_LIMIT_CODEX_CLI);
  });

  it('returns Gemini constant for useGeminiCLI (regression)', () => {
    expect(resolvePromptHardLimit({ useGeminiCLI: true })).toBe(REVIEW_PROMPT_HARD_LIMIT_GEMINI_CLI);
  });

  it('returns default for API provider', () => {
    expect(resolvePromptHardLimit({ apiKey: 'sk-test' })).toBe(REVIEW_PROMPT_HARD_LIMIT_DEFAULT);
  });

  it('returns default for null providerData', () => {
    expect(resolvePromptHardLimit(null)).toBe(REVIEW_PROMPT_HARD_LIMIT_DEFAULT);
  });
});

describe('resolveSingleReviewDiffLimit', () => {
  it('returns OpenCode constant for useOpenCodeCLI', () => {
    expect(resolveSingleReviewDiffLimit({ useOpenCodeCLI: true })).toBe(SINGLE_REVIEW_DIFF_LIMIT_OPENCODE_CLI);
  });

  it('returns Claude constant for useClaudeCLI (regression)', () => {
    expect(resolveSingleReviewDiffLimit({ useClaudeCLI: true })).toBe(SINGLE_REVIEW_DIFF_LIMIT_CLAUDE_CLI);
  });

  it('returns Codex constant for useCodexCLI (regression)', () => {
    expect(resolveSingleReviewDiffLimit({ useCodexCLI: true })).toBe(SINGLE_REVIEW_DIFF_LIMIT_CODEX_CLI);
  });

  it('returns Gemini constant for useGeminiCLI (regression)', () => {
    expect(resolveSingleReviewDiffLimit({ useGeminiCLI: true })).toBe(SINGLE_REVIEW_DIFF_LIMIT_GEMINI_CLI);
  });

  it('returns default for API provider', () => {
    expect(resolveSingleReviewDiffLimit({ apiKey: 'sk-test' })).toBe(SINGLE_REVIEW_DIFF_LIMIT_DEFAULT);
  });

  it('returns default for null providerData', () => {
    expect(resolveSingleReviewDiffLimit(null)).toBe(SINGLE_REVIEW_DIFF_LIMIT_DEFAULT);
  });
});

describe('resolveChunkConcurrency', () => {
  it('treats OpenCode as CLI provider (uses CLI concurrency)', () => {
    const result = resolveChunkConcurrency({ useOpenCodeCLI: true }, 10);
    // CLI providers use REVIEW_CHUNK_CONCURRENCY_CLI, capped at chunkCount
    expect(result).toBe(Math.min(REVIEW_CHUNK_CONCURRENCY_CLI, 10));
  });

  it('treats Claude as CLI provider (regression)', () => {
    const result = resolveChunkConcurrency({ useClaudeCLI: true }, 10);
    expect(result).toBe(Math.min(REVIEW_CHUNK_CONCURRENCY_CLI, 10));
  });

  it('treats Codex as CLI provider (regression)', () => {
    const result = resolveChunkConcurrency({ useCodexCLI: true }, 10);
    expect(result).toBe(Math.min(REVIEW_CHUNK_CONCURRENCY_CLI, 10));
  });

  it('treats Gemini as CLI provider (regression)', () => {
    const result = resolveChunkConcurrency({ useGeminiCLI: true }, 10);
    expect(result).toBe(Math.min(REVIEW_CHUNK_CONCURRENCY_CLI, 10));
  });
});

describe('shouldUseChunkedReviewPath', () => {
  it('returns true for OpenCode CLI with high file count', () => {
    // SINGLE_REVIEW_MAX_FILES_CLI is 10 by default, 20 > 10 so should trigger chunked
    expect(shouldUseChunkedReviewPath({ useOpenCodeCLI: true }, 100, 20)).toBe(true);
  });

  it('returns true for OpenCode CLI when diff exceeds limit', () => {
    // SINGLE_REVIEW_DIFF_LIMIT_OPENCODE_CLI is 15000
    expect(shouldUseChunkedReviewPath({ useOpenCodeCLI: true }, 20000, 1)).toBe(true);
  });

  it('returns false for OpenCode CLI with small diff and low file count', () => {
    // 100 chars, 1 file — way under limits
    expect(shouldUseChunkedReviewPath({ useOpenCodeCLI: true }, 100, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviewProviderExecution.js — Timeout resolver
// ---------------------------------------------------------------------------

describe('resolveProviderRequestTimeoutMs', () => {
  it('returns OpenCode timeout for useOpenCodeCLI', () => {
    expect(resolveProviderRequestTimeoutMs({ useOpenCodeCLI: true })).toBe(PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS);
  });

  it('returns Claude timeout for useClaudeCLI (regression)', () => {
    expect(resolveProviderRequestTimeoutMs({ useClaudeCLI: true })).toBe(PROVIDER_REQUEST_TIMEOUT_CLAUDE_CLI_MS);
  });

  it('returns Codex timeout for useCodexCLI (regression)', () => {
    expect(resolveProviderRequestTimeoutMs({ useCodexCLI: true })).toBe(PROVIDER_REQUEST_TIMEOUT_CODEX_CLI_MS);
  });

  it('returns Gemini timeout for useGeminiCLI (regression)', () => {
    expect(resolveProviderRequestTimeoutMs({ useGeminiCLI: true })).toBe(PROVIDER_REQUEST_TIMEOUT_GEMINI_CLI_MS);
  });

  it('returns API timeout for null providerData', () => {
    expect(resolveProviderRequestTimeoutMs(null)).toBe(PROVIDER_REQUEST_TIMEOUT_API_MS);
  });

  it('returns API timeout for non-CLI provider', () => {
    expect(resolveProviderRequestTimeoutMs({ apiKey: 'sk-test' })).toBe(PROVIDER_REQUEST_TIMEOUT_API_MS);
  });

  it('uses cli-agentic small timeout when no tier is provided', () => {
    expect(
      resolveProviderRequestTimeoutMs({ useOpenCodeCLI: true }, 'cli-agentic', { maxTurns: 24 })
    ).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS);
  });

  it('uses medium cli-agentic timeout when request context is medium tier', () => {
    expect(
      resolveProviderRequestTimeoutMs(
        { useOpenCodeCLI: true },
        'cli-agentic',
        { maxTurns: 30, agenticTier: 'medium' }
      )
    ).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_MEDIUM);
  });

  it('uses large cli-agentic timeout when request context is large tier', () => {
    expect(
      resolveProviderRequestTimeoutMs(
        { useOpenCodeCLI: true },
        'cli-agentic',
        { maxTurns: 24, agenticTier: 'large' }
      )
    ).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_LARGE);
  });
});

// ---------------------------------------------------------------------------
// reviewProviderExecution.js — Execution mode resolver
// ---------------------------------------------------------------------------

describe('resolveProviderExecutionModes', () => {
  it('returns CLI modes for forced-CLI OpenCode provider', () => {
    const pd = {
      useOpenCodeCLI: true,
      provider: { type: 'opencode', source: 'cli_detected' },
    };
    const modes = resolveProviderExecutionModes(pd);
    // OpenCode uses api mode (direct API passthrough) + cli-agent/cli-agentic (no cli-pipe)
    expect(modes).toContain('api');
    expect(modes).toContain('cli-agent');
    expect(modes).toContain('cli-agentic');
    expect(modes).not.toContain('cli-pipe');
  });

  it('returns CLI modes for cli_detected OpenCode provider (not forced)', () => {
    const pd = {
      provider: { type: 'opencode', source: 'cli_detected' },
    };
    const modes = resolveProviderExecutionModes(pd);
    // supportsCli is true for 'opencode', hasCliRuntime is true for cli_detected source
    expect(modes.length).toBeGreaterThan(0);
    expect(modes).toContain('api');
  });

  it('returns empty modes for opencode without CLI runtime', () => {
    const pd = {
      provider: { type: 'opencode', source: 'manual' },
    };
    const modes = resolveProviderExecutionModes(pd);
    // No API key and not forced CLI and source is not 'cli_detected'
    expect(modes).toEqual([]);
  });

  it('still returns correct modes for Claude CLI (regression)', () => {
    const pd = {
      useClaudeCLI: true,
      provider: { type: 'anthropic', source: 'cli_detected' },
    };
    const modes = resolveProviderExecutionModes(pd);
    expect(modes).toContain('cli-pipe');
    expect(modes).toContain('cli-agent');
    expect(modes).toContain('cli-agentic');
  });

  it('still returns correct modes for Gemini CLI (regression)', () => {
    const pd = {
      useGeminiCLI: true,
      provider: { type: 'google', source: 'cli_detected' },
    };
    const modes = resolveProviderExecutionModes(pd);
    expect(modes).toContain('cli-pipe');
    expect(modes).toContain('cli-agent');
    expect(modes).toContain('cli-agentic');
  });
});

// ---------------------------------------------------------------------------
// reviewProviderExecution.js — CLI labels and login commands
// ---------------------------------------------------------------------------

describe('getCliProviderLabel', () => {
  it('returns OpenCode for opencode type', () => {
    expect(getCliProviderLabel('opencode')).toBe('OpenCode');
  });

  it('returns Claude for anthropic type (regression)', () => {
    expect(getCliProviderLabel('anthropic')).toBe('Claude');
  });

  it('returns Codex for openai type (regression)', () => {
    expect(getCliProviderLabel('openai')).toBe('Codex');
  });

  it('returns Gemini for google type', () => {
    expect(getCliProviderLabel('google')).toBe('Gemini');
  });

  it('returns CLI for unknown type', () => {
    expect(getCliProviderLabel('unknown')).toBe('CLI');
  });
});

describe('getCliLoginCommand', () => {
  it('returns opencode auth for opencode type', () => {
    expect(getCliLoginCommand('opencode')).toBe('opencode auth');
  });

  it('returns claude login for anthropic type (regression)', () => {
    expect(getCliLoginCommand('anthropic')).toBe('claude login');
  });

  it('returns codex login for openai type (regression)', () => {
    expect(getCliLoginCommand('openai')).toBe('codex login');
  });

  it('returns gemini auth login for google type', () => {
    expect(getCliLoginCommand('google')).toBe('gemini auth login');
  });

  it('returns login for unknown type', () => {
    expect(getCliLoginCommand('unknown')).toBe('login');
  });
});

// ---------------------------------------------------------------------------
// Constants — sanity checks
// ---------------------------------------------------------------------------

describe('OpenCode constants are correct values', () => {
  it('PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS defaults to 300000', () => {
    expect(PROVIDER_REQUEST_TIMEOUT_OPENCODE_CLI_MS).toBe(300000);
  });

  it('REVIEW_PROMPT_HARD_LIMIT_OPENCODE_CLI is 60000', () => {
    expect(REVIEW_PROMPT_HARD_LIMIT_OPENCODE_CLI).toBe(60000);
  });

  it('SINGLE_REVIEW_DIFF_LIMIT_OPENCODE_CLI is 15000', () => {
    expect(SINGLE_REVIEW_DIFF_LIMIT_OPENCODE_CLI).toBe(15000);
  });

  it('REVIEW_CHUNK_CHAR_LIMIT_OPENCODE_CLI is 45000', () => {
    expect(REVIEW_CHUNK_CHAR_LIMIT_OPENCODE_CLI).toBe(45000);
  });
});
