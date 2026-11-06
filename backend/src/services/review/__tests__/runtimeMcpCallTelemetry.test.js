/**
 * Section R Phase B / M2 #67 stage 1: runtime MCP per-call telemetry.
 *
 * Pure-function tests — no fs, no git, no spawn. Tests the per-call record
 * builder, overlap math, contained-in-prior detection, and the snapshot
 * summary aggregation that the M0 aggregator will consume.
 */
import { describe, it, expect } from 'vitest';
import {
  createRuntimeMcpCallTelemetry,
  resolveRequestedRange,
  computeOverlapPct,
  isFullyContainedInAnyPrior,
} from '../runtimeMcpCallTelemetry.js';

function tu(name, input) {
  return { type: 'tool_use', name, input };
}

describe('resolveRequestedRange', () => {
  it('read_file_slice → uses startLine and endLine verbatim', () => {
    expect(resolveRequestedRange('read_file_slice', { startLine: 10, endLine: 50 })).toEqual({ startLine: 10, endLine: 50 });
  });

  it('read_file_slice → null on missing or invalid range', () => {
    expect(resolveRequestedRange('read_file_slice', {})).toEqual({ startLine: null, endLine: null });
    expect(resolveRequestedRange('read_file_slice', { startLine: 50, endLine: 10 })).toEqual({ startLine: null, endLine: null });
    expect(resolveRequestedRange('read_file_slice', { startLine: 'x', endLine: 10 })).toEqual({ startLine: null, endLine: null });
  });

  it('get_hunk_context → derives start/end from line ± contextLines', () => {
    expect(resolveRequestedRange('get_hunk_context', { line: 100, contextLines: 5 })).toEqual({ startLine: 95, endLine: 105 });
  });

  it('get_hunk_context → defaults contextLines to 20 when omitted', () => {
    expect(resolveRequestedRange('get_hunk_context', { line: 100 })).toEqual({ startLine: 80, endLine: 120 });
  });

  it('get_hunk_context → clamps startLine at 1', () => {
    expect(resolveRequestedRange('get_hunk_context', { line: 5, contextLines: 20 })).toEqual({ startLine: 1, endLine: 25 });
  });

  it('get_diff_for_file → null range (per-path counting only)', () => {
    expect(resolveRequestedRange('get_diff_for_file', { path: 'a.js' })).toEqual({ startLine: null, endLine: null });
  });

  it('unknown tool → null range', () => {
    expect(resolveRequestedRange('not_a_tool', { line: 10 })).toEqual({ startLine: null, endLine: null });
  });
});

describe('computeOverlapPct', () => {
  it('returns null when requested has no usable range', () => {
    expect(computeOverlapPct({ startLine: null, endLine: null }, [])).toBeNull();
  });

  it('returns null when no priors are usable', () => {
    expect(computeOverlapPct({ startLine: 10, endLine: 20 }, [])).toBeNull();
    expect(computeOverlapPct({ startLine: 10, endLine: 20 }, [{ startLine: null, endLine: null }])).toBeNull();
  });

  it('returns 0 for fully disjoint priors', () => {
    expect(computeOverlapPct({ startLine: 10, endLine: 20 }, [{ startLine: 30, endLine: 40 }])).toBe(0);
  });

  it('returns 100 when fully contained in a single prior', () => {
    expect(computeOverlapPct({ startLine: 10, endLine: 20 }, [{ startLine: 5, endLine: 25 }])).toBe(100);
  });

  it('returns the inclusive-line-count overlap percentage', () => {
    // requested 10..20 (11 lines), prior 15..25 → overlap is 15..20 = 6 lines
    expect(computeOverlapPct({ startLine: 10, endLine: 20 }, [{ startLine: 15, endLine: 25 }])).toBeCloseTo((6 / 11) * 100, 2);
  });

  it('unions overlapping priors before computing overlap', () => {
    // priors 5..15 and 12..30 should union to 5..30; requested 10..20 is fully covered
    expect(computeOverlapPct({ startLine: 10, endLine: 20 }, [{ startLine: 5, endLine: 15 }, { startLine: 12, endLine: 30 }])).toBe(100);
  });

  it('handles disjoint multi-prior unions', () => {
    // priors 1..5 and 30..40, requested 4..32 (29 lines) → overlap 4..5 (2) + 30..32 (3) = 5/29
    const requested = { startLine: 4, endLine: 32 };
    const priors = [{ startLine: 1, endLine: 5 }, { startLine: 30, endLine: 40 }];
    expect(computeOverlapPct(requested, priors)).toBeCloseTo((5 / 29) * 100, 1);
  });
});

describe('isFullyContainedInAnyPrior', () => {
  it('false on empty priors', () => {
    expect(isFullyContainedInAnyPrior({ startLine: 10, endLine: 20 }, [])).toBe(false);
  });

  it('false when no single prior fully contains', () => {
    // priors 1..15 and 18..30 — together cover 10..20, but no single prior does.
    expect(isFullyContainedInAnyPrior({ startLine: 10, endLine: 20 }, [{ startLine: 1, endLine: 15 }, { startLine: 18, endLine: 30 }])).toBe(false);
  });

  it('true when one prior fully contains', () => {
    expect(isFullyContainedInAnyPrior({ startLine: 10, endLine: 20 }, [{ startLine: 5, endLine: 25 }])).toBe(true);
  });

  it('true when prior exactly equals requested', () => {
    expect(isFullyContainedInAnyPrior({ startLine: 10, endLine: 20 }, [{ startLine: 10, endLine: 20 }])).toBe(true);
  });

  it('false on null requested range', () => {
    expect(isFullyContainedInAnyPrior({ startLine: null, endLine: null }, [{ startLine: 1, endLine: 100 }])).toBe(false);
  });
});

describe('createRuntimeMcpCallTelemetry — onToolUse + snapshot', () => {
  it('ignores non-runtime-MCP tool_use events', () => {
    const t = createRuntimeMcpCallTelemetry();
    t.onToolUse(tu('Read', { file_path: '/a.js' }));
    t.onToolUse(tu('Grep', { pattern: 'foo' }));
    t.onToolUse(tu('mcp__playwright__browser_click', {}));
    t.onToolUse(tu('mcp__atlas-review__atlas_review_status', {}));
    expect(t.snapshot().calls).toHaveLength(0);
    expect(t.snapshot().summary.callCount).toBe(0);
  });

  it('ignores non-tool_use events (e.g., tool_result, assistant)', () => {
    const t = createRuntimeMcpCallTelemetry();
    t.onToolUse({ type: 'tool_result', name: 'mcp__atlas-review-rt__read_file_slice', content: '...' });
    t.onToolUse({ type: 'assistant', name: 'mcp__atlas-review-rt__read_file_slice' });
    expect(t.snapshot().calls).toHaveLength(0);
  });

  it('ignores runtime-MCP events with no path', () => {
    const t = createRuntimeMcpCallTelemetry();
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { startLine: 1, endLine: 5 }));
    expect(t.snapshot().calls).toHaveLength(0);
  });

  it('records read_file_slice call with requested range', () => {
    const t = createRuntimeMcpCallTelemetry();
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'a.cs', startLine: 10, endLine: 50 }));
    const snap = t.snapshot();
    expect(snap.calls).toHaveLength(1);
    expect(snap.calls[0]).toMatchObject({
      tool: 'read_file_slice',
      path: 'a.cs',
      requestedStartLine: 10,
      requestedEndLine: 50,
      line: null,
      contextLines: null,
      effectiveStartLine: null,
      effectiveEndLine: null,
      repeatedReadIndexForPath: 0,
      overlapPctWithPriorOnPath: null,
      fullyContainedInPriorRead: false,
    });
  });

  it('records get_hunk_context call with line + contextLines', () => {
    const t = createRuntimeMcpCallTelemetry();
    t.onToolUse(tu('mcp__atlas-review-rt__get_hunk_context', { path: 'a.cs', line: 42, contextLines: 5 }));
    const snap = t.snapshot();
    expect(snap.calls[0]).toMatchObject({
      tool: 'get_hunk_context',
      path: 'a.cs',
      requestedStartLine: 37,
      requestedEndLine: 47,
      line: 42,
      contextLines: 5,
    });
  });

  it('records get_diff_for_file with null range, still counts toward path', () => {
    const t = createRuntimeMcpCallTelemetry();
    t.onToolUse(tu('mcp__atlas-review-rt__get_diff_for_file', { path: 'a.cs' }));
    t.onToolUse(tu('mcp__atlas-review-rt__get_diff_for_file', { path: 'a.cs' }));
    const snap = t.snapshot();
    expect(snap.calls).toHaveLength(2);
    expect(snap.calls[0].repeatedReadIndexForPath).toBe(0);
    expect(snap.calls[1].repeatedReadIndexForPath).toBe(1);
    // Range fields null; overlap/contained null because get_diff_for_file
    // is not a range tool.
    expect(snap.calls[0].overlapPctWithPriorOnPath).toBeNull();
    expect(snap.calls[1].overlapPctWithPriorOnPath).toBeNull();
    expect(snap.calls[1].fullyContainedInPriorRead).toBeNull();
  });

  it('computes overlap % across repeated reads on the same path', () => {
    const t = createRuntimeMcpCallTelemetry();
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'a.cs', startLine: 1, endLine: 100 }));
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'a.cs', startLine: 50, endLine: 150 })); // overlap 50..100 = 51 lines / 101 lines requested
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'a.cs', startLine: 25, endLine: 75 }));  // fully contained in prior union 1..150
    const snap = t.snapshot();
    expect(snap.calls).toHaveLength(3);
    expect(snap.calls[0].overlapPctWithPriorOnPath).toBeNull();
    expect(snap.calls[1].overlapPctWithPriorOnPath).toBeCloseTo((51 / 101) * 100, 1);
    expect(snap.calls[1].fullyContainedInPriorRead).toBe(false);
    expect(snap.calls[2].fullyContainedInPriorRead).toBe(true);
    expect(snap.calls[2].overlapPctWithPriorOnPath).toBe(100);
  });

  it('snapshot summary reports per-tool counts and same-path stats', () => {
    const t = createRuntimeMcpCallTelemetry();
    // 3 calls on a.cs (one diff, two slices), 1 call on b.cs (slice), 2 calls on c.cs (hunk + slice)
    t.onToolUse(tu('mcp__atlas-review-rt__get_diff_for_file', { path: 'a.cs' }));
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'a.cs', startLine: 1, endLine: 50 }));
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'a.cs', startLine: 1, endLine: 50 })); // fully contained
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'b.cs', startLine: 1, endLine: 5 }));
    t.onToolUse(tu('mcp__atlas-review-rt__get_hunk_context', { path: 'c.cs', line: 100, contextLines: 10 }));
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'c.cs', startLine: 90, endLine: 110 }));
    const { summary } = t.snapshot();
    expect(summary.callCount).toBe(6);
    expect(summary.perToolCounts).toEqual({
      read_file_slice: 4,
      get_hunk_context: 1,
      get_diff_for_file: 1,
    });
    expect(summary.samePathCallCountMax).toBe(3);
    expect(summary.fullyContainedRedundantReads).toBeGreaterThanOrEqual(1);
    // a.cs has 3 calls and is the top repeated path
    expect(summary.topRepeatedPaths[0]).toEqual({ path: 'a.cs', count: 3 });
  });

  it('reset clears records and prior-range state', () => {
    const t = createRuntimeMcpCallTelemetry();
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'a.cs', startLine: 1, endLine: 50 }));
    t.reset();
    t.onToolUse(tu('mcp__atlas-review-rt__read_file_slice', { path: 'a.cs', startLine: 1, endLine: 50 }));
    const snap = t.snapshot();
    expect(snap.calls).toHaveLength(1);
    expect(snap.calls[0].repeatedReadIndexForPath).toBe(0);
  });
});
