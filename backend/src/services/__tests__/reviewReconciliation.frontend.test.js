import { describe, it, expect } from 'vitest';
import {
  hasInFlightOrPendingProgress,
  shouldClearStaleProgress,
  shouldReplaceBranchSnapshot,
} from '../../../../frontend/src/utils/reviewReconciliation.ts';

describe('frontend reviewReconciliation utils', () => {
  describe('hasInFlightOrPendingProgress', () => {
    it('returns false for null/undefined', () => {
      expect(hasInFlightOrPendingProgress(null)).toBe(false);
      expect(hasInFlightOrPendingProgress(undefined)).toBe(false);
    });

    it('returns true when chunks are pending', () => {
      expect(
        hasInFlightOrPendingProgress({
          currentChunk: 2,
          totalChunks: 5,
          filesCompleted: 0,
          totalFiles: 0,
        })
      ).toBe(true);
    });

    it('returns true when files are pending', () => {
      expect(
        hasInFlightOrPendingProgress({
          currentChunk: 0,
          totalChunks: 0,
          filesCompleted: 4,
          totalFiles: 10,
        })
      ).toBe(true);
    });

    it('returns false when all work is done', () => {
      expect(
        hasInFlightOrPendingProgress({
          currentChunk: 5,
          totalChunks: 5,
          filesCompleted: 10,
          totalFiles: 10,
        })
      ).toBe(false);
    });

    it('returns false when counters are zero', () => {
      expect(
        hasInFlightOrPendingProgress({
          currentChunk: 0,
          totalChunks: 0,
          filesCompleted: 0,
          totalFiles: 0,
        })
      ).toBe(false);
    });

    it('returns true when activeChunkFiles > 0', () => {
      expect(
        hasInFlightOrPendingProgress({
          currentChunk: 5,
          totalChunks: 5,
          filesCompleted: 10,
          totalFiles: 10,
          activeChunkFiles: 3,
        })
      ).toBe(true);
    });
  });

  describe('shouldClearStaleProgress', () => {
    const T0 = '2026-02-22T12:00:00.000Z';
    const T1 = '2026-02-22T12:00:05.000Z';
    const T2 = '2026-02-22T12:00:10.000Z';

    it('clears progress when backend says terminal and no stale counters', () => {
      const progress = {
        phase: 'queued',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 0,
        updatedAt: T0,
      };
      expect(shouldClearStaleProgress(progress, 'completed', T1)).toBe(true);
    });

    it('CRITICAL: clears progress when backend says terminal EVEN WITH stale counters', () => {
      // This is the P1 regression test: stale counters (currentChunk < totalChunks,
      // filesCompleted < totalFiles) must NOT prevent cleanup when backend confirms terminal.
      const progress = {
        phase: 'file_review_inflight',
        currentChunk: 2,
        totalChunks: 5,
        filesCompleted: 4,
        totalFiles: 10,
        updatedAt: T0,
      };
      expect(shouldClearStaleProgress(progress, 'completed', T1)).toBe(true);
      expect(shouldClearStaleProgress(progress, 'failed', T1)).toBe(true);
      expect(shouldClearStaleProgress(progress, 'partial', T1)).toBe(true);
    });

    it('preserves progress from a genuinely newer optimistic run', () => {
      // Progress timestamp is NEWER than the API snapshot — a fresh run was just started
      // and the API hasn't caught up yet.
      const progress = {
        phase: 'queued',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 0,
        updatedAt: T2, // newer than API
      };
      expect(
        shouldClearStaleProgress(progress, 'completed', T1, Date.parse(T2) + 5_000)
      ).toBe(false);
    });

    it('clears optimistic progress when backend remains completed beyond grace window', () => {
      const progress = {
        phase: 'queued',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 0,
        updatedAt: T2,
      };
      expect(
        shouldClearStaleProgress(progress, 'completed', T1, Date.parse(T2) + 45_000)
      ).toBe(true);
    });

    it('CRITICAL: clears newer optimistic progress when backend status is failed', () => {
      const progress = {
        phase: 'reviewing',
        currentChunk: 1,
        totalChunks: 3,
        filesCompleted: 2,
        totalFiles: 8,
        updatedAt: T2,
      };
      expect(shouldClearStaleProgress(progress, 'failed', T1)).toBe(true);
    });

    it('clears progress when status is unknown and phase is inactive', () => {
      const progress = {
        phase: 'idle',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 0,
        updatedAt: T0,
      };
      expect(shouldClearStaleProgress(progress, undefined, null)).toBe(true);
    });

    it('keeps progress when backend says active', () => {
      const progress = {
        phase: 'reviewing',
        currentChunk: 2,
        totalChunks: 5,
        filesCompleted: 4,
        totalFiles: 10,
        updatedAt: T0,
      };
      expect(shouldClearStaleProgress(progress, 'running', T1)).toBe(false);
    });
  });

  describe('shouldReplaceBranchSnapshot', () => {
    it('replaces when no existing snapshot', () => {
      expect(
        shouldReplaceBranchSnapshot(undefined, {
          reviewLifecycleIsActive: false,
          reviewLifecycleIsTerminal: true,
          updatedAt: '2026-02-22T12:00:00Z',
        })
      ).toBe(true);
    });

    it('replaces when incoming is newer', () => {
      expect(
        shouldReplaceBranchSnapshot(
          { reviewLifecycleIsActive: true, reviewLifecycleIsTerminal: false, updatedAt: '2026-02-22T12:00:00Z' },
          { reviewLifecycleIsActive: false, reviewLifecycleIsTerminal: true, updatedAt: '2026-02-22T12:00:10Z' }
        )
      ).toBe(true);
    });

    it('does not replace when incoming is older', () => {
      expect(
        shouldReplaceBranchSnapshot(
          { reviewLifecycleIsActive: true, reviewLifecycleIsTerminal: false, updatedAt: '2026-02-22T12:00:10Z' },
          { reviewLifecycleIsActive: false, reviewLifecycleIsTerminal: true, updatedAt: '2026-02-22T12:00:00Z' }
        )
      ).toBe(false);
    });

    it('CRITICAL: on equal timestamps, terminal replaces active (completed over queued)', () => {
      // This is the P1 regression: after handleBannerReviewNow sets optimistic "queued"
      // snapshot with timestamp T, the API responds with "completed" at the same T.
      // The completed snapshot MUST replace the queued one.
      expect(
        shouldReplaceBranchSnapshot(
          { reviewLifecycleIsActive: true, reviewLifecycleIsTerminal: false, updatedAt: '2026-02-22T12:00:00Z' },
          { reviewLifecycleIsActive: false, reviewLifecycleIsTerminal: true, updatedAt: '2026-02-22T12:00:00Z' }
        )
      ).toBe(true);
    });

    it('on equal timestamps, does not replace terminal with active (prevents stale rerun)', () => {
      expect(
        shouldReplaceBranchSnapshot(
          { reviewLifecycleIsActive: false, reviewLifecycleIsTerminal: true, updatedAt: '2026-02-22T12:00:00Z' },
          { reviewLifecycleIsActive: true, reviewLifecycleIsTerminal: false, updatedAt: '2026-02-22T12:00:00Z' }
        )
      ).toBe(false);
    });
  });
});
