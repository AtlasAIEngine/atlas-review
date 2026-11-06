/**
 * CopyMenuButton — small clipboard-icon trigger that opens a dropdown with
 * the same options as the Actions popover's Copy submenu (Copy as Prompt,
 * Copy as GitHub comment, Copy Markdown, Download Markdown). Designed for
 * compact footers where a labelled `Btn` is too large.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import toast from '@/lib/toast';
import { copyTextToClipboard, downloadMarkdownFile } from './reviewPanelUtils';

export interface CopyMenuExports {
  prompt?: string | null;
  githubComment?: string | null;
  markdown?: string | null;
  /** Filename without extension. ".md" is appended on download. */
  markdownFilenameBase?: string | null;
}

export interface CopyMenuButtonProps {
  exports: CopyMenuExports;
  /** Disabled overlay reason. When provided the button is greyed out and the menu won't open. */
  disabledReason?: string | null;
  /** Override button size. Defaults to 22 to match the trash button next to it. */
  size?: number;
  /** Where to anchor the popover relative to the button. */
  menuAlign?: 'left' | 'right';
  buttonStyle?: CSSProperties;
}

type CopyOption =
  | { id: 'prompt';        label: 'Copy as Prompt';         action: 'copy';     value: string }
  | { id: 'githubComment'; label: 'Copy as GitHub comment'; action: 'copy';     value: string }
  | { id: 'markdown';      label: 'Copy Markdown';          action: 'copy';     value: string }
  | { id: 'download';      label: 'Download Markdown';      action: 'download'; value: string; filename: string };

export function buildCopyMenuOptions(exports: CopyMenuExports): CopyOption[] {
  const filenameBase = (exports.markdownFilenameBase || 'review-summary').trim() || 'review-summary';
  const options: CopyOption[] = [];
  if (exports.prompt) {
    options.push({ id: 'prompt', label: 'Copy as Prompt', action: 'copy', value: exports.prompt });
  }
  if (exports.githubComment) {
    options.push({ id: 'githubComment', label: 'Copy as GitHub comment', action: 'copy', value: exports.githubComment });
  }
  if (exports.markdown) {
    options.push({ id: 'markdown', label: 'Copy Markdown', action: 'copy', value: exports.markdown });
    options.push({ id: 'download', label: 'Download Markdown', action: 'download', value: exports.markdown, filename: `${filenameBase}.md` });
  }
  return options;
}

export async function runCopyMenuOption(option: CopyOption): Promise<void> {
  if (option.action === 'download') {
    const ok = downloadMarkdownFile(option.filename, option.value);
    if (ok) toast.success('Markdown downloaded');
    else toast.error('Download failed');
    return;
  }
  const ok = await copyTextToClipboard(option.value);
  if (ok) toast.success('Copied to clipboard');
  else toast.error('Copy failed');
}

export function CopyMenuButton({
  exports,
  disabledReason = null,
  size = 22,
  menuAlign = 'right',
  buttonStyle,
}: CopyMenuButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const node = containerRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const options = buildCopyMenuOptions(exports);
  const isDisabled = Boolean(disabledReason) || options.length === 0;
  const title = disabledReason
    || (options.length === 0 ? 'No review data to export yet' : 'Copy or download review');

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => {
          if (isDisabled) return;
          setOpen((v) => !v);
        }}
        disabled={isDisabled}
        aria-label="Copy review"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        style={{
          border: '1px solid var(--review-shell-divider)',
          background: 'transparent',
          color: 'var(--text-tertiary)',
          borderRadius: 5,
          width: size,
          height: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.5 : 1,
          ...buttonStyle,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="5" y="5" width="9" height="9" rx="1.5" />
          <path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" />
        </svg>
      </button>
      {open && options.length > 0 && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            ...(menuAlign === 'right' ? { right: 0 } : { left: 0 }),
            minWidth: 200,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 5,
            boxShadow: 'var(--review-card-shadow-strong)',
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            zIndex: 60,
          }}
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void runCopyMenuOption(option);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                padding: '7px 10px',
                fontSize: 12,
                textAlign: 'left',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                borderRadius: 3,
                fontFamily: 'inherit',
                transition: 'background var(--transition-fast)',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface-raised)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
