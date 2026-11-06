import { Btn } from './primitives';
import { formatPersistedFailureMessage } from './reviewPanelUtils';

interface FailedReviewViewProps {
  onRunReview?: () => void;
  kind?: 'branch' | 'pr' | 'review';
  error?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
}

export function FailedReviewView({
  onRunReview,
  kind = 'branch',
  error = null,
  disabled = false,
  disabledReason = null,
}: FailedReviewViewProps) {
  const title = kind === 'pr'
    ? 'Pull request review failed'
    : kind === 'branch'
      ? 'Branch review failed'
      : 'Review failed';
  const formattedError = formatPersistedFailureMessage(String(error || '').trim());
  const detail = formattedError
    || 'Atlas could not complete this review. Retry the review or check provider settings.';

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
        overflow: 'auto',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          background: 'color-mix(in oklab, var(--accent-red) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--accent-red) 32%, transparent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent-red)',
          fontSize: 18,
        }}
      >
        !
      </div>

      <div style={{ textAlign: 'center', display: 'grid', gap: 8, maxWidth: 520 }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--text-primary)' }}>
          {title}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
            overflowWrap: 'anywhere',
          }}
        >
          {detail}
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
          Retry review
        </Btn>
      </div>

      {disabled && disabledReason && (
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center', maxWidth: 320, marginTop: 2 }}>
          {disabledReason}
        </div>
      )}
    </div>
  );
}
