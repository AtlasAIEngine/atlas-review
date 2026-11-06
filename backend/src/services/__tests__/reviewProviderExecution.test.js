import { describe, expect, it } from 'vitest';

import {
  buildClaudeCliPipeArgs,
  resolveClaudeCliModelArg,
  classifyCliAgenticExitError,
  classifyCliRuntimeTextError,
  extractClaudeCliPipeResultMeta,
  extractAgenticResultMeta,
  resolveProviderTimeoutForExecutionAttempt,
  resolveOpenAICliFallbackModel,
  shouldRetryGoogleCliWithFallback,
  shouldRetryOpenAICliWithFallback,
  detectCliRuntimeNoise,
  stripCliRuntimeNoise,
  formatCliErrorDetail,
  shouldClearStaleClaudeTokenForRetry,
} from '../review/reviewProviderExecution.js';
import { createReviewRuntimeError } from '../review/reviewErrorClassification.js';

describe('reviewProviderExecution Google CLI fallback helpers', () => {
  it('forces Claude cli-pipe into single-turn no-tools mode', () => {
    expect(buildClaudeCliPipeArgs(['claude'], 'claude-sonnet-5-5')).toEqual([
      'claude',
      '-p', '-',
      '--output-format', 'json',
      '--max-turns', '1',
      '--tools', '',
      '--model', 'sonnet',
    ]);
  });

  it('normalizes Claude full model ids to CLI aliases for pipe mode', () => {
    expect(resolveClaudeCliModelArg('claude-opus-5-5')).toBe('opus');
    expect(resolveClaudeCliModelArg('claude-sonnet-5-5')).toBe('sonnet');
    expect(resolveClaudeCliModelArg('claude-haiku-5-5')).toBe('haiku');
    expect(resolveClaudeCliModelArg('sonnet')).toBe('sonnet');
    expect(resolveClaudeCliModelArg('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
    expect(resolveClaudeCliModelArg('claude-sonnet-experimental-foo')).toBe('claude-sonnet-experimental-foo');
    expect(resolveClaudeCliModelArg('custom-claude-model')).toBe('custom-claude-model');
  });

  it('extracts usage and cost from Claude cli-pipe JSON results when present', () => {
    const meta = extractClaudeCliPipeResultMeta({
      result: 'ok',
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        output_tokens: 34,
      },
      cost_usd: 0.0042,
    });

    expect(meta).toEqual({
      tokensUsed: { input: 312, output: 34 },
      costUsd: 0.0042,
    });
  });

  it('keeps Claude cli-pipe usage absent when JSON results omit telemetry', () => {
    const meta = extractClaudeCliPipeResultMeta({ result: 'ok' });

    expect(meta).toEqual({
      tokensUsed: { input: 0, output: 0 },
      costUsd: null,
    });
  });

  it('classifies Claude not-logged-in result text as an auth error', () => {
    const error = classifyCliRuntimeTextError(
      'anthropic',
      'Not logged in · Please run /login',
    );

    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('auth');
    expect(error.message).toContain('claude login');
  });

  it('classifies Claude agentic JSON error output as an auth error', () => {
    const rawClaudeJson = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      session_id: 'session-test',
    });

    const error = classifyCliAgenticExitError('anthropic', 1, '', rawClaudeJson);

    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('auth');
    expect(error.message).toContain('claude login');
  });

  it('classifies a Claude API authentication_error envelope as an auth error, not a malformed review', () => {
    const rawClaudeJson = JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid authentication credentials' },
      request_id: 'req_011CavmGdcRSm11bnnxSkLSx',
    });

    const error = classifyCliRuntimeTextError('anthropic', rawClaudeJson);

    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('auth');
    expect(error.message).toContain('claude login');
    expect(error.message).not.toContain('without review content');
  });

  it('classifies a Claude invalid x-api-key envelope as an auth error', () => {
    const rawClaudeJson = JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    });

    const error = classifyCliRuntimeTextError('anthropic', rawClaudeJson);

    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('auth');
  });

  it('does not classify plain output that merely mentions "unauthorized" as an auth error', () => {
    // Regression guard: bare `unauthorized` substring matching false-positives
    // on diff/code content surfaced as the raw CLI output.
    const error = classifyCliRuntimeTextError(
      'anthropic',
      'The patch adds a guard that returns 403 for unauthorized callers in authMiddleware.js',
    );
    expect(error?.runtimeCode).not.toBe('auth');
  });

  it('still classifies an HTTP 401 Unauthorized message as an auth error', () => {
    const error = classifyCliRuntimeTextError('anthropic', 'request failed: 401 Unauthorized');
    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('auth');
  });

  it('uses stderr from failed Claude agentic exits instead of reporting empty stdout', () => {
    const error = classifyCliAgenticExitError(
      'anthropic',
      1,
      'Simulated Claude review failure from repro harness',
      '',
    );

    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('invalid_request');
    expect(error.message).toContain('Simulated Claude review failure');
    expect(error.message).not.toContain('empty response');
  });

  it('classifies Claude credit exhaustion from agentic stderr as quota', () => {
    const error = classifyCliAgenticExitError(
      'anthropic',
      1,
      'Error: Credit balance is too low to access the Anthropic API. Purchase credits to continue.',
      JSON.stringify({
        service_tier: 'standard',
        terminal_reason: 'completed',
        request_id: 'req_123',
      }),
    );

    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('quota');
    expect(error.message).toContain('Claude CLI credits or quota are exhausted');
    expect(error.message).not.toContain('service_tier');
  });

  it('classifies Claude JSONL credit errors as quota', () => {
    const error = classifyCliAgenticExitError(
      'anthropic',
      1,
      '',
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Credit balance is too low to access the Anthropic API.',
      }),
    );

    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('quota');
    expect(error.message).toContain('Anthropic Console billing');
  });

  it('does not surface raw Claude system init JSON when no review content is returned', () => {
    const error = classifyCliAgenticExitError(
      'anthropic',
      1,
      '',
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/Users/test/project',
        session_id: 'session-test',
        tools: ['Task', 'Bash', 'Read'],
        model: 'claude-sonnet-5-5',
      }),
    );

    expect(error).toBeTruthy();
    expect(error.runtimeCode).toBe('invalid_request');
    expect(error.message).toContain('Claude CLI started but exited before returning a review');
    expect(error.message).toContain('claude doctor');
    expect(error.message).not.toContain('"type":"system"');
    expect(error.message).not.toContain('session-test');
  });

  it('retries only for specific model-unavailable error phrases', () => {
    const unavailableError = createReviewRuntimeError(
      'Provider request was rejected. Model not found: gemini-3.1-pro-preview',
      'invalid_request',
    );
    const overloadedError = createReviewRuntimeError(
      'The selected model is currently overloaded. Try again later.',
      'invalid_request',
    );
    const unrelatedNotFoundError = createReviewRuntimeError(
      'Request failed: review profile not found for this account.',
      'invalid_request',
    );
    const genericRejectedError = createReviewRuntimeError(
      'Provider request was rejected due to billing status.',
      'invalid_request',
    );
    const modelSpecificRejectedError = createReviewRuntimeError(
      'Provider request was rejected because model is not supported: gemini-3.1-pro-preview',
      'invalid_request',
    );

    expect(
      shouldRetryGoogleCliWithFallback(
        unavailableError,
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
      ),
    ).toBe(true);
    expect(
      shouldRetryGoogleCliWithFallback(
        overloadedError,
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
      ),
    ).toBe(false);
    expect(
      shouldRetryGoogleCliWithFallback(
        unrelatedNotFoundError,
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
      ),
    ).toBe(false);
    expect(
      shouldRetryGoogleCliWithFallback(
        genericRejectedError,
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
      ),
    ).toBe(false);
    expect(
      shouldRetryGoogleCliWithFallback(
        modelSpecificRejectedError,
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
      ),
    ).toBe(true);
  });

  it('retries OpenAI CLI fallback when the selected model is not enabled', () => {
    const unavailableError = createReviewRuntimeError(
      'Provider request was rejected. Selected model is not enabled for this account.',
      'model_unavailable',
    );

    expect(
      shouldRetryOpenAICliWithFallback(
        unavailableError,
        'gpt-5.4',
        'gpt-5.5',
      ),
    ).toBe(true);
  });

  it('retries OpenAI CLI fallback when Codex writes no final agent message', () => {
    const emptyAgentMessageError = createReviewRuntimeError(
      'Codex CLI error (exit 1): Warning: no last agent message; wrote empty content to /tmp/output.txt',
      'invalid_request',
    );

    expect(
      shouldRetryOpenAICliWithFallback(
        emptyAgentMessageError,
        'gpt-5.5',
        'gpt-5.4',
      ),
    ).toBe(true);
  });

  it('resolves an alternate OpenAI CLI fallback model', () => {
    expect(resolveOpenAICliFallbackModel('gpt-5.5')).toBe('gpt-5.3-codex');
    expect(resolveOpenAICliFallbackModel('gpt-5.4')).toBe('gpt-5.3-codex');
    expect(resolveOpenAICliFallbackModel('gpt-5.4-mini')).toBe('gpt-5.3-codex');
    expect(resolveOpenAICliFallbackModel('gpt-5.4-nano')).toBe('gpt-5.3-codex');
    expect(resolveOpenAICliFallbackModel('gpt-5.3-codex')).toBe('gpt-5.4-mini');
    expect(resolveOpenAICliFallbackModel('gpt-5.2-codex')).toBe('gpt-5.3-codex');
    expect(resolveOpenAICliFallbackModel('custom-openai-model')).toBe('gpt-5.3-codex');
  });

  it('recomputes execution timeout against the remaining deadline budget', () => {
    const providerData = {
      provider: { type: 'google', model: 'gemini-3.1-pro-preview' },
      useGeminiCLI: true,
    };
    const deadline = {
      remainingMs: () => 12000,
    };

    expect(
      resolveProviderTimeoutForExecutionAttempt(
        providerData,
        'cli-agentic',
        { reviewType: 'branch_review' },
        deadline,
      ),
    ).toBe(10000);
  });

  it('returns smaller timeouts when the remaining budget shrinks between attempts', () => {
    const providerData = {
      provider: { type: 'google', model: 'gemini-3.1-pro-preview' },
      useGeminiCLI: true,
    };
    const remaining = [12000, 7000];
    const deadline = {
      remainingMs: () => remaining.shift() ?? 0,
    };

    const firstTimeout = resolveProviderTimeoutForExecutionAttempt(
      providerData,
      'cli-agent',
      { reviewType: 'branch_review' },
      deadline,
    );
    const secondTimeout = resolveProviderTimeoutForExecutionAttempt(
      providerData,
      'cli-agent',
      { reviewType: 'branch_review' },
      deadline,
    );

    expect(firstTimeout).toBe(10000);
    expect(secondTimeout).toBe(5000);
  });

  it('extracts token usage from Codex/OpenCode JSONL stdout', () => {
    const rawStdout = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 150 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300, output_tokens: 75 } }),
      JSON.stringify({ type: 'result', subtype: 'success', cost_usd: 0.0123 }),
    ].join('\n');

    // Codex/OpenCode result events historically omit num_turns entirely.
    // The streaming-counted turn.completed events fill in actualTurns
    // so the UI can display "X of Y" instead of "unknown of Y".
    expect(extractAgenticResultMeta(rawStdout)).toEqual({
      subtype: 'success',
      numTurns: 2,
      costUsd: 0.0123,
      tokensUsed: {
        input: 1500,
        output: 225,
      },
    });
  });

  it('prefers aggregate result usage when result tokens exceed per-turn sum', () => {
    const rawStdout = [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 2,
        usage: { input_tokens: 42, output_tokens: 24 },
        cost_usd: 0.01,
      }),
    ].join('\n');

    // numTurns now comes from the streaming-counted turn events (1) rather
    // than the result event's claim (2), so actualTurns stays on the same
    // scale as maxTurns. Tokens still defer to the larger result-event
    // total when it exceeds the per-turn sum.
    expect(extractAgenticResultMeta(rawStdout)).toEqual({
      subtype: 'success',
      numTurns: 1,
      costUsd: 0.01,
      tokensUsed: {
        input: 42,
        output: 24,
      },
    });
  });

  it('sums per-assistant usage for Claude when the result event under-reports total tokens', () => {
    // Claude stream-json: usage lives on each assistant event under
    // `message.usage`, and the trailing `result` event reports only the
    // final turn — leading to displays like "12 in · 13,268 out" where
    // "12 in" is just the wrap-up turn. Summing per-turn must win.
    const rawStdout = [
      JSON.stringify({ type: 'system', model: 'claude-sonnet-5-5' }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 28000, output_tokens: 1400 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 32000, output_tokens: 4200 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 36500, output_tokens: 7600 } },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 3,
        usage: { input_tokens: 12, output_tokens: 13268 },
      }),
    ].join('\n');

    const meta = extractAgenticResultMeta(rawStdout);
    expect(meta.subtype).toBe('success');
    expect(meta.numTurns).toBe(3);
    // Per-axis reconciliation: input from streamed assistant events
    // (96500 dwarfs the result's last-turn 12); output from the result
    // event (13268 slightly higher than summed 13200, possibly because
    // the final text turn's output isn't fully captured in assistant
    // events). Taking the max of each axis keeps the truthful number.
    expect(meta.tokensUsed).toEqual({
      input: 96500,
      output: 13268,
    });
  });

  it('keeps result-event output when streamed assistant events undercount tool-use turns', () => {
    // Real-world failure mode: 5 assistant events all reporting tiny
    // output_tokens (~8 each, mostly tool_use blocks). The final review
    // JSON arrives in a separate stream path our parser does not capture
    // as an `assistant` event with usage, so summed output ends up at 40.
    // The result event reports the cumulative output (~2,800), so
    // per-axis max correctly prefers the result-event output.
    const rawStdout = [
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 4, cache_read_input_tokens: 30000, output_tokens: 8 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 4, cache_read_input_tokens: 32000, output_tokens: 8 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 4, cache_read_input_tokens: 35000, output_tokens: 8 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 4, cache_read_input_tokens: 38000, output_tokens: 8 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 4, cache_read_input_tokens: 41000, output_tokens: 8 } },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 5,
        // Result event has a useful output count even when assistant events miss it.
        usage: { input_tokens: 6, output_tokens: 2797 },
      }),
    ].join('\n');

    const meta = extractAgenticResultMeta(rawStdout);
    // input: max(6, 4*5 + sum(cache_read)) = max(6, 176020) = 176020
    expect(meta.tokensUsed.input).toBe(176020);
    // output: max(40 summed, 2797 from result) = 2797
    expect(meta.tokensUsed.output).toBe(2797);
  });

  it('counts cached input from cache_creation/cache_read fields when Claude uses prompt caching', () => {
    // Anthropic's prompt caching splits input usage across three fields.
    // input_tokens reflects only the *fresh* (uncached) portion — often
    // tiny. The bulk lives in cache_read_input_tokens. Reading only
    // input_tokens (default) under-reports by orders of magnitude and
    // produces "6 in · 2,797 out" displays for runs that actually
    // consumed tens of thousands of input tokens.
    const rawStdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 12000,
            cache_read_input_tokens: 18000,
            output_tokens: 800,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 6,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 30000,
            output_tokens: 1200,
          },
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 2,
        usage: {
          input_tokens: 6,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1200,
        },
      }),
    ].join('\n');

    const meta = extractAgenticResultMeta(rawStdout);
    // Real input = 4 + 12000 + 18000 + 6 + 0 + 30000 = 60010
    expect(meta.tokensUsed.input).toBe(60010);
    expect(meta.tokensUsed.output).toBe(2000);
  });

  it('uses the streaming assistant-event count for actualTurns even when Claude result.num_turns disagrees', () => {
    // Real-world Claude stream: each agentic iteration emits one
    // `assistant` event but `result.num_turns` historically counts
    // message pairs and over-reports. Using the assistant-event count
    // keeps actualTurns and the maxTurns budget on the same scale.
    const rawStdout = [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10000, output_tokens: 200 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 11000, output_tokens: 250 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 12000, output_tokens: 800 } } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 11,
        usage: { input_tokens: 12, output_tokens: 800 },
      }),
    ].join('\n');

    const meta = extractAgenticResultMeta(rawStdout);
    expect(meta.numTurns).toBe(3);
    expect(meta.tokensUsed.input).toBe(33000);
  });

  it('treats recovered Codex/OpenCode text as success when the result event is absent', () => {
    const rawStdout = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 15 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 5 } }),
    ].join('\n');

    expect(extractAgenticResultMeta(rawStdout, { recoveredText: '{"summary":"streamed"}' })).toEqual({
      subtype: 'success',
      numTurns: 2,
      costUsd: null,
      tokensUsed: {
        input: 160,
        output: 20,
      },
    });
  });
});

describe('CLI runtime noise stripping (Bun/no-AVX warning)', () => {
  const BUN_AVX_STDERR = [
    'warn: CPU lacks AVX support, strange crashes may occur. Reinstall Bun or use *-baseline build:',
    '  https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-darwin-x64-baseline.zip',
    'Provider request was rejected. Verify selected model/provider settings.',
  ].join('\n');

  it('detects the Bun no-AVX warning', () => {
    expect(detectCliRuntimeNoise(BUN_AVX_STDERR).bunLacksAvx).toBe(true);
    expect(detectCliRuntimeNoise('Provider request was rejected.').bunLacksAvx).toBe(false);
  });

  it('strips the warning and trailing release URL but keeps the real error', () => {
    const cleaned = stripCliRuntimeNoise(BUN_AVX_STDERR);
    expect(cleaned).toBe('Provider request was rejected. Verify selected model/provider settings.');
    expect(cleaned).not.toMatch(/AVX/i);
    expect(cleaned).not.toMatch(/oven-sh\/bun/i);
  });

  it('formats the detail with the real error first and an actionable hint when the warning was present', () => {
    const detail = formatCliErrorDetail('anthropic', BUN_AVX_STDERR, '');
    expect(detail).toBe(
      'Provider request was rejected. Verify selected model/provider settings. '
      + 'The `claude` CLI is running on a Bun build that is unstable on this CPU (no AVX support) — '
      + 'reinstall the CLI (or use a "*-baseline" Bun build). This is the likely cause of the failure.'
    );
    expect(detail).not.toMatch(/CPU lacks AVX/);
    // No double-stop where the real error met the hint.
    expect(detail).not.toMatch(/\.\. /);
  });

  it('falls back to stdout when stderr was only noise, and still appends the hint', () => {
    const noiseOnly = 'warn: CPU lacks AVX support, strange crashes may occur. Reinstall Bun or use *-baseline build:';
    const detail = formatCliErrorDetail('anthropic', noiseOnly, '{"type":"error","message":"boom"}');
    expect(detail).toMatch(/boom/);
    expect(detail).toMatch(/Bun build/);
  });

  it('returns the plain detail unchanged when there is no runtime noise', () => {
    expect(formatCliErrorDetail('anthropic', 'something broke', '')).toBe('something broke');
  });
});

describe('shouldClearStaleClaudeTokenForRetry', () => {
  const anthropic = { provider: { type: 'anthropic' } };
  const authError = createReviewRuntimeError('Claude CLI authentication failed. Re-run `claude login`.', 'auth');

  it('returns true for an anthropic auth failure when not yet cleared', () => {
    expect(shouldClearStaleClaudeTokenForRetry(authError, anthropic, false)).toBe(true);
  });

  it('matches the verbatim Anthropic authentication_error envelope', () => {
    const envelopeError = createReviewRuntimeError(
      'Claude CLI authentication failed. Re-run `claude login` (or update the API key in provider settings), then retry.',
      'auth',
    );
    expect(shouldClearStaleClaudeTokenForRetry(envelopeError, anthropic, false)).toBe(true);
  });

  it('returns false once the stale token has already been cleared this call', () => {
    expect(shouldClearStaleClaudeTokenForRetry(authError, anthropic, true)).toBe(false);
  });

  it('returns false for non-anthropic providers', () => {
    expect(shouldClearStaleClaudeTokenForRetry(authError, { provider: { type: 'openai' } }, false)).toBe(false);
    expect(shouldClearStaleClaudeTokenForRetry(authError, null, false)).toBe(false);
  });

  it('returns false for non-auth errors (quota, network, transient)', () => {
    expect(shouldClearStaleClaudeTokenForRetry(createReviewRuntimeError('rate limited', 'rate_limit'), anthropic, false)).toBe(false);
    expect(shouldClearStaleClaudeTokenForRetry(createReviewRuntimeError('ECONNRESET', 'econnreset'), anthropic, false)).toBe(false);
    expect(shouldClearStaleClaudeTokenForRetry(new Error('something else'), anthropic, false)).toBe(false);
  });
});
