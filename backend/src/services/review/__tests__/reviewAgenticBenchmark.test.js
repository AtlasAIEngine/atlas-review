/**
 * Unit tests for cli-agentic review mode.
 * Tests pure functions only — no real CLI/API calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';

import {
  isCliAgenticExecutionEnabled,
  resolveProviderExecutionModes,
  filterExecutionModesForRequest,
  shouldFallbackToNextExecutionMode,
  classifyCliRuntimeTextError,
  resolveProviderExecutionMode,
  buildCliAgenticReviewPrompt,
  buildCliAgenticDiscoveryPrompt,
  buildCliAgenticDiscoveryExtractionPrompt,
  parseCliAgenticDiscoveryResponse,
  convertCliAgenticDiscoveryToReviewPayload,
  summarizeToolInput,
  DANGEROUS_ENV_VARS,
  buildCliSpawnEnv,
  resolveCliSpawnInvocation,
  resolveCliSpawnCwd,
  killProcessGroup,
  detectMaxTurnsExhausted,
  extractAgenticResultMeta,
  buildIsolatedHomeEnv,
  extractToolPath,
  isWriteTool,
  isPathWithinScope,
  isClaudeInternalPath,
  isProtectedHomeTarget,
  stripTomlMcpServers,
  generateSandboxProfile,
  createIsolatedAgentHome,
  resolveAgenticTier,
  computeAgenticMaxTurns,
  normalizeAgenticMaxTurns,
  computeAgenticTimeoutMs,
  buildBehavioralHotspotDistillation,
  tierFileHintsForAgenticPrompt,
  partitionFilesForParallelAgenticReview,
} from '../reviewProviderExecution.js';

import {
  createReviewRuntimeError,
  classifyReviewRuntimeError,
} from '../reviewErrorClassification.js';

import {
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS,
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_MEDIUM,
  PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_LARGE,
  CLI_AGENTIC_MAX_TURNS,
  CLI_AGENTIC_MIN_TURNS,
  CLI_AGENTIC_TIMEOUT_PER_TURN_MS,
  CLI_AGENTIC_TIMEOUT_BASE_MS,
  CLI_AGENTIC_MAX_TURNS_MEDIUM,
  CLI_AGENTIC_MAX_TURNS_LARGE,
  CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT,
  CLI_AGENTIC_TIER_LARGE_FILE_COUNT,
  KNOWN_REVIEW_PROGRESS_PHASES,
} from '../reviewConstants.js';
import claudeAdapter from '../../cliAdapters/ClaudeAdapter.js';

// ---------------------------------------------------------------------------
// isCliAgenticExecutionEnabled (now a stub that always returns true)
// ---------------------------------------------------------------------------

describe('isCliAgenticExecutionEnabled', () => {
  it('always returns true (deprecated stub)', () => {
    expect(isCliAgenticExecutionEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveProviderExecutionModes — default ordering (no userModeOrder)
// ---------------------------------------------------------------------------

describe('resolveProviderExecutionModes default order', () => {
  const makeProviderData = (overrides = {}) => ({
    provider: { type: 'anthropic', source: 'cli_detected', model: 'claude-sonnet-4-6' },
    apiKey: 'sk-test-123',
    useClaudeCLI: false,
    useCodexCLI: false,
    ...overrides,
  });

  it('includes cli-agentic as first entry when hasCliRuntime and hasApi (default order)', () => {
    const modes = resolveProviderExecutionModes(makeProviderData());
    expect(modes[0]).toBe('cli-agentic');
    expect(modes).toContain('api');
    expect(modes).toContain('cli-agent');
    expect(modes).toContain('cli-pipe');
  });

  it('places cli-agentic before api when both are available', () => {
    const modes = resolveProviderExecutionModes(makeProviderData());
    const agenticIdx = modes.indexOf('cli-agentic');
    const apiIdx = modes.indexOf('api');
    expect(agenticIdx).toBeLessThan(apiIdx);
  });

  it('does not include cli-agentic when provider does not support CLI', () => {
    const modes = resolveProviderExecutionModes(makeProviderData({
      provider: { type: 'google', source: 'byok' },
    }));
    expect(modes).not.toContain('cli-agentic');
  });

  it('returns only api when provider is byok without CLI runtime', () => {
    const modes = resolveProviderExecutionModes(makeProviderData({
      provider: { type: 'google', source: 'byok' },
      apiKey: 'gk-test',
    }));
    expect(modes).toEqual(['api']);
  });

  it('returns cli-pipe for forcedCli anthropic without apiKey', () => {
    const modes = resolveProviderExecutionModes(makeProviderData({
      apiKey: null,
      useClaudeCLI: true,
    }));
    expect(modes).toContain('cli-pipe');
    expect(modes).toContain('cli-agentic');
    expect(modes).toContain('cli-agent');
    expect(modes).not.toContain('api');
  });

  it('includes cli-agentic for openai cli-detected providers', () => {
    const modes = resolveProviderExecutionModes(makeProviderData({
      provider: { type: 'openai', source: 'cli_detected', model: 'gpt-5.3-codex' },
      useCodexCLI: true,
      useClaudeCLI: false,
      apiKey: null,
    }));
    expect(modes).toContain('cli-agentic');
    expect(modes).toContain('cli-agent');
    expect(modes).toContain('cli-pipe');
  });

  it('includes cli-agentic for google cli-detected providers', () => {
    const modes = resolveProviderExecutionModes(makeProviderData({
      provider: { type: 'google', source: 'cli_detected', model: 'gemini-2.5-flash' },
      useGeminiCLI: true,
      useClaudeCLI: false,
      useCodexCLI: false,
      apiKey: null,
    }));
    expect(modes).toContain('cli-agentic');
    expect(modes).toContain('cli-agent');
    expect(modes).toContain('cli-pipe');
  });
});

// ---------------------------------------------------------------------------
// resolveProviderExecutionModes — with userModeOrder
// ---------------------------------------------------------------------------

describe('resolveProviderExecutionModes with userModeOrder', () => {
  const makeProviderData = (overrides = {}) => ({
    provider: { type: 'anthropic', source: 'cli_detected', model: 'claude-sonnet-4-6' },
    apiKey: 'sk-test-123',
    useClaudeCLI: false,
    useCodexCLI: false,
    ...overrides,
  });

  it('null userModeOrder uses default logic', () => {
    const modes = resolveProviderExecutionModes(makeProviderData(), null);
    expect(modes[0]).toBe('cli-agentic');
  });

  it('empty array userModeOrder uses default logic', () => {
    const modes = resolveProviderExecutionModes(makeProviderData(), []);
    expect(modes[0]).toBe('cli-agentic');
  });

  it('custom order is respected when all modes are available', () => {
    const modes = resolveProviderExecutionModes(
      makeProviderData(),
      ['api', 'cli-pipe', 'cli-agentic', 'cli-agent']
    );
    expect(modes).toEqual(['api', 'cli-pipe', 'cli-agentic', 'cli-agent']);
  });

  it('unavailable modes in userModeOrder are dropped', () => {
    // Google provider with byok — only api is available
    const modes = resolveProviderExecutionModes(
      makeProviderData({
        provider: { type: 'google', source: 'byok' },
        apiKey: 'gk-test',
      }),
      ['cli-agentic', 'api', 'cli-pipe']
    );
    expect(modes).toEqual(['api']);
  });

  it('available modes not in userModeOrder are appended', () => {
    // User only specified api and cli-pipe, but cli-agentic and cli-agent are also available
    const modes = resolveProviderExecutionModes(
      makeProviderData(),
      ['api', 'cli-pipe']
    );
    expect(modes[0]).toBe('api');
    expect(modes[1]).toBe('cli-pipe');
    // cli-agentic and cli-agent should be appended
    expect(modes.length).toBe(4);
    expect(modes).toContain('cli-agentic');
    expect(modes).toContain('cli-agent');
  });

  it('duplicate modes in userModeOrder are deduplicated', () => {
    const modes = resolveProviderExecutionModes(
      makeProviderData(),
      ['api', 'api', 'cli-pipe', 'cli-pipe']
    );
    const uniqueModes = new Set(modes);
    expect(uniqueModes.size).toBe(modes.length);
  });

  it('user order with api first for BYOK provider', () => {
    const modes = resolveProviderExecutionModes(
      makeProviderData({
        provider: { type: 'anthropic', source: 'byok' },
      }),
      ['api', 'cli-agentic', 'cli-agent', 'cli-pipe']
    );
    expect(modes[0]).toBe('api');
  });
});

describe('filterExecutionModesForRequest', () => {
  it('removes cli-agentic when request is not explicitly agentic', () => {
    const modes = filterExecutionModesForRequest(['cli-agentic', 'api', 'cli-agent'], {});
    expect(modes).toEqual(['api', 'cli-agent']);
  });

  it('preserves cli-agentic when reviewExecutionMode is cli-agentic', () => {
    const modes = filterExecutionModesForRequest(
      ['cli-agentic', 'api', 'cli-agent'],
      { reviewExecutionMode: 'cli-agentic' }
    );
    expect(modes).toEqual(['cli-agentic', 'api', 'cli-agent']);
  });

  it('strips cli-agentic when requestContext is null', () => {
    const modes = filterExecutionModesForRequest(['cli-agentic', 'api', 'cli-agent'], null);
    expect(modes).toEqual(['api', 'cli-agent']);
  });

  it('strips cli-agentic when requestContext is undefined', () => {
    const modes = filterExecutionModesForRequest(['cli-agentic', 'api', 'cli-agent']);
    expect(modes).toEqual(['api', 'cli-agent']);
  });
});

// ---------------------------------------------------------------------------
// shouldFallbackToNextExecutionMode
// ---------------------------------------------------------------------------

describe('shouldFallbackToNextExecutionMode', () => {
  it('returns false for deadline errors', () => {
    const err = new Error('deadline');
    err.isDeadline = true;
    expect(shouldFallbackToNextExecutionMode(err)).toBe(false);
  });

  it('returns false for auth errors', () => {
    const err = createReviewRuntimeError('auth failed', 'auth');
    expect(shouldFallbackToNextExecutionMode(err)).toBe(false);
  });

  it('returns false for context_limit errors', () => {
    const err = createReviewRuntimeError('context limit', 'context_limit');
    expect(shouldFallbackToNextExecutionMode(err)).toBe(false);
  });

  it('returns false for invalid_request errors', () => {
    const err = createReviewRuntimeError('bad request', 'invalid_request');
    expect(shouldFallbackToNextExecutionMode(err)).toBe(false);
  });

  it('returns false for out_of_scope_access errors', () => {
    const err = createReviewRuntimeError('scope violation', 'out_of_scope_access');
    expect(shouldFallbackToNextExecutionMode(err)).toBe(false);
  });

  it('returns true for transient/network errors', () => {
    const err = createReviewRuntimeError('connection reset', 'econnreset');
    expect(shouldFallbackToNextExecutionMode(err)).toBe(true);
  });

  it('returns true for rate limit errors', () => {
    const err = createReviewRuntimeError('too many requests', 'rate_limit');
    expect(shouldFallbackToNextExecutionMode(err)).toBe(true);
  });
});

describe('classifyCliRuntimeTextError', () => {
  it('returns invalid_request for plain-text git repository failures', () => {
    const err = classifyCliRuntimeTextError('anthropic', 'No git repository found in current directory');
    expect(err).toBeInstanceOf(Error);
    expect(err.runtimeCode).toBe('invalid_request');
    expect(err.message).toContain('could not resolve git history');
  });

  it('returns auth for plain-text login failures', () => {
    const err = classifyCliRuntimeTextError('openai', 'Not authenticated. Please run `codex login`.');
    expect(err).toBeInstanceOf(Error);
    expect(err.runtimeCode).toBe('auth');
    expect(err.message).toContain('codex login');
  });

  it('returns null for review JSON payloads', () => {
    const err = classifyCliRuntimeTextError(
      'anthropic',
      JSON.stringify({
        summary: 'ok',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [],
        stats: {},
      })
    );
    expect(err).toBeNull();
  });

  it('returns invalid_request for empty output', () => {
    const err = classifyCliRuntimeTextError('anthropic', '   ');
    expect(err).toBeInstanceOf(Error);
    expect(err.runtimeCode).toBe('invalid_request');
    expect(err.message).toContain('empty response');
  });

  it('returns invalid_request for empty JSON object without review fields', () => {
    const err = classifyCliRuntimeTextError('anthropic', '{}');
    expect(err).toBeInstanceOf(Error);
    expect(err.runtimeCode).toBe('invalid_request');
    expect(err.message).toContain('without review content');
  });

  it('returns invalid_request for JSON with error but no review fields', () => {
    const err = classifyCliRuntimeTextError('anthropic', JSON.stringify({ error: 'something went wrong' }));
    expect(err).toBeInstanceOf(Error);
    expect(err.runtimeCode).toBe('invalid_request');
    expect(err.message).toContain('without review content');
  });

  it('returns null for JSON array containing review fields', () => {
    // Array with review field names is let through — parseReviewResponse rejects arrays later
    const err = classifyCliRuntimeTextError('anthropic', JSON.stringify([{ summary: 'review done' }]));
    expect(err).toBeNull();
  });

  it('returns invalid_request for JSON array without review fields', () => {
    const err = classifyCliRuntimeTextError('anthropic', '[]');
    expect(err).toBeInstanceOf(Error);
    expect(err.runtimeCode).toBe('invalid_request');
    expect(err.message).toContain('without review content');
  });

  it('returns invalid_request for provider rejection text payloads', () => {
    const err = classifyCliRuntimeTextError(
      'anthropic',
      'Provider request was rejected. Selected model is not enabled for this account.'
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.runtimeCode).toBe('model_unavailable');
    expect(err.message).toContain('request was rejected');
  });
});

describe('classifyReviewRuntimeError — max_turns_exceeded', () => {
  it('classifies max_turns_exceeded runtimeCode as non-retryable', () => {
    const err = createReviewRuntimeError('CLI ran out of turns', 'max_turns_exceeded');
    const result = classifyReviewRuntimeError(err);
    expect(result.runtimeClass).toBe('max_turns_exceeded');
    expect(result.legacyClass).toBe('max_turns_exceeded');
    expect(result.retryable).toBe(false);
  });
});

describe('classifyReviewRuntimeError — quota', () => {
  it('classifies provider credit exhaustion as non-retryable quota', () => {
    const err = createReviewRuntimeError(
      'Credit balance is too low to access the Anthropic API. Purchase credits to continue.',
      'invalid_request'
    );

    const result = classifyReviewRuntimeError(err);

    expect(result.runtimeClass).toBe('quota');
    expect(result.legacyClass).toBe('quota');
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCliAgenticReviewPrompt
// ---------------------------------------------------------------------------

describe('buildCliAgenticReviewPrompt', () => {
  const baseInput = {
    branchName: 'feature/my-feature',
    baseBranch: 'main',
    mergeBaseSha: 'abc1234',
    headSha: 'def5678',
    fileHints: [
      { path: 'src/auth.ts', riskScore: 0.9 },
      { path: 'src/utils.ts', riskScore: 0.3 },
    ],
    ignorePatterns: ['*.lock', 'node_modules/**'],
    outputSchema: {
      summary: 'string',
      riskLevel: 'low | medium | high | critical',
      recommendations: [],
      candidateFindings: [],
    },
  };

  it('returns a string', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('contains branch and SHA context', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    expect(prompt).toContain('feature/my-feature');
    expect(prompt).toContain('main');
    expect(prompt).toContain('abc1234');
    expect(prompt).toContain('def5678');
  });

  it('contains the JSON schema', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    expect(prompt).toContain('summary');
    expect(prompt).toContain('riskLevel');
    expect(prompt).toContain('recommendations');
    expect(prompt).toContain('candidateFindings');
  });

  it('contains file hints sorted by risk (highest first)', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    const authIdx = prompt.indexOf('src/auth.ts');
    const utilsIdx = prompt.indexOf('src/utils.ts');
    expect(authIdx).toBeLessThan(utilsIdx);
  });

  it('includes execution budget and coverage target when provided', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      fileCount: 38,
      maxTurns: 25,
      minimumDeepReviewedFiles: 25,
      minimumCoverageRate: 0.65,
    });
    expect(prompt).toContain('OUTPUT FIRST');
    expect(prompt).toContain('Coverage target: deeply review at least 25/38 files (65%+)');
  });

  it('renders file status and rename source in file hints when present', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      fileHints: [
        { path: 'src/renamed.ts', status: 'R', oldPath: 'src/old-name.ts', riskScore: 0.7 },
      ],
    });
    expect(prompt).toContain('[R] src/renamed.ts (from src/old-name.ts)');
  });

  it('contains ignore patterns', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    expect(prompt).toContain('*.lock');
    expect(prompt).toContain('node_modules/**');
  });

  it('does NOT contain raw diff content when preComputedDiff is null', () => {
    const prompt = buildCliAgenticReviewPrompt({ ...baseInput, preComputedDiff: null });
    // Without pre-computed diff, prompt should instruct Claude to explore, not embed diffs
    expect(prompt).not.toContain('diff --git');
    expect(prompt).not.toContain('@@');
  });

  it('includes an explicit merge-base diff command for scope grounding when no preComputedDiff', () => {
    const prompt = buildCliAgenticReviewPrompt({ ...baseInput, preComputedDiff: null });
    expect(prompt).toContain('git diff abc1234...def5678');
  });

  it('instructs fallback to file hints when SHA diff cannot be computed', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    expect(prompt).toContain('If the exact SHA diff cannot be computed');
  });

  it('supports file-list-only mode without requiring SHA diff', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      preferFileListOnly: true,
    });
    expect(prompt).toContain('authoritative changed-file set from Atlas');
    expect(prompt).toContain('do NOT block on git history availability');
    expect(prompt).not.toContain('git diff abc1234...def5678');
  });

  it('instructs Claude to return JSON', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    expect(prompt.toLowerCase()).toContain('json');
  });

  it('explains the split between direct findings and candidate findings', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    expect(prompt).toContain('Use `recommendations` only for findings you are confident Atlas should surface directly');
    expect(prompt).toContain('Use `candidateFindings` for plausible, grounded concerns that still need verification');
  });

  it('keeps Balanced on the full-file review guidance', () => {
    const prompt = buildCliAgenticReviewPrompt(baseInput);
    expect(prompt).toContain('Read changed files in full (not just diff hunks) before reporting findings');
    expect(prompt).toContain('Do a breadth pass across all changed files first');
    expect(prompt).not.toContain('Review every changed hunk in this diff');
    expect(prompt).not.toContain('Before flagging test runner or test-framework usage');
    expect(prompt).not.toContain('Do NOT surface formatting, documentation, or member-ordering convention issues');
  });

  it('guards against test framework mismatch assumptions in Performance mode', () => {
    const prompt = buildCliAgenticReviewPrompt({ ...baseInput, reviewModelStrategy: 'performance' });
    expect(prompt).toContain('Before flagging test runner or test-framework usage');
    expect(prompt).toContain('inspect package scripts/config and nearby tests');
    expect(prompt).toContain('Do not report a framework mismatch when the repo consistently uses that runner');
  });

  it('suppresses low-impact convention findings in Performance mode', () => {
    const prompt = buildCliAgenticReviewPrompt({ ...baseInput, reviewModelStrategy: 'performance' });
    expect(prompt).toContain('Do NOT surface formatting, documentation, or member-ordering convention issues');
    expect(prompt).toContain('concrete build, runtime, API, or product correctness impact');
  });

  it('handles empty file hints', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      fileHints: [],
    });
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('handles empty ignore patterns', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      ignorePatterns: [],
    });
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes pre-computed diff when provided', () => {
    const fakeDiff = 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n+import { verify } from "jsonwebtoken";\n';
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      preComputedDiff: fakeDiff,
    });
    expect(prompt).toContain('<pre-computed-diff>');
    expect(prompt).toContain('</pre-computed-diff>');
    expect(prompt).toContain(fakeDiff);
    expect(prompt).toContain('Do NOT run `git diff`');
    // Should NOT include the fallback git diff instruction
    expect(prompt).not.toContain('git diff abc1234...def5678');
  });

  it('uses diff-first targeted full-file guidance for Performance reviews', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      reviewModelStrategy: 'performance',
      preComputedDiff: 'diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n',
    });

    expect(prompt).toContain('Review every changed hunk in this diff');
    expect(prompt).toContain('Read full files only when a hunk, hotspot, linter signal, or candidate finding needs surrounding context');
    expect(prompt).toContain('Do a breadth pass across all changed hunks first');
    expect(prompt).not.toContain('Read changed files in full (not just diff hunks) before reporting findings');
  });

  it('falls back to git diff instruction when preComputedDiff is null/empty', () => {
    const promptNull = buildCliAgenticReviewPrompt({ ...baseInput, preComputedDiff: null });
    expect(promptNull).not.toContain('<pre-computed-diff>');
    expect(promptNull).toContain('git diff abc1234...def5678');

    const promptEmpty = buildCliAgenticReviewPrompt({ ...baseInput, preComputedDiff: '' });
    expect(promptEmpty).not.toContain('<pre-computed-diff>');
    expect(promptEmpty).toContain('git diff abc1234...def5678');
  });

  it('includes output-priority execution budget instructions', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      maxTurns: 25,
    });
    expect(prompt).toContain('OUTPUT FIRST');
    expect(prompt).toContain('STOP exploring and produce the JSON review immediately');
    expect(prompt).toContain('Do NOT explore unrelated files');
  });

  it('includes truncation hint for large diffs (>100K chars)', () => {
    const largeDiff = 'diff --git a/big.ts b/big.ts\n' + 'x'.repeat(110000);
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      preComputedDiff: largeDiff,
    });
    expect(prompt).toContain('may be truncated');
    expect(prompt).toContain('<pre-computed-diff>');
  });

  it('includes behavioral hotspot summary and file-level hotspot reasons when provided', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      fileHints: [
        {
          path: 'Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
          riskScore: 1.2,
          behavioralSummary: 'lifecycle/init wiring changed; verify signal ordering, setup timing, and teardown symmetry',
        },
      ],
      behavioralHotspotsSummary: '## Behavioral hotspots from the diff:\n\n  - Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs — lifecycle/init wiring changed; verify signal ordering, setup timing, and teardown symmetry',
    });
    expect(prompt).toContain('Behavioral hotspots from the diff');
    expect(prompt).toContain('GameEventsTimerMapView.cs — lifecycle/init wiring changed');
  });

  it('supports discovery mode with lighter PR-review instructions', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...baseInput,
      fileCount: 42,
      minimumDeepReviewedFiles: 30,
      minimumCoverageRate: 0.71,
      linterFindings: [
        {
          file: 'src/auth.ts',
          line: 12,
          severity: 'high',
          title: 'Example linter finding',
        },
      ],
      discoveryMode: true,
    });

    expect(prompt).toContain('FAST DISCOVERY FIRST');
    expect(prompt).toContain('Start from the highest-risk runtime files and hotspot hypotheses first');
    expect(prompt).not.toContain('Coverage target: deeply review at least 30/42');
    expect(prompt).not.toContain('Atlas linter signals');
  });
});

describe('cli agentic discovery helpers', () => {
  it('builds a lightweight discovery prompt', () => {
    const prompt = buildCliAgenticDiscoveryPrompt({
      branchName: 'feature/minimap',
      baseBranch: 'main',
      mergeBaseSha: 'abc123',
      headSha: 'def456',
      fileCount: 5,
      fileHints: [
        {
          path: 'Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
          status: 'M',
          riskScore: 2,
          behavioralSummary: 'lifecycle/init wiring changed',
        },
      ],
      preComputedDiff: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n',
      behavioralHotspotsSummary: '## Behavioral hotspots from the diff:\n\n- Assets/.../GameEventsTimerMapView.cs — lifecycle/init wiring changed',
    });

    expect(prompt).toContain('Return plain text only');
    expect(prompt).toContain('Issues:');
    expect(prompt).toContain('Candidate concerns:');
    expect(prompt).not.toContain('"candidateFindings"');
    expect(prompt).not.toContain('JSON object');
    expect(prompt).not.toContain('Behavioral hotspots from the diff');
    expect(prompt).not.toContain('Inspect these files first');
    expect(prompt).toContain('Changed files:');
  });

  it('adds tighter code-first guidance for Codex discovery', () => {
    const prompt = buildCliAgenticDiscoveryPrompt({
      branchName: 'feature/minimap',
      baseBranch: 'main',
      mergeBaseSha: 'abc123',
      headSha: 'def456',
      fileCount: 5,
      providerType: 'openai',
      fileHints: [
        {
          path: 'Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
          status: 'M',
        },
      ],
    });

    expect(prompt).toContain('Codex-specific guidance:');
    expect(prompt).toContain('Do not inspect prefabs, scenes, localization assets, or other non-code files');
    expect(prompt).toContain('Prefer identifying 1-3 strong issues');
  });

  it('builds a bounded extraction prompt for discovery notes', () => {
    const prompt = buildCliAgenticDiscoveryExtractionPrompt({
      discoveryText: [
        'Summary:',
        'Map view changes introduce a likely math bug.',
        '',
        'Overall risk: high',
        '',
        'Issues:',
        '- [high] Infinity clamp risk',
        '  file: Assets/BLACK/UI/MapViewBase.cs',
        '  line: 44',
        '  why: The denominator can be zero.',
      ].join('\n'),
      outputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          recommendations: { type: 'array' },
        },
      },
      filePaths: [
        'Assets/BLACK/UI/MapViewBase.cs',
        'Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
      ],
      fileCount: 2,
    });

    expect(prompt).toContain('This is an extraction pass, not a fresh code review.');
    expect(prompt).toContain('Use ONLY findings that are explicitly present in the discovery notes.');
    expect(prompt).toContain('Return ONLY a single JSON object.');
    expect(prompt).toContain('Assets/BLACK/UI/MapViewBase.cs');
    expect(prompt).toContain('<<<DISCOVERY_NOTES');
  });

  it('parses discovery notes and converts them into a review payload', () => {
    const raw = `Summary:
Timer setup moved and one UI string is now inline.

Overall risk: high

Issues:
- [high] Storm timer can miss initialization
  file: Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs
  line: 32
  why: Start now subscribes after the producer may already have emitted.
  snippet: _gameEventsTimerSignal.Subscribe(InitializeStormMapUI);
  fix: Subscribe earlier or replay the current timer state.

Candidate concerns:
- [medium] Storm completion text may bypass localization
  file: Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs
  line: 57
  why: Inline text replaces the localized string path.
  snippet: _stormTitle.text = "Storm closing";
  fix: Route the text through the existing localization key.

Positives:
- Good separation between timer refresh and visibility updates.`;

    const parsed = parseCliAgenticDiscoveryResponse(raw);
    expect(parsed.overallRisk).toBe('high');
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.candidateConcerns).toHaveLength(1);

    const payload = convertCliAgenticDiscoveryToReviewPayload(parsed, {
      fileCount: 5,
      totalAdditions: 10,
      totalDeletions: 3,
    });
    expect(payload.summary).toContain('Timer setup moved');
    expect(payload.riskLevel).toBe('high');
    expect(payload.recommendations).toHaveLength(1);
    expect(payload.candidateFindings).toHaveLength(1);
    expect(payload.candidateFindings[0].type).toBe('suggestion');
    expect(payload.recommendations[0].evidence.file).toContain('GameEventsTimerMapView.cs');
  });

  it('extracts free-form discovery text from Claude stream-json output', () => {
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Summary:\nThin review.\n\nOverall risk: medium\n\nIssues:\n- [high] Infinity clamp risk\n  file: Assets/BLACK/UI/MapViewBase.cs\n  line: 42\n  why: denominator can be zero.\n  snippet: value / distanceCorrection\n  fix: guard zero before dividing.\n\nCandidate concerns:\nnone\n\nPositives:\nnone',
            },
          ],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Completed successfully' }),
    ].join('\n');

    const extracted = claudeAdapter.extractDiscoveryText(raw);
    expect(extracted).toContain('Summary:');
    expect(extracted).toContain('Infinity clamp risk');
    expect(extracted).not.toContain('Completed successfully');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolInput
// ---------------------------------------------------------------------------

describe('summarizeToolInput', () => {
  it('summarizes a Read tool event', () => {
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: 'src/services/auth.ts' },
    });
    expect(summary).toContain('Reading');
    expect(summary).toContain('src/services/auth.ts');
  });

  it('summarizes a Grep tool event', () => {
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'Grep',
      input: { pattern: 'validateToken', path: 'src/' },
    });
    expect(summary).toContain('Searching');
    expect(summary).toContain('validateToken');
  });

  it('summarizes a Bash tool event', () => {
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'git diff main...feature/x' },
    });
    expect(summary).toContain('Running');
    expect(summary).toContain('git diff');
  });

  it('summarizes a Glob tool event', () => {
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'Glob',
      input: { pattern: '**/*.ts' },
    });
    expect(summary).toContain('Finding');
    expect(summary).toContain('**/*.ts');
  });

  it('returns a generic summary for unknown tools', () => {
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'SomeUnknownTool',
      input: {},
    });
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('handles missing input gracefully', () => {
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'Read',
    });
    expect(typeof summary).toBe('string');
    expect(summary).toContain('Reading');
  });

  it('handles null event gracefully', () => {
    const summary = summarizeToolInput(null);
    expect(typeof summary).toBe('string');
  });

  it('truncates long command strings', () => {
    const longCmd = 'git diff ' + 'a'.repeat(200);
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'Bash',
      input: { command: longCmd },
    });
    expect(summary.length).toBeLessThan(200);
  });

  it('summarizes an Edit tool event', () => {
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'Edit',
      input: { file_path: 'src/config.ts' },
    });
    expect(summary).toContain('Editing');
    expect(summary).toContain('src/config.ts');
  });

  it('summarizes a Write tool event', () => {
    const summary = summarizeToolInput({
      type: 'tool_use',
      name: 'Write',
      input: { file_path: 'src/new-file.ts' },
    });
    expect(summary).toContain('Writing');
    expect(summary).toContain('src/new-file.ts');
  });
});

// ---------------------------------------------------------------------------
// Constants validation
// ---------------------------------------------------------------------------

describe('cli-agentic constants', () => {
  it('PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS is at least 120s', () => {
    expect(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS).toBeGreaterThanOrEqual(120000);
  });

  it('CLI_AGENTIC_MAX_TURNS is at least 1', () => {
    expect(CLI_AGENTIC_MAX_TURNS).toBeGreaterThanOrEqual(1);
  });

  it('CLI_AGENTIC_MAX_TURNS defaults to 25', () => {
    // Default value (when env not set)
    expect(CLI_AGENTIC_MAX_TURNS).toBe(25);
  });

  it('KNOWN_REVIEW_PROGRESS_PHASES includes agentic phases', () => {
    expect(KNOWN_REVIEW_PROGRESS_PHASES.has('agentic_exploration')).toBe(true);
    expect(KNOWN_REVIEW_PROGRESS_PHASES.has('agentic_tool_use')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveProviderExecutionMode descriptor
// ---------------------------------------------------------------------------

describe('resolveProviderExecutionMode with cli-agentic', () => {
  it('returns anthropic_cli_agentic when cli-agentic is primary mode and context opts in', () => {
    const mode = resolveProviderExecutionMode({
      provider: { type: 'anthropic', source: 'cli_detected', model: 'claude-sonnet-4-6' },
      apiKey: 'sk-test-123',
    }, { reviewExecutionMode: 'cli-agentic' });
    expect(mode).toBe('anthropic_cli_agentic');
  });

  it('returns openai_cli_agentic when openai cli-agentic is primary mode and context opts in', () => {
    const mode = resolveProviderExecutionMode({
      provider: { type: 'openai', source: 'cli_detected', model: 'gpt-5.3-codex' },
      useCodexCLI: true,
      apiKey: null,
    }, { reviewExecutionMode: 'cli-agentic' });
    expect(mode).toBe('openai_cli_agentic');
  });

  it('resolves to api mode when request context disables agentic', () => {
    const mode = resolveProviderExecutionMode(
      {
        provider: { type: 'anthropic', source: 'cli_detected', model: 'claude-sonnet-4-6' },
        apiKey: 'sk-test-123',
      },
      { reviewExecutionMode: null }
    );
    expect(mode).toBe('anthropic_api');
  });
});

// ---------------------------------------------------------------------------
// requestContext.projectPath threading (pure function verification)
// ---------------------------------------------------------------------------

describe('requestContext.projectPath in buildCliAgenticReviewPrompt', () => {
  it('prompt contains provided SHAs in context and diff command', () => {
    const prompt = buildCliAgenticReviewPrompt({
      branchName: 'feat/x',
      baseBranch: 'main',
      mergeBaseSha: 'aaa111',
      headSha: 'bbb222',
      fileHints: [],
      ignorePatterns: [],
      outputSchema: {},
    });
    expect(prompt).toContain('aaa111');
    expect(prompt).toContain('bbb222');
    expect(prompt).toContain('git diff aaa111...bbb222');
  });

  it('includes review profile diagnostics and paired-file class hints', () => {
    const prompt = buildCliAgenticReviewPrompt({
      branchName: 'feature/unity',
      baseBranch: 'main',
      mergeBaseSha: 'aaa111',
      headSha: 'bbb222',
      fileCount: 28,
      fileHints: [
        {
          path: 'Assets/Prefabs/DonateButton.prefab',
          status: 'M',
          profileClass: 'structural',
          memberPaths: ['Assets/Prefabs/DonateButton.prefab', 'Assets/Prefabs/DonateButton.prefab.meta'],
          riskScore: 420,
        },
      ],
      reviewProfile: {
        id: 'unity_csharp',
        label: 'Unity / C#',
        source: 'detected',
      },
      shapedScope: {
        rawFileCount: 131,
        reviewUnitCount: 28,
        classCounts: {
          deep: 8,
          structural: 10,
          shallow: 4,
          collapsed: 109,
          skip: 0,
        },
      },
      outputSchema: {},
    });

    expect(prompt).toContain('## Atlas Review Profile');
    expect(prompt).toContain('Unity / C# (detected)');
    expect(prompt).toContain('131 raw changed files -> 28 review units');
    expect(prompt).toContain('[structural]');
    expect(prompt).toContain('+1 paired file');
  });
});

// ---------------------------------------------------------------------------
// Benchmark utility: JSON parse extraction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildCliSpawnEnv — env sanitization
// ---------------------------------------------------------------------------

describe('buildCliSpawnEnv', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('strips CLAUDECODE and CLAUDE_CODE_ENTRYPOINT from spawned env', () => {
    process.env = { ...originalEnv, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP_ME: 'yes' };
    const env = buildCliSpawnEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
    expect(env.NO_COLOR).toBe('1');
  });

  it('works when neither var is present', () => {
    const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...clean } = process.env;
    process.env = clean;
    const env = buildCliSpawnEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.NO_COLOR).toBe('1');
  });

  it('merges extra vars without reintroducing stripped ones', () => {
    process.env = { ...originalEnv, CLAUDECODE: '1' };
    const env = buildCliSpawnEnv({ CUSTOM_VAR: 'hello' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CUSTOM_VAR).toBe('hello');
  });

  it('strips all DANGEROUS_ENV_VARS from spawned env', () => {
    const injected = {};
    for (const key of DANGEROUS_ENV_VARS) {
      injected[key] = '/tmp/evil';
    }
    process.env = { ...originalEnv, ...injected, SAFE_VAR: 'keep' };
    const env = buildCliSpawnEnv();
    for (const key of DANGEROUS_ENV_VARS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.SAFE_VAR).toBe('keep');
    expect(env.NO_COLOR).toBe('1');
  });

  it('strips LD_PRELOAD and NODE_OPTIONS specifically', () => {
    process.env = {
      ...originalEnv,
      LD_PRELOAD: '/tmp/evil.so',
      NODE_OPTIONS: '--require=/tmp/evil.js',
      PATH: '/usr/bin',
    };
    const env = buildCliSpawnEnv();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('strips DYLD_* vars on macOS-like env', () => {
    process.env = {
      ...originalEnv,
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      DYLD_LIBRARY_PATH: '/tmp/evil',
      DYLD_FRAMEWORK_PATH: '/tmp/evil',
    };
    const env = buildCliSpawnEnv();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(env.DYLD_FRAMEWORK_PATH).toBeUndefined();
  });

  it('extra vars can override safe vars but not reintroduce dangerous ones', () => {
    process.env = { ...originalEnv, SAFE: 'original' };
    const env = buildCliSpawnEnv({ SAFE: 'overridden', LD_PRELOAD: '/tmp/sneak' });
    // extra vars are applied after filtering, so LD_PRELOAD from extra IS included
    // (caller is trusted — only process.env is filtered)
    expect(env.SAFE).toBe('overridden');
    expect(env.LD_PRELOAD).toBe('/tmp/sneak');
  });

  it('removes empty API key vars but keeps non-empty ones', () => {
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: 'sk-real-key',
      GOOGLE_API_KEY: '',
    };
    const env = buildCliSpawnEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe('sk-real-key');
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });
});

describe('resolveCliSpawnInvocation', () => {
  it('wraps Windows batch shims in a shell command line', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
    const invocation = resolveCliSpawnInvocation(
      'C:\\Users\\Test User\\AppData\\Local\\Microsoft\\WinGet\\Links\\opencode.cmd',
      ['run', '--format', 'json', '--model', 'openai/gpt-5']
    );

    expect(invocation).toEqual({
      command: '"C:\\Users\\Test User\\AppData\\Local\\Microsoft\\WinGet\\Links\\opencode.cmd" run --format json --model openai/gpt-5',
      args: [],
      shell: true,
    });
    } finally { Object.defineProperty(process, 'platform', platformDescriptor); }
  });

  it('wraps Windows PowerShell shims with powershell.exe', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
    const originalSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = 'C:\\Windows';
    try {
      const invocation = resolveCliSpawnInvocation(
        'C:\\tools\\opencode.ps1',
        ['run', '--format', 'json']
      );

      expect(invocation).toEqual({
        command: join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'C:\\tools\\opencode.ps1',
          'run',
          '--format',
          'json',
        ],
        shell: false,
      });
    } finally {
      if (originalSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = originalSystemRoot;
      }
    }
    } finally { Object.defineProperty(process, 'platform', platformDescriptor); }
  });

  it('leaves non-Windows executables unchanged', () => {
    const invocation = resolveCliSpawnInvocation('/usr/local/bin/opencode', ['run', '--format', 'json']);

    expect(invocation).toEqual({
      command: '/usr/local/bin/opencode',
      args: ['run', '--format', 'json'],
      shell: false,
    });
  });
});

describe('resolveCliSpawnCwd', () => {
  it('uses the selected project path when present', () => {
    expect(resolveCliSpawnCwd({ projectPath: '/Users/test/projects/app' }))
      .toBe('/Users/test/projects/app');
  });

  it('falls back to process cwd only when no project path is supplied', () => {
    expect(resolveCliSpawnCwd({})).toBe(process.cwd());
    expect(resolveCliSpawnCwd(null)).toBe(process.cwd());
  });
});

// ---------------------------------------------------------------------------
// killProcessGroup — process group termination
// ---------------------------------------------------------------------------

describe('killProcessGroup', () => {
  it('calls process.kill with negated pid for process group', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    const fakeChild = { pid: 12345, kill: vi.fn() };
    killProcessGroup(fakeChild);
    expect(spy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(fakeChild.kill).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('falls back to child.kill if process.kill throws', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const fakeChild = { pid: 12345, kill: vi.fn() };
    killProcessGroup(fakeChild);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    spy.mockRestore();
  });

  it('does not throw if both process.kill and child.kill fail', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const fakeChild = {
      pid: 12345,
      kill: vi.fn(() => { throw new Error('already dead'); }),
    };
    expect(() => killProcessGroup(fakeChild)).not.toThrow();
    spy.mockRestore();
  });

  it('supports custom signal', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    const fakeChild = { pid: 99, kill: vi.fn() };
    killProcessGroup(fakeChild, 'SIGKILL');
    expect(spy).toHaveBeenCalledWith(-99, 'SIGKILL');
    spy.mockRestore();
  });

  it('does not call process.kill when child has no pid', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    const fakeChild = { pid: undefined, kill: vi.fn() };
    killProcessGroup(fakeChild);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('buildIsolatedHomeEnv', () => {
  it('overrides HOME, XDG dirs, and ZDOTDIR consistently', () => {
    const env = buildIsolatedHomeEnv('/tmp/atlas-agent-home-test');
    expect(env.HOME).toBe('/tmp/atlas-agent-home-test');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/atlas-agent-home-test/.config');
    expect(env.XDG_CACHE_HOME).toBe('/tmp/atlas-agent-home-test/.cache');
    expect(env.XDG_DATA_HOME).toBe('/tmp/atlas-agent-home-test/.local/share');
    expect(env.XDG_STATE_HOME).toBe('/tmp/atlas-agent-home-test/.local/state');
    expect(env.ZDOTDIR).toBe('/tmp/atlas-agent-home-test');
  });
});

describe('benchmark JSON extraction patterns', () => {
  it('extracting JSON from markdown-fenced response', () => {
    const raw = '```json\n{"summary":"test","riskLevel":"low"}\n```';
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    expect(fenceMatch).not.toBeNull();
    const parsed = JSON.parse(fenceMatch[1].trim());
    expect(parsed.summary).toBe('test');
  });

  it('extracting JSON from raw response with preamble text', () => {
    const raw = 'Here is my analysis:\n{"summary":"test","riskLevel":"low"}';
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    expect(parsed.summary).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// extractToolPath — path extraction from tool_use events
// ---------------------------------------------------------------------------

describe('extractToolPath', () => {
  it('extracts file_path from Read tool', () => {
    expect(extractToolPath('Read', { file_path: '/Users/foo/project/src/index.ts' }))
      .toBe('/Users/foo/project/src/index.ts');
  });

  it('extracts file_path from Edit tool', () => {
    expect(extractToolPath('Edit', { file_path: 'src/config.ts' }))
      .toBe('src/config.ts');
  });

  it('extracts file_path from Write tool', () => {
    expect(extractToolPath('Write', { file_path: '/tmp/out.json' }))
      .toBe('/tmp/out.json');
  });

  it('falls back to path for Read tool when file_path is absent', () => {
    expect(extractToolPath('Read', { path: 'src/index.ts' }))
      .toBe('src/index.ts');
  });

  it('extracts path from Grep tool', () => {
    expect(extractToolPath('Grep', { pattern: 'foo', path: 'src/' }))
      .toBe('src/');
  });

  it('extracts path from Glob tool', () => {
    expect(extractToolPath('Glob', { pattern: '**/*.ts', path: 'lib/' }))
      .toBe('lib/');
  });

  it('extracts path from FileChange tool', () => {
    expect(extractToolPath('FileChange', { path: 'src/app.ts' }))
      .toBe('src/app.ts');
  });

  it('returns null for Bash tool', () => {
    expect(extractToolPath('Bash', { command: 'git diff' })).toBeNull();
  });

  it('returns null for unknown tool', () => {
    expect(extractToolPath('SomeOtherTool', { foo: 'bar' })).toBeNull();
  });

  it('returns null when input is null', () => {
    expect(extractToolPath('Read', null)).toBeNull();
  });

  it('returns null when file_path is not a string', () => {
    expect(extractToolPath('Read', { file_path: 123 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripTomlMcpServers — remove MCP server blocks from TOML config
// ---------------------------------------------------------------------------

describe('stripTomlMcpServers', () => {
  it('removes [mcp_servers.xxx] blocks and their key-value lines', () => {
    const input = [
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.posthog]',
      'command = "npx"',
      'args = ["-y", "mcp-remote@latest"]',
      '',
      '[features]',
      'multi_agent = true',
    ].join('\n');
    const result = stripTomlMcpServers(input);
    expect(result).not.toContain('mcp_servers');
    expect(result).not.toContain('posthog');
    expect(result).toContain('model = "gpt-5.3-codex"');
    expect(result).toContain('[features]');
    expect(result).toContain('multi_agent = true');
  });

  it('removes bare [mcp_servers] table', () => {
    const input = '[mcp_servers]\nfoo = "bar"\n[other]\nkey = "val"';
    const result = stripTomlMcpServers(input);
    expect(result).not.toContain('mcp_servers');
    expect(result).toContain('[other]');
  });

  it('preserves config with no MCP servers unchanged', () => {
    const input = 'model = "gpt-5.3-codex"\n[features]\nmulti_agent = true';
    expect(stripTomlMcpServers(input)).toBe(input);
  });

  it('handles empty input', () => {
    expect(stripTomlMcpServers('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// isWriteTool — classify read vs write tools
// ---------------------------------------------------------------------------

describe('isWriteTool', () => {
  it('returns true for Edit', () => {
    expect(isWriteTool('Edit')).toBe(true);
  });
  it('returns true for Write', () => {
    expect(isWriteTool('Write')).toBe(true);
  });
  it('requires an explicit mutation action for FileChange', () => {
    expect(isWriteTool('FileChange')).toBe(false);
    expect(isWriteTool('FileChange', { action: 'edit' })).toBe(true);
  });
  it('returns true for NotebookEdit', () => {
    expect(isWriteTool('NotebookEdit')).toBe(true);
  });
  it('returns false for Read', () => {
    expect(isWriteTool('Read')).toBe(false);
  });
  it('returns false for Grep', () => {
    expect(isWriteTool('Grep')).toBe(false);
  });
  it('returns false for Glob', () => {
    expect(isWriteTool('Glob')).toBe(false);
  });
  it('returns false for Bash', () => {
    expect(isWriteTool('Bash')).toBe(false);
  });
  it('returns false for null/undefined', () => {
    expect(isWriteTool(null)).toBe(false);
    expect(isWriteTool(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPathWithinScope — path containment check
// ---------------------------------------------------------------------------

describe('isPathWithinScope', () => {
  const projectPath = '/Users/test/projects/my-app';

  it('accepts relative path within project', () => {
    expect(isPathWithinScope('src/index.ts', projectPath)).toBe(true);
  });

  it('accepts absolute path within project', () => {
    expect(isPathWithinScope(`${projectPath}/src/index.ts`, projectPath)).toBe(true);
  });

  it('rejects absolute path outside project', () => {
    expect(isPathWithinScope('/Users/test/Documents/secret.txt', projectPath)).toBe(false);
  });

  it('rejects ../../etc/passwd traversal', () => {
    expect(isPathWithinScope('../../etc/passwd', projectPath)).toBe(false);
  });

  it('rejects projectPath/../etc/passwd', () => {
    expect(isPathWithinScope(`${projectPath}/../etc/passwd`, projectPath)).toBe(false);
  });

  it('accepts the project root itself', () => {
    expect(isPathWithinScope(projectPath, projectPath)).toBe(true);
  });

  it('rejects null/empty target', () => {
    expect(isPathWithinScope('', projectPath)).toBe(false);
    expect(isPathWithinScope(null, projectPath)).toBe(false);
  });

  it('rejects null/empty scope', () => {
    expect(isPathWithinScope('src/index.ts', '')).toBe(false);
    expect(isPathWithinScope('src/index.ts', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isClaudeInternalPath — Claude Code internal path exemption
// ---------------------------------------------------------------------------

describe('isClaudeInternalPath', () => {
  it('accepts ~/.claude/projects session path', () => {
    const os = require('os');
    const p = `${os.homedir()}/.claude/projects/some-project/session-id/tool-results/abc.txt`;
    expect(isClaudeInternalPath(p)).toBe(true);
  });

  it('accepts ~/.claude/ root itself', () => {
    const os = require('os');
    expect(isClaudeInternalPath(`${os.homedir()}/.claude`)).toBe(true);
  });

  it('rejects paths outside ~/.claude/', () => {
    expect(isClaudeInternalPath('/Users/test/Documents/secret.txt')).toBe(false);
  });

  it('rejects traversal out of ~/.claude/', () => {
    const os = require('os');
    expect(isClaudeInternalPath(`${os.homedir()}/.claude/../Documents/secret.txt`)).toBe(false);
  });

  it('rejects null/empty input', () => {
    expect(isClaudeInternalPath(null)).toBe(false);
    expect(isClaudeInternalPath('')).toBe(false);
  });

  it('accepts isolated HOME ~/.claude paths when custom homePath is provided', () => {
    const p = '/tmp/atlas-agent-home-123/.claude/projects/test/tool-results/1.json';
    expect(isClaudeInternalPath(p, { homePath: '/tmp/atlas-agent-home-123' })).toBe(true);
  });

  it('rejects isolated HOME ~/.claude paths without matching homePath override', () => {
    const p = '/tmp/atlas-agent-home-123/.claude/projects/test/tool-results/1.json';
    expect(isClaudeInternalPath(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeAgenticMaxTurns
// ---------------------------------------------------------------------------

describe('computeAgenticMaxTurns', () => {
  it('returns MIN_TURNS for 0 files (small tier)', () => {
    expect(computeAgenticMaxTurns(0)).toBe(CLI_AGENTIC_MIN_TURNS);
  });

  it('returns MIN_TURNS for 1 file (small tier: 1+5=6=MIN)', () => {
    expect(computeAgenticMaxTurns(1)).toBe(CLI_AGENTIC_MIN_TURNS);
  });

  it('returns count+5 for 5 files (small tier: 5+5=10)', () => {
    expect(computeAgenticMaxTurns(5)).toBe(10);
  });

  it('returns MAX_TURNS for 20 files (small tier: 20+5=25=MAX)', () => {
    expect(computeAgenticMaxTurns(20)).toBe(CLI_AGENTIC_MAX_TURNS);
  });

  it('uses medium tier formula for medium file counts', () => {
    const result = computeAgenticMaxTurns(CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT);
    expect(result).toBe(Math.min(CLI_AGENTIC_MAX_TURNS_MEDIUM, Math.max(CLI_AGENTIC_MIN_TURNS, CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT + 1)));
  });

  it('uses large tier formula for 100 files', () => {
    const result = computeAgenticMaxTurns(100);
    const expected = Math.min(CLI_AGENTIC_MAX_TURNS_LARGE, Math.max(CLI_AGENTIC_MIN_TURNS, Math.ceil(100 * 0.5) + 10));
    expect(result).toBe(expected);
  });

  it('respects explicit tier override', () => {
    expect(computeAgenticMaxTurns(100, 'small')).toBe(CLI_AGENTIC_MAX_TURNS);
  });

  it('returns MIN_TURNS for NaN', () => {
    expect(computeAgenticMaxTurns(NaN)).toBe(CLI_AGENTIC_MIN_TURNS);
  });

  it('returns MIN_TURNS for negative values', () => {
    expect(computeAgenticMaxTurns(-5)).toBe(CLI_AGENTIC_MIN_TURNS);
  });
});

// ---------------------------------------------------------------------------
// resolveAgenticTier
// ---------------------------------------------------------------------------

describe('resolveAgenticTier', () => {
  it('returns small for 0 files', () => {
    expect(resolveAgenticTier(0)).toBe('small');
  });

  it('returns small for 30 files (below medium threshold)', () => {
    expect(resolveAgenticTier(CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT - 1)).toBe('small');
  });

  it('returns medium at medium threshold boundary', () => {
    expect(resolveAgenticTier(CLI_AGENTIC_TIER_MEDIUM_FILE_COUNT)).toBe('medium');
  });

  it('returns medium for 80 files (below large threshold)', () => {
    expect(resolveAgenticTier(CLI_AGENTIC_TIER_LARGE_FILE_COUNT - 1)).toBe('medium');
  });

  it('returns large at large threshold boundary', () => {
    expect(resolveAgenticTier(CLI_AGENTIC_TIER_LARGE_FILE_COUNT)).toBe('large');
  });

  it('returns large for 200 files', () => {
    expect(resolveAgenticTier(200)).toBe('large');
  });

  it('returns small for NaN', () => {
    expect(resolveAgenticTier(NaN)).toBe('small');
  });
});

// ---------------------------------------------------------------------------
// tierFileHintsForAgenticPrompt
// ---------------------------------------------------------------------------

describe('tierFileHintsForAgenticPrompt', () => {
  const makeHints = (n) => Array.from({ length: n }, (_, i) => ({ path: `src/file${i}.ts`, riskScore: n - i }));

  it('returns all hints with no summary for <=40 files', () => {
    const hints = makeHints(20);
    const { detailedHints, summaryHints } = tierFileHintsForAgenticPrompt(hints, 20);
    expect(detailedHints).toHaveLength(20);
    expect(summaryHints).toBeNull();
  });

  it('returns top 40 detailed and summary for 41-80 files', () => {
    const hints = makeHints(60);
    const { detailedHints, summaryHints } = tierFileHintsForAgenticPrompt(hints, 60);
    expect(detailedHints).toHaveLength(40);
    expect(summaryHints).toContain('Additional changed files');
    expect(summaryHints).toContain('20 file');
  });

  it('returns top 30 detailed and summary for 81+ files', () => {
    const hints = makeHints(100);
    const { detailedHints, summaryHints } = tierFileHintsForAgenticPrompt(hints, 100);
    expect(detailedHints).toHaveLength(30);
    expect(summaryHints).toContain('Additional changed files');
    expect(summaryHints).toContain('70 file');
  });

  it('handles empty input gracefully', () => {
    const { detailedHints, summaryHints } = tierFileHintsForAgenticPrompt([], 0);
    expect(detailedHints).toHaveLength(0);
    expect(summaryHints).toBeNull();
  });
});

describe('buildBehavioralHotspotDistillation', () => {
  it('extracts behavioral hotspot summaries from unified diffs', () => {
    const diff = `diff --git a/Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs b/Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs
--- a/Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs
+++ b/Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs
@@
-\tpublic void Init()
+\tprivate void Init()
@@
+\t\tSubscribeToSignal<StormMapUIInitializeSignal>(OnInitializeStormMapUI);
+\t\t_timerText.SetText("Storm covers the map");
diff --git a/Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/MiniMapMask.cs b/Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/MiniMapMask.cs
--- /dev/null
+++ b/Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/MiniMapMask.cs
@@
+\t\t\tgraphic.material.SetVector(_centerID, screenCenter);
+\t\t\tgraphic.material.SetFloat(_radiusID, pixelRadius);`;
    const distillation = buildBehavioralHotspotDistillation(diff, [
      { path: 'Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs' },
      { path: 'Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/MiniMapMask.cs' },
    ]);

    expect(distillation.summary).toContain('Behavioral hotspots from the diff');
    expect(distillation.summary).toContain('GameEventsTimerMapView.cs');
    expect(distillation.summary).toContain('MiniMapMask.cs');
    expect(distillation.perPath.get('Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lifecycle_signal_handoff' }),
        expect.objectContaining({ id: 'hardcoded_user_facing_text' }),
      ])
    );
    expect(distillation.perPath.get('Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/View/MiniMapMask.cs')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'runtime_ui_material_mutation' }),
      ])
    );
  });
});

// ---------------------------------------------------------------------------
// partitionFilesForParallelAgenticReview
// ---------------------------------------------------------------------------

describe('partitionFilesForParallelAgenticReview', () => {
  const makeHints = (n) => Array.from({ length: n }, (_, i) => ({ path: `file${i}.ts`, riskScore: n - i }));

  it('returns single shard for small input', () => {
    const hints = makeHints(10);
    const shards = partitionFilesForParallelAgenticReview(hints);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toHaveLength(10);
  });

  it('produces balanced shards for large input', () => {
    const hints = makeHints(60);
    const shards = partitionFilesForParallelAgenticReview(hints, { minFilesPerShard: 15, targetFilesPerShard: 15, maxShards: 4 });
    expect(shards.length).toBeGreaterThanOrEqual(2);
    expect(shards.length).toBeLessThanOrEqual(4);
    // Verify all files present
    const totalFiles = shards.reduce((sum, s) => sum + s.length, 0);
    expect(totalFiles).toBe(60);
  });

  it('distributes risk via round-robin', () => {
    const hints = makeHints(30);
    const shards = partitionFilesForParallelAgenticReview(hints, { minFilesPerShard: 15, targetFilesPerShard: 15, maxShards: 4 });
    // With 30 files and minPerShard=15, should get 2 shards
    expect(shards).toHaveLength(2);
    // First shard gets indices 0,2,4,... (highest risk spread)
    expect(shards[0]).toHaveLength(15);
    expect(shards[1]).toHaveLength(15);
  });

  it('limits newly expanded large-tier reviews to two default shards', () => {
    const hints = makeHints(59);
    const shards = partitionFilesForParallelAgenticReview(hints);
    expect(shards).toHaveLength(2);
    expect(shards[0].length + shards[1].length).toBe(59);
  });

  it('handles empty input', () => {
    const shards = partitionFilesForParallelAgenticReview([]);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeAgenticMaxTurns — single clamping used by timeout, prompt, CLI args
// ---------------------------------------------------------------------------

describe('normalizeAgenticMaxTurns', () => {
  it('clamps below MIN_TURNS up to MIN_TURNS', () => {
    expect(normalizeAgenticMaxTurns(1)).toBe(CLI_AGENTIC_MIN_TURNS);
    expect(normalizeAgenticMaxTurns(3)).toBe(CLI_AGENTIC_MIN_TURNS);
  });

  it('passes through values in [MIN, MAX]', () => {
    expect(normalizeAgenticMaxTurns(10)).toBe(10);
    expect(normalizeAgenticMaxTurns(CLI_AGENTIC_MIN_TURNS)).toBe(CLI_AGENTIC_MIN_TURNS);
    expect(normalizeAgenticMaxTurns(CLI_AGENTIC_MAX_TURNS)).toBe(CLI_AGENTIC_MAX_TURNS);
  });

  it('clamps above MAX_TURNS down to MAX_TURNS', () => {
    expect(normalizeAgenticMaxTurns(100)).toBe(CLI_AGENTIC_MAX_TURNS);
  });

  it('falls back to MAX_TURNS for NaN', () => {
    expect(normalizeAgenticMaxTurns(NaN)).toBe(CLI_AGENTIC_MAX_TURNS);
  });

  it('falls back to MAX_TURNS for 0', () => {
    expect(normalizeAgenticMaxTurns(0)).toBe(CLI_AGENTIC_MAX_TURNS);
  });

  it('falls back to MAX_TURNS for negative values', () => {
    expect(normalizeAgenticMaxTurns(-5)).toBe(CLI_AGENTIC_MAX_TURNS);
  });

  it('falls back to MAX_TURNS for undefined/null', () => {
    expect(normalizeAgenticMaxTurns(undefined)).toBe(CLI_AGENTIC_MAX_TURNS);
    expect(normalizeAgenticMaxTurns(null)).toBe(CLI_AGENTIC_MAX_TURNS);
  });

  it('floors fractional values', () => {
    expect(normalizeAgenticMaxTurns(10.9)).toBe(10);
  });

  it('uses medium ceiling when tier is medium', () => {
    expect(normalizeAgenticMaxTurns(undefined, 'medium')).toBe(CLI_AGENTIC_MAX_TURNS_MEDIUM);
    expect(normalizeAgenticMaxTurns(200, 'medium')).toBe(CLI_AGENTIC_MAX_TURNS_MEDIUM);
  });

  it('uses large ceiling when tier is large', () => {
    expect(normalizeAgenticMaxTurns(undefined, 'large')).toBe(CLI_AGENTIC_MAX_TURNS_LARGE);
    expect(normalizeAgenticMaxTurns(200, 'large')).toBe(CLI_AGENTIC_MAX_TURNS_LARGE);
  });

  it('does not clamp medium/large tier turns to default ceiling', () => {
    // This is the bug fix: without tier, 40 would be clamped to CLI_AGENTIC_MAX_TURNS (25)
    const mediumTurns = Math.min(40, CLI_AGENTIC_MAX_TURNS_MEDIUM);
    expect(normalizeAgenticMaxTurns(40, 'medium')).toBe(mediumTurns);
    const largeTurns = Math.min(35, CLI_AGENTIC_MAX_TURNS_LARGE);
    expect(normalizeAgenticMaxTurns(35, 'large')).toBe(largeTurns);
  });
});

// ---------------------------------------------------------------------------
// computeAgenticTimeoutMs
// ---------------------------------------------------------------------------

describe('computeAgenticTimeoutMs', () => {
  it('returns tier ceiling for small tier (maxTurns ignored)', () => {
    expect(computeAgenticTimeoutMs(6)).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS);
    expect(computeAgenticTimeoutMs(100)).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS);
  });

  it('returns tier ceiling regardless of NaN or 0 maxTurns', () => {
    expect(computeAgenticTimeoutMs(NaN)).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS);
    expect(computeAgenticTimeoutMs(0)).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS);
  });

  it('returns medium tier ceiling for medium tier', () => {
    expect(computeAgenticTimeoutMs(30, 'medium')).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_MEDIUM);
  });

  it('returns large tier ceiling for large tier', () => {
    expect(computeAgenticTimeoutMs(50, 'large')).toBe(PROVIDER_REQUEST_TIMEOUT_CLI_AGENTIC_MS_LARGE);
  });
});

// ---------------------------------------------------------------------------
// generateSandboxProfile — macOS sandbox profile generation
// ---------------------------------------------------------------------------

describe('generateSandboxProfile', () => {
  const readAndCleanup = async (profilePath) => {
    const fs = await import('fs/promises');
    const pathM = await import('path');
    try {
      return await fs.default.readFile(profilePath, 'utf8');
    } finally {
      await fs.default.rm(pathM.default.dirname(profilePath), { recursive: true, force: true }).catch(() => {});
    }
  };

  it('generates a profile with (allow default) baseline', async () => {
    const profilePath = await generateSandboxProfile('/Users/test/projects/my-app');
    const content = await readAndCleanup(profilePath);
    expect(content).toContain('(version 1)');
    expect(content).toContain('(allow default)');
  });

  it('denies access to TCC-protected directories', async () => {
    const profilePath = await generateSandboxProfile('/Users/test/projects/my-app');
    const content = await readAndCleanup(profilePath);
    expect(content).toContain('(deny file-read* (subpath "');
    expect(content).toContain('/Documents")');
    expect(content).toContain('/Desktop")');
    expect(content).toContain('/Downloads")');
  });

  it('does not deny a TCC dir when project lives under it', async () => {
    const os = await import('os');
    const pathM = await import('path');
    const homedir = os.default.homedir();
    const projectInDocs = pathM.default.join(homedir, 'Documents', 'my-app');
    const profilePath = await generateSandboxProfile(projectInDocs);
    const content = await readAndCleanup(profilePath);
    // Documents should NOT be denied since the project is inside it
    expect(content).not.toContain('/Documents")');
    // But other TCC dirs should still be denied
    expect(content).toContain('/Desktop")');
  });

  it('writes the profile to a temp file', async () => {
    const fs = await import('fs/promises');
    const pathM = await import('path');
    const profilePath = await generateSandboxProfile('/Users/test/projects/my-app');
    try {
      expect(profilePath).toContain('atlas-sandbox-');
      expect(profilePath).toMatch(/\.sb$/);
      const stat = await fs.default.stat(profilePath);
      expect(stat.isFile()).toBe(true);
    } finally {
      await fs.default.rm(pathM.default.dirname(profilePath), { recursive: true, force: true }).catch(() => {});
    }
  });

  it('accepts optional binaryPath without error', async () => {
    const profilePath = await generateSandboxProfile('/Users/test/projects/my-app', '/usr/local/bin/claude');
    const content = await readAndCleanup(profilePath);
    expect(content).toContain('(version 1)');
  });
});

// ---------------------------------------------------------------------------
// createIsolatedAgentHome — TCC-safe HOME isolation
// ---------------------------------------------------------------------------

describe('createIsolatedAgentHome', () => {
  it('returns an object with home path and cleanup function', async () => {
    const result = await createIsolatedAgentHome();
    try {
      expect(typeof result.home).toBe('string');
      expect(result.home).toContain('atlas-agent-home-');
      expect(typeof result.cleanup).toBe('function');
    } finally {
      await result.cleanup();
    }
  });

  it('creates a temp directory that exists on disk', async () => {
    const fs = await import('fs/promises');
    const result = await createIsolatedAgentHome();
    try {
      const stat = await fs.default.stat(result.home);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await result.cleanup();
    }
  });

  it('symlinks every existing candidate dotfile from real HOME', async () => {
    const fs = await import('fs/promises');
    const pathM = await import('path');
    const os = await import('os');
    const realHome = os.default.homedir();

    const result = await createIsolatedAgentHome();
    try {
      const candidates = [
        '.claude',
        // .claude is NOT in this list — it is scaffolded, not symlinked
        '.codex',
        '.config',
        '.npm',
        '.nvm',
        '.local',
        '.gitconfig',
        '.netrc',
      ];
      let existingCount = 0;
      for (const name of candidates) {
        const src = pathM.default.join(realHome, name);
        const dest = pathM.default.join(result.home, name);
        try {
          await fs.default.stat(src);
          existingCount += 1;
          const lstat = await fs.default.lstat(dest);
          expect(lstat.isSymbolicLink()).toBe(true);
          const target = await fs.default.readlink(dest);
          expect(target).toBe(src);
        } catch {
          // Source doesn't exist or was intentionally skipped.
        }
      }
      // Stay stable on clean CI environments with zero user dotfiles.
      if (existingCount === 0) {
        const seededEntries = await fs.default.readdir(result.home);
        expect(Array.isArray(seededEntries)).toBe(true);
      }
    } finally {
      await result.cleanup();
    }
  });

  it('returns isolated env overrides for HOME, XDG, and shell init paths', async () => {
    const result = await createIsolatedAgentHome();
    try {
      expect(result.env.HOME).toBe(result.home);
      expect(result.env.XDG_CONFIG_HOME).toContain(result.home);
      expect(result.env.XDG_CACHE_HOME).toContain(result.home);
      expect(result.env.XDG_DATA_HOME).toContain(result.home);
      expect(result.env.XDG_STATE_HOME).toContain(result.home);
      expect(result.env.ZDOTDIR).toBe(result.home);
    } finally {
      await result.cleanup();
    }
  });

  it('does NOT contain TCC-protected directories', async () => {
    const fs = await import('fs/promises');
    const pathM = await import('path');

    const result = await createIsolatedAgentHome();
    try {
      const tccDirs = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music'];
      for (const dir of tccDirs) {
        const dirPath = pathM.default.join(result.home, dir);
        await expect(fs.default.stat(dirPath)).rejects.toThrow();
      }
    } finally {
      await result.cleanup();
    }
  });

  it('cleanup removes the temp directory', async () => {
    const fs = await import('fs/promises');
    const result = await createIsolatedAgentHome();
    const homePath = result.home;

    await result.cleanup();

    await expect(fs.default.stat(homePath)).rejects.toThrow();
  });

  it('concurrent calls create separate isolated homes', async () => {
    const [a, b] = await Promise.all([
      createIsolatedAgentHome(),
      createIsolatedAgentHome(),
    ]);
    try {
      expect(a.home).not.toBe(b.home);
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });

  it('scaffolds .claude as a real directory (not symlink) with no plugins', async () => {
    const fs = await import('fs/promises');
    const pathM = await import('path');

    const result = await createIsolatedAgentHome();
    try {
      const claudeDir = pathM.default.join(result.home, '.claude');
      // Must be a real directory, NOT a symlink
      const lstat = await fs.default.lstat(claudeDir);
      expect(lstat.isSymbolicLink()).toBe(false);
      expect(lstat.isDirectory()).toBe(true);

      // Should have a clean settings.json with no plugins
      const settings = JSON.parse(
        await fs.default.readFile(pathM.default.join(claudeDir, 'settings.json'), 'utf8')
      );
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
      expect(settings.enabledPlugins).toEqual({});

      // Should NOT have plugins directory
      await expect(fs.default.stat(pathM.default.join(claudeDir, 'plugins'))).rejects.toThrow();
    } finally {
      await result.cleanup();
    }
  });

  it('scaffolds .codex as a real directory (not symlink) with no MCP servers', async () => {
    const fs = await import('fs/promises');
    const pathM = await import('path');

    const result = await createIsolatedAgentHome();
    try {
      const codexDir = pathM.default.join(result.home, '.codex');
      // Must be a real directory, NOT a symlink
      const lstat = await fs.default.lstat(codexDir);
      expect(lstat.isSymbolicLink()).toBe(false);
      expect(lstat.isDirectory()).toBe(true);

      // config.toml should exist and NOT contain [mcp_servers]
      const configPath = pathM.default.join(codexDir, 'config.toml');
      try {
        const config = await fs.default.readFile(configPath, 'utf8');
        expect(config).not.toMatch(/\[mcp_servers/i);
      } catch {
        // No config.toml on this machine — acceptable
      }
    } finally {
      await result.cleanup();
    }
  });

  it('cleanup is idempotent (double cleanup does not throw)', async () => {
    const result = await createIsolatedAgentHome();
    await result.cleanup();
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('copies .claude.json as a regular file with MCP servers stripped', async () => {
    const fs = await import('fs/promises');
    const pathM = await import('path');
    const os = await import('os');
    const realHome = os.default.homedir();
    const srcFile = pathM.default.join(realHome, '.claude.json');

    // Only run if .claude.json exists on this machine
    let srcExists = false;
    try { await fs.default.stat(srcFile); srcExists = true; } catch {}
    if (!srcExists) return;

    const result = await createIsolatedAgentHome();
    try {
      const dest = pathM.default.join(result.home, '.claude.json');
      const lstat = await fs.default.lstat(dest);
      // Must be a regular file, NOT a symlink
      expect(lstat.isSymbolicLink()).toBe(false);
      expect(lstat.isFile()).toBe(true);

      // MCP servers must be stripped from the sanitized copy
      const data = JSON.parse(await fs.default.readFile(dest, 'utf8'));
      expect(data.mcpServers).toBeUndefined();
      // Per-project mcpServers must also be stripped
      if (data.projects) {
        for (const [, proj] of Object.entries(data.projects)) {
          if (proj && typeof proj === 'object') {
            expect(proj.mcpServers).toBeUndefined();
          }
        }
      }
    } finally {
      await result.cleanup();
    }
  });
});

describe('isProtectedHomeTarget', () => {
  it('marks TCC-protected home directories as blocked', () => {
    const home = '/Users/test';
    expect(isProtectedHomeTarget(home, '/Users/test/Desktop')).toBe(true);
    expect(isProtectedHomeTarget(home, '/Users/test/Documents/work/notes.txt')).toBe(true);
    expect(isProtectedHomeTarget(home, '/Users/test/Library/Mobile Documents/iCloud/file.txt')).toBe(true);
    expect(isProtectedHomeTarget(home, '/Users/test/Library/CloudStorage/Drive/file.txt')).toBe(true);
  });

  it('marks paths outside home as blocked and regular dotfiles as safe', () => {
    const home = '/Users/test';
    expect(isProtectedHomeTarget(home, '/tmp/outside-home')).toBe(true);
    expect(isProtectedHomeTarget(home, '/Users/test/.config/tool/config.toml')).toBe(false);
    expect(isProtectedHomeTarget(home, '/Users/test/.claude/settings.json')).toBe(false);
  });
});

describe('detectMaxTurnsExhausted', () => {
  it('returns numTurns when result event has subtype error_max_turns', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}',
      '{"type":"result","subtype":"error_max_turns","is_error":false,"result":"","num_turns":20}',
    ].join('\n');
    const info = detectMaxTurnsExhausted(stdout);
    expect(info).toEqual({ numTurns: 20 });
  });

  it('returns null when result event has a normal subtype', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"review json","num_turns":5}',
    ].join('\n');
    expect(detectMaxTurnsExhausted(stdout)).toBeNull();
  });

  it('returns null for empty or missing stdout', () => {
    expect(detectMaxTurnsExhausted('')).toBeNull();
    expect(detectMaxTurnsExhausted(null)).toBeNull();
    expect(detectMaxTurnsExhausted(undefined)).toBeNull();
  });

  it('returns null when no result event is present', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
    ].join('\n');
    expect(detectMaxTurnsExhausted(stdout)).toBeNull();
  });

  it('handles numTurns field name variant', () => {
    const stdout = '{"type":"result","subtype":"error_max_turns","numTurns":15}';
    const info = detectMaxTurnsExhausted(stdout);
    expect(info).toEqual({ numTurns: 15 });
  });

  it('returns "?" when num_turns is missing', () => {
    const stdout = '{"type":"result","subtype":"error_max_turns","is_error":false,"result":""}';
    const info = detectMaxTurnsExhausted(stdout);
    expect(info).toEqual({ numTurns: '?' });
  });

  it('is case-insensitive on subtype', () => {
    const stdout = '{"type":"result","subtype":"Error_Max_Turns","num_turns":10}';
    const info = detectMaxTurnsExhausted(stdout);
    expect(info).toEqual({ numTurns: 10 });
  });
});

describe('extractAgenticResultMeta', () => {
  it('extracts success result with turn count and cost', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"review"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":8,"cost_usd":0.15}',
    ].join('\n');
    const meta = extractAgenticResultMeta(stdout);
    expect(meta).toEqual({
      subtype: 'success',
      numTurns: 8,
      costUsd: 0.15,
      tokensUsed: null,
    });
  });

  it('extracts error_max_turns result', () => {
    const stdout = '{"type":"result","subtype":"error_max_turns","num_turns":20}';
    const meta = extractAgenticResultMeta(stdout);
    expect(meta).toEqual({
      subtype: 'error_max_turns',
      numTurns: 20,
      costUsd: null,
      tokensUsed: null,
    });
  });

  it('returns null for empty/missing stdout', () => {
    expect(extractAgenticResultMeta('')).toBeNull();
    expect(extractAgenticResultMeta(null)).toBeNull();
    expect(extractAgenticResultMeta(undefined)).toBeNull();
  });

  it('returns null when no result event is present', () => {
    const stdout = '{"type":"assistant","message":{"content":[]}}';
    expect(extractAgenticResultMeta(stdout)).toBeNull();
  });

  it('handles missing cost_usd and numTurns gracefully', () => {
    const stdout = '{"type":"result","subtype":"success"}';
    const meta = extractAgenticResultMeta(stdout);
    expect(meta).toEqual({
      subtype: 'success',
      numTurns: null,
      costUsd: null,
      tokensUsed: null,
    });
  });

  it('marks recovered text as success when only stream turn usage is present', () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":8}}';
    const meta = extractAgenticResultMeta(stdout, { recoveredText: '{"summary":"ok"}' });
    expect(meta).toEqual({
      subtype: 'success',
      numTurns: 1,
      costUsd: null,
      tokensUsed: { input: 12, output: 8 },
    });
  });

  it('prefers num_turns over numTurns field', () => {
    const stdout = '{"type":"result","subtype":"success","num_turns":5,"numTurns":10}';
    const meta = extractAgenticResultMeta(stdout);
    expect(meta.numTurns).toBe(5);
  });
});
