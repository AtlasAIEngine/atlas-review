import { describe, expect, it, vi } from 'vitest';
import { createCliInstallJobService } from '../cliInstallJobService.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('cliInstallJobService', () => {
  it('reuses the active attempt for the same package while installation is running', async () => {
    const deferred = createDeferred();
    const cliInstaller = {
      ALLOWED_PACKAGES: { codex: '@openai/codex' },
      installCLI: vi.fn(async (_packageKey, onProgress) => {
        onProgress({ type: 'progress', message: 'Installing @openai/codex...' });
        await deferred.promise;
        onProgress({ type: 'complete', message: '@openai/codex installed successfully.', binaryPath: '/tmp/codex' });
      }),
      installClaudeCodeWithWindowsPrereqs: vi.fn(),
    };
    const providerScanner = {
      fullScan: vi.fn(async () => {}),
    };

    const service = createCliInstallJobService({
      cliInstaller,
      providerScanner,
      createAttemptId: () => 'attempt-1',
      now: (() => {
        let tick = 0;
        return () => `2026-03-20T00:00:0${tick += 1}.000Z`;
      })(),
    });

    const firstStart = service.startInstall('codex');
    await vi.waitFor(() => {
      expect(service.getAttempt('attempt-1')?.status).toBe('installing');
    });

    const secondStart = service.startInstall('codex');

    expect(firstStart.reused).toBe(false);
    expect(secondStart.reused).toBe(true);
    expect(secondStart.attempt.attemptId).toBe('attempt-1');
    expect(cliInstaller.installCLI).toHaveBeenCalledTimes(1);

    deferred.resolve();

    await vi.waitFor(() => {
      expect(service.getAttempt('attempt-1')?.status).toBe('success');
    });

    expect(providerScanner.fullScan).toHaveBeenCalledTimes(1);
    expect(service.getAttempt('attempt-1')).toMatchObject({
      attemptId: 'attempt-1',
      packageKey: 'codex',
      status: 'success',
      binaryPath: '/tmp/codex',
      error: null,
    });
    expect(service.getAttempt('attempt-1')?.logs).toEqual([
      'Starting installation of codex...',
      'Installing @openai/codex...',
      '@openai/codex installed successfully.',
      'codex installed successfully.',
    ]);
  });

  it('exposes active attempts while installation is in progress and clears them on completion', async () => {
    const deferred = createDeferred();
    const service = createCliInstallJobService({
      cliInstaller: {
        ALLOWED_PACKAGES: { 'gemini-cli': '@google/gemini-cli' },
        installCLI: vi.fn(async (_packageKey, onProgress) => {
          onProgress({ type: 'progress', message: 'Installing @google/gemini-cli...' });
          await deferred.promise;
          onProgress({ type: 'complete', message: '@google/gemini-cli installed successfully.' });
        }),
        installClaudeCodeWithWindowsPrereqs: vi.fn(),
      },
      providerScanner: {
        fullScan: vi.fn(async () => {}),
      },
      createAttemptId: () => 'attempt-gemini',
    });

    service.startInstall('gemini-cli');

    await vi.waitFor(() => {
      expect(service.getActiveAttempts()).toMatchObject({
        'gemini-cli': {
          attemptId: 'attempt-gemini',
          status: 'installing',
        },
      });
    });

    deferred.resolve();

    await vi.waitFor(() => {
      expect(service.getAttempt('attempt-gemini')?.status).toBe('success');
    });

    expect(service.getActiveAttempts()).toEqual({});
  });

  it('records terminal errors when installation fails', async () => {
    const service = createCliInstallJobService({
      cliInstaller: {
        ALLOWED_PACKAGES: { codex: '@openai/codex' },
        installCLI: vi.fn(async () => {
          throw new Error('npm install exited with code 1');
        }),
        installClaudeCodeWithWindowsPrereqs: vi.fn(),
      },
      providerScanner: {
        fullScan: vi.fn(async () => {}),
      },
      createAttemptId: () => 'attempt-error',
    });

    service.startInstall('codex');

    await vi.waitFor(() => {
      expect(service.getAttempt('attempt-error')?.status).toBe('error');
    });

    expect(service.getAttempt('attempt-error')).toMatchObject({
      attemptId: 'attempt-error',
      status: 'error',
      error: 'npm install exited with code 1',
    });
    expect(service.getAttempt('attempt-error')?.logs.at(-1)).toBe('Error: npm install exited with code 1');
  });
});
