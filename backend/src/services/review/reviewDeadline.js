/**
 * Review Deadline
 * Abort controllers, deadline enforcement, and sleep utilities.
 */

import {
  ReviewDeadlineError,
  REVIEW_TOTAL_DEADLINE_MS,
  REVIEW_DEADLINE_TIMEOUT_BUFFER_MS,
} from './reviewConstants.js';

export function getAbortReasonError(signal, fallbackError) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return fallbackError;
}

export function createReviewDeadline(externalSignal = null, totalDeadlineMs = REVIEW_TOTAL_DEADLINE_MS) {
  const normalizedDeadlineMs = Math.max(1, Number(totalDeadlineMs) || REVIEW_TOTAL_DEADLINE_MS);
  const controller = new AbortController();
  const deadlineAtMs = Date.now() + normalizedDeadlineMs;
  const timer = setTimeout(() => {
    controller.abort(new ReviewDeadlineError(normalizedDeadlineMs));
  }, normalizedDeadlineMs);
  if (typeof timer?.unref === 'function') timer.unref();
  let externalAbortHandler = null;
  if (externalSignal) {
    externalAbortHandler = () => {
      if (!controller.signal.aborted) {
        controller.abort(externalSignal.reason || new Error('External runtime abort'));
      }
    };
    if (externalSignal.aborted) {
      externalAbortHandler();
    } else {
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }
  return {
    signal: controller.signal,
    deadlineAtMs,
    remainingMs() {
      return Math.max(0, deadlineAtMs - Date.now());
    },
    clear() {
      clearTimeout(timer);
      if (externalSignal && externalAbortHandler) {
        try {
          externalSignal.removeEventListener('abort', externalAbortHandler);
        } catch {
          // noop
        }
      }
    },
    check(minRemainingMs = 0, operation = 'operation') {
      if (controller.signal.aborted) {
        throw getAbortReasonError(
          controller.signal,
          new ReviewDeadlineError(normalizedDeadlineMs)
        );
      }
      if (minRemainingMs > 0 && (deadlineAtMs - Date.now()) < minRemainingMs) {
        throw new ReviewDeadlineError(
          normalizedDeadlineMs,
          `not enough time remaining to start ${operation}`
        );
      }
    },
  };
}

export function throwIfDeadlineExceeded(signal) {
  if (signal?.aborted) {
    throw getAbortReasonError(signal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS));
  }
}

export function createOperationAbort(timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Operation timed out'));
    }
  }, Math.max(1, Number(timeoutMs) || 1));
  if (typeof timer?.unref === 'function') timer.unref();

  let externalAbortHandler = null;
  if (externalSignal) {
    externalAbortHandler = () => {
      if (!controller.signal.aborted) {
        controller.abort(externalSignal.reason || new Error('Operation aborted'));
      }
    };
    if (externalSignal.aborted) {
      externalAbortHandler();
    } else {
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      if (externalSignal && externalAbortHandler) {
        try {
          externalSignal.removeEventListener('abort', externalAbortHandler);
        } catch {
          // noop
        }
      }
    },
  };
}

export function resolveTimeoutForRemainingBudget(timeoutMs, deadline = null) {
  const safeTimeout = Math.max(1, Number(timeoutMs) || 1);
  if (!deadline || typeof deadline.remainingMs !== 'function') return safeTimeout;
  const remainingMs = deadline.remainingMs();
  if (!Number.isFinite(remainingMs)) return safeTimeout;
  return Math.max(1, Math.min(safeTimeout, remainingMs - REVIEW_DEADLINE_TIMEOUT_BUFFER_MS));
}

export function sleep(ms, signal = null) {
  const duration = Math.max(0, Number(ms) || 0);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, duration));
  }
  throwIfDeadlineExceeded(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    if (typeof timer?.unref === 'function') timer.unref();

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(getAbortReasonError(signal, new ReviewDeadlineError(REVIEW_TOTAL_DEADLINE_MS)));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
