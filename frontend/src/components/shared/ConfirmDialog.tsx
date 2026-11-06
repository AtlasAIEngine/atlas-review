/**
 * Modal confirmation dialog.
 * Fixed overlay, centered card, Escape to cancel.
 */

import { useEffect, type ReactNode } from 'react';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  showCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  showCancel = true,
  onConfirm,
  onCancel,
  danger = false,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(var(--bg-base-rgb), 0.58)',
        backdropFilter: 'blur(10px)',
        padding: '24px',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--review-shell-bg)',
          border: '1px solid var(--review-shell-border-strong)',
          borderRadius: 18,
          maxWidth: 420,
          width: '90vw',
          boxShadow: 'var(--review-panel-shadow)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
        }}>
          <h3 style={{
            fontSize: 'var(--text-lg)',
            fontWeight: 700,
            color: 'var(--text-primary)',
            margin: 0,
          }}>
            {title}
          </h3>
        </div>
        <div style={{
          padding: '24px',
          background: 'var(--review-panel-alt-bg)',
        }}>
          {typeof message === 'string' ? (
            <p style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-6)',
              lineHeight: 1.5,
              whiteSpace: 'pre-line',
            }}>
              {message}
            </p>
          ) : (
            <div style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-6)',
              lineHeight: 1.5,
            }}>
              {message}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
            {showCancel && (
              <button
                type="button"
                onClick={onCancel}
                style={secondaryButtonStyle()}
              >
                {cancelLabel}
              </button>
            )}
            <button
              type="button"
              onClick={onConfirm}
              style={primaryButtonStyle(danger)}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function secondaryButtonStyle(): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'neutral' }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}

function primaryButtonStyle(danger: boolean): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: danger ? 'red' : 'blue', active: true }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}
