/**
 * FilesView — Direction C left-pane file-list container. Pre-review (no
 * findings) this is a plain file tree; post-review the caller can tag
 * rows with severity dots via the FileRow primitive before passing them
 * as children.
 *
 * The right pane (TrustDiffViewer) is owned by the shell; this is just
 * the list column.
 */

import type { ReactNode } from 'react';

interface FilesViewProps {
  children: ReactNode;
  header?: ReactNode;
}

export function FilesView({ children, header }: FilesViewProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        background: 'var(--review-panel-alt-bg)',
      }}
    >
      {header && (
        <div
          style={{
            padding: '8px 14px',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            borderBottom: '1px solid var(--review-shell-divider)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'var(--review-panel-header-bg)',
          }}
        >
          {header}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
