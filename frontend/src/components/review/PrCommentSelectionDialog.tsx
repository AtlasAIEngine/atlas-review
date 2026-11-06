import { useEffect, useMemo } from 'react';
import { getReviewActionButtonStyle } from './ReviewChrome';

interface PrCommentSelectionItem {
  key: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  location: string | null;
  defaultSelected: boolean;
  kindLabel?: string;
}

interface PrCommentSelectionDialogProps {
  isOpen: boolean;
  action: 'comment' | 'request_changes';
  items: PrCommentSelectionItem[];
  selectedKeys: Set<string>;
  isSubmitting?: boolean;
  onToggle: (key: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

const SEVERITY_COLORS: Record<PrCommentSelectionItem['severity'], string> = {
  critical: 'var(--accent-red)',
  high: 'var(--accent-red)',
  medium: 'var(--accent-yellow)',
  low: 'var(--text-tertiary)',
};

export function PrCommentSelectionDialog({
  isOpen,
  action,
  items,
  selectedKeys,
  isSubmitting = false,
  onToggle,
  onCancel,
  onConfirm,
}: PrCommentSelectionDialogProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onCancel]);

  const selectedCount = useMemo(
    () => items.filter((item) => selectedKeys.has(item.key)).length,
    [items, selectedKeys]
  );
  const isRequestChanges = action === 'request_changes';

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
          borderRadius: '18px',
          maxWidth: 720,
          width: 'min(92vw, 720px)',
          maxHeight: '80vh',
          boxShadow: 'var(--review-panel-shadow)',
          display: 'flex',
          flexDirection: 'column',
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
            margin: '0 0 var(--space-2)',
          }}>
            {isRequestChanges ? 'Request changes with selected comments' : 'Publish selected comments'}
          </h3>
          <p style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            margin: 0,
            lineHeight: 1.5,
          }}>
            High and medium findings are selected by default. Saved line comments are selected by default.
            {isRequestChanges
              ? ' Only the checked items will be included in the GitHub request-changes review.'
              : ' Only the checked items will be included in the GitHub comment review.'}
          </p>
        </div>

        <div style={{
          padding: '20px 24px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          minHeight: 0,
          overflow: 'hidden',
          background: 'var(--review-panel-alt-bg)',
        }}>
          <div style={{
            border: '1px solid var(--review-shell-border)',
            borderRadius: '14px',
            overflow: 'auto',
            maxHeight: '48vh',
            background: 'var(--review-code-bg)',
          }}>
          {items.map((item, index) => {
            const checked = selectedKeys.has(item.key);
            const severityColor = SEVERITY_COLORS[item.severity];
            return (
              <label
                key={item.key}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) var(--space-4)',
                  borderTop: index === 0 ? 'none' : '1px solid var(--review-shell-divider)',
                  background: checked ? 'var(--review-segment-active-bg)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(item.key)}
                  disabled={isSubmitting}
                  style={{
                    marginTop: 2,
                    accentColor: 'var(--accent-blue)',
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    flexWrap: 'wrap',
                    marginBottom: 'var(--space-1)',
                  }}>
                    {item.kindLabel && (
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: 'var(--text-tertiary)',
                      }}>
                        {item.kindLabel}
                      </span>
                    )}
                    <span style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: severityColor,
                    }}>
                      {item.severity}
                    </span>
                    <span style={{
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-primary)',
                      fontWeight: 600,
                    }}>
                      {item.title}
                    </span>
                  </div>
                  {item.location && (
                    <div style={{
                      fontSize: 11,
                      color: 'var(--text-tertiary)',
                      fontFamily: 'var(--font-mono)',
                    }}>
                      {item.location}
                    </div>
                  )}
                </div>
              </label>
            );
          })}
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}>
            <div style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}>
              {selectedCount}/{items.length} comments selected
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
              <button
                type="button"
                onClick={onCancel}
                disabled={isSubmitting}
                style={getSecondaryButtonStyle(isSubmitting)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={isSubmitting || selectedCount === 0}
                style={getPrimaryButtonStyle(isSubmitting || selectedCount === 0)}
              >
                {isSubmitting
                  ? (isRequestChanges ? 'Submitting request changes…' : 'Publishing…')
                  : (isRequestChanges ? 'Request changes' : 'Publish selected comments')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function getPrimaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'blue', active: !disabled, disabled }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}

function getSecondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'neutral', disabled }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}
