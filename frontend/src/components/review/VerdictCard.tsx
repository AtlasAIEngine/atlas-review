/**
 * VerdictCard — Direction C spec. Drops the duplicated findings-count row
 * (the shell top bar now owns severity counts), leads with a single
 * verdict pill + plain-language reason, opens the plain-prose summary by
 * default, and keeps details collapsed. Progress bar hides at 0/N.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { openExternal } from '@/utils/openExternal';
import type {
  ReviewResult,
  ChangeSetVerification,
  VerificationStatus,
} from '@/types';
import {
  getEffectiveReviewRiskLevel,
  getReviewCoverageStats,
  getReviewDiffScopeSummary,
  getReviewPrecisionStats,
  normalizeReviewModelStrategyValue,
  normalizeRecommendationSeverity,
  humanizeReasonCode,
  humanizeReasonCodeList,
  buildReviewOutcomeProgress,
} from './reviewPanelUtils';
import type { ReviewCoverageStats } from './reviewPanelUtils';
import { ReviewActionButton } from './ReviewChrome';

type VerdictTone = 'block' | 'needs-review' | 'ready';

interface VerdictPillSpec {
  label: string;
  tone: VerdictTone;
  color: string;
  reason: string;
}

function formatReviewModelStrategyLabel(strategy: ReturnType<typeof normalizeReviewModelStrategyValue>): string | null {
  if (strategy === 'smart') return 'Balanced';
  if (strategy === 'adaptive') return 'Cost-aware';
  if (strategy === 'performance') return 'Performance';
  if (strategy === 'max_quality') return 'Maximum quality';
  if (strategy === 'custom') return 'Custom';
  if (strategy === 'latency_first') return 'Latency-first';
  return null;
}

function buildVerdictPill(opts: {
  actionableCount: number;
  highCount: number;
  criticalCount: number;
  effectiveRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  resolvedCount: number;
  unresolvedCount: number;
}): VerdictPillSpec {
  const { actionableCount, highCount, criticalCount, effectiveRiskLevel, resolvedCount, unresolvedCount } = opts;

  if (actionableCount === 0) {
    return {
      label: 'READY',
      tone: 'ready',
      color: 'var(--sev-ok)',
      reason: 'No actionable findings — review is clean.',
    };
  }

  const resolvedAll = unresolvedCount === 0 && resolvedCount > 0;
  if (resolvedAll) {
    return {
      label: 'RESOLVED',
      tone: 'ready',
      color: 'var(--sev-ok)',
      reason: `All ${resolvedCount} finding${resolvedCount === 1 ? '' : 's'} addressed or dismissed.`,
    };
  }

  const blocking = criticalCount + highCount;
  if (blocking > 0 || effectiveRiskLevel === 'high' || effectiveRiskLevel === 'critical') {
    const noun = blocking === 1 ? 'finding' : 'findings';
    const phrase = blocking > 0
      ? `${blocking} high-severity ${noun} block${blocking === 1 ? 's' : ''} approval`
      : 'High-risk changes block approval';
    return {
      label: 'BLOCKS APPROVAL',
      tone: 'block',
      color: 'var(--sev-high)',
      reason: `${phrase}.`,
    };
  }

  return {
    label: 'NEEDS REVIEW',
    tone: 'needs-review',
    color: 'var(--sev-med)',
    reason: `${actionableCount} open finding${actionableCount === 1 ? '' : 's'} to review before approval.`,
  };
}

function VerdictPill({ spec }: { spec: VerdictPillSpec }) {
  const prefix = spec.tone === 'block' ? '\u26A0 ' : '';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        fontFamily: 'var(--font-ui)',
        lineHeight: 1.2,
        color: spec.color,
        background: `color-mix(in oklab, ${spec.color} 14%, transparent)`,
        border: `1px solid color-mix(in oklab, ${spec.color} 30%, transparent)`,
      }}
    >
      {prefix}{spec.label}
    </span>
  );
}

export function VerdictCard({
  review,
  verification,
  contextFileCount,
  coverageStats,
  detailsOpen = false,
  onToggleDetails,
  scopeStatusLabel,
  hideRoutingMetadata = false,
  summaryText = null,
  summaryExpanded = true,
  onToggleSummary,
  addressedFindingCount = 0,
  dismissedFindingCount = 0,
  approvalStateLabel = null,
  approvalStateTone = 'info',
  detailsContent = null,
  reviewActionLabel,
  onReviewAction,
  reviewActionDisabled = false,
}: {
  review: ReviewResult;
  verification?: ChangeSetVerification | null;
  contextFileCount?: number;
  coverageStats?: ReviewCoverageStats | null;
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
  scopeStatusLabel?: string | null;
  hideRoutingMetadata?: boolean;
  summaryText?: string | null;
  summaryExpanded?: boolean;
  onToggleSummary?: () => void;
  addressedFindingCount?: number;
  dismissedFindingCount?: number;
  approvalStateLabel?: string | null;
  approvalStateTone?: 'info' | 'warn' | 'good';
  detailsContent?: ReactNode;
  reviewActionLabel?: string;
  onReviewAction?: () => void;
  reviewActionDisabled?: boolean;
}) {
  const collapsedSummaryRef = useRef<HTMLDivElement | null>(null);
  const [isSummaryTruncated, setIsSummaryTruncated] = useState(false);

  // Guard the recommendations array at the component boundary (CLAUDE.md code-pattern).
  const recs = useMemo(
    () => (Array.isArray(review.recommendations) ? review.recommendations : []),
    [review.recommendations],
  );

  const counts = useMemo(() => {
    let issue = 0, suggestion = 0;
    const sev = { critical: 0, high: 0, medium: 0, low: 0 } as Record<'critical' | 'high' | 'medium' | 'low', number>;
    for (const rec of recs) {
      if (rec.type === 'issue') issue += 1;
      else if (rec.type === 'suggestion') suggestion += 1;
      if (rec.type === 'issue' || rec.type === 'suggestion') {
        sev[normalizeRecommendationSeverity(rec)] += 1;
      }
    }
    return { issue, suggestion, sev, actionable: issue + suggestion };
  }, [recs]);

  const effectiveRiskLevel = counts.actionable === 0
    ? 'low'
    : getEffectiveReviewRiskLevel(review);

  const progress = buildReviewOutcomeProgress(
    counts.actionable,
    addressedFindingCount,
    dismissedFindingCount,
  );

  const verdict = useMemo(() => buildVerdictPill({
    actionableCount: counts.actionable,
    highCount: counts.sev.high,
    criticalCount: counts.sev.critical,
    effectiveRiskLevel,
    resolvedCount: progress.resolvedCount,
    unresolvedCount: progress.unresolvedCount,
  }), [counts.actionable, counts.sev.high, counts.sev.critical, effectiveRiskLevel, progress.resolvedCount, progress.unresolvedCount]);

  const effectiveCoverage = coverageStats || getReviewCoverageStats(review, contextFileCount);
  const diffScopeSummary = getReviewDiffScopeSummary(review, contextFileCount);
  const precisionStats = getReviewPrecisionStats(review);
  const canToggleDetails = typeof onToggleDetails === 'function';
  const canToggleSummary = typeof onToggleSummary === 'function' && Boolean(summaryText);
  const showSummary = Boolean(summaryText);
  const showCollapsedSummary = showSummary && canToggleSummary && !summaryExpanded;

  useEffect(() => {
    if (!showCollapsedSummary) {
      setIsSummaryTruncated(false);
      return;
    }
    const measurePreview = () => {
      const el = collapsedSummaryRef.current;
      if (!el) return;
      setIsSummaryTruncated(el.scrollHeight - el.clientHeight > 1);
    };
    measurePreview();
    window.addEventListener('resize', measurePreview);
    return () => window.removeEventListener('resize', measurePreview);
  }, [showCollapsedSummary, summaryText]);

  // Functional verification icons (retained; displayed inline when present).
  const verifyIcon = (status?: VerificationStatus) => {
    if (!status || status === 'not_run') return { symbol: '\u2014', color: 'var(--text-tertiary)' };
    if (status === 'pass') return { symbol: '\u2713', color: 'var(--sev-ok)' };
    return { symbol: '\u2717', color: 'var(--sev-high)' };
  };
  const lintV = verifyIcon(verification?.lint);
  const unitV = verifyIcon(verification?.unit);
  const e2eV = verifyIcon(verification?.e2e);
  const hasFunctionalVerification = [verification?.lint, verification?.unit, verification?.e2e]
    .some((status) => status === 'pass' || status === 'fail');

  const approvalStateColor = approvalStateTone === 'warn'
    ? 'var(--sev-med)'
    : approvalStateTone === 'good'
      ? 'var(--sev-ok)'
      : 'var(--text-secondary)';

  // Routing metadata (shown in collapsed "Details" section).
  const strategy = normalizeReviewModelStrategyValue(review.stats?.reviewModelStrategy);
  const effectiveStrategy = normalizeReviewModelStrategyValue(
    review.stats?.reviewModelEffectiveStrategy || review.stats?.reviewModelStrategy,
  );
  const strategyLabel = formatReviewModelStrategyLabel(strategy);
  const effectiveStrategyLabel = formatReviewModelStrategyLabel(effectiveStrategy);
  const rolloutMode = String(review.stats?.reviewModelRollout?.mode || '').trim().toLowerCase();
  const rolloutReason = humanizeReasonCode(review.stats?.reviewModelRollout?.reason);
  const decisionReason = humanizeReasonCode(review.stats?.reviewModelDecisionReason);
  const fallbackReason = humanizeReasonCode(review.stats?.reviewModelFallbackReason);
  const policyVersion = String(review.stats?.reviewModelPolicyVersion || '').trim();
  const budgetClass = String(review.stats?.reviewModelBudgetClass || '').trim().toLowerCase();
  const reviewProfile = review.stats?.reviewProfile;
  const shapedScope = review.stats?.shapedScope;
  const gateStatus = String(
    review.stats?.reviewModelGate?.status
      || review.stats?.reviewModelRollout?.gate?.status
      || '',
  ).trim().toLowerCase();
  const gateReasons = (() => {
    const runtimeReasons = humanizeReasonCodeList(review.stats?.reviewModelGate?.reasonCodes);
    if (runtimeReasons.length > 0) return runtimeReasons;
    return humanizeReasonCodeList(review.stats?.reviewModelRollout?.gate?.reasonCodes);
  })();
  const gateReasonLabel = gateReasons.length > 0 ? gateReasons.slice(0, 2).join(', ') : null;
  const gateColor = gateStatus === 'fail'
    ? 'var(--sev-high)'
    : gateStatus === 'warn'
      ? 'var(--sev-med)'
      : gateStatus === 'pass'
        ? 'var(--sev-ok)'
        : 'var(--text-tertiary)';
  const profileLabel = typeof reviewProfile?.label === 'string' && reviewProfile.label.trim()
    ? reviewProfile.label.trim()
    : (typeof reviewProfile?.id === 'string' && reviewProfile.id.trim() ? reviewProfile.id.trim() : '');
  const profileSource = typeof reviewProfile?.source === 'string' && reviewProfile.source.trim()
    ? reviewProfile.source.trim().toLowerCase()
    : '';
  const shapedScopeLabel = shapedScope
    && (Number.isFinite(Number(shapedScope.rawFileCount)) || Number.isFinite(Number(shapedScope.reviewUnitCount)))
    ? `${Math.max(0, Number(shapedScope.rawFileCount) || 0)} files -> ${Math.max(0, Number(shapedScope.reviewUnitCount) || 0)} review units`
    : null;
  const shapedScopeDetailParts: string[] = [];
  if ((Number(shapedScope?.classCounts?.collapsed) || 0) > 0) {
    shapedScopeDetailParts.push(`${Math.max(0, Number(shapedScope?.classCounts?.collapsed) || 0)} collapsed`);
  }
  if ((Number(shapedScope?.pairedFiles) || 0) > 0) {
    shapedScopeDetailParts.push(`${Math.max(0, Number(shapedScope?.pairedFiles) || 0)} paired`);
  }
  const shapedScopeDetail = shapedScopeDetailParts.length > 0 ? shapedScopeDetailParts.join(', ') : null;

  // Execution telemetry — only present for cli-agentic runs. Hide the
  // entire group when none of the fields exist (chunked-mode reviews
  // and reviews from before these stats were tracked).
  const exec = (() => {
    const stats = review.stats || {};
    const statsAny = stats as typeof stats & {
      executionMode?: string | null;
      agenticReview?: boolean | null;
    };
    const actualTurns = Number(stats.agenticActualTurns);
    const maxTurns = Number(stats.agenticMaxTurns);
    const toolUseCount = Number(stats.agenticToolUseCount);
    const completionRaw = typeof stats.agenticCompletionReason === 'string'
      ? stats.agenticCompletionReason.trim()
      : '';
    const tier = typeof stats.agenticTier === 'string' ? stats.agenticTier.trim() : '';
    const executionModeRaw = typeof statsAny.executionMode === 'string' ? statsAny.executionMode.trim() : '';
    const hasAgenticMode = statsAny.agenticReview === true || executionModeRaw === 'cli-agentic' || Boolean(tier);
    const hasAny = Number.isFinite(actualTurns)
      || Number.isFinite(maxTurns)
      || Number.isFinite(toolUseCount)
      || completionRaw.length > 0;
    if (!hasAny) return null;
    const completionLabel = completionRaw
      ? completionRaw.replace(/_/g, ' ')
      : null;
    const completionTone = completionRaw === 'max_turns_reached' || completionRaw === 'liveness_timeout'
      ? 'var(--sev-med)'
      : completionRaw === 'success'
        ? 'var(--sev-ok)'
        : undefined;
    const turnsLabel = (() => {
      const haveActual = Number.isFinite(actualTurns) && actualTurns >= 0;
      const haveMax = Number.isFinite(maxTurns) && maxTurns > 0;
      if (haveActual && haveMax) return `${actualTurns} of ${maxTurns}`;
      if (haveActual) return `${actualTurns}`;
      if (haveMax) return `up to ${maxTurns}`;
      return null;
    })();
    return {
      modeLabel: hasAgenticMode
        ? (tier ? `agentic (${tier})` : 'agentic')
        : (executionModeRaw ? executionModeRaw.replace(/-/g, ' ') : 'structured'),
      tier: tier || null,
      turnsLabel,
      completionLabel,
      completionTone,
      toolUseCount: Number.isFinite(toolUseCount) && toolUseCount >= 0 ? toolUseCount : null,
    };
  })();

  return (
    <div
      style={{
        padding: '0 0 var(--space-3)',
        borderBottom: '1px solid var(--review-shell-divider)',
        marginBottom: 'var(--space-3)',
      }}
    >
      {/* Verdict pill + plain-language reason */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
        <VerdictPill spec={verdict} />
        <span style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 }}>
          {verdict.reason}
        </span>
        {hasFunctionalVerification && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 'auto', fontSize: 10, color: 'var(--text-secondary)' }}>
            <span style={{ color: lintV.color, fontWeight: 700 }} title="Lint">{lintV.symbol}</span>
            <span>lint</span>
            <span style={{ opacity: 0.45 }}>&#8212;</span>
            <span style={{ color: unitV.color, fontWeight: 700 }} title="Types">{unitV.symbol}</span>
            <span>types</span>
            <span style={{ opacity: 0.45 }}>&#8212;</span>
            <span style={{ color: e2eV.color, fontWeight: 700 }} title="Tests">{e2eV.symbol}</span>
            <span>tests</span>
          </span>
        )}
      </div>

      {/* Progress bar — only when there are findings AND some are resolved */}
      {counts.actionable > 0 && progress.resolvedCount > 0 && (
        <div style={{ display: 'grid', gap: 4, marginBottom: 'var(--space-2)' }}>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--border-muted)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${progress.percent}%`,
                height: '100%',
                background: progress.percent >= 100 ? 'var(--sev-ok)' : verdict.color,
                transition: 'width var(--transition-fast)',
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-tertiary)' }}>
            <span>{progress.label}</span>
            {(progress.addressed > 0 || progress.dismissed > 0) && (
              <span>{progress.addressed} addressed · {progress.dismissed} dismissed</span>
            )}
          </div>
        </div>
      )}

      {approvalStateLabel && (
        <div
          style={{
            marginBottom: 'var(--space-2)',
            fontSize: 10,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            fontWeight: 600,
            color: approvalStateColor,
          }}
        >
          {approvalStateLabel}
        </div>
      )}

      {/* Summary — plain prose, default open */}
      {showSummary && summaryText && (
        <div style={{ marginBottom: 'var(--space-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
              Summary
            </span>
            {canToggleSummary && (
              <button
                type="button"
                onClick={onToggleSummary}
                aria-expanded={summaryExpanded}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  fontSize: 10,
                  fontFamily: 'var(--font-ui)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                {summaryExpanded ? '\u25BE hide' : '\u25B8 show'}
              </button>
            )}
          </div>
          {summaryExpanded ? (
            <div
              className="pr-summary-markdown"
              style={{
                fontSize: 12,
                color: 'var(--text-primary)',
                lineHeight: 1.6,
              }}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (href) void openExternal(href);
                      }}
                      style={{ color: 'var(--accent-blue)', textDecoration: 'none', cursor: 'pointer' }}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {summaryText}
              </ReactMarkdown>
            </div>
          ) : (
            <div>
              <div
                ref={collapsedSummaryRef}
                className="pr-summary-markdown"
                style={{
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  lineHeight: 1.55,
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (href) void openExternal(href);
                        }}
                        style={{ color: 'var(--accent-blue)', textDecoration: 'none', cursor: 'pointer' }}
                      >
                        {children}
                      </a>
                    ),
                    p: ({ children }) => <>{children}</>,
                  }}
                >
                  {summaryText}
                </ReactMarkdown>
              </div>
              {isSummaryTruncated && (
                <button
                  type="button"
                  onClick={onToggleSummary}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--accent-blue)',
                    fontSize: 10,
                    fontWeight: 600,
                    padding: 0,
                    marginTop: 4,
                    cursor: 'pointer',
                  }}
                >
                  Tap to expand
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action row */}
      {(canToggleDetails || (onReviewAction && reviewActionLabel)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: detailsOpen ? 'var(--space-2)' : 0 }}>
          {canToggleDetails && (
            <ReviewActionButton
              onClick={onToggleDetails}
              tone="neutral"
              style={{ minHeight: 26 }}
              title={detailsOpen ? 'Hide review details' : 'Show review details'}
              aria-label={detailsOpen ? 'Hide review details' : 'Show review details'}
            >
              {detailsOpen ? '\u25BE Hide details' : '\u25B8 Details'}
            </ReviewActionButton>
          )}
          {onReviewAction && reviewActionLabel && (
            <ReviewActionButton
              onClick={onReviewAction}
              disabled={reviewActionDisabled}
              tone="blue"
              active={!reviewActionDisabled}
              style={{ minHeight: 26 }}
            >
              {reviewActionLabel}
            </ReviewActionButton>
          )}
        </div>
      )}

      {/* Details — collapsed by default, ledger-style tokens/cost/profile */}
      {detailsOpen && !hideRoutingMetadata && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--text-secondary)',
            display: 'grid',
            gap: 4,
            paddingTop: 'var(--space-2)',
            borderTop: '1px solid var(--review-shell-divider)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <DetailRow
            label="Coverage"
            value={`${effectiveCoverage.analyzedFiles} analyzed · ${Math.max(0, effectiveCoverage.totalFiles - effectiveCoverage.analyzedFiles)} omitted`}
          />
          {effectiveCoverage.focusedLabel && <DetailRow label="Analysis" value={effectiveCoverage.focusedLabel} />}
          {effectiveCoverage.chunkLabel && <DetailRow label="Chunking" value={effectiveCoverage.chunkLabel} />}
          {effectiveCoverage.cacheLabel && <DetailRow label="Cache" value={effectiveCoverage.cacheLabel} />}
          {diffScopeSummary && <DetailRow label="Scope" value={diffScopeSummary.longLabel} />}
          {precisionStats.label && (
            <DetailRow
              label="Precision"
              value={precisionStats.label}
              valueColor={precisionStats.issuesSuppressed > 0 ? 'var(--sev-med)' : undefined}
            />
          )}
          {precisionStats.details && <DetailRow label="" value={precisionStats.details} />}
          {scopeStatusLabel && <DetailRow label="Scope status" value={scopeStatusLabel} />}
          {strategy && (
            <DetailRow
              label="Strategy"
              value={`${strategyLabel || strategy}${effectiveStrategyLabel && effectiveStrategy !== strategy ? ` -> ${effectiveStrategyLabel}` : ''}`}
            />
          )}
          {policyVersion && <DetailRow label="Policy" value={policyVersion} />}
          {/* Rollout/Gate hidden when on+pass — the green tick already says "all good"; only surface when something is unusual. */}
          {rolloutMode && rolloutMode !== 'on' && <DetailRow label="Rollout" value={rolloutMode} />}
          {gateStatus && gateStatus !== 'pass' && <DetailRow label="Gate" value={gateStatus} valueColor={gateColor} />}
          {/* Decision hidden when it just restates the strategy (Balanced "balanced_user_selected_model", default "provider_default"). */}
          {decisionReason
            && decisionReason !== 'balanced user selected model'
            && decisionReason !== 'provider default'
            && <DetailRow label="Decision" value={decisionReason} />}
          {/* Budget hidden when it's a 1:1 mapping of strategy. Only Cost-aware (adaptive) splits into latency/balanced/quality. */}
          {budgetClass && strategy === 'adaptive' && <DetailRow label="Budget" value={budgetClass} />}
          {/* Profile hidden when generic fallback — "(fallback)" is debug noise; users only care when a real stack profile fired. */}
          {profileLabel && profileSource !== 'fallback' && (
            <DetailRow label="Profile" value={`${profileLabel}${profileSource ? ` (${profileSource})` : ''}`} />
          )}
          {shapedScopeLabel && (
            <DetailRow label="Shaped scope" value={`${shapedScopeLabel}${shapedScopeDetail ? ` · ${shapedScopeDetail}` : ''}`} />
          )}
          {fallbackReason && <DetailRow label="Fallback" value={fallbackReason} valueColor="var(--sev-med)" />}
          {/* Reason hidden when rollout is on (it just restates Rollout). Show for off/canary-skipped/gate-failed/etc. */}
          {!fallbackReason && rolloutReason && rolloutMode !== 'on' && (
            <DetailRow label="Reason" value={rolloutReason} />
          )}
          {gateReasonLabel && (
            <DetailRow
              label="Gate reason"
              value={gateReasonLabel}
              valueColor={gateStatus === 'fail' ? 'var(--sev-high)' : undefined}
            />
          )}
          {exec && (
            <div
              style={{
                marginTop: 'var(--space-2)',
                paddingTop: 'var(--space-2)',
                borderTop: '1px solid var(--review-shell-divider)',
                display: 'grid',
                gap: 4,
              }}
            >
              <div style={{
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--text-tertiary)',
                marginBottom: 2,
              }}>
                Execution
              </div>
              <DetailRow
                label="Mode"
                value={exec.modeLabel}
              />
              {/* "Model strategy" row removed — it's an exact duplicate of the
                  Strategy row in the section above. */}
              {exec.turnsLabel && (
                <DetailRow
                  label="Turns"
                  value={exec.completionLabel
                    ? `${exec.turnsLabel} · ${exec.completionLabel}`
                    : exec.turnsLabel}
                  valueColor={exec.completionTone}
                />
              )}
              {exec.toolUseCount !== null && (
                <DetailRow label="Tool calls" value={String(exec.toolUseCount)} />
              )}
            </div>
          )}
          {detailsContent && <div style={{ marginTop: 'var(--space-2)' }}>{detailsContent}</div>}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 9.5 }}>
        {label}
      </span>
      <span style={{ color: valueColor || 'var(--text-primary)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}
