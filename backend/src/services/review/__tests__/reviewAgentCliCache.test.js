import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/claudeBinary.js', () => ({
  findClaudeBinary: vi.fn(),
}));

import { findClaudeBinary } from '../../../utils/claudeBinary.js';
import {
  clearReviewAgentCliCache,
  getCachedAuthStatusForReviewAgent,
  resolveCachedReviewAgentLaunchCommand,
} from '../reviewAgentCliCache.js';

function makeAdapter({ type = 'anthropic', authResult, findBinaryResult } = {}) {
  return {
    getType: () => type,
    checkAuth: vi.fn().mockResolvedValue(authResult ?? { authenticated: true, source: 'oauth' }),
    findBinary: vi.fn().mockResolvedValue(findBinaryResult ?? '/some/cli'),
  };
}

beforeEach(() => {
  clearReviewAgentCliCache();
  vi.mocked(findClaudeBinary).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getCachedAuthStatusForReviewAgent', () => {
  it('returns adapter result and memoizes successful auth', async () => {
    const adapter = makeAdapter();
    const r1 = await getCachedAuthStatusForReviewAgent(adapter);
    const r2 = await getCachedAuthStatusForReviewAgent(adapter);
    expect(r1).toEqual({ authenticated: true, source: 'oauth' });
    expect(r2).toBe(r1);
    expect(adapter.checkAuth).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache failures so the next call retries', async () => {
    const adapter = makeAdapter({ authResult: { authenticated: false, error: 'no token' } });
    const r1 = await getCachedAuthStatusForReviewAgent(adapter);
    const r2 = await getCachedAuthStatusForReviewAgent(adapter);
    expect(r1.authenticated).toBe(false);
    expect(r2.authenticated).toBe(false);
    expect(adapter.checkAuth).toHaveBeenCalledTimes(2);
  });

  it('keys by provider type so anthropic and openai do not collide', async () => {
    const claude = makeAdapter({ type: 'anthropic' });
    const openai = makeAdapter({ type: 'openai' });
    await getCachedAuthStatusForReviewAgent(claude);
    await getCachedAuthStatusForReviewAgent(openai);
    await getCachedAuthStatusForReviewAgent(claude);
    await getCachedAuthStatusForReviewAgent(openai);
    expect(claude.checkAuth).toHaveBeenCalledTimes(1);
    expect(openai.checkAuth).toHaveBeenCalledTimes(1);
  });

  it('expires after TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const adapter = makeAdapter();
    await getCachedAuthStatusForReviewAgent(adapter);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z')); // 61s later
    await getCachedAuthStatusForReviewAgent(adapter);
    expect(adapter.checkAuth).toHaveBeenCalledTimes(2);
  });

  it('clearReviewAgentCliCache forces re-check', async () => {
    const adapter = makeAdapter();
    await getCachedAuthStatusForReviewAgent(adapter);
    clearReviewAgentCliCache();
    await getCachedAuthStatusForReviewAgent(adapter);
    expect(adapter.checkAuth).toHaveBeenCalledTimes(2);
  });

  it('dedups concurrent cache misses into one checkAuth call', async () => {
    let resolveAuth;
    const authPromise = new Promise((resolve) => { resolveAuth = resolve; });
    const adapter = {
      getType: () => 'anthropic',
      checkAuth: vi.fn().mockReturnValue(authPromise),
      findBinary: vi.fn(),
    };

    const callA = getCachedAuthStatusForReviewAgent(adapter);
    const callB = getCachedAuthStatusForReviewAgent(adapter);
    const callC = getCachedAuthStatusForReviewAgent(adapter);

    expect(adapter.checkAuth).toHaveBeenCalledTimes(1);

    resolveAuth({ authenticated: true, source: 'oauth' });
    const [a, b, c] = await Promise.all([callA, callB, callC]);
    expect(a).toEqual({ authenticated: true, source: 'oauth' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('resolveCachedReviewAgentLaunchCommand', () => {
  it('caches the anthropic binary lookup but rebuilds args per call', async () => {
    vi.mocked(findClaudeBinary).mockResolvedValue({ binary: '/usr/bin/claude', args: ['--prelude'] });
    const adapter = makeAdapter({ type: 'anthropic' });

    const r1 = await resolveCachedReviewAgentLaunchCommand(adapter, ['--print', 'A']);
    const r2 = await resolveCachedReviewAgentLaunchCommand(adapter, ['--print', 'B']);

    expect(findClaudeBinary).toHaveBeenCalledTimes(1);
    expect(r1.binaryPath).toBe('/usr/bin/claude');
    expect(r1.args).toEqual(['--prelude', '--print', 'A']);
    expect(r2.args).toEqual(['--prelude', '--print', 'B']);
  });

  it('TTL invalidates the anthropic binary cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.mocked(findClaudeBinary).mockResolvedValue({ binary: '/usr/bin/claude', args: [] });
    const adapter = makeAdapter({ type: 'anthropic' });

    await resolveCachedReviewAgentLaunchCommand(adapter, []);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    await resolveCachedReviewAgentLaunchCommand(adapter, []);

    expect(findClaudeBinary).toHaveBeenCalledTimes(2);
  });

  it('dedups concurrent claude binary lookups', async () => {
    let resolveFind;
    const findPromise = new Promise((resolve) => { resolveFind = resolve; });
    vi.mocked(findClaudeBinary).mockReturnValue(findPromise);
    const adapter = makeAdapter({ type: 'anthropic' });

    const a = resolveCachedReviewAgentLaunchCommand(adapter, ['--print', 'A']);
    const b = resolveCachedReviewAgentLaunchCommand(adapter, ['--print', 'B']);
    const c = resolveCachedReviewAgentLaunchCommand(adapter, ['--print', 'C']);

    expect(findClaudeBinary).toHaveBeenCalledTimes(1);

    resolveFind({ binary: '/usr/bin/claude', args: [] });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.binaryPath).toBe('/usr/bin/claude');
    expect(ra.args).toEqual(['--print', 'A']);
    expect(rb.args).toEqual(['--print', 'B']);
    expect(rc.args).toEqual(['--print', 'C']);
  });

  it('passes through to cliAdapter.findBinary for non-anthropic providers', async () => {
    const adapter = makeAdapter({ type: 'openai', findBinaryResult: '/usr/bin/codex' });

    const r1 = await resolveCachedReviewAgentLaunchCommand(adapter, ['exec']);
    const r2 = await resolveCachedReviewAgentLaunchCommand(adapter, ['exec', 'resume']);

    expect(findClaudeBinary).not.toHaveBeenCalled();
    // Non-anthropic intentionally does not memoize at this layer; the adapter
    // owns its own caching (findCodexBinary, _findBinaryCache for gemini).
    expect(adapter.findBinary).toHaveBeenCalledTimes(2);
    expect(r1.binaryPath).toBe('/usr/bin/codex');
    expect(r1.args).toEqual(['exec']);
    expect(r2.args).toEqual(['exec', 'resume']);
  });
});
