/**
 * Modal multi-option dialog. Like ConfirmDialog but with N action buttons
 * and a true cancel path: clicking the backdrop or pressing Escape resolves
 * with `null` (distinct from any action button).
 */

import { useEffect, type ReactNode } from 'react';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';

export interface ChooseDialogAction {
  key: string;
  label: string;
  tone?: 'primary' | 'secondary' | 'danger';
}

interface ChooseDialogProps {
  isOpen: boolean;
  title: string;
  message: ReactNode;
  actions: ChooseDialogAction[];
  onSelect: (key: string) => void;
  onCancel: () => void;
}

export function ChooseDialog({
  isOpen,
  title,
  message,
  actions,
  onSelect,
  onCancel,
}: ChooseDialogProps) {
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
          maxWidth: 460,
          width: '90vw',
          boxShadow: 'var(--review-panel-shadow)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
        }}>
          <h3 style={{
            fontSize: 'var(--text-lg)',
            fontWeight: 700,
            color: 'var(--text-primary)',
            margin: 0,
            flex: 1,
            minWidth: 0,
          }}>
            {title}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{
              flexShrink: 0,
              width: 24,
              height: 24,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-base)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-tertiary)';
            }}
          >
            ×
          </button>
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
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                onClick={() => onSelect(action.key)}
                style={buttonStyle(action.tone || 'primary')}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function buttonStyle(tone: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
  const reviewTone = tone === 'danger' ? 'red' : tone === 'secondary' ? 'neutral' : 'blue';
  return {
    ...getReviewActionButtonStyle({ tone: reviewTone, active: tone === 'primary' }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}
