/**
 * ReviewShellTopBar — Direction C shell chrome. Owns:
 * - Back chevron, project name, branch/PR kind badge
 * - Status chip (NOT REVIEWED / RUNNING / COMPLETED)
 * - Severity counts (H/M/L) for completed state
 * - Mode switcher (Findings | Walkthrough | Files)
 * - Actions popover anchor
 */

import type { ReactNode } from 'react';
import { AtlasAiMark } from './AtlasAiMark';
import { Btn, SevChip } from './primitives';

export type ReviewShellMode = 'findings' | 'walkthrough' | 'files';
export type ReviewShellLifecycle = 'idle' | 'loading' | 'running' | 'reviewed' | 'failed';

interface ReviewShellAction {
  label: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onClick: () => void;
}

interface ReviewShellTopBarProps {
  projectName: string;
  kindBadge: ReactNode;
  lifecycle: ReviewShellLifecycle;
  highCount?: number;
  medCount?: number;
  lowCount?: number;
  addressedCount?: number;
  dismissedCount?: number;
  totalFindings?: number;
  mode: ReviewShellMode;
  onModeChange: (mode: ReviewShellMode) => void;
  onBack?: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  primaryAction?: ReviewShellAction | null;
  secondaryAction?: ReviewShellAction | null;
  assistantAction?: ReviewShellAction | null;
  /** Caller-supplied submit popover content (slot). Rendered absolutely-positioned under Submit. */
  submitPopover?: ReactNode;
  /** Extra meta line shown under the chip row, e.g. coverage + changes. */
  metaLine?: ReactNode;
  /** Compact running details shown next to the RUNNING chip. */
  runningMetaLine?: ReactNode;
  /** Modes the shell should expose in the switcher. Defaults to all three. */
  availableModes?: ReviewShellMode[];
  modeCounts?: Partial<Record<ReviewShellMode, number>>;
  /**
   * Amber chip surfaced next to severity counts when an agentic review
   * stopped with a non-success completion reason (e.g. hit turn budget,
   * killed for inactivity). Communicates that coverage may be incomplete.
   */
  executionWarning?: { label: string; tooltip?: string } | null;
}

const STATUS_VAR: Record<ReviewShellLifecycle, { label: string; color: string; pulsing: boolean }> = {
  idle:     { label: 'NOT REVIEWED', color: 'var(--text-tertiary)', pulsing: false },
  loading:  { label: 'LOADING',      color: 'var(--text-tertiary)', pulsing: true  },
  running:  { label: 'RUNNING',      color: 'var(--accent-blue)',   pulsing: true  },
  reviewed: { label: 'COMPLETED',    color: 'var(--sev-ok)',        pulsing: false },
  failed:   { label: 'FAILED',       color: 'var(--accent-red)',    pulsing: false },
};

const MODE_LABEL: Record<ReviewShellMode, string> = {
  findings: 'Findings',
  walkthrough: 'Walkthrough',
  files: 'Files',
};

function ReviewShellModeIcon({ mode }: { mode: ReviewShellMode }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style: { flexShrink: 0 },
  };

  if (mode === 'findings') {
    return (
      <svg {...common}>
        <path d="M7.1 2.3 1.7 12a1.3 1.3 0 0 0 1.1 2h10.4a1.3 1.3 0 0 0 1.1-2L8.9 2.3a1 1 0 0 0-1.8 0Z" />
        <path d="M8 5.8v3.2" />
        <path d="M8 11.7h.01" />
      </svg>
    );
  }

  if (mode === 'walkthrough') {
    return (
      <svg {...common}>
        <path d="M4.5 2.5h5.4l2 2v9l-3.9-2-3.9 2v-10a1 1 0 0 1 1-1Z" />
        <path d="M9.8 2.6v2h2" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path d="M4.5 1.8h4.6l2.9 2.9v8.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z" />
      <path d="M9 2v3h3" />
    </svg>
  );
}

export function ReviewShellTopBar({
  projectName,
  kindBadge,
  lifecycle,
  highCount = 0,
  medCount = 0,
  lowCount = 0,
  addressedCount = 0,
  dismissedCount = 0,
  totalFindings = 0,
  mode,
  onModeChange,
  availableModes = ['findings', 'walkthrough', 'files'],
  onBack,
  onSubmit,
  submitLabel = 'Submit',
  submitDisabled = false,
  primaryAction = null,
  secondaryAction = null,
  assistantAction = null,
  submitPopover = null,
  metaLine = null,
  runningMetaLine = null,
  modeCounts = {},
  executionWarning = null,
}: ReviewShellTopBarProps) {
  const status = STATUS_VAR[lifecycle];
  const cleanAndDone = lifecycle === 'reviewed' && highCount === 0 && medCount === 0 && lowCount === 0;
  const resolvedTail = lifecycle === 'reviewed'
    ? `${totalFindings} finding${totalFindings === 1 ? '' : 's'} · ${addressedCount} addressed · ${dismissedCount} dismissed`
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--review-shell-topbar)',
        borderBottom: '1px solid var(--review-shell-divider)',
        flexShrink: 0,
      }}
    >
      {/* Row 1: back arrow, project name, kind badge, mode switcher, action buttons */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
          height: 40,
          fontSize: 12,
          minHeight: 40,
        }}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to dashboard"
            title="Back to dashboard"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              padding: 2,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="10 3 5 8 10 13" />
            </svg>
          </button>
        )}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            title="Back to project home"
            aria-label={`${projectName} home`}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              fontWeight: 500,
              fontSize: 'inherit',
              fontFamily: 'inherit',
              padding: '2px 4px',
              margin: '0 -4px',
              borderRadius: 3,
              cursor: 'pointer',
              transition: 'background var(--transition-fast), color var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-surface-raised)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            {projectName}
          </button>
        ) : (
          <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{projectName}</span>
        )}
        <span style={{ color: 'var(--text-tertiary)' }}>/</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {kindBadge}
        </span>

        <div style={{ flex: 1 }} />

        {/* Mode switcher — Findings | Walkthrough | Files. Stays available during active runs. */}
        <div
          style={{
            display: 'inline-flex',
            gap: 2,
            padding: 2,
            background: 'var(--review-segment-bg)',
            border: '1px solid var(--review-shell-divider)',
            borderRadius: 4,
          }}
        >
          {availableModes.map((m) => {
            const active = m === mode;
            const modeCount = modeCounts[m];
            const hasModeCount = typeof modeCount === 'number' && Number.isFinite(modeCount);
            return (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                style={{
                  padding: '3px 10px',
                  borderRadius: 2,
                  border: 'none',
                  background: active ? 'var(--review-segment-active-bg)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <ReviewShellModeIcon mode={m} />
                {MODE_LABEL[m]}
                {hasModeCount && (
                  <span
                    style={{
                      minWidth: 15,
                      height: 15,
                      padding: '0 4px',
                      borderRadius: 999,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: active ? 'var(--bg-surface)' : 'var(--bg-hover)',
                      color: active ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                      fontSize: 10,
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      lineHeight: 1,
                    }}
                  >
                    {Math.max(0, Math.floor(modeCount))}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {primaryAction && (
          <Btn
            variant="primary"
            size="sm"
            accent={primaryAction.tone === 'danger' ? 'var(--sev-high)' : undefined}
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
          >
            {primaryAction.tone === 'danger' && (
              <span style={{ width: 6, height: 6, background: '#fff', borderRadius: 1, display: 'inline-block' }} />
            )}
            {primaryAction.tone !== 'danger' && (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4 8 1.5Z" fill="currentColor" opacity="0.9" />
                <path d="M12.4 1.8 12.9 3.1 14.2 3.6 12.9 4.1 12.4 5.4 11.9 4.1 10.6 3.6 11.9 3.1 12.4 1.8Z" fill="currentColor" opacity="0.65" />
              </svg>
            )}
            {primaryAction.label}
          </Btn>
        )}

        {secondaryAction && (
          <Btn
            variant="ghost"
            size="sm"
            accent={secondaryAction.tone === 'danger' ? 'var(--sev-high)' : undefined}
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
          >
            {secondaryAction.tone === 'danger' && (
              <span style={{ width: 6, height: 6, background: 'currentColor', borderRadius: 1, display: 'inline-block' }} />
            )}
            {secondaryAction.label}
          </Btn>
        )}

        {onSubmit && (
          <div style={{ position: 'relative' }}>
            <Btn
              variant="primary"
              size="sm"
              onMouseDown={(event) => {
                if (submitPopover) event.stopPropagation();
              }}
              onClick={onSubmit}
              disabled={submitDisabled}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 8 6 11 13 4" />
              </svg>
              {submitLabel}
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, opacity: 0.8 }}>
                <polyline points="3 6 8 11 13 6" />
              </svg>
            </Btn>
            {submitPopover}
          </div>
        )}
      </div>

      {/* Row 2: status chip, severity counts, meta, tab-specific rerun */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 16px',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 7px',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: status.color,
            background:
              lifecycle === 'idle'
                ? 'transparent'
                : `color-mix(in oklab, ${status.color} 14%, transparent)`,
            border: `1px solid ${lifecycle === 'idle' ? 'var(--border-default)' : `color-mix(in oklab, ${status.color} 30%, transparent)`}`,
          }}
        >
          {status.pulsing && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                background: status.color,
                animation: 'atlas-pulse 1.2s ease-in-out infinite',
              }}
            />
          )}
          {status.label}
        </span>

        {lifecycle === 'running' && runningMetaLine && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', minWidth: 0 }}>
            {runningMetaLine}
          </span>
        )}

        {lifecycle === 'reviewed' && (
          <>
            {highCount > 0 && <SevChip level="HIGH" count={highCount} />}
            {medCount > 0 && <SevChip level="MED" count={medCount} />}
            {lowCount > 0 && <SevChip level="LOW" count={lowCount} />}
            {cleanAndDone && (
              <span style={{ fontSize: 11, color: 'var(--sev-ok)', fontWeight: 500 }}>
                {'\u2713'} Clean
              </span>
            )}
            {executionWarning && (
              <span
                title={executionWarning.tooltip || executionWarning.label}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 7px',
                  borderRadius: 3,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  textTransform: 'uppercase',
                  color: 'var(--sev-med)',
                  background: 'color-mix(in oklab, var(--sev-med) 14%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--sev-med) 32%, transparent)',
                }}
              >
                {'\u26a0'} {executionWarning.label}
              </span>
            )}
            {resolvedTail && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {resolvedTail}
              </span>
            )}
          </>
        )}

        <div style={{ flex: 1 }} />
        {metaLine && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'inline-flex', gap: 12 }}>{metaLine}</span>}
        {assistantAction && (
          <button
            type="button"
            onClick={assistantAction.onClick}
            disabled={assistantAction.disabled}
            aria-label={assistantAction.label}
            title={assistantAction.label}
            style={{
              minWidth: 28,
              height: 28,
              borderRadius: 5,
              border: assistantAction.disabled
                ? '1px solid var(--review-shell-divider)'
                : '1px solid var(--review-assistant-action-border)',
              background: assistantAction.disabled
                ? 'var(--bg-surface)'
                : 'var(--review-assistant-action-bg)',
              color: assistantAction.disabled ? 'var(--text-tertiary)' : 'var(--review-assistant-action-fg)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '0 9px 0 7px',
              cursor: assistantAction.disabled ? 'default' : 'pointer',
              boxShadow: assistantAction.disabled ? 'none' : 'var(--review-assistant-action-shadow)',
              whiteSpace: 'nowrap',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
            }}
          >
            <AtlasAiMark size={17} />
            <span>Ask Atlas</span>
          </button>
        )}
      </div>
    </div>
  );
}
