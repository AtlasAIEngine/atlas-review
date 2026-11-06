import { useEffect, useRef, useState } from 'react';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';

interface PromptDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  multiline?: boolean;
  danger?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  isOpen,
  title,
  message,
  initialValue = '',
  placeholder = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  multiline = false,
  danger = false,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValue(initialValue);
  }, [isOpen, initialValue]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Enter' && !multiline) {
        e.preventDefault();
        onConfirm(value);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, multiline, onCancel, onConfirm, value]);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => {
      if (multiline) {
        textareaRef.current?.focus();
        textareaRef.current?.select();
      } else {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    });
  }, [isOpen, multiline]);

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
          <p style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            margin: '0 0 var(--space-4)',
            lineHeight: 1.5,
            whiteSpace: 'pre-line',
          }}>
            {message}
          </p>

          {multiline ? (
            <textarea
              ref={textareaRef}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              rows={4}
              style={textFieldStyle(true)}
              onFocus={(e) => applyFocusStyles(e.currentTarget)}
              onBlur={(e) => clearFocusStyles(e.currentTarget)}
            />
          ) : (
            <input
              ref={inputRef}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              style={textFieldStyle(false)}
              onFocus={(e) => applyFocusStyles(e.currentTarget)}
              onBlur={(e) => clearFocusStyles(e.currentTarget)}
            />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
            <button
              type="button"
              onClick={onCancel}
              style={promptSecondaryButtonStyle()}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(value)}
              style={promptPrimaryButtonStyle(danger)}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function textFieldStyle(multiline: boolean): React.CSSProperties {
  return {
    width: '100%',
    resize: multiline ? 'vertical' : undefined,
    borderRadius: 12,
    border: '1px solid var(--review-shell-border)',
    background: 'var(--review-code-bg)',
    color: 'var(--text-primary)',
    padding: multiline ? 'var(--space-3)' : 'var(--space-2) var(--space-3)',
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    marginBottom: 'var(--space-5)',
    outline: 'none',
    transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
    boxSizing: 'border-box',
  };
}

function applyFocusStyles(element: HTMLInputElement | HTMLTextAreaElement) {
  element.style.borderColor = 'var(--review-shell-border-strong)';
  element.style.boxShadow = '0 0 0 1px var(--review-selection-glow)';
}

function clearFocusStyles(element: HTMLInputElement | HTMLTextAreaElement) {
  element.style.borderColor = 'var(--review-shell-border)';
  element.style.boxShadow = 'none';
}

function promptSecondaryButtonStyle(): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'neutral' }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}

function promptPrimaryButtonStyle(danger: boolean): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: danger ? 'red' : 'blue', active: true }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}
