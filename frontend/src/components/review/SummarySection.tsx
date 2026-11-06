/**
 * SummarySection — Review summary with partial/files-only notice, stats, provider
 * attribution, model routing metadata, and strategy badge.
 */

import type { ReviewResult } from '@/types';
import {
  normalizeReviewTier,
  normalizeReviewModelStrategyValue,
  buildReviewedByLabel,
  buildReviewModelBreakdown,
  humanizeReasonCode,
  humanizeReasonCodeList,
  formatPartialReasonForDisplay,
} from './reviewPanelUtils';

export function SummarySection({
  review,
  hideRoutingMetadata = false,
}: {
  review: ReviewResult;
  hideRoutingMetadata?: boolean;
}) {
  const tier = normalizeReviewTier(review);
  const isPartial = tier === 'partial' || Boolean(review.stats?.isPartial);
  const failedFileCount = Math.max(0, Number(review.stats?.perFileFailedFiles || 0));
  const partialChunksCompleted = Math.max(0, Number(review.stats?.partialChunksCompleted || 0));
  const partialChunksTotal = Math.max(partialChunksCompleted, Number(review.stats?.partialChunksTotal || 0));
  const partialReason = typeof review.stats?.partialReason === 'string'
    ? formatPartialReasonForDisplay(review.stats.partialReason)
    : '';
  const reviewedByLabel = buildReviewedByLabel(review);
  const reviewModelBreakdown = buildReviewModelBreakdown(review);
  const strategy = normalizeReviewModelStrategyValue(review.stats?.reviewModelStrategy);
  const effectiveStrategy = normalizeReviewModelStrategyValue(
    review.stats?.reviewModelEffectiveStrategy || review.stats?.reviewModelStrategy
  );
  const policyVersion = String(review.stats?.reviewModelPolicyVersion || '').trim();
  const decisionReason = humanizeReasonCode(review.stats?.reviewModelDecisionReason);
  const fallbackReason = humanizeReasonCode(review.stats?.reviewModelFallbackReason);
  const budgetClass = String(review.stats?.reviewModelBudgetClass || '').trim().toLowerCase();
  const rolloutMode = String(review.stats?.reviewModelRollout?.mode || '').trim().toLowerCase();
  const rolloutReason = humanizeReasonCode(review.stats?.reviewModelRollout?.reason);
  const gateStatus = String(
    review.stats?.reviewModelGate?.status
      || review.stats?.reviewModelRollout?.gate?.status
      || ''
  ).trim().toLowerCase();
  const gateReasons = (() => {
    const runtimeReasons = humanizeReasonCodeList(review.stats?.reviewModelGate?.reasonCodes);
    if (runtimeReasons.length > 0) return runtimeReasons;
    return humanizeReasonCodeList(review.stats?.reviewModelRollout?.gate?.reasonCodes);
  })();
  const gateReasonLabel = gateReasons.length > 0 ? gateReasons.slice(0, 2).join(', ') : '';
  const thresholdProfile = review.stats?.reviewModelThresholdProfile;
  const adaptiveThresholdLabel = (
    Number(thresholdProfile?.adaptive?.fastPathMaxFiles || 0) > 0
    && Number(thresholdProfile?.adaptive?.fastPathMaxDiffChars || 0) > 0
  )
    ? `${Number(thresholdProfile?.adaptive?.fastPathMaxFiles || 0)}f/${Number(thresholdProfile?.adaptive?.fastPathMaxDiffChars || 0)}c`
    : '';
  const latencyThresholdLabel = (
    Number(thresholdProfile?.latencyFirst?.reviewMaxFiles || 0) > 0
    && Number(thresholdProfile?.latencyFirst?.reviewMaxDiffChars || 0) > 0
  )
    ? `${Number(thresholdProfile?.latencyFirst?.reviewMaxFiles || 0)}f/${Number(thresholdProfile?.latencyFirst?.reviewMaxDiffChars || 0)}c`
    : '';
  const thresholdLabel = adaptiveThresholdLabel || latencyThresholdLabel;
  const modelsByPhase = review.stats?.modelsChosenByPhase;
  const phaseModelLabel = modelsByPhase && typeof modelsByPhase === 'object'
    ? [
      modelsByPhase.triage ? `triage: ${modelsByPhase.triage}` : null,
      modelsByPhase.review ? `review: ${modelsByPhase.review}` : null,
      modelsByPhase.synthesis ? `synthesis: ${modelsByPhase.synthesis}` : null,
    ].filter(Boolean).join(' • ')
    : '';

  return (
    <div>
      {isPartial && (
        <div style={{
          marginBottom: 'var(--space-2)',
          padding: 'var(--space-2)',
          border: '1px solid var(--accent-yellow)',
          background: 'var(--chip-warning-bg)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-primary)',
        }}>
          <strong>Partial review</strong>
          {partialChunksTotal > 0 ? ` (${partialChunksCompleted}/${partialChunksTotal} chunks analyzed)` : ''}
          {failedFileCount > 0 ? ` • ${failedFileCount} file${failedFileCount !== 1 ? 's' : ''} failed deep analysis` : ''}
          {partialReason ? `: ${partialReason}` : ''}
        </div>
      )}
      <p style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--text-secondary)',
        lineHeight: 1.5,
        margin: '0 0 var(--space-2)',
      }}>
        {review.summary}
      </p>

      {/* Stats line */}
      <div style={{
        display: 'flex',
        gap: 'var(--space-3)',
        fontSize: 'var(--text-xs)',
        color: 'var(--text-tertiary)',
        marginBottom: 'var(--space-1)',
      }}>
        <span>{review.stats.filesAnalyzed} files</span>
        <span>
          <span style={{ color: 'var(--accent-green)' }}>+{review.stats.totalAdditions}</span>
          {' '}
          <span style={{ color: 'var(--accent-red)' }}>-{review.stats.totalDeletions}</span>
        </span>
        <span>{review.stats.estimatedComplexity}</span>
      </div>

      {/* Provider attribution */}
      <div style={{
        fontSize: 10,
        color: 'var(--text-tertiary)',
      }}>
        Reviewed by {reviewedByLabel}
      </div>
      {reviewModelBreakdown && (
        <div style={{
          fontSize: 10,
          color: 'var(--text-quaternary)',
          marginTop: 2,
        }}>
          {reviewModelBreakdown}
        </div>
      )}
      {!hideRoutingMetadata && (
        <>
          {(strategy || policyVersion || rolloutMode || gateStatus || decisionReason || fallbackReason || rolloutReason || gateReasonLabel) && (
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
              {[
                strategy
                  ? `strategy ${strategy}${effectiveStrategy && effectiveStrategy !== strategy ? ` -> ${effectiveStrategy}` : ''}`
                  : null,
                policyVersion ? `policy ${policyVersion}` : null,
                rolloutMode ? `rollout ${rolloutMode}` : null,
                gateStatus ? `gate ${gateStatus}` : null,
                decisionReason ? `decision ${decisionReason}` : null,
                budgetClass ? `budget ${budgetClass}` : null,
                thresholdLabel ? `thresholds ${thresholdLabel}` : null,
                fallbackReason ? `fallback ${fallbackReason}` : null,
                (!fallbackReason && rolloutReason) ? `reason ${rolloutReason}` : null,
                gateReasonLabel ? `gate reason ${gateReasonLabel}` : null,
              ].filter(Boolean).join(' • ')}
            </div>
          )}
          {phaseModelLabel && (
            <div style={{ fontSize: 10, color: 'var(--text-quaternary)', marginTop: 2 }}>
              {phaseModelLabel}
            </div>
          )}
        </>
      )}
      {normalizeReviewModelStrategyValue(review.stats?.reviewModelStrategy) === 'smart' && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          marginTop: 'var(--space-1)',
          padding: '1px var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 10,
          color: 'var(--chip-warning-text)',
          background: 'var(--chip-warning-bg)',
          border: '1px solid var(--accent-yellow)',
        }}>
          Balanced
        </div>
      )}
      {normalizeReviewModelStrategyValue(review.stats?.reviewModelStrategy) === 'max_quality' && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          marginTop: 'var(--space-1)',
          padding: '1px var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          background: 'var(--bg-overlay)',
          border: '1px solid var(--border-muted)',
        }}>
          Max quality
        </div>
      )}
      {normalizeReviewModelStrategyValue(review.stats?.reviewModelStrategy) === 'adaptive' && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          marginTop: 'var(--space-1)',
          padding: '1px var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          background: 'rgba(59, 130, 246, 0.14)',
          border: '1px solid var(--accent-blue)',
        }}>
          Cost-aware
        </div>
      )}
      {normalizeReviewModelStrategyValue(review.stats?.reviewModelStrategy) === 'performance' && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          marginTop: 'var(--space-1)',
          padding: '1px var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 10,
          color: 'var(--accent-blue)',
          background: 'var(--chip-info-bg)',
          border: '1px solid var(--accent-blue)',
        }}>
          Performance
          <span style={{ textTransform: 'uppercase', letterSpacing: 0, opacity: 0.8 }}>Experimental</span>
        </div>
      )}
      {normalizeReviewModelStrategyValue(review.stats?.reviewModelStrategy) === 'latency_first' && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          marginTop: 'var(--space-1)',
          padding: '1px var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 10,
          color: 'var(--accent-blue)',
          background: 'var(--chip-info-bg)',
          border: '1px solid var(--accent-blue)',
        }}>
          Latency-first
        </div>
      )}
    </div>
  );
}
