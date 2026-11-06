/**
 * Lightweight hunk-grouped parser for unified-diff `patch` bodies that
 * `BranchReviewFileContent.patch` ships with. Unlike
 * `parseUnifiedPatchToDiffLines` in `./diff`, this preserves hunk
 * boundaries so the Walkthrough right pane can render each hunk with
 * its own `@@` header and split hunks at recommendation line numbers.
 *
 * Kept intentionally small (target: under 80 lines) — no word-diff
 * highlighting, no rename parsing, no "\ No newline at end of file"
 * handling beyond skipping.
 */

import type { DiffHunkLine } from '@/components/review/primitives';

export interface ParsedPatchHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffHunkLine[];
  /** Inclusive new-file line-number range of `+`/` ` lines in this hunk. */
  newRange: { start: number; end: number } | null;
}

export function parsePatch(patchText: string | null | undefined): ParsedPatchHunk[] {
  if (typeof patchText !== 'string' || !patchText.trim()) return [];

  const src = patchText.replace(/\r\n/g, '\n').split('\n');
  const hunks: ParsedPatchHunk[] = [];

  let current: ParsedPatchHunk | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (const raw of src) {
    if (raw.startsWith('@@')) {
      const match = raw.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@.*$/);
      if (!match) {
        current = null;
        continue;
      }
      oldNum = Number.parseInt(match[1], 10);
      newNum = Number.parseInt(match[2], 10);
      current = {
        header: raw,
        oldStart: oldNum,
        newStart: newNum,
        lines: [],
        newRange: null,
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (!raw) continue;

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.lines.push({ kind: '+', n: newNum, text: raw.slice(1) });
      current.newRange = {
        start: current.newRange?.start ?? newNum,
        end: newNum,
      };
      newNum += 1;
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      current.lines.push({ kind: '-', n: oldNum, text: raw.slice(1) });
      oldNum += 1;
      continue;
    }
    if (raw.startsWith(' ')) {
      current.lines.push({ kind: ' ', n: newNum, text: raw.slice(1) });
      current.newRange = {
        start: current.newRange?.start ?? newNum,
        end: newNum,
      };
      oldNum += 1;
      newNum += 1;
      continue;
    }
    // "\ No newline at end of file" and file-header metadata are skipped.
  }

  return hunks;
}
