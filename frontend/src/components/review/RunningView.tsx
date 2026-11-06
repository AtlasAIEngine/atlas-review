/**
 * RunningView — shown while a review is actively running. Three stacked
 * sections matching Direction C: Current-step card (mono agent status +
 * shimmer + progress meta), Pipeline checklist, and Activity log tail.
 *
 * Presentational only — the caller wires `onStop` to its existing cancel
 * hook (reviewApi / branchReviewApi / prReviewApi) and passes through
 * the live branch/PR progress snapshot.
 */

import { useState, type ReactNode } from 'react';
import { Btn } from './primitives';

export interface RunningStepSpec {
  id: string;
  label: string;
  state: 'pending' | 'active' | 'done';
}

export interface RunningProgress {
  phase?: string;
  agentName?: string | null;
  agenticToolSummary?: string | null;
  reviewModel?: string | null;
  reviewModelStrategy?: string | null;
  reviewModelEffectiveStrategy?: string | null;
  filesCompleted?: number;
  totalFiles?: number;
  currentChunk?: number;
  totalChunks?: number;
  elapsedSeconds?: number;
  // Live cli-agentic counters from progress events; only present during
  // agentic_exploration / agentic_tool_use phases.
  agenticToolUseCount?: number;
  agenticMaxTurns?: number;
}

interface RunningViewProps {
  currentStep?: string | null;
  steps?: RunningStepSpec[];
  progress?: RunningProgress | null;
  logTail?: string[];
  elapsedLabel?: string | null;
  metaLabel?: ReactNode;
  queuedReviewNotice?: ReactNode;
  onStop?: () => void;
  stopDisabled?: boolean;
}

const DEFAULT_STEPS: RunningStepSpec[] = [
  { id: 'prep',   label: 'Preparing files',     state: 'done' },
  { id: 'triage', label: 'Triage',              state: 'active' },
  { id: 'review', label: 'Reviewing',           state: 'pending' },
  { id: 'synth',  label: 'Synthesising summary', state: 'pending' },
];

export function RunningView({
  currentStep,
  steps = DEFAULT_STEPS,
  progress = null,
  logTail,
  elapsedLabel = null,
  queuedReviewNotice = null,
  onStop,
  stopDisabled = false,
}: RunningViewProps) {
  const agentName = progress?.agentName?.trim() || 'Atlas';
  const agentSummary = progress?.agenticToolSummary?.trim() || null;
  const currentStepText = currentStep || buildCurrentStepText(progress, agentName, agentSummary);
  const progressMeta = buildProgressMeta(steps, progress, elapsedLabel);
  const activityLines = buildVisibleActivityLines(logTail, progress, agentName, agentSummary);
  const activityMetaLines = buildReviewModelActivityLines(progress);
  const progressiveHint = buildProgressiveHint(progress?.elapsedSeconds || 0, progress?.totalFiles);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'auto',
      }}
    >
      {/* ── Current step card ───────────────────────────────────────────── */}
      <div style={{ padding: 18, borderBottom: '1px solid var(--review-shell-divider)' }}>
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 600,
            marginBottom: 10,
          }}
        >
          Current step
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            padding: '10px 12px',
            background: 'var(--bg-base)',
            border: '1px solid var(--review-shell-divider)',
            borderRadius: 4,
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: 'var(--accent-blue)',
              animation: 'atlas-pulse 1.2s ease-in-out infinite',
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentStepText}
          </span>
          <span style={{ color: 'var(--text-tertiary)', animation: 'atlas-pulse 1.2s ease-in-out infinite' }}>…</span>
        </div>
        {/* Shimmer bar */}
        <div
          style={{
            marginTop: 10,
            height: 3,
            borderRadius: 2,
            background: 'var(--border-muted)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: '35%',
              background: 'linear-gradient(90deg, transparent, var(--accent-blue), transparent)',
              animation: 'atlas-shimmer 1.8s linear infinite',
            }}
          />
        </div>
        {progressMeta && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 6,
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>{progressMeta.stepPart}</span>
            {progressMeta.timePart && <span>{progressMeta.timePart}</span>}
          </div>
        )}
        {progressiveHint && (
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              fontSize: 11,
              color: 'var(--text-secondary)',
              background: 'var(--bg-base)',
              border: '1px dashed var(--border-muted)',
              borderRadius: 4,
              lineHeight: 1.4,
            }}
            role="status"
            aria-live="polite"
          >
            {progressiveHint}
          </div>
        )}
      </div>

      {/* ── Pipeline ────────────────────────────────────────────────────── */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--review-shell-divider)' }}>
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          Pipeline
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {steps.map((step) => {
            const durationLabel = getStepDurationLabel(step, progress);
            return (
              <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                <StepMarker state={step.state} />
                <span
                  style={{
                    color:
                      step.state === 'done' ? 'var(--text-secondary)'
                      : step.state === 'active' ? 'var(--text-primary)'
                      : 'var(--text-tertiary)',
                    fontWeight: step.state === 'active' ? 600 : 400,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {step.label}
                </span>
                {durationLabel && (
                  <span style={{
                    color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {durationLabel}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {queuedReviewNotice && (
        <div style={{ padding: '12px 16px 0' }}>
          {queuedReviewNotice}
        </div>
      )}

      {/* ── Activity ────────────────────────────────────────────────────── */}
      <div style={{ padding: '14px 16px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          Activity
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--text-secondary)',
            lineHeight: 1.7,
            background: 'var(--bg-base)',
            padding: '8px 10px',
            border: '1px solid var(--review-shell-divider)',
            borderRadius: 4,
            height: 168,
            overflow: 'auto',
          }}
        >
          {activityLines.length > 0 ? activityLines.map((line, idx) => (
            <div key={idx} style={{ whiteSpace: 'pre-wrap' }}>{line}</div>
          )) : (
            <div style={{ color: 'var(--text-tertiary)' }}>Waiting for the first event…</div>
          )}
        </div>
        {activityMetaLines.length > 0 && (
          <div
            style={{
              marginTop: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
              background: 'var(--bg-base)',
              padding: '6px 10px',
              border: '1px solid var(--review-shell-divider)',
              borderRadius: 4,
            }}
          >
            {activityMetaLines.map((line, idx) => (
              <div key={idx} style={{ whiteSpace: 'pre-wrap' }}>{line}</div>
            ))}
          </div>
        )}
      </div>

      {/* ── Stop ────────────────────────────────────────────────────────── */}
      {onStop && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--review-shell-divider)' }}>
          <Btn
            variant="primary"
            size="sm"
            accent="var(--sev-high)"
            onClick={onStop}
            disabled={stopDisabled}
          >
            <span style={{ width: 6, height: 6, background: '#fff', borderRadius: 1, display: 'inline-block' }} />
            Stop review
          </Btn>
        </div>
      )}
    </div>
  );
}

export function RunningReviewStrip({
  currentStep,
  steps = DEFAULT_STEPS,
  progress = null,
  logTail,
  elapsedLabel = null,
  metaLabel = null,
}: Omit<RunningViewProps, 'onStop' | 'stopDisabled'>) {
  const [expanded, setExpanded] = useState(false);
  const agentName = progress?.agentName?.trim() || 'Atlas';
  const agentSummary = progress?.agenticToolSummary?.trim() || null;
  const currentStepText = currentStep || buildCurrentStepText(progress, agentName, agentSummary);
  const progressMeta = buildProgressMeta(steps, progress, elapsedLabel);
  const activityLines = buildVisibleActivityLines(logTail, progress, agentName, agentSummary);
  const activityMetaLines = buildReviewModelActivityLines(progress);
  const progressiveHint = buildProgressiveHint(progress?.elapsedSeconds || 0, progress?.totalFiles);

  return (
    <div
      style={{
        margin: '12px 14px 10px',
        border: '1px solid color-mix(in oklab, var(--accent-blue) 35%, var(--review-shell-divider))',
        borderRadius: 8,
        background: 'color-mix(in srgb, var(--review-panel-bg) 88%, var(--accent-blue) 4%)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <div style={{ padding: '10px 12px' }}>
        {metaLabel && (
          <div
            style={{
              marginBottom: 8,
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-sans)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {metaLabel}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--text-primary)',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: 'var(--accent-blue)',
              animation: 'atlas-pulse 1.2s ease-in-out infinite',
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentStepText}
          </span>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-tertiary)',
              fontSize: 10.5,
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'var(--font-sans)',
            }}
          >
            {expanded ? 'Hide details' : 'Show more'}
          </button>
        </div>
        <div
          style={{
            marginTop: 8,
            height: 3,
            borderRadius: 2,
            background: 'var(--border-muted)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: '35%',
              background: 'linear-gradient(90deg, transparent, var(--accent-blue), transparent)',
              animation: 'atlas-shimmer 1.8s linear infinite',
            }}
          />
        </div>
        {progressMeta && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 6,
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>{progressMeta.stepPart}</span>
            {progressMeta.timePart && <span>{progressMeta.timePart}</span>}
          </div>
        )}
        {progressiveHint && (
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              fontSize: 11,
              color: 'var(--text-secondary)',
              background: 'var(--bg-base)',
              border: '1px dashed var(--border-muted)',
              borderRadius: 4,
              lineHeight: 1.4,
            }}
            role="status"
            aria-live="polite"
          >
            {progressiveHint}
          </div>
        )}
      </div>
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--review-shell-divider)',
            padding: '10px 12px 12px',
            display: 'grid',
            gap: 10,
          }}
        >
          <div style={{ display: 'grid', gap: 6 }}>
            {steps.map((step) => (
              <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
                <StepMarker state={step.state} />
                <span
                  style={{
                    color:
                      step.state === 'done' ? 'var(--text-secondary)'
                      : step.state === 'active' ? 'var(--text-primary)'
                      : 'var(--text-tertiary)',
                    fontWeight: step.state === 'active' ? 600 : 400,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {step.label}
                </span>
                {getStepDurationLabel(step, progress) && (
                  <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                    {getStepDurationLabel(step, progress)}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--text-secondary)',
              lineHeight: 1.55,
              background: 'var(--bg-base)',
              padding: '7px 9px',
              border: '1px solid var(--review-shell-divider)',
              borderRadius: 4,
              maxHeight: 140,
              overflow: 'auto',
            }}
          >
            {activityLines.length > 0 ? activityLines.map((line, idx) => (
              <div key={idx} style={{ whiteSpace: 'pre-wrap' }}>{line}</div>
            )) : (
              <div style={{ color: 'var(--text-tertiary)' }}>Waiting for the first event…</div>
            )}
          </div>
          {activityMetaLines.length > 0 && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
                background: 'var(--bg-base)',
                padding: '6px 9px',
                border: '1px solid var(--review-shell-divider)',
                borderRadius: 4,
              }}
            >
              {activityMetaLines.map((line, idx) => (
                <div key={idx} style={{ whiteSpace: 'pre-wrap' }}>{line}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function QueuedReviewPill({
  position = null,
  detail = null,
  onCancel,
  cancelDisabled = false,
}: {
  position?: number | null;
  detail?: ReactNode;
  onCancel?: () => void;
  cancelDisabled?: boolean;
}) {
  const positionLabel = typeof position === 'number' && position > 0
    ? `Queue position ${position}`
    : 'Waiting for the active review';
  return (
    <div
      style={{
        border: '1px solid color-mix(in srgb, var(--accent-yellow) 45%, var(--review-shell-divider))',
        borderRadius: 7,
        background: 'color-mix(in srgb, var(--review-panel-bg) 90%, var(--accent-yellow) 8%)',
        padding: '9px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--accent-yellow)',
          boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent-yellow) 18%, transparent)',
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-primary)', fontWeight: 600 }}>
          New review queued
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {detail || positionLabel}
        </div>
      </div>
      {onCancel && (
        <Btn
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={cancelDisabled}
          aria-label="Cancel queued review"
          title="Cancel queued review"
        >
          Cancel
        </Btn>
      )}
    </div>
  );
}

function buildProgressMeta(
  steps: RunningStepSpec[],
  progress: RunningProgress | null,
  elapsedLabel: string | null,
): { stepPart: string; timePart: string | null } | null {
  const doneCount = steps.filter((s) => s.state === 'done').length;
  const activeOffset = steps.some((s) => s.state === 'active') ? 1 : 0;
  const stepPart = `${doneCount + activeOffset} of ${steps.length} steps`;

  let filePart: string | null = null;
  const total = progress?.totalFiles;
  const done = progress?.filesCompleted;
  if (typeof total === 'number' && total > 0 && typeof done === 'number') {
    filePart = `${done}/${total} files`;
  } else if (typeof progress?.currentChunk === 'number' && typeof progress?.totalChunks === 'number' && progress.totalChunks > 0) {
    filePart = `chunk ${progress.currentChunk}/${progress.totalChunks}`;
  }

  const timePart = elapsedLabel || filePart;
  return { stepPart, timePart };
}

function buildCurrentStepText(
  progress: RunningProgress | null,
  agentName: string,
  agentSummary: string | null,
): string {
  const phase = String(progress?.phase || '').trim().toLowerCase();
  switch (phase) {
    case 'queued':
      return 'Queued — waiting to start';
    case 'preparing_files':
      return 'Preparing files';
    case 'file_triage':
      return 'Triaging files for review';
    case 'file_review_start':
    case 'file_review_inflight':
    case 'single_start':
    case 'single_inflight':
    case 'chunk_start':
    case 'chunk_inflight':
      return `${agentName} is reviewing files`;
    case 'chunk_split':
      return 'Splitting large chunks';
    case 'file_partial':
    case 'file_review_failed':
      return 'Retrying after a partial review';
    case 'agentic_exploration':
      return `${agentName} is exploring the codebase`;
    case 'agentic_tool_use':
      return `${agentName} is inspecting files`;
    case 'synthesizing':
      return 'Synthesising findings';
    case 'provider_retry':
    case 'retrying':
      return 'Retrying after a provider issue';
    // Phase 12: heuristic walkthrough-generation phases. Walkthrough is a
    // single-call cheap-tier generation, so the frontend infers the phase
    // from elapsed seconds rather than a backend event stream. See
    // WalkthroughView.walkthroughPhaseLabel.
    case 'preparing_diff':
      return 'Preparing diff';
    case 'generating_walkthrough':
      return `${agentName} is generating walkthrough`;
    default:
      return agentSummary ? `${agentName} is ${agentSummary}` : `${agentName} is reviewing files`;
  }
}

function buildProgressiveHint(elapsedSeconds: number, totalFiles: number | null | undefined): string | null {
  const elapsed = Math.max(0, Math.floor(Number(elapsedSeconds) || 0));
  const fileCount = typeof totalFiles === 'number' && totalFiles > 0 ? totalFiles : 0;
  const isLargeDiff = fileCount >= 50;

  if (elapsed < 60) return null;
  if (elapsed < 180) {
    return isLargeDiff
      ? `Still working — ${fileCount} files is a large diff and typically takes a few minutes.`
      : 'Still working…';
  }
  if (elapsed < 360) {
    return isLargeDiff
      ? `Taking longer than usual — large diffs can take 5–15 minutes. You can stop and run a partial review if needed.`
      : 'Taking longer than usual.';
  }
  return isLargeDiff
    ? `Running long — for very large diffs, partial review may be more practical. Use Stop above if you want to cut early.`
    : 'Running long. Stop above is available if you want to cut early.';
}

function formatElapsedDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  if (safeSeconds < 3600) {
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function getStepDurationLabel(step: RunningStepSpec, progress: RunningProgress | null): string | null {
  if (step.state !== 'active') return null;
  const elapsed = Number(progress?.elapsedSeconds);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return formatElapsedDuration(elapsed);
}

function buildActivityLines(
  progress: RunningProgress | null,
  agentName: string,
  agentSummary: string | null,
): string[] {
  const lines: string[] = [];
  const phase = String(progress?.phase || '').toLowerCase();
  if (phase) lines.push(`phase: ${phase}`);
  if (agentSummary) lines.push(`${agentName}: ${agentSummary}`);
  const isAgenticPhase = phase === 'agentic_exploration' || phase === 'agentic_tool_use';
  if (isAgenticPhase && typeof progress?.totalFiles === 'number' && progress.totalFiles > 0) {
    lines.push(`scope: ${progress.totalFiles} files`);
  }
  if (isAgenticPhase) {
    const toolUseCount = Number(progress?.agenticToolUseCount);
    const maxTurns = Number(progress?.agenticMaxTurns);
    const haveTools = Number.isFinite(toolUseCount) && toolUseCount > 0;
    const haveMax = Number.isFinite(maxTurns) && maxTurns > 0;
    if (haveTools && haveMax) {
      lines.push(`turns: ${toolUseCount} of ${maxTurns} · ${toolUseCount} tool call${toolUseCount === 1 ? '' : 's'}`);
    } else if (haveTools) {
      lines.push(`tool calls: ${toolUseCount}`);
    } else if (haveMax) {
      lines.push(`turn budget: up to ${maxTurns}`);
    }
  }
  if (typeof progress?.filesCompleted === 'number' && typeof progress?.totalFiles === 'number' && progress.totalFiles > 0) {
    if (!isAgenticPhase) {
      lines.push(`files: ${progress.filesCompleted} of ${progress.totalFiles} reviewed`);
    }
  }
  if (typeof progress?.currentChunk === 'number' && typeof progress?.totalChunks === 'number' && progress.totalChunks > 0) {
    lines.push(`chunk: ${progress.currentChunk} of ${progress.totalChunks}`);
  }
  return lines;
}

function buildVisibleActivityLines(
  logTail: string[] | undefined,
  progress: RunningProgress | null,
  agentName: string,
  agentSummary: string | null,
): string[] {
  return logTail && logTail.length > 0
    ? [...logTail]
    : buildActivityLines(progress, agentName, agentSummary);
}

function buildReviewModelActivityLines(progress: RunningProgress | null): string[] {
  const modelLabel = formatReviewModelLabel(progress?.reviewModel);
  const strategyLabel = formatReviewModelStrategyLabel(progress?.reviewModelStrategy);
  const effectiveStrategyLabel = formatReviewModelStrategyLabel(progress?.reviewModelEffectiveStrategy);
  const lines: string[] = [];
  if (modelLabel) {
    lines.push(`model: ${modelLabel}`);
  }
  if (strategyLabel) {
    const effectiveSuffix = effectiveStrategyLabel && effectiveStrategyLabel !== strategyLabel
      ? ` -> ${effectiveStrategyLabel}`
      : '';
    lines.push(`strategy: ${strategyLabel}${effectiveSuffix}`);
  }
  return lines;
}

function formatReviewModelLabel(model: string | null | undefined): string | null {
  const normalized = typeof model === 'string' ? model.trim() : '';
  return normalized || null;
}

function formatReviewModelStrategyLabel(strategy: string | null | undefined): string | null {
  const normalized = typeof strategy === 'string' ? strategy.trim().toLowerCase() : '';
  switch (normalized) {
    case 'smart':
      return 'Balanced';
    case 'adaptive':
      return 'Cost-aware';
    case 'performance':
      return 'Performance';
    case 'max_quality':
      return 'Maximum quality';
    case 'latency_first':
      return 'Latency-first';
    case 'custom':
      return 'Custom';
    default:
      return normalized ? normalized.replace(/_/g, ' ') : null;
  }
}

function StepMarker({ state }: { state: RunningStepSpec['state'] }) {
  if (state === 'done') {
    return (
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          background: 'var(--sev-ok)',
          color: '#0c0d0e',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 9,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {'\u2713'}
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          border: '2px solid var(--accent-blue)',
          borderTopColor: 'transparent',
          animation: 'atlas-spin 1s linear infinite',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        border: '1px solid var(--border-default)',
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );
}
