import { describe, it, expect } from 'vitest';
import { derivePrLifecycleState } from '../githubService.js';

describe('derivePrLifecycleState', () => {
  it('treats merged PRs as merged regardless of draft flag', () => {
    expect(derivePrLifecycleState({ state: 'closed', merged_at: '2026-05-09T00:00:00Z', draft: false })).toBe('merged');
    expect(derivePrLifecycleState({ state: 'closed', merged_at: '2026-05-09T00:00:00Z', draft: true })).toBe('merged');
  });

  // Regression: a draft PR that was closed (without merging) was previously
  // surfaced as 'draft' — falsely treating it as an active PR in the UI.
  it('treats closed draft PRs as closed, not draft', () => {
    expect(derivePrLifecycleState({ state: 'closed', merged_at: null, draft: true })).toBe('closed');
  });

  it('treats closed non-draft PRs as closed', () => {
    expect(derivePrLifecycleState({ state: 'closed', merged_at: null, draft: false })).toBe('closed');
  });

  it('treats open draft PRs as draft', () => {
    expect(derivePrLifecycleState({ state: 'open', merged_at: null, draft: true })).toBe('draft');
  });

  it('treats open non-draft PRs as open', () => {
    expect(derivePrLifecycleState({ state: 'open', merged_at: null, draft: false })).toBe('open');
  });

  it('falls back to open for missing input', () => {
    expect(derivePrLifecycleState(null)).toBe('open');
    expect(derivePrLifecycleState({})).toBe('open');
  });
});
