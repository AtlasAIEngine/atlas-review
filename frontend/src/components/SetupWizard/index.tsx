/**
 * SetupWizard Component
 * Multi-step wizard for first-run setup
 * Step 1: Welcome (Atlas Review intro)
 * Step 2: AI Provider (auto-detect + BYOK)
 * Step 3: MCP onboarding (optional tool connection guidance)
 */

import { useState, useEffect, useRef } from 'react';
import { providerApi } from '@/services/api';
import { WelcomeStep } from './WelcomeStep';
import { ProviderStep } from './ProviderStep';
import { McpStep } from './McpStep';

type WizardStep = 'welcome' | 'provider' | 'mcp';

interface ScanResult {
  providers: any[];
  activeProvider: any | null;
  done: boolean;
}

interface SetupWizardProps {
  onComplete: (projectId?: string) => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>('welcome');
  const [scanResult, setScanResult] = useState<ScanResult>({ providers: [], activeProvider: null, done: false });
  const scanStarted = useRef(false);

  const runProviderScan = () => {
    if (scanStarted.current) return;
    scanStarted.current = true;

    providerApi.scan().then((result) => {
      if (result.success && result.providers) {
        setScanResult({ providers: result.providers, activeProvider: result.activeProvider, done: true });
      } else {
        setScanResult({ providers: [], activeProvider: null, done: true });
      }
    }).catch(() => {
      setScanResult({ providers: [], activeProvider: null, done: true });
    });
  };

  // Defer provider discovery until the user actually enters the provider step.
  useEffect(() => {
    if (currentStep !== 'provider') return;
    runProviderScan();
  }, [currentStep]);

  const goToStep = (step: WizardStep) => {
    setCurrentStep(step);
  };

  const handleSkip = () => {
    onComplete();
  };

  // Step indicator
  const steps: WizardStep[] = ['welcome', 'provider', 'mcp'];
  const currentIndex = steps.indexOf(currentStep);
  const contentMaxWidth = currentStep === 'welcome' ? 'max-w-6xl' : 'max-w-3xl';

  return (
    <div
      className="h-screen w-full overflow-y-auto"
      style={{
        background: 'var(--review-shell-bg)',
        color: 'var(--text-primary)',
      }}
    >
      <div className="min-h-screen flex flex-col items-center px-6 py-8 md:px-8 md:py-10">
      {/* Progress Indicator */}
      <div className="mb-8 flex items-center gap-2">
        {steps.map((step, index) => (
          <div key={step} className="flex items-center">
            <div
              className="rounded-full transition-colors"
              style={{
                width: 12,
                height: 12,
                background: index <= currentIndex ? 'var(--text-primary)' : 'var(--review-shell-border)',
                boxShadow: index === currentIndex ? '0 0 0 4px var(--review-selection-glow)' : 'none',
              }}
            />
            {index < steps.length - 1 && (
              <div
                className="h-0.5 transition-colors"
                style={{
                  width: 32,
                  background: index < currentIndex ? 'var(--text-primary)' : 'var(--review-shell-divider)',
                }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step Content */}
      <div
        className={`w-full ${contentMaxWidth}`}
        style={{
          background: 'var(--review-panel-bg)',
          border: '1px solid var(--review-shell-border)',
          borderRadius: 28,
          boxShadow: 'var(--review-panel-shadow)',
          padding: currentStep === 'welcome' ? 'clamp(24px, 3vw, 36px)' : 'clamp(24px, 4vw, 40px)',
        }}
      >
        {currentStep === 'welcome' && (
          <WelcomeStep
            onNext={() => goToStep('provider')}
          />
        )}

        {currentStep === 'provider' && (
          <ProviderStep
            onNext={() => goToStep('mcp')}
            onBack={() => goToStep('welcome')}
            onSkip={handleSkip}
            scanResult={scanResult}
            onRescan={() => {
              scanStarted.current = false;
              setScanResult({ providers: [], activeProvider: null, done: false });
              runProviderScan();
            }}
          />
        )}

        {currentStep === 'mcp' && (
          <McpStep
            onNext={handleSkip}
            onBack={() => goToStep('provider')}
            onSkip={handleSkip}
          />
        )}
      </div>

      {/* Version */}
      <div className="mt-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        AtlasEngine Desktop
      </div>
      </div>
    </div>
  );
}

export default SetupWizard;
