/**
 * InputModal — Simple modal with text input fields.
 * Works in both browser and Tauri webview contexts (replaces window.prompt).
 */

import { useState, useEffect, useRef } from 'react';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface InputField {
  label: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
}

interface InputModalProps {
  isOpen: boolean;
  title: string;
  fields: InputField[];
  submitLabel?: string;
  onSubmit: (values: string[]) => void;
  onClose: () => void;
}

function InputModal({ isOpen, title, fields, submitLabel = 'OK', onSubmit, onClose }: InputModalProps) {
  const [values, setValues] = useState<string[]>([]);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValues(fields.map(f => f.defaultValue || ''));
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Check required fields
    const allValid = fields.every((f, i) => !f.required || values[i]?.trim());
    if (!allValid) return;
    onSubmit(values);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      onClick={onClose}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(var(--bg-base-rgb), 0.58)',
        backdropFilter: 'blur(10px)',
        padding: '24px',
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        style={{
          background: 'var(--review-shell-bg)',
          border: '1px solid var(--review-shell-border-strong)',
          borderRadius: '18px',
          boxShadow: 'var(--review-panel-shadow)',
          minWidth: 380,
          maxWidth: 480,
          width: 'min(92vw, 480px)',
          fontFamily: 'var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
        }}>
          <h3 style={{
            fontSize: 'var(--text-xl)',
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
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}>
          {fields.map((field, i) => (
            <div key={i}>
              <label style={{
                display: 'block',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 10,
              }}>
                {field.label}{field.required ? '' : ' (optional)'}
              </label>
              <input
                ref={i === 0 ? firstInputRef : undefined}
                type="text"
                value={values[i] || ''}
                onChange={(e) => {
                  const next = [...values];
                  next[i] = e.target.value;
                  setValues(next);
                }}
                placeholder={field.placeholder}
                autoFocus={i === 0}
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  fontSize: 'var(--text-md)',
                  fontFamily: 'var(--font-sans, inherit)',
                  color: 'var(--text-primary)',
                  background: 'var(--review-code-bg)',
                  border: '1px solid var(--review-shell-border)',
                  borderRadius: '12px',
                  outline: 'none',
                  boxSizing: 'border-box',
                  transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)';
                  e.currentTarget.style.boxShadow = '0 0 0 1px var(--review-selection-glow)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--review-shell-border)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              />
            </div>
          ))}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              style={secondaryButtonStyle(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={fields.some((f, i) => f.required && !values[i]?.trim())}
              style={primaryButtonStyle(fields.some((f, i) => f.required && !values[i]?.trim()))}
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'blue', active: !disabled, disabled }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'neutral', disabled }),
    minHeight: 32,
    padding: '0 16px',
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
  };
}

export default InputModal;
