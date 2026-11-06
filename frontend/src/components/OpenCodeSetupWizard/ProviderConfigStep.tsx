/**
 * ProviderConfigStep — Step 2 of OpenCode Setup Wizard
 * Atlas no longer mutates OpenCode config. This step is read-only guidance.
 */

import { useEffect, useState } from 'react';
import { providerApi } from '@/services/api';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';

interface ProviderConfigStepProps {
  onNext: () => void;
  onBack: () => void;
  toolCapableOnly?: boolean;
  reviewCapableOnly?: boolean;
}

export function ProviderConfigStep({ onNext, onBack }: ProviderConfigStepProps) {
  const [configuredProviders, setConfiguredProviders] = useState<Array<{ type: string; hasKey: boolean }>>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);

  useEffect(() => {
    providerApi.getOpenCodeStatus().then((result) => {
      setConfiguredProviders(result.configuredProviders || []);
      setActiveModel(result.activeModel || null);
    }).catch(() => {});
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div>
        <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Use Your OpenCode Setup As-Is
        </h3>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 'var(--space-2)', lineHeight: 1.6 }}>
          Atlas no longer configures OpenCode for you. Connect providers in OpenCode with <code style={inlineCodeStyle}>/connect</code> and choose the active model with <code style={inlineCodeStyle}>/models</code>, then continue here.
        </p>
      </div>

      <div style={panelStyle}>
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <div style={labelStyle}>Detected providers</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {configuredProviders.length > 0 ? configuredProviders.map((provider) => (
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
          <div style={valueStyle}>{activeModel || 'Not detected yet'}</div>
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          If you update OpenCode now, come back after reopening Atlas or re-scanning providers so the detected model refreshes.
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-2)' }}>
        <button type="button" onClick={onBack} style={backButtonStyle()}>
          Back
        </button>
        <button type="button" onClick={onNext} style={continueButtonStyle()}>
          Continue
        </button>
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

function backButtonStyle(): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'neutral' }),
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: '0 var(--space-3)',
    minHeight: 32,
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
    cursor: 'pointer',
  };
}

function continueButtonStyle(): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'blue', active: true }),
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: '0 var(--space-4)',
    minHeight: 32,
    borderRadius: 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
    cursor: 'pointer',
  };
}
