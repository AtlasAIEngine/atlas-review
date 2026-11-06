/**
 * InstallStep — Step 1 of OpenCode Setup Wizard
 * Checks if OpenCode CLI is installed, shows install instructions if not,
 * and polls until installation is detected.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { providerApi } from '@/services/api';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';

interface InstallStepProps {
  onNext: () => void;
  onBack: () => void;
}

const POLL_INTERVAL_MS = 3000;
const INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/install | bash';

export function InstallStep({ onNext, onBack }: InstallStepProps) {
  const [checking, setChecking] = useState(true);
  const [installed, setInstalled] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const checkStatus = useCallback(async () => {
    try {
      const result = await providerApi.getOpenCodeStatus();
      if (cancelledRef.current) return;
      if (result.installed) {
        setInstalled(true);
        setChecking(false);
        // Auto-advance after a brief delay
        setTimeout(() => {
          if (!cancelledRef.current) onNext();
        }, 800);
      } else {
        setChecking(false);
      }
    } catch {
      if (!cancelledRef.current) setChecking(false);
    }
  }, [onNext]);

  // Initial check
  useEffect(() => {
    cancelledRef.current = false;
    checkStatus();
    return () => { cancelledRef.current = true; };
  }, [checkStatus]);

  // Poll when not installed
  useEffect(() => {
    if (installed || checking) return;
    pollRef.current = setInterval(checkStatus, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [installed, checking, checkStatus]);

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div>
        <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Install OpenCode CLI
        </h3>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 'var(--space-2)' }}>
          OpenCode is an open-source coding agent that connects to 75+ LLM providers.
        </p>
      </div>

      {checking ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-4)',
          background: 'var(--review-card-bg)',
          borderRadius: 14,
          border: '1px solid var(--review-shell-border)',
        }}>
          <Spinner />
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Checking for OpenCode CLI...
          </span>
        </div>
      ) : installed ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-4)',
          background: 'var(--chip-success-bg)',
          borderRadius: 14,
          border: '1px solid var(--chip-success-border)',
        }}>
          <CheckIcon />
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--status-success, #22c55e)', fontWeight: 500 }}>
            OpenCode CLI is installed
          </span>
        </div>
      ) : (
        <>
          <div style={{
            padding: 'var(--space-4)',
            background: 'var(--review-card-bg)',
            borderRadius: 14,
            border: '1px solid var(--review-shell-border)',
          }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
              Run this command in your terminal:
            </div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              background: 'var(--review-code-bg)',
              borderRadius: 10,
              padding: 'var(--space-2) var(--space-3)',
              border: '1px solid var(--review-shell-border)',
            }}>
              <code style={{
                flex: 1,
                fontSize: 'var(--text-sm)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)',
                userSelect: 'all',
                overflowX: 'auto',
              }}>
                {INSTALL_COMMAND}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                style={{
                  ...getReviewActionButtonStyle({ tone: copied ? 'green' : 'neutral', active: copied }),
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '0 10px',
                  minHeight: 24,
                  borderRadius: 8,
                  color: copied ? 'var(--status-success, #22c55e)' : 'var(--text-secondary)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'color 0.15s',
                  flexShrink: 0,
                }}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
          }}>
            <Spinner size={12} />
            Waiting for installation...
          </div>
        </>
      )}

      {/* Navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-3)' }}>
        <button
          type="button"
          onClick={onBack}
          style={wizardBackButtonStyle()}
        >
          Back
        </button>
        {installed && (
          <button
            type="button"
            onClick={onNext}
            style={wizardPrimaryButtonStyle()}
          >
            Next
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

function CheckIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="var(--status-success, #22c55e)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function wizardBackButtonStyle(): React.CSSProperties {
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

function wizardPrimaryButtonStyle(): React.CSSProperties {
  return {
    ...getReviewActionButtonStyle({ tone: 'blue', active: true }),
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
