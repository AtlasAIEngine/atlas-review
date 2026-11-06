import crypto from 'crypto';
import cliInstallService from './cliInstallService.js';
import providerService from './providerService.js';

const TERMINAL_STATUSES = new Set(['success', 'error']);

function cloneAttempt(attempt) {
  if (!attempt) {
    return null;
  }

  return {
    attemptId: attempt.attemptId,
    packageKey: attempt.packageKey,
    status: attempt.status,
    logs: [...attempt.logs],
    error: attempt.error,
    binaryPath: attempt.binaryPath,
    startedAt: attempt.startedAt,
    updatedAt: attempt.updatedAt,
    completedAt: attempt.completedAt,
  };
}

export function createCliInstallJobService({
  cliInstaller = cliInstallService,
  providerScanner = providerService,
  now = () => new Date().toISOString(),
  createAttemptId = () => crypto.randomUUID(),
  maxLogsPerAttempt = 300,
  maxRetainedAttempts = 50,
} = {}) {
  const attemptsById = new Map();
  const latestAttemptIdByPackage = new Map();

  const touchAttempt = (attempt) => {
    attempt.updatedAt = now();
  };

  const appendLog = (attempt, message) => {
    if (typeof message !== 'string' || !message.trim()) {
      return;
    }

    attempt.logs.push(message.trim());
    if (attempt.logs.length > maxLogsPerAttempt) {
      attempt.logs.splice(0, attempt.logs.length - maxLogsPerAttempt);
    }
    touchAttempt(attempt);
  };

  const setTerminalStatus = (attempt, status, errorMessage = null) => {
    attempt.status = status;
    attempt.error = errorMessage;
    attempt.completedAt = now();
    touchAttempt(attempt);
  };

  const pruneCompletedAttempts = () => {
    const removable = Array.from(attemptsById.values())
      .filter((attempt) => TERMINAL_STATUSES.has(attempt.status))
      .sort((a, b) => new Date(a.completedAt || a.updatedAt).getTime() - new Date(b.completedAt || b.updatedAt).getTime());

    while (attemptsById.size > maxRetainedAttempts && removable.length > 0) {
      const attempt = removable.shift();
      if (!attempt) break;
      attemptsById.delete(attempt.attemptId);
      if (latestAttemptIdByPackage.get(attempt.packageKey) === attempt.attemptId) {
        latestAttemptIdByPackage.delete(attempt.packageKey);
      }
    }
  };

  const runAttempt = async (attempt) => {
    attempt.status = 'installing';
    touchAttempt(attempt);

    const handleProgress = (event = {}) => {
      if (event.binaryPath) {
        attempt.binaryPath = event.binaryPath;
      }

      if (event.type === 'progress' || event.type === 'complete') {
        appendLog(attempt, event.message);
      }
    };

    try {
      if (attempt.packageKey === 'claude-code') {
        await cliInstaller.installClaudeCodeWithWindowsPrereqs(handleProgress);
      } else {
        await cliInstaller.installCLI(attempt.packageKey, handleProgress);
      }

      try {
        await providerScanner.fullScan();
      } catch {
        // Best effort rescan so new binaries are discoverable.
      }

      appendLog(attempt, `${attempt.packageKey} installed successfully.`);
      setTerminalStatus(attempt, 'success');
    } catch (error) {
      const message = error?.message || 'Installation failed';
      appendLog(attempt, `Error: ${message}`);
      setTerminalStatus(attempt, 'error', message);
    } finally {
      if (latestAttemptIdByPackage.get(attempt.packageKey) === attempt.attemptId && TERMINAL_STATUSES.has(attempt.status)) {
        // Keep latestAttemptIdByPackage pointing at the most recent attempt, even after completion.
      }
      pruneCompletedAttempts();
    }
  };

  const startInstall = (packageKey) => {
    if (!cliInstaller.ALLOWED_PACKAGES?.[packageKey]) {
      throw new Error(`Invalid package. Allowed: ${Object.keys(cliInstaller.ALLOWED_PACKAGES || {}).join(', ')}`);
    }

    const latestAttemptId = latestAttemptIdByPackage.get(packageKey);
    const latestAttempt = latestAttemptId ? attemptsById.get(latestAttemptId) : null;
    if (latestAttempt && !TERMINAL_STATUSES.has(latestAttempt.status)) {
      return { reused: true, attempt: cloneAttempt(latestAttempt) };
    }

    const timestamp = now();
    const attempt = {
      attemptId: createAttemptId(),
      packageKey,
      status: 'queued',
      logs: [`Starting installation of ${packageKey}...`],
      error: null,
      binaryPath: null,
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };

    attemptsById.set(attempt.attemptId, attempt);
    latestAttemptIdByPackage.set(packageKey, attempt.attemptId);

    queueMicrotask(() => {
      void runAttempt(attempt);
    });

    pruneCompletedAttempts();
    return { reused: false, attempt: cloneAttempt(attempt) };
  };

  const getAttempt = (attemptId) => cloneAttempt(attemptsById.get(attemptId) || null);

  const getActiveAttempts = () => {
    const active = {};
    for (const [packageKey, attemptId] of latestAttemptIdByPackage.entries()) {
      const attempt = attemptsById.get(attemptId);
      if (attempt && !TERMINAL_STATUSES.has(attempt.status)) {
        active[packageKey] = cloneAttempt(attempt);
      }
    }
    return active;
  };

  return {
    startInstall,
    getAttempt,
    getActiveAttempts,
  };
}

const cliInstallJobService = createCliInstallJobService();

export default cliInstallJobService;
