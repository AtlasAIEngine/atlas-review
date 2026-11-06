/**
 * DeployProgress — Shows deployment pipeline progress steps.
 * Polls /api/deploy/status/:id every 2 seconds.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import * as deployApi from '../services/deployApi';

interface DeployProgressProps {
  deploymentId: number;
  onComplete: (liveUrl: string) => void;
  onError: (error: string) => void;
}

type Step = 'packaging' | 'uploading' | 'building' | 'deploying' | 'live';

const STEPS: { key: Step; label: string }[] = [
  { key: 'packaging', label: 'Packaging' },
  { key: 'uploading', label: 'Uploading' },
  { key: 'building', label: 'Building' },
  { key: 'deploying', label: 'Deploying' },
  { key: 'live', label: 'Live' },
];

const STATUS_TO_STEP: Record<string, Step> = {
  pending: 'packaging',
  uploading: 'uploading',
  building: 'building',
  deploying: 'deploying',
  live: 'live',
};

const POLL_INTERVAL_MS = 2000;

export default function DeployProgress({ deploymentId, onComplete, onError }: DeployProgressProps) {
  const [currentStep, setCurrentStep] = useState<Step>('packaging');
  const [buildLog, setBuildLog] = useState('');
  const [showLog, setShowLog] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const errorCountRef = useRef(0);
  const MAX_CONSECUTIVE_ERRORS = 5;

  const poll = useCallback(async () => {
    if (cancelledRef.current) return;
    try {
      const result = await deployApi.getStatus(deploymentId);
      errorCountRef.current = 0; // Reset on success

      const status = result.data.status;

      if (result.data.buildLog) {
        setBuildLog(result.data.buildLog);
      }

      if (status === 'failed') {
        if (intervalRef.current) clearInterval(intervalRef.current);
        onError(result.data.buildLog || 'Build failed');
        return;
      }

      if (status === 'live') {
        setCurrentStep('live');
        if (intervalRef.current) clearInterval(intervalRef.current);
        onComplete(result.data.liveUrl || `https://${result.data.subdomain}.atlasengine.dev`);
        return;
      }

      const step = STATUS_TO_STEP[status] || 'packaging';
      setCurrentStep(step);
    } catch (err) {
      console.error('[DeployProgress] Poll error:', err);
      errorCountRef.current++;
      if (errorCountRef.current >= MAX_CONSECUTIVE_ERRORS) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        onError('Lost connection to deployment server');
      }
    }
  }, [deploymentId, onComplete, onError]);

  useEffect(() => {
    cancelledRef.current = false;
    poll(); // initial poll
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelledRef.current = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll]);

  const stepIndex = STEPS.findIndex(s => s.key === currentStep);

  return (
    <div style={{ padding: 'var(--space-4)' }}>
      {/* Step indicators */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {STEPS.map((step, i) => {
          const isComplete = i < stepIndex;
          const isCurrent = i === stepIndex;
          const isPending = i > stepIndex;

          return (
            <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              {/* Circle */}
              <div style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 'var(--text-xs)',
                fontWeight: 600,
                background: isComplete
                  ? 'var(--status-success)'
                  : isCurrent
                    ? 'var(--accent-blue)'
                    : 'var(--bg-hover)',
                color: isComplete || isCurrent ? '#fff' : 'var(--text-tertiary)',
                transition: 'background var(--transition-fast)',
              }}>
                {isComplete ? '\u2713' : i + 1}
              </div>

              {/* Label */}
              <span style={{
                fontSize: 'var(--text-xs)',
                fontWeight: isCurrent ? 600 : 400,
                color: isPending ? 'var(--text-tertiary)' : 'var(--text-primary)',
              }}>
                {step.label}
              </span>

              {/* Connector */}
              {i < STEPS.length - 1 && (
                <div style={{
                  width: 20,
                  height: 2,
                  background: isComplete ? 'var(--status-success)' : 'var(--border-default)',
                  transition: 'background var(--transition-fast)',
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Current step message */}
      {currentStep !== 'live' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-sm)',
          marginBottom: 'var(--space-3)',
        }}>
          <div className="animate-spin" style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '2px solid var(--border-default)',
            borderTopColor: 'var(--accent-blue)',
          }} />
          {STEPS[stepIndex]?.label}...
        </div>
      )}

      {/* Build log toggle */}
      {buildLog && (
        <div>
          <button
            type="button"
            onClick={() => setShowLog(!showLog)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent-blue)',
              fontSize: 'var(--text-xs)',
              cursor: 'pointer',
              padding: 0,
              marginBottom: 'var(--space-2)',
            }}
          >
            {showLog ? 'Hide' : 'Show'} build log
          </button>

          {showLog && (
            <pre style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
              fontSize: 'var(--text-xs)',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              maxHeight: 200,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              margin: 0,
            }}>
              {buildLog}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
