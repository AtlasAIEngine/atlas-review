import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLinterCorroborationSourceEvaluator,
} from '../reviewCorroborationIntegration.js';

describe('createLinterCorroborationSourceEvaluator', () => {
  const linterFindings = [
    { file: 'src/foo.ts', line: 42, source: 'eslint', ruleId: 'no-unused-vars', message: 'bar is never used' },
    { file: 'backend/server.js', line: 10, source: 'eslint', ruleId: 'no-console' },
  ];

  afterEach(() => {
    delete process.env.ATLAS_REVIEW_CORROBORATION_SOURCE_MODE;
    vi.resetModules();
  });

  it('returns null when no findings', () => {
    expect(createLinterCorroborationSourceEvaluator([])).toBeNull();
    expect(createLinterCorroborationSourceEvaluator(null)).toBeNull();
  });

  it('matches exact file + line', () => {
    const evaluator = createLinterCorroborationSourceEvaluator(linterFindings);
    const result = evaluator({ file: 'src/foo.ts', line: 42, title: 'Unused variable', description: 'bar is declared but never used.' });
    expect(result).not.toBeNull();
    expect(result.status).toBe('supported');
    expect(result.confidence).toBe('high');
    expect(result.sourceClass).toBe('deterministic_tool');
    expect(result.sourceName).toBe('eslint:no-unused-vars');
  });

  it('matches within default line window', () => {
    const evaluator = createLinterCorroborationSourceEvaluator(linterFindings);
    expect(evaluator({ file: 'src/foo.ts', line: 44, title: 'Unused variable', description: 'bar is declared but never used.' })).not.toBeNull();
    expect(evaluator({ file: 'src/foo.ts', line: 39, title: 'Unused variable', description: 'bar is declared but never used.' })).not.toBeNull();
  });

  it('rejects outside line window', () => {
    const evaluator = createLinterCorroborationSourceEvaluator(linterFindings, { lineWindow: 3 });
    expect(evaluator({ file: 'src/foo.ts', line: 50 })).toBeNull();
  });

  it('rejects unknown file', () => {
    const evaluator = createLinterCorroborationSourceEvaluator(linterFindings);
    expect(evaluator({ file: 'unknown.ts', line: 42 })).toBeNull();
  });

  it('handles suffix matching for file paths', () => {
    const evaluator = createLinterCorroborationSourceEvaluator(linterFindings);
    expect(evaluator({ file: 'server.js', line: 10, title: 'Avoid console logging', description: 'console.log should not ship in server code.' })).not.toBeNull();
  });

  it('rejects corroboration when suffix fallback spans multiple files', () => {
    const evaluator = createLinterCorroborationSourceEvaluator([
      { file: 'src/server.js', line: 10, source: 'eslint', ruleId: 'no-console', message: 'Unexpected console statement.' },
      { file: 'backend/server.js', line: 90, source: 'eslint', ruleId: 'no-console', message: 'Unexpected console statement.' },
    ]);
    expect(evaluator({
      file: 'server.js',
      line: 89,
      title: 'Avoid console logging',
      description: 'console.log should not ship in server code.',
    })).toBeNull();
  });

  it('rejects ambiguous suffix corroboration ties', () => {
    const evaluator = createLinterCorroborationSourceEvaluator([
      { file: 'src/server.js', line: 10, source: 'eslint', ruleId: 'no-console', message: 'Unexpected console statement.' },
      { file: 'backend/server.js', line: 10, source: 'eslint', ruleId: 'no-console', message: 'Unexpected console statement.' },
    ]);
    expect(evaluator({
      file: 'server.js',
      line: 10,
      title: 'Avoid console logging',
      description: 'console.log should not ship in server code.',
    })).toBeNull();
  });

  it('returns null for recommendation without file or line', () => {
    const evaluator = createLinterCorroborationSourceEvaluator(linterFindings);
    expect(evaluator({ file: null, line: 42 })).toBeNull();
    expect(evaluator({ file: 'src/foo.ts', line: 0 })).toBeNull();
    expect(evaluator(null)).toBeNull();
  });

  it('does not corroborate unrelated issues on the same line', () => {
    const evaluator = createLinterCorroborationSourceEvaluator(linterFindings);
    const result = evaluator({
      file: 'src/foo.ts',
      line: 42,
      title: 'Missing null guard',
      description: 'response.body can be null before accessing id.',
    });
    expect(result).toBeNull();
  });

  it('disables all source corroboration when source mode is none', async () => {
    process.env.ATLAS_REVIEW_CORROBORATION_SOURCE_MODE = 'none';
    vi.resetModules();
    const mod = await import('../reviewCorroborationIntegration.js');
    const evaluator = mod.createCorroborationSourceEvaluator({
      verificationStatus: {
        lint: 'fail',
        logs: { lint: 'src/foo.ts bar is never used' },
      },
      linterFindings,
    });
    expect(evaluator).toBeNull();
  });

  it('enables deterministic source corroboration when verification-log mode is active', async () => {
    process.env.ATLAS_REVIEW_CORROBORATION_SOURCE_MODE = 'verification_logs';
    vi.resetModules();
    const mod = await import('../reviewCorroborationIntegration.js');
    const evaluator = mod.createCorroborationSourceEvaluator({
      verificationStatus: null,
      linterFindings,
    });
    expect(evaluator).toBeTypeOf('function');
    expect(evaluator({
      file: 'src/foo.ts',
      line: 42,
      title: 'Unused variable',
      description: 'bar is declared but never used.',
    })).not.toBeNull();
  });
});
