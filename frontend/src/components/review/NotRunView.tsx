/**
 * NotRunView — shown when no review has run on the branch yet. Top-aligned
 * hero with a single primary "Run review" action plus a Configure ghost.
 *
 * Direction C originally surfaced three run presets (Full / Risky paths /
 * Diff vs. last). The current product cut keeps only one path — the
 * default full review — so the preset tiles were removed in favour of a
 * cleaner CTA. The shell top bar shows the same Run review button on the
 * right; this hero is the empty-state for the left pane.
 */

import { Btn } from './primitives';

function isLastCommitFallbackBaseBranch(baseBranch: string | null | undefined): boolean {
  return typeof baseBranch === 'string' && baseBranch.endsWith('~last-commit');
}

interface NotRunViewProps {
  /** Triggered by both the hero button and the top-bar Run review button (caller wires the same handler). */
  onRunReview?: () => void;
  /** Triggered by the secondary Configure button. Optional — when omitted the button is hidden. */
  onConfigure?: () => void;
  kind?: 'branch' | 'pr' | 'review';
  branchLabel?: string | null;
  baseBranch?: string | null;
  fileCount?: number | null;
  baseBranchMode?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  footer?: React.ReactNode;
  emptyDiffRecovery?: {
    baseBranch: string;
    onReviewLastCommit?: () => void;
    onChangeBase?: () => void;
    disabled?: boolean;
    disabledReason?: string | null;
  } | null;
}

export function NotRunView({
  onRunReview,
  onConfigure,
  kind = 'branch',
  branchLabel,
  baseBranch,
  fileCount,
  baseBranchMode = false,
  disabled = false,
  disabledReason = null,
  footer = null,
  emptyDiffRecovery = null,
}: NotRunViewProps) {
  const description = buildDescription({ kind, fileCount, baseBranch, branchLabel, baseBranchMode });
  const title = baseBranchMode && branchLabel
    ? `${branchLabel} is the base branch`
    : kind === 'pr'
    ? 'Ready to review this pull request'
    : kind === 'branch'
      ? `Ready to review${branchLabel ? ' this branch' : ''}`
      : 'Ready to review these changes';
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: '96px 32px 32px',
        gap: 14,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          background: 'color-mix(in oklab, var(--accent-blue) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--accent-blue) 30%, transparent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent-blue)',
          fontSize: 18,
        }}
      >
        {'\u2728'}
      </div>

      <div style={{ textAlign: 'center', display: 'grid', gap: 6, maxWidth: 420 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {title}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
          {description}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Btn
          variant="primary"
          size="sm"
          onClick={onRunReview}
          disabled={disabled || !onRunReview}
          title={disabled ? (disabledReason || undefined) : undefined}
        >
          <span style={{ fontSize: 12 }}>{'\u2728'}</span>
          Run review
        </Btn>
        {onConfigure && (
          <Btn
            variant="ghost"
            size="sm"
            onClick={onConfigure}
            disabled={disabled}
          >
            <span style={{ fontSize: 12 }}>{'\u2699'}</span>
            Configure
          </Btn>
        )}
      </div>

      {disabled && disabledReason && (
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center', maxWidth: 320, marginTop: 2 }}>
          {disabledReason}
        </div>
      )}

      {emptyDiffRecovery && (
        <div
          style={{
            width: 'min(100%, 420px)',
            marginTop: 8,
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--chip-warning-border)',
            background: 'var(--chip-warning-bg)',
            display: 'grid',
            gap: 10,
            textAlign: 'left',
          }}
        >
          <div style={{ display: 'grid', gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-yellow)' }}>
              No changes found against {emptyDiffRecovery.baseBranch}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              This branch may be stacked on another branch. You can review the latest commit or choose a different base.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn
              variant="primary"
              size="sm"
              onClick={emptyDiffRecovery.onReviewLastCommit}
              disabled={emptyDiffRecovery.disabled || !emptyDiffRecovery.onReviewLastCommit}
              title={emptyDiffRecovery.disabled ? (emptyDiffRecovery.disabledReason || undefined) : undefined}
            >
              Review last commit
            </Btn>
            {emptyDiffRecovery.onChangeBase && (
              <Btn
                variant="ghost"
                size="sm"
                onClick={emptyDiffRecovery.onChangeBase}
                disabled={emptyDiffRecovery.disabled}
              >
                Change base
              </Btn>
            )}
          </div>
          {emptyDiffRecovery.disabled && emptyDiffRecovery.disabledReason && (
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
              {emptyDiffRecovery.disabledReason}
            </div>
          )}
        </div>
      )}

      {footer && (
        <div style={{
          width: '100%',
          marginTop: 18,
          alignSelf: 'stretch',
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          paddingBottom: 40,
          scrollPaddingBottom: 40,
        }}>
          {footer}
        </div>
      )}
    </div>
  );
}

function buildDescription({
  kind,
  fileCount,
  baseBranch,
  branchLabel,
  baseBranchMode,
}: {
  kind: 'branch' | 'pr' | 'review';
  fileCount?: number | null;
  baseBranch?: string | null;
  branchLabel?: string | null;
  baseBranchMode?: boolean;
}): React.ReactNode {
  const fileCountText = typeof fileCount === 'number' && fileCount > 0
    ? `${fileCount} changed file${fileCount === 1 ? '' : 's'}`
    : 'the changed files';
  const subject = kind === 'pr' ? 'pull request' : kind === 'branch' ? 'branch' : 'change set';
  if (baseBranchMode) {
    return (
      <>
        Atlas can review the latest commit on {branchLabel || 'the base branch'}. The better workflow is to branch from base, build there, and review feature branches.
      </>
    );
  }
  if (baseBranch) {
    if (isLastCommitFallbackBaseBranch(baseBranch) || baseBranch === 'Last commit') {
      return (
        <>
          Atlas will analyze this {subject}'s {fileCountText} from the latest commit and surface findings grouped by severity. Typical runs take 30&ndash;90s.
        </>
      );
    }
    return (
      <>
        Atlas will analyze this {subject}'s {fileCountText} against{' '}
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{baseBranch}</span>{' '}
        and surface findings grouped by severity. Typical runs take 30&ndash;90s.
      </>
    );
  }
  return (
    <>
      Atlas will analyze this {subject}'s {fileCountText} and surface findings grouped by severity. Typical runs take 30&ndash;90s.
    </>
  );
}
