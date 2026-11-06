import {
  ReviewActionButton,
  ReviewChip,
  getReviewMetaTextStyle,
  reviewSurfaceStyle,
} from './ReviewChrome';
import type { ReviewFixRunHistoryEntry } from '@/types';

export function FixProgressBanner({
  statusLabel,
  selectedCount,
  elapsedSeconds,
  isRunning,
  error,
  summaryLabel,
  patchSummaryLabel,
  patchPreviewLabel,
  coverageLabel,
  primaryActionLabel,
  secondaryActionLabel,
  onStop,
  onPrimaryAction,
  onSecondaryAction,
  historyItems,
  onHistoryAction,
  onHistoryPatchAction,
}: {
  statusLabel: string;
  selectedCount: number;
  elapsedSeconds?: number | null;
  isRunning: boolean;
  error?: string | null;
  summaryLabel?: string | null;
  patchSummaryLabel?: string | null;
  patchPreviewLabel?: string | null;
  coverageLabel?: string | null;
  primaryActionLabel?: string | null;
  secondaryActionLabel?: string | null;
  onStop?: (() => void) | null;
  onPrimaryAction?: (() => void) | null;
  onSecondaryAction?: (() => void) | null;
  historyItems?: ReviewFixRunHistoryEntry[];
  onHistoryAction?: ((item: ReviewFixRunHistoryEntry) => void) | null;
  onHistoryPatchAction?: ((item: ReviewFixRunHistoryEntry) => void) | null;
}) {
  const elapsedLabel = Number.isFinite(Number(elapsedSeconds))
    ? `${Math.max(0, Math.floor(Number(elapsedSeconds)))}s`
    : null;

  return (
    <div style={{
      marginBottom: 'var(--space-2)',
      ...reviewSurfaceStyle({ elevated: true, padded: false, variant: 'toolbar' }),
      padding: 'var(--space-2) var(--space-3)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 'var(--space-2)',
      flexWrap: 'wrap',
    }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: isRunning ? 'var(--accent-blue)' : 'var(--accent-yellow)',
          boxShadow: isRunning ? '0 0 0 4px rgba(96, 165, 250, 0.14)' : 'none',
          flexShrink: 0,
        }}
        />
        <ReviewChip tone={isRunning ? 'blue' : 'yellow'} style={{ minHeight: 22, padding: '0 9px' }}>
          {statusLabel}
        </ReviewChip>
        <span style={getReviewMetaTextStyle()}>
          {selectedCount} finding{selectedCount === 1 ? '' : 's'}
        </span>
        {elapsedLabel && (
          <span style={getReviewMetaTextStyle({ mono: true })}>
            {elapsedLabel}
          </span>
        )}
        {summaryLabel && (
          <span style={getReviewMetaTextStyle({ bright: true })}>
            {summaryLabel}
          </span>
        )}
        {patchSummaryLabel && (
          <span style={getReviewMetaTextStyle({ bright: true })}>
            {patchSummaryLabel}
          </span>
        )}
        {patchPreviewLabel && (
          <span style={getReviewMetaTextStyle()}>
            {patchPreviewLabel}
          </span>
        )}
        {coverageLabel && (
          <span style={getReviewMetaTextStyle()}>
            {coverageLabel}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {error && (
          <span style={{ ...getReviewMetaTextStyle({ bright: true }), color: 'var(--accent-red)' }}>
            {error}
          </span>
        )}
        {isRunning && onStop && (
          <ReviewActionButton
            onClick={onStop}
            style={{ minHeight: 26, padding: '0 10px', fontSize: 10, fontWeight: 700 }}
          >
            Stop
          </ReviewActionButton>
        )}
        {!isRunning && primaryActionLabel && onPrimaryAction && (
          <ReviewActionButton
            onClick={onPrimaryAction}
            tone="blue"
            style={{ minHeight: 26, padding: '0 10px', fontSize: 10, fontWeight: 700 }}
          >
            {primaryActionLabel}
          </ReviewActionButton>
        )}
        {!isRunning && secondaryActionLabel && onSecondaryAction && (
          <ReviewActionButton
            onClick={onSecondaryAction}
            tone="neutral"
            style={{ minHeight: 26, padding: '0 10px', fontSize: 10, fontWeight: 700 }}
          >
            {secondaryActionLabel}
          </ReviewActionButton>
        )}
      </div>
      {Array.isArray(historyItems) && historyItems.length > 0 && (
        <div style={{
          width: '100%',
          display: 'grid',
          gap: 'var(--space-1)',
          paddingTop: 'var(--space-2)',
          borderTop: '1px solid var(--review-shell-divider)',
        }}
        >
          <span style={getReviewMetaTextStyle({ bright: true })}>Recent runs</span>
          {historyItems.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-2)',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', minWidth: 0 }}>
                <ReviewChip tone={item.status === 'failed' ? 'red' : item.status === 'stopped' ? 'yellow' : 'neutral'} style={{ minHeight: 20, padding: '0 8px' }}>
                  {item.statusLabel}
                </ReviewChip>
                <span style={getReviewMetaTextStyle()}>{item.timestampLabel}</span>
                <span style={getReviewMetaTextStyle()}>
                  {item.selectedCount} finding{item.selectedCount === 1 ? '' : 's'}
                </span>
                {item.summaryLabel && (
                  <span style={getReviewMetaTextStyle({ bright: true })}>
                    {item.summaryLabel}
                  </span>
                )}
                {item.fileSummaryLabel && (
                  <span style={getReviewMetaTextStyle({ bright: true })}>
                    {item.fileSummaryLabel}
                  </span>
                )}
                {item.filePreviewLabel && (
                  <span style={getReviewMetaTextStyle()}>
                    {item.filePreviewLabel}
                  </span>
                )}
                {item.coverageLabel && (
                  <span style={getReviewMetaTextStyle()}>
                    {item.coverageLabel}
                  </span>
                )}
                {item.changesetTitle && (
                  <span style={getReviewMetaTextStyle({ bright: true })}>
                    {item.changesetId ? `${item.changesetId} · ${item.changesetTitle}` : item.changesetTitle}
                  </span>
                )}
                {item.error && (
                  <span style={{ ...getReviewMetaTextStyle({ bright: true }), color: 'var(--accent-red)' }}>
                    {item.error}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                {item.patchAction && item.patchActionLabel && onHistoryPatchAction && (
                  <ReviewActionButton
                    onClick={() => onHistoryPatchAction(item)}
                    tone="neutral"
                    style={{ minHeight: 24, padding: '0 9px', fontSize: 10, fontWeight: 700 }}
                  >
                    {item.patchActionLabel}
                  </ReviewActionButton>
                )}
                {item.action && item.actionLabel && onHistoryAction && (
                  <ReviewActionButton
                    onClick={() => onHistoryAction(item)}
                    tone={item.action === 'verify' ? 'blue' : 'neutral'}
                    style={{ minHeight: 24, padding: '0 9px', fontSize: 10, fontWeight: 700 }}
                  >
                    {item.actionLabel}
                  </ReviewActionButton>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
