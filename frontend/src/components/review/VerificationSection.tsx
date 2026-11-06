/**
 * VerificationSection — Lint/unit/e2e check status display.
 * Extracted from TrustReviewPanel.tsx.
 */

import type { VerifyConfig } from '@/services/api';
import type { ChangeSetVerification, VerificationStatus } from '@/types';

export function VerificationSection({
  verification,
  verifyConfig,
  isRunningChecks,
  verifyError,
  expandedLogs,
  onRunChecks,
  onToggleLog,
}: {
  verification?: ChangeSetVerification | null;
  verifyConfig: VerifyConfig | null;
  isRunningChecks: boolean;
  verifyError: string | null;
  expandedLogs: Set<string>;
  onRunChecks: () => void;
  onToggleLog: (checkName: string) => void;
}) {
  type CheckInfo = {
    key: string;
    name: string;
    enabled: boolean;
    status: VerificationStatus;
    logs?: string;
  };

  const configChecks = verifyConfig?.checks && verifyConfig.checks.length > 0
    ? verifyConfig.checks
    : [
      { id: 'lint', label: 'Lint', kind: 'lint', enabled: verifyConfig?.lint ?? true },
      { id: 'unit', label: 'Unit Tests', kind: 'unit', enabled: verifyConfig?.unit ?? true },
      { id: 'e2e', label: 'E2E Tests', kind: 'e2e', enabled: verifyConfig?.e2e ?? true },
    ];

  const checks: CheckInfo[] = configChecks.map((check) => ({
    key: check.id,
    name: check.label,
    enabled: check.enabled !== false,
    status: verification?.checks?.[check.id]?.status
      || (check.kind === 'lint' ? verification?.lint : undefined)
      || (check.kind === 'unit' ? verification?.unit : undefined)
      || (check.kind === 'e2e' ? verification?.e2e : undefined)
      || 'not_run',
    logs: verification?.logs?.[check.id]
      || (check.kind === 'lint' ? verification?.logs?.lint : undefined)
      || (check.kind === 'unit' ? verification?.logs?.unit : undefined)
      || (check.kind === 'e2e' ? verification?.logs?.e2e : undefined),
  }));

  const passedCount = checks.filter(c => c.enabled && c.status === 'pass').length;
  const enabledCount = checks.filter(c => c.enabled).length;

  const statusIcon = (check: CheckInfo): { symbol: string; color: string } => {
    if (!check.enabled) return { symbol: '\u2699', color: 'var(--text-tertiary)' }; // gear
    if (check.status === 'pass') return { symbol: '\u2713', color: 'var(--accent-green)' };
    if (check.status === 'fail') return { symbol: '\u2717', color: 'var(--accent-red)' };
    return { symbol: '\u2014', color: 'var(--text-tertiary)' };
  };

  const statusText = (check: CheckInfo): string => {
    if (!check.enabled) return 'disabled';
    if (check.status === 'pass') return 'passed';
    if (check.status === 'fail') return 'failed';
    return 'not run';
  };

  return (
    <div style={{
      background: 'var(--bg-surface)',
      borderTop: '1px solid var(--border-muted)',
      paddingTop: 'var(--space-3)',
      marginTop: 'var(--space-2)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        marginBottom: 'var(--space-2)',
      }}>
        <span style={{
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          color: 'var(--text-primary)',
        }}>
          Verification
        </span>
        <span style={{
          fontSize: 10,
          color: 'var(--text-tertiary)',
        }}>
          {passedCount}/{enabledCount} passed
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onRunChecks}
          disabled={isRunningChecks}
          style={{
            padding: '2px var(--space-2)',
            fontSize: 10,
            fontFamily: 'var(--font-sans)',
            fontWeight: 500,
            color: isRunningChecks ? 'var(--text-tertiary)' : 'var(--accent-blue)',
            background: isRunningChecks ? 'var(--bg-overlay)' : 'var(--chip-info-bg)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: isRunningChecks ? 'wait' : 'pointer',
          }}
        >
          {isRunningChecks ? 'Verifying...' : 'Verify'}
        </button>
      </div>

      {/* Check rows */}
      {checks.map((check) => {
        const icon = statusIcon(check);
        const hasFailed = check.enabled && check.status === 'fail' && check.logs;
        const isLogOpen = expandedLogs.has(check.key);

        return (
          <div key={check.key}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: 'var(--space-1) 0',
                fontSize: 'var(--text-xs)',
                height: 24,
              }}
            >
              <span style={{
                color: icon.color,
                fontWeight: 700,
                width: 14,
                textAlign: 'center',
              }}>
                {icon.symbol}
              </span>
              <span style={{
                color: check.enabled ? 'var(--text-secondary)' : 'var(--text-tertiary)',
              }}>
                {check.name}
              </span>
              <span style={{ flex: 1 }} />
              {hasFailed && (
                <button
                  type="button"
                  onClick={() => onToggleLog(check.key)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    color: 'var(--text-tertiary)',
                    fontSize: 10,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      transform: isLogOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform var(--transition-fast)',
                    }}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              )}
              <span style={{
                color: icon.color,
                fontSize: 10,
                textTransform: 'capitalize',
              }}>
                {statusText(check)}
              </span>
            </div>

            {/* Expanded log output */}
            {hasFailed && isLogOpen && check.logs && (
              <pre style={{
                margin: '0 0 var(--space-2) 22px',
                padding: 'var(--space-2)',
                background: 'var(--bg-overlay)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-secondary)',
                overflow: 'auto',
                maxHeight: 200,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                lineHeight: 1.4,
              }}>
                {check.logs}
              </pre>
            )}
          </div>
        );
      })}

      {/* Error message */}
      {verifyError && (
        <div style={{
          fontSize: 10,
          color: 'var(--accent-red)',
          marginTop: 'var(--space-1)',
          padding: 'var(--space-1) 0',
        }}>
          {verifyError}
          <button
            type="button"
            onClick={onRunChecks}
            style={{
              marginLeft: 'var(--space-2)',
              background: 'none',
              border: 'none',
              color: 'var(--accent-blue)',
              cursor: 'pointer',
              fontSize: 10,
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Last run timestamp */}
      {verification?.lastRunAt && (
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
          Last run: {new Date(verification.lastRunAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
