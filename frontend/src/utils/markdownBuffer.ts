/**
 * Streaming Markdown Buffer
 *
 * Buffers incomplete markdown constructs during streaming to prevent
 * rendering flicker (e.g. half-open code fences, unclosed bold markers).
 * Most chunks pass through immediately — only chunks that open a construct
 * without closing it incur ~1-2 chunk latency.
 */

export class MarkdownBuffer {
  private buffer = '';

  /** Append a new chunk and return the safe-to-render portion */
  append(chunk: string): string {
    this.buffer += chunk;
    const breakpoint = this.findSafeBreakpoint(this.buffer);
    const safe = this.buffer.slice(0, breakpoint);
    this.buffer = this.buffer.slice(breakpoint);
    return safe;
  }

  /** Flush any remaining buffered content (call on stream completion) */
  flush(): string {
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
  }

  /** Reset the buffer state */
  reset(): void {
    this.buffer = '';
  }

  /**
   * Walk backward from the end of text to find the last position where
   * all markdown constructs are closed (safe to render).
   */
  private findSafeBreakpoint(text: string): number {
    // Track open constructs
    let codeFenceCount = 0;
    let inInlineCode = false;
    let unclosedBracket = -1;  // position of last unclosed '['
    let unclosedParen = -1;    // position of last unclosed '(' after ']'
    let boldStarCount = 0;     // count of unmatched '**'
    let italicStarCount = 0;   // count of unmatched '*' (not part of **)

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      // Code fences (```)
      if (ch === '`' && next === '`' && text[i + 2] === '`') {
        codeFenceCount++;
        i += 2; // skip the full ```
        // Skip to end of line for the fence info string
        if (codeFenceCount % 2 === 1) {
          while (i + 1 < text.length && text[i + 1] !== '\n') i++;
        }
        continue;
      }

      // Inside a code fence, don't track other constructs
      if (codeFenceCount % 2 === 1) continue;

      // Inline code
      if (ch === '`') {
        inInlineCode = !inInlineCode;
        continue;
      }
      if (inInlineCode) continue;

      // Bold ** markers
      if (ch === '*' && next === '*') {
        boldStarCount++;
        i++; // skip second *
        continue;
      }

      // Italic * markers (single, not **)
      if (ch === '*') {
        italicStarCount++;
        continue;
      }

      // Link syntax [text](url)
      if (ch === '[') {
        unclosedBracket = i;
        unclosedParen = -1;
      } else if (ch === ']') {
        if (next === '(') {
          unclosedParen = i + 1;
          i++; // skip (
        } else {
          unclosedBracket = -1;
        }
      } else if (ch === ')' && unclosedParen >= 0) {
        unclosedBracket = -1;
        unclosedParen = -1;
      }
    }

    // Determine the earliest unresolved construct
    let safeEnd = text.length;

    // If inside an open code fence, find where the last ``` started
    if (codeFenceCount % 2 === 1) {
      const lastFence = text.lastIndexOf('```');
      if (lastFence >= 0) safeEnd = Math.min(safeEnd, lastFence);
    }

    // If an inline code backtick is open, find where it started
    if (inInlineCode) {
      const lastBacktick = text.lastIndexOf('`');
      if (lastBacktick >= 0) safeEnd = Math.min(safeEnd, lastBacktick);
    }

    // If bold marker is unmatched, trim to before it
    if (boldStarCount % 2 === 1) {
      const lastBold = text.lastIndexOf('**');
      if (lastBold >= 0) safeEnd = Math.min(safeEnd, lastBold);
    }

    // If italic marker is unmatched, trim to before it
    if (italicStarCount % 2 === 1) {
      const lastItalic = text.lastIndexOf('*');
      if (lastItalic >= 0) safeEnd = Math.min(safeEnd, lastItalic);
    }

    // If link syntax is unclosed
    if (unclosedBracket >= 0) {
      safeEnd = Math.min(safeEnd, unclosedBracket);
    }

    return safeEnd;
  }
}
