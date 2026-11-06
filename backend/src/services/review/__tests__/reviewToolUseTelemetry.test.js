import { describe, it, expect } from 'vitest';
import {
  createReviewToolUseTelemetry,
  shouldEmitPerformanceTelemetry,
} from '../reviewToolUseTelemetry.js';

describe('createReviewToolUseTelemetry', () => {
  it('starts empty with classificationReliability=1', () => {
    const t = createReviewToolUseTelemetry();
    const s = t.snapshot();
    expect(s.toolCalls).toBe(0);
    expect(s.fullFileReads).toBe(0);
    expect(s.classificationReliability).toBe(1);
    expect(Object.keys(s.repeatedReadsPerPath)).toEqual([]);
  });

  it('counts a full file read', () => {
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    const s = t.snapshot();
    expect(s.toolCalls).toBe(1);
    expect(s.fullFileReads).toBe(1);
    expect(s.partialFileReads).toBe(0);
    expect(s.uniqueFilesRead).toBe(1);
  });

  it('does not count a single read as repeated', () => {
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    expect(t.snapshot().repeatedReadsPerPath).toEqual({});
    expect(t.snapshot().repeatedReadsTotal).toBe(0);
  });

  it('counts repeated reads per path', () => {
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js', limit: 50 } });
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    const s = t.snapshot();
    expect(s.repeatedReadsPerPath).toEqual({ '/p/a.js': 3 });
    expect(s.repeatedReadsTotal).toBe(2); // 3 reads = 2 repeats
    expect(s.uniqueFilesRead).toBe(1);
  });

  it('counts git_diff calls', () => {
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Bash', input: { command: 'git diff HEAD' } });
    t.onToolUse({ name: 'Bash', input: { command: 'git status' } });
    t.onToolUse({ name: 'Bash', input: { command: 'git --no-pager diff main' } });
    const s = t.snapshot();
    expect(s.gitDiffCalls).toBe(2);
    expect(s.classifiedCounts.git_other).toBe(1);
    expect(s.classifiedCounts.shell).toBe(0);
  });

  it('tracks unclassified events and computes reliability', () => {
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    t.onToolUse(null);
    t.onToolUse({ input: {} });
    const s = t.snapshot();
    expect(s.toolCalls).toBe(3);
    expect(s.unclassifiedCount).toBe(2);
    expect(s.classificationReliability).toBeCloseTo(1 / 3, 4);
  });

  it('reset() clears state', () => {
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    t.reset();
    const s = t.snapshot();
    expect(s.toolCalls).toBe(0);
    expect(s.fullFileReads).toBe(0);
    expect(Object.keys(s.repeatedReadsPerPath)).toEqual([]);
  });

  it('snapshots are independent (mutating returned object does not affect later snapshots)', () => {
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    const s1 = t.snapshot();
    s1.classifiedCounts.full_file_read = 999;
    s1.repeatedReadsPerPath['/p/a.js'] = 999;
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    const s2 = t.snapshot();
    expect(s2.classifiedCounts.full_file_read).toBe(2);
    expect(s2.repeatedReadsPerPath).toEqual({ '/p/a.js': 2 });
  });

  // Simulate the exact gating pattern reviewService.js uses to decide whether
  // to attach `review.stats.performance.toolUseTelemetry`. This protects the
  // Balanced byte-identity contract: under strategy='smart' with no opt-in env
  // var, no `performance` namespace must appear on review.stats.
  it('wire-pattern: Balanced (smart) does NOT attach performance namespace by default', () => {
    const stats = {};
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    if (shouldEmitPerformanceTelemetry('smart', {})) {
      stats.performance = { toolUseTelemetry: t.snapshot() };
    }
    expect('performance' in stats).toBe(false);
  });

  it('wire-pattern: Performance attaches the namespace', () => {
    const stats = {};
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    if (shouldEmitPerformanceTelemetry('performance', {})) {
      stats.performance = { toolUseTelemetry: t.snapshot() };
    }
    expect(stats.performance?.toolUseTelemetry?.fullFileReads).toBe(1);
  });

  it('wire-pattern: ATLAS_REVIEW_TELEMETRY_BALANCED=1 forces emission under Balanced', () => {
    const stats = {};
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    if (shouldEmitPerformanceTelemetry('smart', { ATLAS_REVIEW_TELEMETRY_BALANCED: '1' })) {
      stats.performance = { toolUseTelemetry: t.snapshot() };
    }
    expect(stats.performance?.toolUseTelemetry?.toolCalls).toBe(1);
  });

  it('mixed real flow: 2 full reads, 1 grep, 1 partial read, 1 edit', () => {
    const t = createReviewToolUseTelemetry();
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js' } });
    t.onToolUse({ name: 'Read', input: { file_path: '/p/b.js' } });
    t.onToolUse({ name: 'Grep', input: { pattern: 'foo' } });
    t.onToolUse({ name: 'Read', input: { file_path: '/p/a.js', offset: 100 } });
    t.onToolUse({ name: 'Edit', input: { file_path: '/p/a.js' } });
    const s = t.snapshot();
    expect(s.toolCalls).toBe(5);
    expect(s.fullFileReads).toBe(2);
    expect(s.partialFileReads).toBe(1);
    expect(s.classifiedCounts.grep).toBe(1);
    expect(s.classifiedCounts.edit).toBe(1);
    expect(s.repeatedReadsPerPath).toEqual({ '/p/a.js': 2 }); // full + partial
    expect(s.uniqueFilesRead).toBe(2);
    expect(s.classificationReliability).toBe(1);
  });
});

describe('shouldEmitPerformanceTelemetry gate', () => {
  it('returns true for performance strategy regardless of env', () => {
    expect(shouldEmitPerformanceTelemetry('performance', {})).toBe(true);
    expect(shouldEmitPerformanceTelemetry('performance', { ATLAS_REVIEW_TELEMETRY_BALANCED: '0' })).toBe(true);
  });
  it('returns false for smart/balanced by default', () => {
    expect(shouldEmitPerformanceTelemetry('smart', {})).toBe(false);
    expect(shouldEmitPerformanceTelemetry('balanced', {})).toBe(false);
    expect(shouldEmitPerformanceTelemetry('latency_first', {})).toBe(false);
    expect(shouldEmitPerformanceTelemetry('max_quality', {})).toBe(false);
    expect(shouldEmitPerformanceTelemetry('custom', {})).toBe(false);
    expect(shouldEmitPerformanceTelemetry('adaptive', {})).toBe(false);
  });
  it('returns true under any strategy when ATLAS_REVIEW_TELEMETRY_BALANCED=1', () => {
    expect(shouldEmitPerformanceTelemetry('smart', { ATLAS_REVIEW_TELEMETRY_BALANCED: '1' })).toBe(true);
    expect(shouldEmitPerformanceTelemetry('max_quality', { ATLAS_REVIEW_TELEMETRY_BALANCED: '1' })).toBe(true);
  });
  it('does not match truthy-but-not-"1" env values (must be exactly "1")', () => {
    expect(shouldEmitPerformanceTelemetry('smart', { ATLAS_REVIEW_TELEMETRY_BALANCED: 'true' })).toBe(false);
    expect(shouldEmitPerformanceTelemetry('smart', { ATLAS_REVIEW_TELEMETRY_BALANCED: 'yes' })).toBe(false);
  });
  it('handles null/undefined strategy safely', () => {
    expect(shouldEmitPerformanceTelemetry(null, {})).toBe(false);
    expect(shouldEmitPerformanceTelemetry(undefined, {})).toBe(false);
  });
});
