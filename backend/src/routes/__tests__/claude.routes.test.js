import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = {
        stack,
        get(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { get: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
        post(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { post: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
        put(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { put: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
        delete(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { delete: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
      };
      return router;
    },
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../utils/claudeBinary.js', () => ({
  findClaudeBinary: vi.fn(),
}));

vi.mock('../../services/providerService.js', () => ({
  default: {
    getAnthropicCLIModels: vi.fn(() => []),
  },
}));

vi.mock('../../services/claudeTokenService.js', () => ({
  buildClaudeCliEnv: vi.fn(async (baseEnv = {}, token = '') => ({
    ...baseEnv,
    NO_COLOR: '1',
    ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
  })),
  clearStoredClaudeOAuthToken: vi.fn(),
  getStoredClaudeOAuthToken: vi.fn(async () => null),
  hasStoredClaudeOAuthToken: vi.fn(async () => false),
  saveStoredClaudeOAuthToken: vi.fn(),
}));

import { execFile, spawn } from 'child_process';
import { findClaudeBinary } from '../../utils/claudeBinary.js';
import claudeRouter, { clearClaudeCache } from '../claude.js';

function createMockReqRes({ body = {}, ip = '127.0.0.1', query = {} } = {}) {
  const req = {
    body,
    query,
    ip,
    socket: { remoteAddress: ip },
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
  return { req, res };
}

async function callRouteHandler(router, method, path, req, res) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const routeMethod = Object.keys(layer.route.methods)[0];
    if (routeMethod !== method || layer.route.path !== path) continue;

    for (const handler of layer.route.stack.map((entry) => entry.handle)) {
      await new Promise((resolve, reject) => {
        const next = (err) => (err ? reject(err) : resolve());
        const result = handler(req, res, next);
        if (result instanceof Promise) {
          result.then(resolve).catch(reject);
        }
      });
    }
    return;
  }

  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.emit('close', null, 'SIGTERM');
  });
  return child;
}

describe('claude routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearClaudeCache();
    findClaudeBinary.mockResolvedValue({ binary: '/tmp/claude', args: [] });
  });

  afterEach(() => {
    clearClaudeCache();
    vi.restoreAllMocks();
  });

  it('uses spawn-based validation for Claude print probes and surfaces invalid token errors', async () => {
    spawn.mockImplementation((binary, args) => {
      expect(binary).toBe('/tmp/claude');
      expect(args).toEqual(['--print', '-p', 'hi']);

      const child = createMockChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Failed to authenticate. API Error: 401 Invalid bearer token\n'));
        child.emit('close', 1, null);
      });
      return child;
    });

    const { req, res } = createMockReqRes({
      body: { token: 'sk-ant-oat-test-token' },
    });

    await callRouteHandler(claudeRouter, 'post', '/test', req, res);

    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        authenticated: false,
        error: 'Invalid or expired token',
      },
    });
  });

  it('requires the Windows SIGTERM false-negative signature before allowing deferred token validation', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    execFile.mockImplementation((binary, args, options, callback) => {
      callback(Object.assign(new Error(`Command failed: ${binary} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
        signal: null,
      }));
    });

    const { req, res } = createMockReqRes({
      body: { token: 'sk-ant-oat-test-token' },
    });

    try {
      await callRouteHandler(claudeRouter, 'post', '/test', req, res);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        authenticated: false,
        error: expect.stringContaining('Connection test failed'),
      },
    });
  });

  it('prefers Claude CLI auth status over legacy credentials files for native auth checks', async () => {
    execFile.mockImplementation((binary, args, options, callback) => {
      expect(binary).toBe('/tmp/claude');
      if (args.includes('--version')) {
        callback(null, { stdout: '2.1.76\n', stderr: '' });
        return;
      }
      if (args[0] === 'auth' && args[1] === 'status' && args[2] === '--json') {
        callback(null, {
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            apiProvider: 'firstParty',
          }),
          stderr: '',
        });
        return;
      }
      callback(new Error(`Unexpected execFile args: ${args.join(' ')}`));
    });

    const { req, res } = createMockReqRes();

    await callRouteHandler(claudeRouter, 'get', '/status', req, res);

    expect(spawn).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        installed: true,
        version: '2.1.76',
        authenticated: true,
        hasNativeAuth: true,
        hasStoredToken: false,
        hasOAuthToken: false,
        nativeAuthSource: 'claude.ai',
      },
    });
  });

  it('bypasses cached status when refresh is requested', async () => {
    let authStatusCalls = 0;
    execFile.mockImplementation((binary, args, options, callback) => {
      expect(binary).toBe('/tmp/claude');
      if (args.includes('--version')) {
        callback(null, { stdout: '2.1.76\n', stderr: '' });
        return;
      }
      if (args[0] === 'auth' && args[1] === 'status' && args[2] === '--json') {
        authStatusCalls += 1;
        callback(null, {
          stdout: JSON.stringify(
            authStatusCalls === 1
              ? { loggedIn: false }
              : { loggedIn: true, authMethod: 'claude.ai' }
          ),
          stderr: '',
        });
        return;
      }
      callback(new Error(`Unexpected execFile args: ${args.join(' ')}`));
    });

    const first = createMockReqRes();
    await callRouteHandler(claudeRouter, 'get', '/status', first.req, first.res);
    expect(first.res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        installed: true,
        version: '2.1.76',
        authenticated: false,
        hasNativeAuth: false,
        hasStoredToken: false,
        hasOAuthToken: false,
        nativeAuthSource: null,
      },
    });

    const refresh = createMockReqRes({ query: { refresh: '1' } });
    await callRouteHandler(claudeRouter, 'get', '/status', refresh.req, refresh.res);
    expect(refresh.res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        installed: true,
        version: '2.1.76',
        authenticated: true,
        hasNativeAuth: true,
        hasStoredToken: false,
        hasOAuthToken: false,
        nativeAuthSource: 'claude.ai',
      },
    });
  });
});
