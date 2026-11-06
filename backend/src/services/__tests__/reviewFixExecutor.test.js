import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUILDER_RUN_POLICY,
  REVIEW_FIX_RUN_POLICY,
  createCliRunExecutor,
  resolveRunPolicy,
} from '../review/reviewFixExecutor.js';
import {
  REVIEW_FIX_EVENT_NAMES,
  REVIEW_FIX_RECOMMENDATION_STATUSES,
  buildFixCompletionStatusEvents,
  buildFixRecommendationStatusEvents,
  createFixStatusEvent,
} from '../review/reviewFixEvents.js';

function createMockProcess() {
  const stdoutHandlers = new Map();
  const stderrHandlers = new Map();
  const processHandlers = new Map();

  const mockProcess = {
    stdout: {
      on: vi.fn((event, cb) => {
        stdoutHandlers.set(event, cb);
      }),
    },
    stderr: {
      on: vi.fn((event, cb) => {
        stderrHandlers.set(event, cb);
      }),
    },
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    },
    on: vi.fn((event, cb) => {
      processHandlers.set(event, cb);
    }),
    kill: vi.fn(() => {
      setTimeout(() => {
        processHandlers.get('close')?.(143);
      }, 0);
    }),
  };

  return { mockProcess, stdoutHandlers, stderrHandlers, processHandlers };
}

describe('reviewFixExecutor', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('keeps builder defaults side-effectful while review_fix stays verification-safe', () => {
    expect(BUILDER_RUN_POLICY).toEqual({
      createChangeset: true,
      autoCommit: true,
      autoPush: true,
      persistChatMessages: true,
      updateMemory: true,
    });

    expect(REVIEW_FIX_RUN_POLICY).toEqual({
      createChangeset: true,
      autoCommit: false,
      autoPush: false,
      persistChatMessages: false,
      updateMemory: false,
    });
  });

  it('allows explicit policy overrides without mutating the defaults', () => {
    const policy = resolveRunPolicy(REVIEW_FIX_RUN_POLICY, { autoCommit: true });

    expect(policy).toEqual({
      createChangeset: true,
      autoCommit: true,
      autoPush: false,
      persistChatMessages: false,
      updateMemory: false,
    });
    expect(REVIEW_FIX_RUN_POLICY.autoCommit).toBe(false);
  });

  it('defines the canonical review_fix socket event names', () => {
    expect(REVIEW_FIX_EVENT_NAMES).toEqual({
      started: 'fix-started',
      stream: 'fix-stream',
      toolUse: 'fix-tool-use',
      fileDiff: 'fix-file-diff',
      status: 'fix-status',
      complete: 'fix-complete',
      error: 'fix-error',
      stopped: 'fix-stopped',
    });
  });

  it('builds verification-pending status events without implying addressed', () => {
    expect(createFixStatusEvent({
      projectId: 'project-1',
      recommendationKey: 'rec-1',
      status: REVIEW_FIX_RECOMMENDATION_STATUSES.verificationPending,
    })).toEqual({
      event: 'fix-status',
      data: {
        projectId: 'project-1',
        recommendationKey: 'rec-1',
        status: 'verification_pending',
      },
    });
  });

  it('creates canonical per-finding running status events', () => {
    expect(buildFixRecommendationStatusEvents({
      projectId: 'project-1',
      runId: 'run-1',
      recommendationKeys: ['rec-1', 'rec-2', 'rec-1'],
      status: REVIEW_FIX_RECOMMENDATION_STATUSES.running,
    })).toEqual([
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-1',
          status: 'running',
        },
      },
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-2',
          status: 'running',
        },
      },
    ]);
  });

  it('maps single-finding fix completions to verification_pending instead of addressed', () => {
    expect(buildFixCompletionStatusEvents({
      projectId: 'project-1',
      runId: 'run-1',
      recommendationKeys: ['rec-1'],
      recommendationFilePathsByKey: {
        'rec-1': ['src/playerlook.cs'],
      },
      observedFilePaths: ['src/playerlook.cs'],
      hasFileChanges: true,
    })).toEqual([
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-1',
          status: 'verification_pending',
          filePaths: ['src/playerlook.cs'],
        },
      },
    ]);
  });

  it('keeps multi-finding fix completions at patch_applied until verification can disambiguate them', () => {
    expect(buildFixCompletionStatusEvents({
      projectId: 'project-1',
      runId: 'run-1',
      recommendationKeys: ['rec-1', 'rec-2'],
      recommendationFilePathsByKey: {
        'rec-1': ['src/playerlook.cs'],
        'rec-2': ['src/playercameras.cs'],
      },
      observedFilePaths: ['src/playerlook.cs', 'src/playercameras.cs'],
      hasFileChanges: true,
    })).toEqual([
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-1',
          status: 'patch_applied',
          filePaths: ['src/playerlook.cs'],
        },
      },
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-2',
          status: 'patch_applied',
          filePaths: ['src/playercameras.cs'],
        },
      },
    ]);
  });

  it('runs through injected hooks without any socket dependency', async () => {
    const { mockProcess } = createMockProcess();
    const events = [];
    const executor = createCliRunExecutor({
      spawnProcess: vi.fn(() => mockProcess),
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    const { controller, done } = executor.start({
      projectId: 'project-1',
      projectPath: '/tmp/project-1',
      runType: 'review_fix',
      cliAdapter: {
        getName: () => 'Codex',
        getType: () => 'openai',
        getDefaultModel: () => 'gpt-5',
        parseStreamLine: () => null,
      },
      providerType: 'openai',
      adapterResult: {
        stdinMessage: false,
        structuredOutput: true,
      },
      cliBinaryPath: '/usr/bin/codex',
      cliLaunchArgs: ['exec'],
      spawnEnv: { PATH: process.env.PATH || '' },
      inactivityTimeoutMs: 30_000,
      inactivityTimeoutLabel: '30s',
      policy: REVIEW_FIX_RUN_POLICY,
      onEvent: (event) => {
        events.push(event);
      },
    });

    await controller.stop();
    const result = await done;

    expect(events[0]).toMatchObject({
      type: 'started',
      data: {
        projectId: 'project-1',
        runType: 'review_fix',
        policy: REVIEW_FIX_RUN_POLICY,
      },
    });
    expect(result.status).toBe('stopped');
    expect(result.policy).toEqual(REVIEW_FIX_RUN_POLICY);
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not emit user-facing errors for Codex rollout persistence warnings', async () => {
    const { mockProcess, stderrHandlers, processHandlers } = createMockProcess();
    const events = [];
    const executor = createCliRunExecutor({
      spawnProcess: vi.fn(() => mockProcess),
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    const { done } = executor.start({
      projectId: 'project-1',
      projectPath: '/tmp/project-1',
      runType: 'review_agent',
      cliAdapter: {
        getName: () => 'Codex',
        getType: () => 'openai',
        getDefaultModel: () => 'gpt-5',
        parseStreamLine: () => null,
      },
      providerType: 'openai',
      adapterResult: {
        stdinMessage: false,
        structuredOutput: true,
      },
      cliBinaryPath: '/usr/bin/codex',
      cliLaunchArgs: ['exec'],
      spawnEnv: { PATH: process.env.PATH || '' },
      inactivityTimeoutMs: 30_000,
      inactivityTimeoutLabel: '30s',
      policy: REVIEW_FIX_RUN_POLICY,
      onEvent: (event) => {
        events.push(event);
      },
    });

    stderrHandlers.get('data')?.(Buffer.from(
      '2026-05-01T12:06:51.114715Z ERROR codex_core::session: failed to record rollout items: thread 019de36f-078e-7e10-a777-5e6312188e91 not found\n'
    ));
    processHandlers.get('close')?.(0);
    const result = await done;

    expect(result.exitCode).toBe(0);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(result.stderrBuffer).toContain('failed to record rollout items');
  });

  it('still emits user-facing errors for real provider stderr failures', async () => {
    const { mockProcess, stderrHandlers, processHandlers } = createMockProcess();
    const events = [];
    const executor = createCliRunExecutor({
      spawnProcess: vi.fn(() => mockProcess),
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    const { done } = executor.start({
      projectId: 'project-1',
      projectPath: '/tmp/project-1',
      runType: 'review_agent',
      cliAdapter: {
        getName: () => 'Codex',
        getType: () => 'openai',
        getDefaultModel: () => 'gpt-5',
        parseStreamLine: () => null,
      },
      providerType: 'openai',
      adapterResult: {
        stdinMessage: false,
        structuredOutput: true,
      },
      cliBinaryPath: '/usr/bin/codex',
      cliLaunchArgs: ['exec'],
      spawnEnv: { PATH: process.env.PATH || '' },
      inactivityTimeoutMs: 30_000,
      inactivityTimeoutLabel: '30s',
      policy: REVIEW_FIX_RUN_POLICY,
      onEvent: (event) => {
        events.push(event);
      },
    });

    stderrHandlers.get('data')?.(Buffer.from('ERROR: Codex CLI authentication failed\n'));
    processHandlers.get('close')?.(1);
    await done;

    expect(events).toContainEqual({
      type: 'error',
      data: {
        error: 'ERROR: Codex CLI authentication failed\n',
      },
    });
  });
});
