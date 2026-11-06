import { describe, expect, it } from 'vitest';

import {
  getVisibleReviewFileLimit,
  resolveVisibleReviewFileLimit,
  selectVisibleReviewFiles,
  summarizeVisibleReviewFiles,
} from '../reviewFileSelection.js';

describe('reviewFileSelection', () => {
  it('keeps recommendation-backed files visible ahead of non-code assets', () => {
    const files = [
      { path: 'Assets/Textures/ship.png', additions: 0, deletions: 0, status: 'M', oldPath: null },
      { path: 'Assets/Scripts/Combat/Bot.cs', additions: 4, deletions: 2, status: 'M', oldPath: null },
      { path: 'Assets/Scenes/Arena.unity', additions: 10, deletions: 3, status: 'M', oldPath: null },
    ];
    const visible = selectVisibleReviewFiles(files, {
      reviewJson: {
        recommendations: [
          { type: 'issue', file: 'Assets/Scenes/Arena.unity' },
        ],
      },
    }, 2);

    expect(visible.map((file) => file.path)).toEqual([
      'Assets/Scenes/Arena.unity',
      'Assets/Scripts/Combat/Bot.cs',
    ]);
  });

  it('summarizes hidden file counts from the capped manifest', () => {
    const visible = Array.from({ length: 3 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      additions: 1,
      deletions: 0,
      status: 'M',
      oldPath: null,
    }));
    const summary = summarizeVisibleReviewFiles(visible, 9, 3);

    expect(summary).toEqual({
      visibleCount: 3,
      totalCount: 9,
      hiddenCount: 6,
      maxVisible: 3,
      isCapped: true,
    });
    expect(getVisibleReviewFileLimit()).toBeGreaterThan(0);
  });

  describe('resolveVisibleReviewFileLimit', () => {
    const defaultLimit = getVisibleReviewFileLimit();

    it('returns the default when no override is provided', () => {
      expect(resolveVisibleReviewFileLimit(undefined)).toBe(defaultLimit);
      expect(resolveVisibleReviewFileLimit(null)).toBe(defaultLimit);
    });

    it('returns the default when override is invalid or non-positive', () => {
      expect(resolveVisibleReviewFileLimit('not-a-number')).toBe(defaultLimit);
      expect(resolveVisibleReviewFileLimit('0')).toBe(defaultLimit);
      expect(resolveVisibleReviewFileLimit(-50)).toBe(defaultLimit);
    });

    it('clamps overrides below the default up to the default (never lower)', () => {
      expect(resolveVisibleReviewFileLimit(10)).toBe(defaultLimit);
    });

    it('respects valid overrides above the default and floors fractional values', () => {
      expect(resolveVisibleReviewFileLimit(defaultLimit + 50)).toBe(defaultLimit + 50);
      expect(resolveVisibleReviewFileLimit('250.7')).toBe(250);
    });

    it('clamps overrides above the safety ceiling', () => {
      expect(resolveVisibleReviewFileLimit(99999)).toBe(5000);
    });
  });
});
