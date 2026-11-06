import { describe, it, expect } from 'vitest';
import {
  classifyToolEvent,
  TOOL_EVENT_KINDS,
  __testables,
} from '../reviewToolEventClassifier.js';

const { isGitDiffCommand, isGitInvocation, extractTarget } = __testables;

describe('classifyToolEvent — Read', () => {
  it('classifies a Read with no offset/limit as full_file_read', () => {
    expect(classifyToolEvent({ name: 'Read', input: { file_path: '/p/a.js' } }))
      .toEqual({ kind: 'full_file_read', target: '/p/a.js' });
  });

  it('classifies a Read with offset>0 as partial_file_read', () => {
    expect(classifyToolEvent({ name: 'Read', input: { file_path: '/p/a.js', offset: 100 } }).kind)
      .toBe('partial_file_read');
  });

  it('classifies a Read with limit>0 as partial_file_read', () => {
    expect(classifyToolEvent({ name: 'Read', input: { file_path: '/p/a.js', limit: 50 } }).kind)
      .toBe('partial_file_read');
  });

  it('treats offset:0 / limit:0 as full_file_read', () => {
    expect(classifyToolEvent({ name: 'Read', input: { file_path: '/p/a.js', offset: 0, limit: 0 } }).kind)
      .toBe('full_file_read');
  });

  it('returns null target when file_path missing', () => {
    expect(classifyToolEvent({ name: 'Read', input: {} }).target).toBeNull();
  });
});

describe('classifyToolEvent — Grep / Glob / LS', () => {
  it('classifies Grep', () => {
    expect(classifyToolEvent({ name: 'Grep', input: { pattern: 'foo', path: 'src' } }))
      .toEqual({ kind: 'grep', target: 'src' });
  });
  it('classifies Glob', () => {
    expect(classifyToolEvent({ name: 'Glob', input: { pattern: '**/*.js' } }).kind).toBe('glob');
  });
  it('classifies LS as glob', () => {
    expect(classifyToolEvent({ name: 'LS', input: { path: '/x' } }).kind).toBe('glob');
  });
});

describe('classifyToolEvent — mutations', () => {
  it('classifies Edit', () => {
    expect(classifyToolEvent({ name: 'Edit', input: { file_path: '/p/a.js' } })).toEqual({ kind: 'edit', target: '/p/a.js' });
  });
  it('classifies NotebookEdit as edit', () => {
    expect(classifyToolEvent({ name: 'NotebookEdit', input: { notebook_path: '/p/a.ipynb' } })).toEqual({ kind: 'edit', target: '/p/a.ipynb' });
  });
  it('classifies Write', () => {
    expect(classifyToolEvent({ name: 'Write', input: { file_path: '/p/a.js' } })).toEqual({ kind: 'write', target: '/p/a.js' });
  });
});

describe('classifyToolEvent — Bash', () => {
  it('classifies plain `git diff` as git_diff', () => {
    expect(classifyToolEvent({ name: 'Bash', input: { command: 'git diff HEAD~1' } }).kind).toBe('git_diff');
  });
  it('classifies `git --no-pager diff` as git_diff', () => {
    expect(classifyToolEvent({ name: 'Bash', input: { command: 'git --no-pager diff' } }).kind).toBe('git_diff');
  });
  it('classifies `git -c color.ui=false diff` as git_diff', () => {
    expect(classifyToolEvent({ name: 'Bash', input: { command: 'git -c color.ui=false diff main..HEAD' } }).kind).toBe('git_diff');
  });
  it('does NOT classify `git difftool` as git_diff', () => {
    expect(classifyToolEvent({ name: 'Bash', input: { command: 'git difftool' } }).kind).toBe('git_other');
  });
  it('does NOT classify `git diff-files` as git_diff', () => {
    expect(classifyToolEvent({ name: 'Bash', input: { command: 'git diff-files' } }).kind).toBe('git_other');
  });
  it('does NOT classify substring "git diff" inside arg as git_diff', () => {
    expect(classifyToolEvent({ name: 'Bash', input: { command: 'echo "this prints git diff output"' } }).kind).toBe('shell');
  });
  it('classifies `git status` as git_other', () => {
    expect(classifyToolEvent({ name: 'Bash', input: { command: 'git status' } }).kind).toBe('git_other');
  });
  it('classifies non-git Bash as shell', () => {
    expect(classifyToolEvent({ name: 'Bash', input: { command: 'ls -la' } }).kind).toBe('shell');
  });
  it('handles missing command field as shell (best-effort)', () => {
    expect(classifyToolEvent({ name: 'Bash', input: {} }).kind).toBe('shell');
  });
});

describe('classifyToolEvent — web / mcp / other / unclassified', () => {
  it('classifies WebFetch as web', () => {
    expect(classifyToolEvent({ name: 'WebFetch', input: { url: 'https://x' } }).kind).toBe('web');
  });
  it('classifies WebSearch as web', () => {
    expect(classifyToolEvent({ name: 'WebSearch', input: { query: 'q' } }).kind).toBe('web');
  });
  it('classifies mcp__foo__bar as mcp', () => {
    expect(classifyToolEvent({ name: 'mcp__atlas-review__atlas_review_status', input: {} }).kind).toBe('mcp');
  });
  it('Section R Phase B: maps mcp__atlas-review-rt__get_diff_for_file to git_diff', () => {
    const result = classifyToolEvent({
      name: 'mcp__atlas-review-rt__get_diff_for_file',
      input: { path: 'src/foo.js' },
    });
    expect(result.kind).toBe('git_diff');
    expect(result.target).toBe('src/foo.js');
  });
  it('Section R Phase B: maps mcp__atlas-review-rt__read_file_slice to partial_file_read', () => {
    const result = classifyToolEvent({
      name: 'mcp__atlas-review-rt__read_file_slice',
      input: { path: 'src/bar.js', startLine: 10, endLine: 50 },
    });
    expect(result.kind).toBe('partial_file_read');
    expect(result.target).toBe('src/bar.js');
  });
  it('Section R Phase B: maps mcp__atlas-review-rt__get_hunk_context to partial_file_read', () => {
    const result = classifyToolEvent({
      name: 'mcp__atlas-review-rt__get_hunk_context',
      input: { path: 'src/baz.js', line: 42 },
    });
    expect(result.kind).toBe('partial_file_read');
    expect(result.target).toBe('src/baz.js');
  });
  it('Section R Phase B: unknown atlas-review-rt subtools fall back to mcp', () => {
    // If a future Phase B-N tool ships before the classifier mapping is
    // updated, the agent should still see the call recorded — just under
    // the generic mcp bucket rather than misclassified into a wrong kind.
    expect(classifyToolEvent({
      name: 'mcp__atlas-review-rt__some_future_tool',
      input: { path: 'x' },
    }).kind).toBe('mcp');
  });
  it('Section R Phase B: other mcp__* servers still bucket as mcp', () => {
    // Only the runtime-MCP tools should remap. The consumer-side
    // mcp-review-server (atlas_review_*) and any other MCP servers stay
    // generic so we don't accidentally tag them as file reads.
    expect(classifyToolEvent({
      name: 'mcp__atlas-review__atlas_review_latest',
      input: {},
    }).kind).toBe('mcp');
    expect(classifyToolEvent({
      name: 'mcp__playwright__browser_click',
      input: {},
    }).kind).toBe('mcp');
  });
  it('classifies an unknown tool name as other (recognized but unclassified kind)', () => {
    expect(classifyToolEvent({ name: 'TodoWrite', input: {} }).kind).toBe('other');
  });
  it('classifies null event as unclassified', () => {
    expect(classifyToolEvent(null).kind).toBe('unclassified');
  });
  it('classifies missing name as unclassified', () => {
    expect(classifyToolEvent({ input: {} }).kind).toBe('unclassified');
  });
  it('classifies non-string name as unclassified', () => {
    expect(classifyToolEvent({ name: 42, input: {} }).kind).toBe('unclassified');
  });
});

describe('isGitDiffCommand internal helper', () => {
  it('detects diff at line start', () => expect(isGitDiffCommand('git diff')).toBe(true));
  it('rejects empty', () => expect(isGitDiffCommand('')).toBe(false));
  it('rejects non-git', () => expect(isGitDiffCommand('cat file')).toBe(false));
  it('detects after `set -e;`', () => expect(isGitDiffCommand('set -e; git diff')).toBe(true));
  it('rejects diff-tree', () => expect(isGitDiffCommand('git diff-tree HEAD')).toBe(false));
});

describe('isGitInvocation internal helper', () => {
  it('detects git status', () => expect(isGitInvocation('git status')).toBe(true));
  it('rejects "agitator"', () => expect(isGitInvocation('agitator --git')).toBe(false));
});

describe('extractTarget internal helper', () => {
  it('returns file_path for Read', () => {
    expect(extractTarget('Read', { file_path: '/p/a.js' })).toBe('/p/a.js');
  });
  it('returns null for Bash', () => {
    expect(extractTarget('Bash', { command: 'ls' })).toBeNull();
  });
});

describe('TOOL_EVENT_KINDS', () => {
  it('is frozen and contains the canonical set', () => {
    expect(Object.isFrozen(TOOL_EVENT_KINDS)).toBe(true);
    expect(TOOL_EVENT_KINDS).toContain('full_file_read');
    expect(TOOL_EVENT_KINDS).toContain('git_diff');
    expect(TOOL_EVENT_KINDS).toContain('unclassified');
  });
});
