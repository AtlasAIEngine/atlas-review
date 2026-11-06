/**
 * VerifyStep — Step 3 of OpenCode Setup Wizard
 * Runs a test prompt through OpenCode CLI to verify the provider connection.
 */

import { useState, useEffect, useRef } from 'react';
import { providerApi } from '@/services/api';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';

interface VerifyStepProps {
  onComplete: () => void;
  onBack: () => void;
}

export function VerifyStep({ onComplete, onBack }: VerifyStepProps) {
  const [status, setStatus] = useState<'testing' | 'success' | 'error'>('testing');
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runVerification();
  }, []);

  const runVerification = async () => {
    setStatus('testing');
    setError(null);
    try {
      const result = await providerApi.verifyOpenCode();
      if (result.success) {
        setStatus('success');
        setLatencyMs(result.latencyMs);
      } else {
        setStatus('error');
        setError(result.error || 'Verification failed');
      }
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Verification failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div>
        <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Verify Connection
        </h3>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 'var(--space-2)' }}>
          Running a test prompt through OpenCode to confirm everything works.
        </p>
      </div>

      <div style={{
        padding: 'var(--space-5)',
        background: 'var(--review-card-bg)',
        borderRadius: 14,
        border: status === 'success'
          ? '1px solid var(--chip-success-border)'
          : status === 'error'
            ? '1px solid var(--chip-danger-border)'
            : '1px solid var(--review-shell-border)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-3)',
      }}>
        {status === 'testing' && (
          <>
            <Spinner size={32} />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Testing connection...
            </span>
          </>
        )}

        {status === 'success' && (
          <>
            <svg width={36} height={36} viewBox="0 0 24 24" fill="none" stroke="var(--status-success, #22c55e)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--status-success, #22c55e)' }}>
              Connection successful!
            </span>
            {latencyMs != null && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                Response time: {latencyMs}ms
              </span>
            )}
          </>
        )}

        {status === 'error' && (
          <>
            <svg width={36} height={36} viewBox="0 0 24 24" fill="none" stroke="var(--status-error, #ef4444)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--status-error, #ef4444)' }}>
              Connection failed
            </span>
            {error && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
                {error}
              </span>
            )}
            <button
              type="button"
              onClick={runVerification}
              style={{ ...verifySecondaryButtonStyle(), marginTop: 'var(--space-2)' }}
            >
              Retry
            </button>
          </>
        )}
      </div>

      {/* Navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-3)' }}>
        <button
          type="button"
          onClick={onBack}
          style={verifySecondaryButtonStyle()}
        >
          Back
        </button>
        {status === 'success' && (
          <button
            type="button"
            onClick={onComplete}
            style={verifyDoneButtonStyle()}
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity={0.25} />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}

function verifySecondaryButtonStyle(): React.CSSProperties {
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

function verifyDoneButtonStyle(): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'green', active: true }),
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
