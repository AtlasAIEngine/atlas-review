/**
 * Ask Atlas (review-agent) CLI prep cache.
 *
 * Per-message Ask Atlas calls do two redundant CLI lookups:
 *   1. cliAdapter.checkAuth() → providerService.getCliAuthStatus(), which
 *      itself calls findClaudeBinary + 3× detect functions (~410ms).
 *   2. resolveProviderLaunchCommand() → findClaudeBinary again (~150ms).
 *
 * findClaudeBinary has no module-level cache, so each call re-runs
 * `which -a claude` + `--help` + `--version` probes. Within Ask Atlas
 * specifically, neither result changes between consecutive messages, so
 * we memoize them here with a short TTL.
 *
 * IMPORTANT: This cache is intentionally scoped to Ask Atlas only. Code
 * review, builder chat, and Fix Issues continue to call the unwrapped
 * helpers — the freshness guarantees there matter more than the latency
 * win, and those flows aren't the user-perceived bottleneck.
 */

import { findClaudeBinary } from '../../utils/claudeBinary.js';

const AUTH_TTL_MS = 60_000;
const BINARY_TTL_MS = 60_000;

const _authCache = new Map();
const _authInFlight = new Map();
let _claudeBinaryCache = null;
let _claudeBinaryInFlight = null;

export async function getCachedAuthStatusForReviewAgent(cliAdapter) {
  const providerType = cliAdapter.getType();
  const cached = _authCache.get(providerType);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  // Dedup concurrent misses: when two Ask Atlas calls hit the cache empty
  // window simultaneously (different projects can both reach here), share
  // a single in-flight checkAuth() rather than doubling up the probes.
  const existing = _authInFlight.get(providerType);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await cliAdapter.checkAuth();
      // Cache only successful authenticated results. A failed checkAuth is
      // typically a misconfiguration the user wants to see resolved on the
      // next try, not memoized.
      if (result?.authenticated) {
        _authCache.set(providerType, {
          result,
          expiresAt: Date.now() + AUTH_TTL_MS,
        });
      }
      return result;
    } finally {
      _authInFlight.delete(providerType);
    }
  })();
  _authInFlight.set(providerType, promise);
  return promise;
}

async function getCachedClaudeBinary() {
  if (_claudeBinaryCache && _claudeBinaryCache.expiresAt > Date.now()) {
    return { binary: _claudeBinaryCache.binary, args: _claudeBinaryCache.args };
  }
  if (_claudeBinaryInFlight) {
    return _claudeBinaryInFlight;
  }

  _claudeBinaryInFlight = (async () => {
    try {
      const result = await findClaudeBinary();
      _claudeBinaryCache = {
        binary: result.binary,
        args: Array.isArray(result.args) ? result.args : [],
        expiresAt: Date.now() + BINARY_TTL_MS,
      };
      return { binary: _claudeBinaryCache.binary, args: _claudeBinaryCache.args };
    } finally {
      _claudeBinaryInFlight = null;
    }
  })();
  return _claudeBinaryInFlight;
}

export async function resolveCachedReviewAgentLaunchCommand(cliAdapter, cliArgs) {
  if (cliAdapter.getType() === 'anthropic') {
    const { binary, args } = await getCachedClaudeBinary();
    return {
      binaryPath: binary,
      args: [...args, ...cliArgs],
    };
  }

  // Codex owns its own binary cache (findCodexBinary), and the providerService
  // findBinary path memoizes Gemini for 30s. Pass through.
  return {
    binaryPath: await cliAdapter.findBinary(),
    args: cliArgs,
  };
}

export function clearReviewAgentCliCache() {
  _authCache.clear();
  _authInFlight.clear();
  _claudeBinaryCache = null;
  _claudeBinaryInFlight = null;
}
