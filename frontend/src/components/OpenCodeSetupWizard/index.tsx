/**
 * OpenCodeSetupWizard — 3-step wizard for OpenCode CLI setup
 * Step 1: Install Check — verify OpenCode binary is installed
 * Step 2: Provider Config — choose and configure a free LLM provider
 * Step 3: Verify — test the connection
 */

import { useState } from 'react';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';
import { InstallStep } from './InstallStep';
import { ProviderConfigStep } from './ProviderConfigStep';
import { VerifyStep } from './VerifyStep';

type WizardStep = 'install' | 'provider' | 'verify';

interface OpenCodeSetupWizardProps {
  onComplete: () => void;
  onClose: () => void;
  initialStep?: WizardStep;
  toolCapableOnly?: boolean;
  reviewCapableOnly?: boolean;
}

const STEPS: WizardStep[] = ['install', 'provider', 'verify'];

export function OpenCodeSetupWizard({ onComplete, onClose, initialStep = 'install', toolCapableOnly = false, reviewCapableOnly = false }: OpenCodeSetupWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>(initialStep);
  const currentIndex = STEPS.indexOf(currentStep);

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(var(--bg-base-rgb), 0.58)',
      backdropFilter: 'blur(10px)',
      padding: '24px',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 520,
        maxHeight: '90vh',
        overflowY: 'auto',
        background: 'var(--review-shell-bg)',
        border: '1px solid var(--review-shell-border-strong)',
        borderRadius: '18px',
        boxShadow: 'var(--review-panel-shadow)',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
        }}>
          <div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)' }}>
              OpenCode Setup
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 'var(--space-2)' }}>
              Install OpenCode, configure a provider, and verify the connection.
            </div>
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

        <div style={{ padding: '24px', background: 'var(--review-panel-alt-bg)' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-5)',
        }}>
          {STEPS.map((step, index) => (
            <div key={step} style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: index <= currentIndex ? 'var(--accent-blue)' : 'var(--review-chip-neutral-border)',
                transition: 'background 0.2s',
              }} />
              {index < STEPS.length - 1 && (
                <div style={{
                  width: 32,
                  height: 2,
                  background: index < currentIndex ? 'var(--accent-blue)' : 'var(--review-chip-neutral-border)',
                  transition: 'background 0.2s',
                }} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        {currentStep === 'install' && (
          <InstallStep
            onNext={() => setCurrentStep('provider')}
            onBack={onClose}
          />
        )}
        {currentStep === 'provider' && (
          <ProviderConfigStep
            onNext={() => setCurrentStep('verify')}
            onBack={() => setCurrentStep('install')}
            toolCapableOnly={toolCapableOnly}
            reviewCapableOnly={reviewCapableOnly}
          />
        )}
        {currentStep === 'verify' && (
          <VerifyStep
            onComplete={onComplete}
            onBack={() => setCurrentStep('provider')}
          />
        )}
        </div>
      </div>
    </div>
  );
}
