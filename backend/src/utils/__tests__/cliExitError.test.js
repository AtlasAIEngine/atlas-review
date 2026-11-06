import { describe, expect, it } from 'vitest';
import { buildCliExitErrorMessage } from '../cliExitError.js';

describe('buildCliExitErrorMessage', () => {
  it('classifies Gemini quota/rate-limit exits with actionable billing guidance', () => {
    const message = buildCliExitErrorMessage({
      providerType: 'google',
      cliName: 'Gemini CLI',
      exitCode: 1,
      stderrBuffer: 'Error: 429 RESOURCE_EXHAUSTED: You exceeded your current quota. Please check your plan and billing details.',
      streamErrorMessage: '',
    });

    expect(message).toContain('Gemini CLI quota or rate limit reached');
    expect(message).toContain('free-tier credits');
    expect(message).toContain('Google AI Studio quota/billing');
    expect(message).toContain('RESOURCE_EXHAUSTED');
  });

  it('classifies authentication failures and includes provider-specific login command', () => {
    const message = buildCliExitErrorMessage({
      providerType: 'openai',
      cliName: 'Codex CLI',
      exitCode: 1,
      stderrBuffer: 'Not authenticated. Please login first.',
      streamErrorMessage: '',
    });

    expect(message).toContain('Codex CLI authentication failed');
    expect(message).toContain('`codex login`');
  });

  it('classifies model access failures', () => {
    const message = buildCliExitErrorMessage({
      providerType: 'google',
      cliName: 'Gemini CLI',
      exitCode: 1,
      stderrBuffer: 'Error: model not found: gemini-3-pro-preview',
      streamErrorMessage: '',
    });

    expect(message).toContain('Gemini CLI model access failed');
    expect(message).toContain('selected model');
  });

  it('uses parsed stream error text directly when no better classification exists', () => {
    const message = buildCliExitErrorMessage({
      providerType: 'google',
      cliName: 'Gemini CLI',
      exitCode: 1,
      stderrBuffer: 'some non-specific stderr line',
      streamErrorMessage: 'Unexpected internal runner failure while streaming',
    });

    expect(message).toBe('Gemini CLI: Unexpected internal runner failure while streaming');
  });

  it('falls back to exit code and appends useful stderr detail', () => {
    const message = buildCliExitErrorMessage({
      providerType: 'google',
      cliName: 'Gemini CLI',
      exitCode: 1,
      stderrBuffer: 'panic: unhandled runtime branch',
      streamErrorMessage: '',
    });

    expect(message).toContain('Gemini CLI exited with code 1');
    expect(message).toContain('panic: unhandled runtime branch');
  });
});

