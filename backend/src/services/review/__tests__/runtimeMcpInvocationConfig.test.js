/**
 * Section R Phase B: unit tests for `buildRuntimeMcpInvocationConfig`.
 *
 * The helper gates whether the spawned agentic CLI receives a per-review
 * MCP server registration. Returning null means the CLI's spawn args stay
 * byte-equivalent to pre-Phase-B. Any condition that causes a null return
 * here is a hard guarantee of "no surprise tools added to the agent."
 */
import { describe, it, expect } from 'vitest';
import { buildRuntimeMcpInvocationConfig } from '../reviewProviderExecution.js';

describe('buildRuntimeMcpInvocationConfig', () => {
  const baseCtx = {
    runtimeMcpEnabled: true,
    mergeBaseSha: 'abcd1234',
    headSha: 'beef5678',
  };
  const projectPath = '/abs/project';

  it('returns null when requestContext is null/undefined', () => {
    expect(buildRuntimeMcpInvocationConfig(null, projectPath)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig(undefined, projectPath)).toBeNull();
  });

  it('returns null when runtimeMcpEnabled is not strictly true', () => {
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, runtimeMcpEnabled: false }, projectPath)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, runtimeMcpEnabled: undefined }, projectPath)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, runtimeMcpEnabled: 1 }, projectPath)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, runtimeMcpEnabled: 'true' }, projectPath)).toBeNull();
  });

  it('returns null when projectPath is missing or non-string', () => {
    expect(buildRuntimeMcpInvocationConfig(baseCtx, null)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig(baseCtx, '')).toBeNull();
    expect(buildRuntimeMcpInvocationConfig(baseCtx, 42)).toBeNull();
  });

  it('returns null when mergeBaseSha is missing or empty', () => {
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, mergeBaseSha: '' }, projectPath)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, mergeBaseSha: '   ' }, projectPath)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, mergeBaseSha: undefined }, projectPath)).toBeNull();
  });

  it('returns null when headSha is missing or empty', () => {
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, headSha: '' }, projectPath)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, headSha: '   ' }, projectPath)).toBeNull();
    expect(buildRuntimeMcpInvocationConfig({ ...baseCtx, headSha: undefined }, projectPath)).toBeNull();
  });

  it('returns the runtime MCP descriptor when all inputs valid', () => {
    const cfg = buildRuntimeMcpInvocationConfig(baseCtx, projectPath);
    expect(cfg).not.toBeNull();
    expect(cfg.projectRoot).toBe(projectPath);
    expect(cfg.mergeBaseSha).toBe('abcd1234');
    expect(cfg.headSha).toBe('beef5678');
    expect(cfg.binPath).toMatch(/runtimeMcp[/\\]bin\.js$/);
    expect(cfg.binPath.startsWith('/')).toBe(true); // absolute on POSIX
  });

  it('trims whitespace from SHA inputs', () => {
    const cfg = buildRuntimeMcpInvocationConfig({
      ...baseCtx,
      mergeBaseSha: '  abcd1234  ',
      headSha: '  beef5678\n',
    }, projectPath);
    expect(cfg.mergeBaseSha).toBe('abcd1234');
    expect(cfg.headSha).toBe('beef5678');
  });
});
