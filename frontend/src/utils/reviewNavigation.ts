import type { DiffLineOrCollapsed } from '@/utils/diff';
import type { ReviewRecommendation } from '@/types';

export type DiffNavigationTarget = string | {
  filePath: string;
  line?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
  suppressNearestDiffToast?: boolean;
};

export type RecommendationDisplayAnchorMode =
  | 'patch'
  | 'source-visible'
  | 'nearby-rendered-line'
  | 'source-only';

export interface RecommendationDisplayAnchor {
  filePath: string;
  line: number | null;
  mode: RecommendationDisplayAnchorMode;
  sourceLine: number | null;
  patchLine: number | null;
  patchStatus: string | null;
}

export function getRecommendationSourceFile(rec?: Pick<ReviewRecommendation, 'file' | 'sourceAnchor'> | null): string {
  const sourceFile = typeof rec?.sourceAnchor?.file === 'string' ? rec.sourceAnchor.file.trim() : '';
  if (sourceFile) return sourceFile;
  return typeof rec?.file === 'string' ? rec.file.trim() : '';
}

export function getRecommendationSourceLine(rec?: Pick<ReviewRecommendation, 'line' | 'sourceAnchor'> | null): number | null {
  const rawLine = rec?.sourceAnchor?.line ?? rec?.line;
  return Number.isFinite(Number(rawLine)) && Number(rawLine) > 0
    ? Math.floor(Number(rawLine))
    : null;
}

function normalizePositiveLine(rawLine: unknown): number | null {
  return Number.isFinite(Number(rawLine)) && Number(rawLine) > 0
    ? Math.floor(Number(rawLine))
    : null;
}

export function getRecommendationPatchLine(rec?: Pick<ReviewRecommendation, 'patchAnchor'> | null): number | null {
  const status = String(rec?.patchAnchor?.status || '').trim().toLowerCase();
  const rawLine = rec?.patchAnchor?.line;
  const line = normalizePositiveLine(rawLine);
  if (!line) return null;
  if (status === 'outside_patch' || status === 'file_not_in_diff' || status === 'diff_unavailable' || status === 'unanchored') {
    return null;
  }
  return line;
}

export function getRecommendationPatchFile(rec?: Pick<ReviewRecommendation, 'patchAnchor'> | null): string {
  const patchFile = typeof rec?.patchAnchor?.file === 'string' ? rec.patchAnchor.file.trim() : '';
  return patchFile;
}

export function getRecommendationPatchStatus(rec?: Pick<ReviewRecommendation, 'patchAnchor'> | null): string | null {
  const status = String(rec?.patchAnchor?.status || '').trim().toLowerCase();
  return status || null;
}

export function isRecommendationSourceOnly(
  rec?: Pick<ReviewRecommendation, 'file' | 'line' | 'sourceAnchor' | 'patchAnchor'> | null
): boolean {
  const sourceLine = getRecommendationSourceLine(rec);
  const patchLine = getRecommendationPatchLine(rec);
  const status = getRecommendationPatchStatus(rec);
  if (sourceLine == null || patchLine != null) return false;
  return status === 'outside_patch'
    || status === 'file_not_in_diff'
    || status === 'diff_unavailable'
    || status === 'unanchored';
}

export function getRecommendationDiffNavigationTarget(
  rec?: Pick<ReviewRecommendation, 'file' | 'line' | 'sourceAnchor' | 'patchAnchor'> | null
): DiffNavigationTarget | null {
  const sourceFilePath = getRecommendationSourceFile(rec);
  const patchFilePath = getRecommendationPatchFile(rec);
  const patchLine = getRecommendationPatchLine(rec);
  if (patchLine != null) {
    const filePath = patchFilePath || sourceFilePath;
    if (!filePath) return null;
    return { filePath, line: patchLine };
  }
  if (!sourceFilePath) return null;
  const sourceLine = getRecommendationSourceLine(rec);
  if (sourceLine != null) {
    return { filePath: sourceFilePath, line: sourceLine };
  }
  return sourceFilePath;
}

export function resolveRecommendationDisplayAnchor(
  rec?: Pick<ReviewRecommendation, 'file' | 'line' | 'sourceAnchor' | 'patchAnchor'> | null,
  renderedLineNumbers?: Iterable<number | null | undefined> | null,
): RecommendationDisplayAnchor | null {
  const filePath = getRecommendationSourceFile(rec);
  if (!filePath) return null;

  const sourceLine = getRecommendationSourceLine(rec);
  const patchLine = getRecommendationPatchLine(rec);
  const patchStatus = getRecommendationPatchStatus(rec);

  if (patchLine != null) {
    return {
      filePath,
      line: patchLine,
      mode: 'patch',
      sourceLine,
      patchLine,
      patchStatus,
    };
  }

  if (sourceLine != null) {
    const renderedTarget = resolveRenderedLineTarget(
      renderedLineNumbers ? Array.from(renderedLineNumbers) : [],
      sourceLine,
    );
    if (renderedTarget?.exact) {
      return {
        filePath,
        line: renderedTarget.line,
        mode: 'source-visible',
        sourceLine,
        patchLine,
        patchStatus,
      };
    }
    if (renderedTarget && renderedTarget.line != null) {
      return {
        filePath,
        line: renderedTarget.line,
        mode: 'nearby-rendered-line',
        sourceLine,
        patchLine,
        patchStatus,
      };
    }
    return {
      filePath,
      line: null,
      mode: 'source-only',
      sourceLine,
      patchLine,
      patchStatus,
    };
  }

  return null;
}

export function formatRecommendationSourceLocation(
  rec?: Pick<ReviewRecommendation, 'file' | 'line' | 'sourceAnchor'> | null
): string {
  const filePath = getRecommendationSourceFile(rec);
  const line = getRecommendationSourceLine(rec);
  if (!filePath) return '';
  if (line != null) return `${filePath}:${line}`;
  return filePath;
}

export function formatRecommendationPatchLocation(
  rec?: Pick<ReviewRecommendation, 'file' | 'line' | 'sourceAnchor' | 'patchAnchor'> | null
): string {
  const patchLine = getRecommendationPatchLine(rec);
  if (patchLine == null) return '';

  const filePath = getRecommendationPatchFile(rec) || getRecommendationSourceFile(rec);
  if (!filePath) return '';

  const startLine = normalizePositiveLine(rec?.patchAnchor?.startLine);
  const endLine = normalizePositiveLine(rec?.patchAnchor?.endLine);
  const patchStatus = getRecommendationPatchStatus(rec);

  if (
    (patchStatus === 'exact_block' || patchStatus === 'partial_block')
    && startLine != null
    && endLine != null
  ) {
    if (startLine === endLine) {
      return `${filePath}:${startLine}`;
    }
    return `${filePath}:${startLine}-${endLine}`;
  }

  return `${filePath}:${patchLine}`;
}

export function formatRecommendationDisplayLocation(
  rec?: Pick<ReviewRecommendation, 'file' | 'line' | 'sourceAnchor' | 'patchAnchor'> | null
): string {
  return formatRecommendationPatchLocation(rec) || formatRecommendationSourceLocation(rec);
}

export function getRecommendationDisplayLocationLabel(
  rec?: Pick<ReviewRecommendation, 'patchAnchor'> | null
): 'Anchor' | 'Source' {
  return getRecommendationPatchLine(rec) != null ? 'Anchor' : 'Source';
}

function isCollapsedSection(item: DiffLineOrCollapsed): boolean {
  return (item as { type?: string }).type === 'collapsed';
}

export function parseRecommendationLocation(
  fileValue?: string,
  explicitLine?: number | null
): DiffNavigationTarget | null {
  const raw = String(fileValue || '').trim();
  if (!raw) return null;

  const rawMatch = raw.match(/^(.*):(\d+)$/);
  const parsedFilePath = rawMatch ? String(rawMatch[1] || '').trim() : raw;
  const parsedLineFromFile = rawMatch ? Number.parseInt(rawMatch[2], 10) : null;

  const safeLine = Number.isFinite(Number(explicitLine)) && Number(explicitLine) > 0
    ? Math.floor(Number(explicitLine))
    : null;
  const fallbackLine = Number.isFinite(Number(parsedLineFromFile)) && Number(parsedLineFromFile) > 0
    ? Math.floor(Number(parsedLineFromFile))
    : null;
  const resolvedLine = safeLine ?? fallbackLine;
  const resolvedPath = parsedFilePath || raw;
  if (resolvedLine) {
    return { filePath: resolvedPath, line: resolvedLine };
  }
  return resolvedPath;
}

export function resolveDisplayLineTarget(
  displayLines: DiffLineOrCollapsed[],
  targetLine: number
): { index: number; exact: boolean; fallback?: 'nearest-hunk' | 'file-top' } | null {
  let nearestHunkIndex = -1;
  let nearestHunkDistance = Number.POSITIVE_INFINITY;

  for (let idx = 0; idx < displayLines.length; idx++) {
    const item = displayLines[idx];
    if (isCollapsedSection(item)) continue;
    const lineNum = (item as { newNum?: number | null; oldNum?: number | null }).newNum
      ?? (item as { oldNum?: number | null }).oldNum;
    if (lineNum == null) continue;

    if (lineNum === targetLine) {
      return { index: idx, exact: true };
    }

    const lineType = (item as { type?: string }).type;
    const distance = Math.abs(lineNum - targetLine);
    if (lineType === 'add' || lineType === 'del') {
      if (distance < nearestHunkDistance) {
        nearestHunkDistance = distance;
        nearestHunkIndex = idx;
      }
    }
  }

  if (nearestHunkIndex >= 0) return { index: nearestHunkIndex, exact: false, fallback: 'nearest-hunk' };

  for (let idx = 0; idx < displayLines.length; idx++) {
    if (!isCollapsedSection(displayLines[idx])) {
      return { index: idx, exact: false, fallback: 'file-top' };
    }
  }

  return null;
}

export function resolveRenderedLineTarget(
  renderedLineNumbers: Array<number | null | undefined>,
  targetLine: number
): { line: number; exact: boolean } | null {
  let nearestLine: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const rawLine of renderedLineNumbers) {
    const lineNumber = Number.isFinite(Number(rawLine)) && Number(rawLine) > 0
      ? Math.floor(Number(rawLine))
      : null;
    if (lineNumber == null) continue;
    if (lineNumber === targetLine) {
      return { line: lineNumber, exact: true };
    }
    const distance = Math.abs(lineNumber - targetLine);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestLine = lineNumber;
    }
  }

  if (nearestLine == null) return null;
  return { line: nearestLine, exact: false };
}
