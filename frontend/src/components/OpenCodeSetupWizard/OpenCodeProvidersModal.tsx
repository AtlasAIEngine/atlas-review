/**
 * OpenCodeProvidersModal — Read-only OpenCode status modal.
 * Atlas uses the user's OpenCode setup as-is.
 */

import { useEffect, useState } from 'react';
import { providerApi } from '@/services/api';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';

interface OpenCodeProvidersModalProps {
  onClose: () => void;
}

export function OpenCodeProvidersModal({ onClose }: OpenCodeProvidersModalProps) {
  const [configuredProviders, setConfiguredProviders] = useState<Array<{ type: string; hasKey: boolean }>>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoadingStatus(true);
    providerApi.getOpenCodeStatus()
      .then((result) => {
        if (cancelled) return;
        setConfiguredProviders(result.configuredProviders || []);
        setActiveModel(result.activeModel || null);
        setStatusError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setConfiguredProviders([]);
        setActiveModel(null);
        setStatusError(error instanceof Error ? error.message : 'Unable to read your OpenCode status right now.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingStatus(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
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
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'var(--review-shell-bg)',
          border: '1px solid var(--review-shell-border-strong)',
          borderRadius: '18px',
          boxShadow: 'var(--review-panel-shadow)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--review-shell-divider)',
            background: 'var(--review-panel-header-bg)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              OpenCode
            </h3>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 'var(--space-2)', marginBottom: 0, lineHeight: 1.6 }}>
              Atlas reads your OpenCode providers and active model but does not modify them.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              ...getReviewActionButtonStyle({ tone: 'neutral' }),
              width: 32,
              minHeight: 32,
              padding: 0,
              borderRadius: 999,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', background: 'var(--review-panel-alt-bg)', display: 'grid', gap: 'var(--space-4)' }}>
          {statusError && (
            <div
              style={{
                padding: 'var(--space-3) var(--space-4)',
                borderRadius: 'var(--review-card-radius)',
                border: '1px solid var(--review-status-medium-border)',
                background: 'var(--review-status-medium-bg)',
                color: 'var(--review-status-medium-text)',
                fontSize: 'var(--text-sm)',
                lineHeight: 1.6,
              }}
            >
              Unable to read your OpenCode status right now. Re-scan Atlas after OpenCode is available.
            </div>
          )}

          <div style={panelStyle}>
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <div style={labelStyle}>Configured providers</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                {loadingStatus ? (
                  <span style={valueStyle}>Checking OpenCode status...</span>
                ) : configuredProviders.length > 0 ? configuredProviders.map((provider) => (
                  <span key={provider.type} style={chipStyle}>
                    {provider.type}
                  </span>
                )) : (
                  <span style={valueStyle}>No configured providers detected yet.</span>
                )}
              </div>
            </div>
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <div style={labelStyle}>Active model</div>
              <div style={valueStyle}>
                {loadingStatus ? 'Checking OpenCode status...' : activeModel || 'Not detected yet'}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            Use <code style={inlineCodeStyle}>/connect</code> in OpenCode to add providers and <code style={inlineCodeStyle}>/models</code> to choose the active model. Re-scan Atlas after you change them.
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                ...getReviewActionButtonStyle({ tone: 'blue', active: true }),
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 var(--space-5)',
                borderRadius: 10,
                minHeight: 32,
                fontSize: 'var(--text-sm)',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 'var(--space-4)',
  padding: 'var(--space-4)',
  borderRadius: 'var(--review-card-radius)',
  border: '1px solid var(--review-shell-border)',
  background: 'var(--review-toolbar-bg)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const valueStyle: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--text-primary)',
};

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 24,
  padding: '0 var(--space-3)',
  borderRadius: 999,
  border: '1px solid var(--review-shell-border)',
  background: 'var(--review-card-bg)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-xs)',
  textTransform: 'capitalize',
};

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  background: 'var(--review-code-bg)',
  border: '1px solid var(--review-shell-border)',
  borderRadius: 6,
  padding: '1px 6px',
};
