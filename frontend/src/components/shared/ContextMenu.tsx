/**
 * Minimal positioned context menu dropdown.
 * Fixed position at (x, y), click-outside and Escape to close.
 */

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Clamp position so menu doesn't overflow viewport
  const menuWidth = 180;
  const menuItemHeight = 34;
  const menuPadding = 8;
  const estimatedHeight = items.length * menuItemHeight + menuPadding * 2;

  const left = Math.min(x, window.innerWidth - menuWidth - 8);
  const top = Math.min(y, window.innerHeight - estimatedHeight - 8);

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 9999,
        minWidth: menuWidth,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: `${menuPadding}px 0`,
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          onClick={() => {
            item.onClick();
            onClose();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            width: '100%',
            padding: '7px var(--space-3)',
            background: 'transparent',
            border: 'none',
            color: item.danger ? 'var(--accent-red)' : 'var(--text-primary)',
            fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'background var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
