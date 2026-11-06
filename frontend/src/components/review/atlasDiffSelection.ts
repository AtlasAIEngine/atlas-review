import type { ReviewAgentAttachment } from '@/services/reviewAgentApi';

export type AtlasDiffSelection = {
  attachment: Extract<ReviewAgentAttachment, { type: 'line_range' }>;
  prompt: string;
  rect: { top: number; left: number };
};

function getAtlasDiffLineMeta(element: Element): {
  path: string;
  side: 'LEFT' | 'RIGHT';
  lineNumber: number;
} | null {
  if (!(element instanceof HTMLElement)) return null;
  const path = String(element.dataset.atlasDiffPath || '').trim();
  const side = element.dataset.atlasDiffSide === 'LEFT' || element.dataset.atlasDiffSide === 'RIGHT'
    ? element.dataset.atlasDiffSide
    : null;
  const lineNumber = Number.parseInt(String(element.dataset.atlasDiffLineNumber || ''), 10);
  if (!path || !side || !Number.isFinite(lineNumber) || lineNumber <= 0) return null;
  return { path, side, lineNumber };
}

function lineElementIntersectsRange(element: Element, range: Range): boolean {
  try {
    return range.intersectsNode(element);
  } catch {
    return false;
  }
}

function extractAtlasLineCode(lineElement: Element): string {
  // Each diff row is a flex container with separate cells for the note
  // button (●/+), gutter (─/+/−), line numbers, and code. Selection.toString()
  // inserts newlines at every block boundary, exploding "+  44  try {" into
  // four separate lines. Pull the dedicated code cell instead.
  const contentCell = lineElement.querySelector('[data-atlas-diff-content="true"]');
  if (contentCell instanceof HTMLElement) {
    return contentCell.innerText.replace(/\s+$/u, '');
  }
  return '';
}

export function resolveAtlasDiffSelection(container: HTMLElement | null): AtlasDiffSelection | null {
  const selection = window.getSelection();
  if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (!anchorNode || !focusNode || !container.contains(anchorNode) || !container.contains(focusNode)) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const lineElements = Array.from(container.querySelectorAll('[data-atlas-diff-line="true"]'))
    .filter((element) => lineElementIntersectsRange(element, range));
  const metas = lineElements
    .map(getAtlasDiffLineMeta)
    .filter((meta): meta is NonNullable<ReturnType<typeof getAtlasDiffLineMeta>> => Boolean(meta));
  if (metas.length === 0) {
    return null;
  }

  const first = metas[0];
  if (metas.some((meta) => meta.path !== first.path || meta.side !== first.side)) {
    return null;
  }

  const lineNumbers = metas.map((meta) => meta.lineNumber);
  const startLine = Math.min(...lineNumbers);
  const endLine = Math.max(...lineNumbers);

  // Reconstruct code from per-line content cells in line-number order so the
  // captured text matches what the user visually selected, not what
  // Selection.toString() produces over the multi-cell layout.
  const orderedLines = lineElements
    .map((element, index) => ({ element, meta: metas[index] }))
    .filter((entry) => entry.meta != null)
    .sort((a, b) => a.meta!.lineNumber - b.meta!.lineNumber)
    .map((entry) => extractAtlasLineCode(entry.element));
  const selectedText = orderedLines.join('\n').replace(/\n+$/u, '');
  if (!selectedText.trim()) {
    return null;
  }

  const rangeRect = range.getBoundingClientRect();
  const fallbackRect = lineElements[0]?.getBoundingClientRect();
  const rect = rangeRect.width > 0 || rangeRect.height > 0 ? rangeRect : fallbackRect;
  if (!rect) {
    return null;
  }

  return {
    attachment: {
      type: 'line_range',
      path: first.path,
      side: first.side,
      startLine,
      endLine,
      selectedText,
    },
    prompt: 'Can you explain me this code?',
    rect: {
      top: Math.max(8, Math.min(rect.top - 42, window.innerHeight - 52)),
      left: Math.max(8, Math.min(rect.left + (rect.width / 2) - 56, window.innerWidth - 132)),
    },
  };
}
