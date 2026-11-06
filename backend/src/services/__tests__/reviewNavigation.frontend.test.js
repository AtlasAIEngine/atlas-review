import { describe, it, expect } from 'vitest';
import {
  formatRecommendationSourceLocation,
  getRecommendationPatchFile,
  getRecommendationDiffNavigationTarget,
  getRecommendationPatchLine,
  isRecommendationSourceOnly,
  parseRecommendationLocation,
  resolveRecommendationDisplayAnchor,
  resolveDisplayLineTarget,
  resolveRenderedLineTarget,
} from '../../../../frontend/src/utils/reviewNavigation.ts';

describe('frontend reviewNavigation utils', () => {
  describe('parseRecommendationLocation', () => {
    it('returns null for empty input', () => {
      expect(parseRecommendationLocation('')).toBeNull();
      expect(parseRecommendationLocation(undefined)).toBeNull();
    });

    it('parses file:line location from file field', () => {
      expect(parseRecommendationLocation('backend/server.js:42')).toEqual({
        filePath: 'backend/server.js',
        line: 42,
      });
    });

    it('prefers explicit line over embedded line', () => {
      expect(parseRecommendationLocation('backend/server.js:42', 120)).toEqual({
        filePath: 'backend/server.js',
        line: 120,
      });
    });

    it('returns string path when no line is available', () => {
      expect(parseRecommendationLocation('backend/server.js')).toBe('backend/server.js');
    });
  });

  describe('resolveDisplayLineTarget', () => {
    it('returns exact match when target line exists', () => {
      const lines = [
        { type: 'ctx', oldNum: 9, newNum: 9, oldSeg: [], newSeg: [] },
        { type: 'add', oldNum: null, newNum: 10, oldSeg: [], newSeg: [] },
        { type: 'ctx', oldNum: 11, newNum: 11, oldSeg: [], newSeg: [] },
      ];
      expect(resolveDisplayLineTarget(lines, 10)).toEqual({ index: 1, exact: true });
    });

    it('falls back to nearest diff hunk when exact line is missing', () => {
      const lines = [
        { type: 'ctx', oldNum: 1, newNum: 1, oldSeg: [], newSeg: [] },
        { type: 'add', oldNum: null, newNum: 5, oldSeg: [], newSeg: [] },
        { type: 'ctx', oldNum: 6, newNum: 6, oldSeg: [], newSeg: [] },
      ];
      expect(resolveDisplayLineTarget(lines, 20)).toEqual({
        index: 1,
        exact: false,
        fallback: 'nearest-hunk',
      });
    });

    it('falls back to file top when there are no changed lines', () => {
      const lines = [
        { type: 'collapsed', startIdx: 0, endIdx: 5, oldStart: 1, newStart: 1, count: 5 },
        { type: 'ctx', oldNum: 6, newNum: 6, oldSeg: [], newSeg: [] },
        { type: 'ctx', oldNum: 7, newNum: 7, oldSeg: [], newSeg: [] },
      ];
      expect(resolveDisplayLineTarget(lines, 100)).toEqual({
        index: 1,
        exact: false,
        fallback: 'file-top',
      });
    });
  });

  describe('resolveRenderedLineTarget', () => {
    it('returns exact match when rendered line exists', () => {
      expect(resolveRenderedLineTarget([39, 52, 82, 108], 82)).toEqual({
        line: 82,
        exact: true,
      });
    });

    it('falls back to the nearest rendered line when source line is outside the patch', () => {
      expect(resolveRenderedLineTarget([39, 52, 108, 109, 110], 82)).toEqual({
        line: 108,
        exact: false,
      });
    });

    it('returns null when no rendered lines are available', () => {
      expect(resolveRenderedLineTarget([], 82)).toBeNull();
      expect(resolveRenderedLineTarget([null, undefined], 82)).toBeNull();
    });
  });

  describe('recommendation anchor helpers', () => {
    it('formats source locations from explicit source anchors', () => {
      expect(formatRecommendationSourceLocation({
        file: 'src/contracts.ts',
        line: 60,
        sourceAnchor: { file: 'src/contracts.ts', line: 59 },
      })).toBe('src/contracts.ts:59');
    });

    it('uses patch anchors for diff navigation when available', () => {
      expect(getRecommendationPatchFile({
        patchAnchor: { file: 'src/contracts.ts', line: 60, status: 'nearby_unique_line' },
      })).toBe('src/contracts.ts');
      expect(getRecommendationPatchLine({
        patchAnchor: { file: 'src/contracts.ts', line: 60, status: 'nearby_unique_line' },
      })).toBe(60);
      expect(getRecommendationDiffNavigationTarget({
        file: 'src/contracts.ts',
        line: 59,
        sourceAnchor: { file: 'src/contracts.ts', line: 59 },
        patchAnchor: { file: 'src/contracts.ts', line: 60, status: 'nearby_unique_line' },
      })).toEqual({
        filePath: 'src/contracts.ts',
        line: 60,
      });
    });

    it('prefers patchAnchor.file over the source path for diff navigation', () => {
      expect(getRecommendationDiffNavigationTarget({
        file: 'src/old-name.ts',
        line: 59,
        sourceAnchor: { file: 'src/old-name.ts', line: 59 },
        patchAnchor: { file: 'src/new-name.ts', line: 60, status: 'patch' },
      })).toEqual({
        filePath: 'src/new-name.ts',
        line: 60,
      });
    });

    it('falls back to file-only navigation for outside-patch findings', () => {
      expect(getRecommendationPatchLine({
        patchAnchor: { file: 'src/patrol.ts', line: null, status: 'outside_patch' },
      })).toBeNull();
      expect(isRecommendationSourceOnly({
        file: 'src/patrol.ts',
        line: 247,
        sourceAnchor: { file: 'src/patrol.ts', line: 247 },
        patchAnchor: { file: 'src/patrol.ts', line: null, status: 'outside_patch' },
      })).toBe(true);
      expect(getRecommendationDiffNavigationTarget({
        file: 'src/patrol.ts',
        line: 247,
        sourceAnchor: { file: 'src/patrol.ts', line: 247 },
        patchAnchor: { file: 'src/patrol.ts', line: null, status: 'outside_patch' },
      })).toEqual({
        filePath: 'src/patrol.ts',
        line: 247,
      });
    });

    it('treats file_not_in_diff findings as source-only', () => {
      expect(isRecommendationSourceOnly({
        file: 'src/view.ts',
        line: 58,
        sourceAnchor: { file: 'src/view.ts', line: 58 },
        patchAnchor: { file: 'src/view.ts', line: null, status: 'file_not_in_diff' },
      })).toBe(true);
      expect(getRecommendationDiffNavigationTarget({
        file: 'src/view.ts',
        line: 58,
        sourceAnchor: { file: 'src/view.ts', line: 58 },
        patchAnchor: { file: 'src/view.ts', line: null, status: 'file_not_in_diff' },
      })).toEqual({
        filePath: 'src/view.ts',
        line: 58,
      });
    });

    it('renders outside-patch findings near the closest visible diff line when available', () => {
      expect(resolveRecommendationDisplayAnchor({
        file: 'src/view.ts',
        line: 82,
        sourceAnchor: { file: 'src/view.ts', line: 82 },
        patchAnchor: { file: 'src/view.ts', line: null, status: 'outside_patch' },
      }, [39, 52, 108, 109])).toEqual({
        filePath: 'src/view.ts',
        line: 108,
        mode: 'nearby-rendered-line',
        sourceLine: 82,
        patchLine: null,
        patchStatus: 'outside_patch',
      });
    });

    it('prefers the exact visible source line when the source anchor is already rendered', () => {
      expect(resolveRecommendationDisplayAnchor({
        file: 'src/view.ts',
        line: 23,
        sourceAnchor: { file: 'src/view.ts', line: 23 },
        patchAnchor: { file: 'src/view.ts', line: null, status: 'file_not_in_diff' },
      }, [1, 2, 23, 24])).toEqual({
        filePath: 'src/view.ts',
        line: 23,
        mode: 'source-visible',
        sourceLine: 23,
        patchLine: null,
        patchStatus: 'file_not_in_diff',
      });
    });
  });
});
