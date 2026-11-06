/**
 * ClaudeService adapter integration tests
 * Verifies _executeClaudeCommand uses CLI adapters (not claude-wrapper.js)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process.spawn before importing claudeService
const mockStdout = { on: vi.fn() };
const mockStderr = { on: vi.fn() };
const mockStdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
const mockProcess = {
  stdout: mockStdout,
  stderr: mockStderr,
  stdin: mockStdin,
  on: vi.fn(),
  kill: vi.fn(),
};

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProcess),
}));

// Mock database queries
vi.mock('../../db/queries.js', () => ({
  getUserQuotas: vi.fn().mockResolvedValue({ quota_exceeded: false }),
  logUsage: vi.fn().mockResolvedValue(undefined),
  saveChatMessage: vi.fn().mockResolvedValue(undefined),
  getChatHistory: vi.fn().mockResolvedValue([]),
  updateProject: vi.fn().mockResolvedValue(undefined),
  getProjectById: vi.fn().mockResolvedValue({ source: 'builder' }),
}));

// Mock memoryService
vi.mock('../memoryService.js', () => ({
  default: {
    initializeMemory: vi.fn().mockResolvedValue(undefined),
    analyzeAndUpdateFromToolUse: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the adapter
const mockAdapter = {
  findBinary: vi.fn().mockResolvedValue('/usr/local/bin/opencode'),
  buildArgs: vi.fn().mockReturnValue({
    args: ['run', '--format', 'json'],
    stdinMessage: true,
    structuredOutput: true,
    message: 'test message',
  }),
  getName: vi.fn().mockReturnValue('OpenCode'),
  getDefaultModel: vi.fn().mockReturnValue('opencode-default'),
  extractReviewText: vi.fn().mockReturnValue('test response'),
};

vi.mock('../cliAdapters/index.js', () => ({
  getAdapter: vi.fn(() => mockAdapter),
  hasAdapter: vi.fn(() => true),
  getAvailableAdapters: vi.fn().mockResolvedValue([]),
  getSupportedAdapters: vi.fn().mockReturnValue([]),
  getAdapterForProvider: vi.fn(() => mockAdapter),
  default: {
    getAdapter: vi.fn(() => mockAdapter),
    hasAdapter: vi.fn(() => true),
    getAvailableAdapters: vi.fn().mockResolvedValue([]),
    getSupportedAdapters: vi.fn().mockReturnValue([]),
    getAdapterForProvider: vi.fn(() => mockAdapter),
  },
}));

// Mock fs/promises (for initializeSession's CLAUDE.md check)
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

const { spawn } = await import('child_process');

describe('ClaudeService adapter-aware _executeClaudeCommand', () => {
  let claudeService;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamic import to pick up mocks
    const mod = await import('../claudeService.js');
    claudeService = mod.default;

    // Initialize a test session
    await claudeService.initializeSession('test-project', '/tmp/test-project', 'test-user');
  });

  afterEach(() => {
    // Clean up session
    claudeService.sessions.delete('test-project');
    claudeService.commandQueue.delete('test-project');
  });

  it('uses adapter findBinary instead of claude-wrapper.js path', async () => {
    // Arrange: set up spawn to resolve
    mockProcess.on.mockImplementation((event, cb) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });
    mockStdout.on.mockImplementation((event, cb) => {
      if (event === 'data') {
        cb(Buffer.from(JSON.stringify({ message: 'hello', tokensUsed: 10 })));
      }
    });
    mockStderr.on.mockImplementation(() => {});

    // Act
    const result = await claudeService._executeClaudeCommand(
      'test-project', 'test message', [], { providerType: 'opencode' }
    );

    // Assert: spawn was called with the adapter binary, NOT claude-wrapper.js
    expect(spawn).toHaveBeenCalled();
    const spawnCall = spawn.mock.calls[0];
    expect(spawnCall[0]).toBe('/usr/local/bin/opencode');
    expect(spawnCall[1]).toEqual(['run', '--format', 'json']);
    // Should NOT contain claude-wrapper.js anywhere
    const fullCmd = JSON.stringify(spawnCall);
    expect(fullCmd).not.toContain('claude-wrapper');
  });

  it('writes message to stdin when adapter returns stdinMessage: true', async () => {
    mockProcess.on.mockImplementation((event, cb) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });
    mockStdout.on.mockImplementation((event, cb) => {
      if (event === 'data') {
        cb(Buffer.from('response text'));
      }
    });
    mockStderr.on.mockImplementation(() => {});

    await claudeService._executeClaudeCommand(
      'test-project', 'test message', [], { providerType: 'opencode' }
    );

    expect(mockStdin.write).toHaveBeenCalledWith('test message');
    expect(mockStdin.end).toHaveBeenCalled();
  });

  it('falls back to the original message when a stdin adapter omits adapterResult.message', async () => {
    mockAdapter.buildArgs.mockReturnValueOnce({
      args: ['--print'],
      stdinMessage: true,
      structuredOutput: true,
    });

    mockProcess.on.mockImplementation((event, cb) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });
    mockStdout.on.mockImplementation((event, cb) => {
      if (event === 'data') {
        cb(Buffer.from('response text'));
      }
    });
    mockStderr.on.mockImplementation(() => {});

    await claudeService._executeClaudeCommand(
      'test-project', 'fallback message', [], { providerType: 'anthropic' }
    );

    expect(mockStdin.write).toHaveBeenCalledWith('fallback message');
    expect(mockStdin.end).toHaveBeenCalled();
  });

  it('does not write to stdin when adapter returns stdinMessage: false', async () => {
    mockAdapter.buildArgs.mockReturnValueOnce({
      args: ['--print', '--', 'test message'],
      stdinMessage: false,
      structuredOutput: false,
      message: 'test message',
    });

    mockProcess.on.mockImplementation((event, cb) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });
    mockStdout.on.mockImplementation((event, cb) => {
      if (event === 'data') {
        cb(Buffer.from('response'));
      }
    });
    mockStderr.on.mockImplementation(() => {});

    await claudeService._executeClaudeCommand(
      'test-project', 'test message', [], { providerType: 'anthropic' }
    );

    expect(mockStdin.write).not.toHaveBeenCalled();
  });

  it('passes providerType to adapter resolution', async () => {
    const { getAdapter } = await import('../cliAdapters/index.js');

    mockProcess.on.mockImplementation((event, cb) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });
    mockStdout.on.mockImplementation((event, cb) => {
      if (event === 'data') {
        cb(Buffer.from('{}'));
      }
    });
    mockStderr.on.mockImplementation(() => {});

    await claudeService._executeClaudeCommand(
      'test-project', 'hello', [], { providerType: 'opencode' }
    );

    expect(getAdapter).toHaveBeenCalledWith('opencode');
  });

  it('defaults to anthropic when providerType is not specified', async () => {
    const { getAdapter } = await import('../cliAdapters/index.js');

    mockProcess.on.mockImplementation((event, cb) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });
    mockStdout.on.mockImplementation((event, cb) => {
      if (event === 'data') {
        cb(Buffer.from('{}'));
      }
    });
    mockStderr.on.mockImplementation(() => {});

    await claudeService._executeClaudeCommand(
      'test-project', 'hello', [], {}
    );

    // Should default to 'anthropic'
    expect(getAdapter).toHaveBeenCalledWith('anthropic');
  });

  it('tracks runtime activity separately from persistent session existence', () => {
    let sessions = claudeService.getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isActive).toBe(false);
    expect(Number.isFinite(sessions[0].startTime)).toBe(true);
    expect(Number.isFinite(sessions[0].lastActivity)).toBe(true);
    expect(sessions[0].uptime).toBe(0);

    claudeService.setRunActive('test-project', true, 123456);
    sessions = claudeService.getAllSessions();
    expect(sessions[0].isActive).toBe(true);
    expect(sessions[0].startTime).toBe(123456);
  });

  it('updates last activity without producing NaN session stats', () => {
    claudeService.markSessionActivity('test-project', 999999);
    const sessions = claudeService.getAllSessions();
    expect(sessions[0].lastActivity).toBe(999999);
    expect(Number.isFinite(sessions[0].uptime)).toBe(true);
  });
});
