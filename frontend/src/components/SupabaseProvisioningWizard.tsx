/**
 * SupabaseProvisioningWizard
 * Inline wizard shown in PublishPanel when a project needs a database
 * but has no Supabase project linked. Steps auto-skip if already done.
 */

import { useState, useEffect } from 'react';
import toast from '@/lib/toast';
import { supabaseApi } from '@/services/supabaseApi';
import type { SupabaseProject } from '@/services/supabaseApi';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface SupabaseProvisioningWizardProps {
  projectId: string;
  dbType: string;
  initialConnected: boolean;
  initialLinked: boolean;
  onComplete: () => void;
}

type WizardStep = 'connect' | 'link' | 'done';

function SupabaseProvisioningWizard({
  projectId,
  dbType,
  initialConnected,
  initialLinked,
  onComplete,
}: SupabaseProvisioningWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>(() => {
    if (initialLinked) return 'done';
    if (initialConnected) return 'link';
    return 'connect';
  });

  // Connect step state
  const [token, setToken] = useState('');
  const [isValidating, setIsValidating] = useState(false);

  // Link step state
  const [projects, setProjects] = useState<SupabaseProject[]>([]);
  const [selectedProjectRef, setSelectedProjectRef] = useState('');
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLinking, setIsLinking] = useState(false);

  // Done step state
  const [linkedProjectName, setLinkedProjectName] = useState<string | null>(null);

  // Load Supabase projects when entering link step
  useEffect(() => {
    if (currentStep === 'link') {
      loadProjects();
    }
  }, [currentStep]);

  // If we start at 'done', notify parent
  useEffect(() => {
    if (currentStep === 'done' && initialLinked) {
      onComplete();
    }
  }, []);

  const loadProjects = async () => {
    setIsLoadingProjects(true);
    try {
      const projectList = await supabaseApi.getProjects();
      setProjects(projectList);
      if (projectList.length > 0 && !selectedProjectRef) {
        setSelectedProjectRef(projectList[0].id);
      }
    } catch (error) {
      console.error('Failed to load Supabase projects:', error);
      toast.error('Failed to load Supabase projects');
    } finally {
      setIsLoadingProjects(false);
    }
  };

  const handleConnect = async () => {
    if (!token.trim()) {
      toast.error('Please enter your Supabase access token');
      return;
    }
    setIsValidating(true);
    try {
      await supabaseApi.connect(token.trim());
      setToken('');
      toast.success('Supabase connected');
      setCurrentStep('link');
    } catch (error: any) {
      const msg = error.response?.data?.error || 'Failed to connect Supabase';
      toast.error(msg);
    } finally {
      setIsValidating(false);
    }
  };

  const handleLink = async () => {
    if (!selectedProjectRef) {
      toast.error('Select a Supabase project');
      return;
    }
    setIsLinking(true);
    try {
      const result = await supabaseApi.linkProject(projectId, {
        supabaseProjectRef: selectedProjectRef,
      });
      const name = result.linked?.supabase_project_name || 'Supabase project';
      setLinkedProjectName(name);
      toast.success(`Linked to ${name}`);
      setCurrentStep('done');
      onComplete();
    } catch (error: any) {
      const msg = error.response?.data?.error || 'Failed to link project';
      toast.error(msg);
    } finally {
      setIsLinking(false);
    }
  };

  const steps: { key: WizardStep; label: string }[] = [
    { key: 'connect', label: 'Connect' },
    { key: 'link', label: 'Link Project' },
    { key: 'done', label: 'Ready' },
  ];

  const stepIndex = steps.findIndex(s => s.key === currentStep);

  return (
    <div style={{ background: 'var(--review-panel-bg)', borderRadius: 18, border: '1px solid var(--chip-warning-border)', overflow: 'hidden', boxShadow: 'var(--review-panel-shadow)' }}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2" style={{ background: 'var(--chip-warning-bg)', borderBottom: '1px solid var(--chip-warning-border)' }}>
        <svg className="w-4 h-4" style={{ color: 'var(--accent-yellow)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
        </svg>
        <span className="text-sm font-medium" style={{ color: 'var(--accent-yellow)' }}>Production Database Setup</span>
        <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>{dbType}</span>
      </div>

      {/* Step Indicator */}
      <div className="px-3 py-2 flex items-center gap-1">
        {steps.map((step, i) => {
          const isComplete = i < stepIndex || currentStep === 'done';
          const isCurrent = i === stepIndex && currentStep !== 'done';
          return (
            <div key={step.key} className="flex items-center gap-1">
              {i > 0 && (
                <div className="w-6 h-px" style={{ background: isComplete ? 'var(--accent-green)' : 'var(--review-shell-border)' }} />
              )}
              <div className="flex items-center gap-1">
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium"
                  style={{
                    background: isComplete ? 'var(--chip-success-bg)' : isCurrent ? 'var(--chip-warning-bg)' : 'var(--review-chip-neutral-bg)',
                    color: isComplete ? 'var(--accent-green)' : isCurrent ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                    border: `1px solid ${isComplete ? 'var(--chip-success-border)' : isCurrent ? 'var(--chip-warning-border)' : 'var(--review-chip-neutral-border)'}`,
                  }}
                >
                  {isComplete ? (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span className="text-[10px]" style={{ color: isComplete ? 'var(--accent-green)' : isCurrent ? 'var(--accent-yellow)' : 'var(--text-tertiary)' }}>
                  {step.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="px-3 pb-3">
        {/* Step 1: Connect */}
        {currentStep === 'connect' && (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Enter your Supabase Personal Access Token to connect.{' '}
              <a
                href="https://supabase.com/dashboard/account/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                style={{ color: 'var(--accent-yellow)' }}
              >
                Generate one here
              </a>
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                placeholder="sbp_..."
                className="flex-1 px-2 py-1.5 rounded text-sm placeholder-content-tertiary focus:outline-none"
                style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border-strong)', color: 'var(--text-primary)' }}
              />
              <button
                onClick={handleConnect}
                disabled={isValidating || !token.trim()}
                className="flex items-center gap-1.5"
                style={getReviewActionButtonStyle({ tone: 'yellow', active: true, disabled: isValidating || !token.trim() })}
              >
                {isValidating ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Validating...
                  </>
                ) : (
                  'Connect'
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Select & Link */}
        {currentStep === 'link' && (
          <div className="space-y-2">
            {isLoadingProjects ? (
              <div className="flex items-center gap-2 text-xs py-2" style={{ color: 'var(--text-secondary)' }}>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Loading Supabase projects...
              </div>
            ) : projects.length === 0 ? (
              <p className="text-xs py-2" style={{ color: 'var(--text-secondary)' }}>
                No Supabase projects found. Create one at{' '}
                <a
                  href="https://supabase.com/dashboard/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: 'var(--accent-yellow)' }}
                >
                  supabase.com/dashboard
                </a>{' '}
                then{' '}
                <button onClick={loadProjects} className="underline" style={{ color: 'var(--accent-yellow)' }}>
                  refresh
                </button>
              </p>
            ) : (
              <>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  Select the Supabase project to use for production.
                </p>
                <div className="flex gap-2">
                  <select
                    value={selectedProjectRef}
                    onChange={(e) => setSelectedProjectRef(e.target.value)}
                    className="flex-1 px-2 py-1.5 rounded text-sm focus:outline-none"
                    style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border-strong)', color: 'var(--text-primary)' }}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.region})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleLink}
                    disabled={isLinking || !selectedProjectRef}
                    className="flex items-center gap-1.5"
                    style={getReviewActionButtonStyle({ tone: 'yellow', active: true, disabled: isLinking || !selectedProjectRef })}
                  >
                    {isLinking ? (
                      <>
                        <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Linking...
                      </>
                    ) : (
                      'Link'
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 3: Done */}
        {currentStep === 'done' && (
          <div className="flex items-center gap-2 py-1">
            <svg className="w-4 h-4" style={{ color: 'var(--accent-green)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm" style={{ color: 'var(--accent-green)' }}>
              {linkedProjectName ? `Linked to ${linkedProjectName}` : 'Supabase linked'}
            </span>
            <span className="text-[10px] ml-auto" style={{ color: 'var(--text-tertiary)' }}>Secrets auto-created</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default SupabaseProvisioningWizard;
