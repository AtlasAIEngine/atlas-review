/**
 * WalkthroughView — Direction C third review mode. Two-pane step
 * reader: left pane lists steps (from `review.changeGroups`), right
 * pane renders the active step detail + files + inline AI-comment
 * callouts. See direction-c.jsx:867-1163.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { MutableRefObject } from 'react';
import type { ReviewChangeGroup, ReviewRecommendation, ReviewResult, BranchReviewFileContent, BranchReviewFileSummary, ReviewOutcomeScope } from '@/types';
import type { DiffNavigationTarget } from '@/utils/reviewNavigation';
import { branchReviewApi, describeApiError, prReviewApi, projectApi, providerApi, workspaceReviewApi, reviewApi, walkthroughApi } from '@/services/api';
import type { ReviewAgentAttachment } from '@/services/reviewAgentApi';
import { buildReviewRecommendationKey } from '@/utils/reviewRecommendationKeys';
import { usePopup } from '../shared/PopupProvider';
import type { ReviewShellLifecycle } from './ReviewShellTopBar';
import { WalkthroughStepRow } from './WalkthroughStepRow';
import type { StepRowStatus } from './WalkthroughStepRow';
import { clearReadSteps, getReadSteps, replaceReadSteps, setStepRead } from '@/lib/walkthroughReadState';
import { mapFindingsToSteps } from '@/lib/findingsToSteps';
import { buildWalkthroughChangeMap, buildWalkthroughReviewFocus, groupWalkthroughFilesByRole } from '@/lib/walkthroughChangeMap';
import type { WalkthroughFileRole } from '@/lib/walkthroughChangeMap';
import { Btn, FileRow, Kbd, SevChip } from './primitives';
import type { SevLevel } from './primitives';
import { StepFileSection } from './StepFileSection';
import { RunningReviewStrip, RunningView } from './RunningView';
import type { RunningProgress, RunningStepSpec } from './RunningView';
import {
  buildManualLineCommentStorageKey,
  buildRecommendationCommentStorageKey,
  getRecommendationFingerprint,
  REVIEW_COMMENT_DRAFTS_UPDATED_EVENT,
  normalizeManualLineCommentMap,
  normalizeRecommendationCommentMap,
  normalizeRecommendationSeverity,
} from './reviewPanelUtils';
import type { ManualLineCommentMap, RecommendationCommentMap, ReviewCommentDraftsUpdatedDetail } from './reviewPanelUtils';

/**
 * Phase 11: in-flight walkthrough generation, keyed by
 * `${projectId}:${baseSha}:${headSha}`. Lives at module scope so the
 * "Generating…" state survives WalkthroughView remounts (e.g., when the
 * user switches review tabs and comes back). The AbortController lets the
 * Stop button cancel the HTTP request immediately; the backend may still
 * complete the work and persist the row, which the next mount's GET picks
 * up as a cache hit.
 *
 * Phase 12: `startedAt` (epoch ms) lives on the entry so the elapsed-tick
 * UI can show a continuous counter across remounts (Findings ↔ Walkthrough
 * tab swaps don't reset the timer because the Map entry survives).
 */
interface InFlightWalkthrough {
  promise: Promise<{ changeGroups: unknown } | null>;
  abort: AbortController;
  startedAt: number;
  mode: 'incremental' | 'full';
}
const inFlightWalkthroughs = new Map<string, InFlightWalkthrough>();

function getGroupedWalkthroughFilePaths(files: ReviewChangeGroup['files'] | undefined): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const group of groupWalkthroughFilesByRole(files || [])) {
    for (const file of group.files) {
      const path = typeof file?.path === 'string' ? file.path.trim() : '';
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export interface WalkthroughGenerationSignal {
  id: number;
  force: boolean;
  // When true, route through the choice popup (incremental vs full) instead
  // of executing immediately. Used by the top-bar "Generate walkthrough"
  // button so a click on it offers the same choice as the stale-banner
  // button. Keyboard shortcuts keep their direct semantics and ignore this.
  interactive?: boolean;
}

function walkthroughKey(projectId: string, baseSha: string, headSha: string): string {
  return `${projectId}:${baseSha}:${headSha}`;
}

// Find an in-flight walkthrough by (projectId, baseSha) prefix. The actual
// in-flight key includes a headSha that may not match `dataState.headSha`
// (e.g., the interactive handler used a freshly-fetched headSha override),
// so the Stop button, re-attach-on-mount effect, and elapsed-tick effect
// can't compute the key from `dataState.headSha` alone — they'd miss the
// entry. Only one walkthrough generates per (projectId, baseSha) at a time,
// so a prefix scan returns at most one match.
function findInFlightForBase(projectId: string, baseSha: string): { key: string; entry: InFlightWalkthrough } | null {
  const prefix = `${projectId}:${baseSha}:`;
  for (const [key, entry] of inFlightWalkthroughs.entries()) {
    if (key.startsWith(prefix)) return { key, entry };
  }
  return null;
}

function resolveWalkthroughArtifactKey(wt: { id?: unknown; updatedAt?: unknown } | null | undefined): string | null {
  const id = typeof wt?.id === 'string' ? wt.id.trim() : '';
  if (!id) return null;
  const updatedAt = typeof wt?.updatedAt === 'string' ? wt.updatedAt.trim() : '';
  return updatedAt ? `${id}:${updatedAt}` : id;
}

function resolveWalkthroughHeadSha(wt: { headSha?: unknown } | null | undefined, fallback: string | null): string | null {
  const headSha = typeof wt?.headSha === 'string' ? wt.headSha.trim() : '';
  return headSha || fallback;
}

// Step identity = the exact set of file paths the step covers. Two steps with
// identical file sets are treated as the same step across regenerations, so a
// previously-read step keeps its read flag if its files weren't touched.
function computeStepFingerprint(group: ReviewChangeGroup | null | undefined): string {
  if (!group) return '';
  const paths = new Set<string>();
  for (const file of group.files || []) {
    const path = typeof file?.path === 'string' ? file.path.trim() : '';
    if (path) paths.add(path);
  }
  if (paths.size === 0) return '';
  return JSON.stringify(Array.from(paths).sort());
}

function migrateReadStateAcrossArtifacts(
  oldArtifactKey: string | null,
  oldGroups: ReviewChangeGroup[] | null,
  newArtifactKey: string | null,
  newGroups: ReviewChangeGroup[] | null,
): Set<number> {
  const carried = new Set<number>();
  if (!newArtifactKey || !Array.isArray(newGroups) || newGroups.length === 0) {
    return carried;
  }
  const newStorageKey = `artifact:${newArtifactKey}`;
  const oldStorageKey = oldArtifactKey ? `artifact:${oldArtifactKey}` : '';
  if (!oldStorageKey) {
    return getReadSteps(newStorageKey);
  }
  const oldReadIndices = oldStorageKey ? getReadSteps(oldStorageKey) : new Set<number>();

  if (oldReadIndices.size > 0 && Array.isArray(oldGroups) && oldGroups.length > 0) {
    const carriedFingerprints = new Set<string>();
    oldGroups.forEach((group, idx) => {
      if (!oldReadIndices.has(idx)) return;
      const fp = computeStepFingerprint(group);
      if (fp) carriedFingerprints.add(fp);
    });
    if (carriedFingerprints.size > 0) {
      newGroups.forEach((group, idx) => {
        const fp = computeStepFingerprint(group);
        if (fp && carriedFingerprints.has(fp)) carried.add(idx);
      });
    }
  }

  if (carried.size > 0 || oldStorageKey !== newStorageKey) {
    replaceReadSteps(newStorageKey, carried);
  }
  if (oldStorageKey && oldStorageKey !== newStorageKey) {
    clearReadSteps(oldStorageKey);
  }
  return carried;
}

export interface WalkthroughViewProps {
  projectId: string;
  branchReviewId?: string | null;
  workspaceReviewId?: string | null;
  prReviewId?: string | null;
  lifecycle: ReviewShellLifecycle;
  runningReviewProgress?: RunningProgress | null;
  runningReviewSteps?: RunningStepSpec[];
  runningReviewElapsedLabel?: string | null;
  runningReviewCurrentStep?: string | null;
  runningReviewMetaLabel?: ReactNode;
  onRunReview?: () => void;
  onSelectFile?: (target: DiffNavigationTarget) => void;
  onSwitchToFindings?: () => void;
  scrollToFileRef?: MutableRefObject<((target: DiffNavigationTarget) => void) | null>;
  generationSignal?: WalkthroughGenerationSignal;
  onGenerationStateChange?: (isGenerating: boolean, stopGeneration: (() => void) | null) => void;
  onWalkthroughCountChange?: (count: number | null) => void;
  diffViewMode?: WalkthroughDiffViewMode;
  onDiffViewModeChange?: (mode: WalkthroughDiffViewMode) => void;
  onAskAtlasSelection?: (payload: {
    attachment: Extract<ReviewAgentAttachment, { type: 'line_range' }>;
    prompt: string;
  }) => void;
  leftPaneWidth?: number;
  onStartPaneResize?: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => void;
}

type StepFilter = 'all' | 'unread' | 'flagged';
type WalkthroughDiffViewMode = 'unified' | 'split';
const DEFAULT_LEFT_PANE_WIDTH = 440;
const PANE_RESIZE_HANDLE_WIDTH = 6;

interface StepMeta {
  group: ReviewChangeGroup;
  index: number;
  files: number;
  adds: number;
  dels: number;
  sev: SevLevel | null;
}

type ReviewDataState = {
  review: ReviewResult | null;
  files: Array<BranchReviewFileSummary | BranchReviewFileContent>;
  /** Phase 11: SHAs needed to look up / generate a standalone walkthrough. */
  baseSha: string | null;
  headSha: string | null;
};

function pickWalkthroughBaseSha(
  headSha: string | null,
  candidates: Array<unknown>,
): string | null {
  const head = typeof headSha === 'string' ? headSha.trim() : '';
  const normalized = candidates
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  return normalized.find((value) => !head || value !== head) || normalized[0] || null;
}

function toRecSevLevel(rec: ReviewRecommendation): SevLevel | null {
  const sev = normalizeRecommendationSeverity(rec);
  if (sev === 'critical' || sev === 'high') return 'HIGH';
  if (sev === 'medium') return 'MED';
  if (sev === 'low') return 'LOW';
  return null;
}

/** Highest SevLevel between two (HIGH > MED > LOW). */
function maxSev(a: SevLevel | null, b: SevLevel | null): SevLevel | null {
  const rank = (s: SevLevel | null) => (s === 'HIGH' ? 3 : s === 'MED' ? 2 : s === 'LOW' ? 1 : 0);
  return rank(a) >= rank(b) ? a : b;
}

function shortStepRole(role: WalkthroughFileRole | null | undefined): string | null {
  if (role === 'contract') return 'API';
  if (role === 'implementation') return 'Impl';
  if (role === 'consumer') return 'Use';
  if (role === 'test') return 'Test';
  if (role === 'docs') return 'Docs';
  if (role === 'generated') return 'Gen';
  return null;
}

interface WalkthroughModelHint {
  providerLabel: string | null;
  providerSource: 'cli_detected' | 'byok' | null;
  modelId: string | null;
  modelLabel: string | null;
}

type WalkthroughRunMetadata = Record<string, unknown>;

function shortSha(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, 7) : '';
}

function normalizeWalkthroughRunMetadata(wt: {
  runMetadata?: unknown;
  modelId?: unknown;
  providerType?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
} | null | undefined): WalkthroughRunMetadata | null {
  if (!wt) return null;
  const raw = wt.runMetadata;
  const base = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as WalkthroughRunMetadata) }
    : {};
  if (typeof wt.modelId === 'string' && wt.modelId.trim() && !base.modelId) {
    base.modelId = wt.modelId.trim();
  }
  if (typeof wt.providerType === 'string' && wt.providerType.trim() && !base.providerType) {
    base.providerType = wt.providerType.trim();
  }
  if (typeof wt.updatedAt === 'string' && wt.updatedAt.trim() && !base.updatedAt) {
    base.updatedAt = wt.updatedAt.trim();
  }
  if (typeof wt.createdAt === 'string' && wt.createdAt.trim() && !base.createdAt) {
    base.createdAt = wt.createdAt.trim();
  }
  return Object.keys(base).length > 0 ? base : null;
}

function formatWalkthroughModelLine(hint: WalkthroughModelHint | null): string {
  if (!hint?.modelLabel && !hint?.modelId) return 'walkthrough cheap tier (planned)';
  const providerSourceLabel = hint.providerSource === 'cli_detected'
    ? 'CLI'
    : hint.providerSource === 'byok'
      ? 'API'
      : '';
  const providerLabel = [hint.providerLabel, providerSourceLabel].filter(Boolean).join(' ');
  const modelLabel = hint.modelLabel || hint.modelId || 'walkthrough cheap tier';
  return `${providerLabel ? `${providerLabel} / ` : ''}${modelLabel} (planned)`;
}

function metadataString(meta: WalkthroughRunMetadata | null, key: string): string | null {
  const value = meta?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function metadataNumber(meta: WalkthroughRunMetadata | null, key: string): number | null {
  const value = Number(meta?.[key]);
  return Number.isFinite(value) ? value : null;
}

function metadataBoolean(meta: WalkthroughRunMetadata | null, key: string): boolean | null {
  const value = meta?.[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function formatProviderLabel(value: string | null): string {
  if (!value) return 'Unknown';
  if (value === 'openai') return 'OpenAI';
  if (value === 'anthropic') return 'Anthropic';
  if (value === 'google') return 'Google';
  if (value === 'opencode') return 'OpenCode';
  return value;
}

function formatWalkthroughMode(value: string | null): string {
  if (value === 'map-reduce') return 'map-reduce';
  if (value === 'single-pass') return 'single pass';
  if (value === 'incremental-no-changes') return 'incremental, no changes';
  if (value === 'empty-diff') return 'empty diff';
  return value || 'unknown';
}

function formatDurationMs(value: number | null): string | null {
  if (value == null || value < 0) return null;
  if (value > 0 && value < 1000) return '<1s';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function formatTokenCount(value: number | null): string | null {
  if (value == null || value <= 0) return null;
  return Math.trunc(value).toLocaleString();
}

function formatCost(value: number | null): string | null {
  if (value == null || value < 0) return null;
  return `$${value.toFixed(4)}`;
}

function buildWalkthroughDetailsRows(meta: WalkthroughRunMetadata | null): Array<{ label: string; value: string; detail?: string | null }> {
  const provider = formatProviderLabel(metadataString(meta, 'providerType'));
  const model = metadataString(meta, 'modelId');
  const duration = formatDurationMs(metadataNumber(meta, 'durationMs'));
  const totalTokenValue = metadataNumber(meta, 'totalTokens');
  const totalTokens = formatTokenCount(totalTokenValue);
  const inputTokens = formatTokenCount(metadataNumber(meta, 'inputTokens'));
  const outputTokens = formatTokenCount(metadataNumber(meta, 'outputTokens'));
  const estimatedCostValue = metadataNumber(meta, 'estimatedCost');
  const providerNativeCostValue = metadataNumber(meta, 'providerNativeCost');
  const cost = formatCost(estimatedCostValue);
  const fileCount = metadataNumber(meta, 'fileCount');
  const llmFileCount = metadataNumber(meta, 'llmFileCount');
  const deterministicFileCount = metadataNumber(meta, 'deterministicFileCount');
  const providerCallCount = metadataNumber(meta, 'providerCallCount');
  const providerCalls = providerCallCount == null ? null : Math.max(0, Math.trunc(providerCallCount));
  const clusterCount = metadataNumber(meta, 'clusterCount');
  const clusterCacheHits = metadataNumber(meta, 'clusterCacheHits');
  const clusterEscalations = metadataNumber(meta, 'clusterEscalations');
  const executionMode = metadataString(meta, 'executionMode');
  const cached = metadataBoolean(meta, 'cached') === true;
  const deterministicFallback = metadataBoolean(meta, 'deterministicFallback') === true;
  const noProviderCalls = providerCalls === 0;
  const rows: Array<{ label: string; value: string; detail?: string | null }> = [
    { label: 'Strategy', value: metadataString(meta, 'strategy') || 'walkthrough cheap tier', detail: metadataString(meta, 'budget') },
    { label: 'Mode', value: formatWalkthroughMode(metadataString(meta, 'mode')), detail: meta?.incremental === true ? 'incremental' : null },
    {
      label: 'Source',
      value: cached && noProviderCalls
        ? 'file cache'
        : deterministicFallback
          ? 'deterministic fallback'
          : 'provider',
      detail: cached && noProviderCalls ? 'no provider call' : null,
    },
    {
      label: 'Provider/model',
      value: model ? `${provider} / ${model}` : provider,
      detail: cached && noProviderCalls ? 'planned' : executionMode,
    },
  ];
  if (duration) rows.push({ label: 'Duration', value: duration });
  if (totalTokens) rows.push({ label: 'Tokens', value: totalTokens, detail: `${inputTokens || '0'} in / ${outputTokens || '0'} out` });
  else if (cached && noProviderCalls) rows.push({ label: 'Tokens', value: 'not used', detail: 'file cache hit' });
  else rows.push({ label: 'Tokens', value: 'unavailable', detail: 'not reported for this run' });
  if (cached && noProviderCalls) {
    rows.push({ label: 'Estimated cost', value: 'not incurred', detail: 'file cache hit' });
  } else if (cost && ((estimatedCostValue || 0) > 0 || (providerNativeCostValue || 0) > 0 || (totalTokenValue || 0) > 0)) {
    rows.push({ label: 'Estimated cost', value: cost, detail: metadataString(meta, 'costSource') });
  } else if ((providerCalls || 0) > 0) {
    rows.push({ label: 'Estimated cost', value: 'unavailable', detail: 'usage not reported' });
  }
  if (fileCount != null) {
    rows.push({
      label: 'Files',
      value: `${Math.trunc(fileCount)}`,
      detail: `${Math.trunc(llmFileCount || 0)} LLM-eligible / ${Math.trunc(deterministicFileCount || 0)} deterministic`,
    });
  }
  if (providerCalls != null) rows.push({ label: 'Provider calls', value: `${providerCalls}` });
  if (clusterCount != null && clusterCount > 0) {
    rows.push({
      label: 'Map-reduce',
      value: `${Math.trunc(clusterCount)} clusters`,
      detail: `${Math.trunc(clusterCacheHits || 0)} cached / ${Math.trunc(clusterEscalations || 0)} escalated`,
    });
  }
  return rows;
}

interface WalkthroughEmptyCtaProps {
  onGenerate?: () => void;
  onStop?: () => void;
  onRunReview?: () => void;
  canGenerate: boolean;
  isGenerating: boolean;
}

function WalkthroughEmptyCta({ onGenerate, onStop, onRunReview, canGenerate, isGenerating }: WalkthroughEmptyCtaProps) {
  // Phase 11: walkthrough is decoupled from review. Prefer the standalone
  // generate path when SHAs are available; fall back to the review CTA only
  // when we genuinely cannot resolve a diff yet. While generating, swap the
  // primary action for Stop so the user can cancel.
  const primaryHandler = canGenerate
    ? (isGenerating ? onStop : onGenerate)
    : onRunReview;
  const primaryLabel = canGenerate
    ? (isGenerating ? 'Stop' : 'Generate walkthrough')
    : 'Run review';
  const primaryVariant: 'primary' | 'ghost' = canGenerate && isGenerating ? 'ghost' : 'primary';
  const helper = canGenerate
    ? (isGenerating
      ? 'Generating walkthrough… Click Stop to cancel.'
      : 'Generates only the walkthrough — review findings stay separate.')
    : 'Walkthrough needs a diff. Run a review first to anchor the SHAs.';
  return (
    <>
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
        {'\uD83D\uDCD6'}
      </div>
      <div style={{ textAlign: 'center', display: 'grid', gap: 6, maxWidth: 360 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          Read this branch as a story
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
          Group related changes into steps with context.
        </div>
      </div>
      <Btn
        variant={primaryVariant}
        size="sm"
        onClick={primaryHandler}
        disabled={!primaryHandler}
      >
        {primaryLabel}
      </Btn>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center', maxWidth: 320, marginTop: 2, lineHeight: 1.45 }}>
        {helper}
      </div>
    </>
  );
}

interface WalkthroughPlaceholderPaneProps {
  onGenerate?: () => void;
  onStop?: () => void;
  onRunReview?: () => void;
  canGenerate: boolean;
  isGenerating: boolean;
  /**
   * Phase 12: when false, render only the dim backdrop preview (no popup
   * CTA on top). Used by the right pane while generation is happening —
   * the canonical Stop affordance lives in the RunningView footer in the
   * left pane, so the popup is suppressed to avoid two stop buttons.
   */
  showCta?: boolean;
}

function WalkthroughPlaceholderPane({ onGenerate, onStop, onRunReview, canGenerate, isGenerating, showCta = true }: WalkthroughPlaceholderPaneProps) {
  const placeholderSteps = [
    { title: 'Review shell foundation', files: 6, adds: 312, dels: 84, state: 'read', sev: null },
    { title: 'PR summary surface', files: 4, adds: 188, dels: 42, state: 'read', sev: null },
    { title: 'Finding-focused diff view', files: 5, adds: 246, dels: 118, state: 'active', sev: 'HIGH' as SevLevel },
    { title: 'Walkthrough empty state', files: 3, adds: 96, dels: 12, state: 'flagged', sev: 'MED' as SevLevel },
    { title: 'Keyboard footer cleanup', files: 2, adds: 34, dels: 9, state: 'unread', sev: null },
  ];
  const fileRows = [
    ['review/SummaryDiffView.tsx', '+121', '-48'],
    ['review/InlineComments.tsx', '+42', '-11'],
    ['review/primitives/DiffHunk.tsx', '+58', '-37'],
    ['TrustReviewView.tsx', '+25', '-22'],
  ];
  const codeLines = [
    'const focusedLine = selectedFinding?.line ?? null;',
    'const visibleRows = collapseAroundFocusLine(rows, focusedLine);',
    'const commentsByLine = mapInlineComments(activeFindings);',
    'return <InlineComments commentsByLine={commentsByLine} />;',
  ];

  return (
    <div
      style={{
        flex: 1,
        position: 'relative',
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--review-panel-bg)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          gridTemplateColumns: '440px 1fr',
          opacity: 0.82,
        }}
      >
        <div style={{ borderRight: '1px solid var(--review-shell-divider)', display: 'flex', flexDirection: 'column', background: 'var(--review-panel-alt-bg)' }}>
          <div style={{ height: 38, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: '1px solid var(--review-shell-divider)' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Walkthrough</span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>5 steps · 2 read · 1 flagged</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)' }}>All</span>
          </div>
          {placeholderSteps.map((step, index) => (
            <div
              key={step.title}
              style={{
                minHeight: 56,
                display: 'grid',
                gridTemplateColumns: '20px 1fr',
                gap: 8,
                padding: '10px 16px',
                borderBottom: '1px solid var(--review-shell-divider)',
                background: step.state === 'active' ? 'color-mix(in oklab, var(--accent-blue) 9%, var(--review-panel-bg))' : 'transparent',
              }}
            >
              <span style={{
                width: 13,
                height: 13,
                borderRadius: '50%',
                marginTop: 3,
                background: step.state === 'read' ? 'var(--accent-green)' : step.state === 'active' ? 'transparent' : 'var(--bg-overlay)',
                border: step.state === 'active' ? '2px solid var(--accent-blue)' : '1px solid var(--review-shell-divider)',
              }} />
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {index + 1}. {step.title}
                  </span>
                  {step.sev && <SevChip level={step.sev} />}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {step.files} files · <span style={{ color: 'var(--accent-green)' }}>+{step.adds}</span>
                  {step.dels > 0 && <> <span style={{ color: 'var(--accent-red)' }}>−{step.dels}</span></>}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>STEP 3 OF 5</span>
            <SevChip level="HIGH" />
          </div>
          <div style={{ fontSize: 20, fontWeight: 760, color: 'var(--text-primary)' }}>Finding-focused diff view</div>
          <div style={{ maxWidth: 760, fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
            Explains how selected AI findings narrow the diff to local code context while Files keeps the complete changed-file browser available for deeper inspection.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="primary" size="sm">Mark read</Btn>
          </div>
          <div style={{ marginTop: 6, borderTop: '1px solid var(--review-shell-divider)', borderBottom: '1px solid var(--review-shell-divider)' }}>
            <div style={{ padding: '9px 0', fontSize: 10, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--text-tertiary)', fontWeight: 700 }}>
              Files in step (4)
            </div>
            {fileRows.map(([path, adds, dels], index) => (
              <div key={path} style={{
                display: 'grid',
                gridTemplateColumns: '1fr 52px 42px',
                alignItems: 'center',
                minHeight: 24,
                padding: '0 12px',
                background: index === 0 ? 'var(--review-panel-alt-bg)' : 'transparent',
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)' }}>{path}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-green)', textAlign: 'right' }}>{adds}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-red)', textAlign: 'right' }}>{dels}</span>
              </div>
            ))}
          </div>
          <div style={{ border: '1px solid var(--review-shell-divider)', borderRadius: 8, overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {codeLines.map((line, index) => (
              <div key={line} style={{
                display: 'grid',
                gridTemplateColumns: '42px 1fr',
                minHeight: 24,
                alignItems: 'center',
                background: index === 1 || index === 2 ? 'color-mix(in oklab, var(--accent-green) 11%, transparent)' : 'transparent',
                borderTop: index === 0 ? 'none' : '1px solid color-mix(in oklab, var(--review-shell-divider) 50%, transparent)',
              }}>
                <span style={{ color: 'var(--text-tertiary)', textAlign: 'right', paddingRight: 10 }}>{124 + index}</span>
                <span style={{ color: 'var(--text-primary)' }}>{index === 1 || index === 2 ? '+ ' : '  '}{line}</span>
              </div>
            ))}
          </div>
          <div style={{ border: '1px solid var(--review-shell-divider)', borderLeft: '2px solid var(--sev-high)', borderRadius: 6, padding: 14, background: 'var(--bg-surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ color: 'var(--accent-blue)', fontSize: 11 }}>✦ AI</span>
              <SevChip level="HIGH" />
              <span style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-tertiary)', fontWeight: 700 }}>UX</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)' }}>L45</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
              Selected finding keeps nearby context only
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
              The reviewer lands near the relevant lines with expandable hidden sections above and below, avoiding a long scroll through unrelated file changes.
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(5, 8, 13, 0.52)',
          backdropFilter: 'blur(1.2px)',
        }}
      />

      {showCta && (
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-start',
            minHeight: '100%',
            paddingTop: 96,
            gap: 14,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 14,
              padding: '22px 28px',
              borderRadius: 18,
              background: 'color-mix(in oklab, var(--review-panel-bg) 86%, transparent)',
              border: '1px solid color-mix(in oklab, var(--review-shell-border) 72%, transparent)',
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.32)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <WalkthroughEmptyCta
              onGenerate={onGenerate}
              onStop={onStop}
              onRunReview={onRunReview}
              canGenerate={canGenerate}
              isGenerating={isGenerating}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function resolveReviewId(props: WalkthroughViewProps): string {
  return String(
    props.branchReviewId
    || props.workspaceReviewId
    || props.prReviewId
    || ''
  );
}

export function WalkthroughView(props: WalkthroughViewProps) {
  const {
    projectId,
    branchReviewId,
    workspaceReviewId,
    prReviewId,
    lifecycle,
    runningReviewProgress,
    runningReviewSteps,
    runningReviewElapsedLabel,
    runningReviewCurrentStep,
    runningReviewMetaLabel,
    onRunReview,
    onSelectFile,
    onSwitchToFindings,
    generationSignal,
    onGenerationStateChange,
    onWalkthroughCountChange,
    diffViewMode: controlledDiffViewMode,
    onDiffViewModeChange,
    onAskAtlasSelection,
    leftPaneWidth = DEFAULT_LEFT_PANE_WIDTH,
    onStartPaneResize,
  } = props;
  // scrollToFileRef — consumed by the Files tab's diff viewer today; not
  // threaded into the Walkthrough right pane yet.
  void props.scrollToFileRef;
  // Review-run progress belongs to the shell top bar and Findings/Files. The
  // Walkthrough pane only surfaces standalone walkthrough generation progress.
  void runningReviewProgress;
  void runningReviewSteps;
  void runningReviewElapsedLabel;
  void runningReviewCurrentStep;
  void runningReviewMetaLabel;
  // Empty walkthrough now uses the canonical placeholder CTA instead of a
  // secondary "Switch to Findings" action.
  void onSwitchToFindings;
  const popup = usePopup();
  const reviewId = resolveReviewId(props);
  const walkthroughGridColumns = onStartPaneResize
    ? `${leftPaneWidth}px ${PANE_RESIZE_HANDLE_WIDTH}px minmax(0, 1fr)`
    : `${leftPaneWidth}px minmax(0, 1fr)`;
  const resizeHandle = onStartPaneResize ? (
    <div
      role="separator"
      aria-label="Resize walkthrough panes"
      title="Resize walkthrough panes"
      style={{
        width: PANE_RESIZE_HANDLE_WIDTH,
        cursor: 'col-resize',
        background: 'var(--review-shell-divider)',
        transition: 'background var(--transition-fast)',
      }}
      onMouseDown={onStartPaneResize}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--accent-blue)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--review-shell-divider)'; }}
    />
  ) : null;

  const [dataState, setDataState] = useState<ReviewDataState>({ review: null, files: [], baseSha: null, headSha: null });
  // Phase 11: standalone walkthrough state. Independently fetched from the
  // walkthroughs table; if missing, we fall through to the legacy
  // reviewJson.changeGroups in the changeGroups memo below.
  const [walkthroughGroups, setWalkthroughGroups] = useState<ReviewChangeGroup[] | null>(null);
  const [walkthroughCacheState, setWalkthroughCacheState] = useState<'unknown' | 'missing' | 'present'>('unknown');
  const [walkthroughArtifactKey, setWalkthroughArtifactKey] = useState<string | null>(null);
  const [walkthroughRunMetadata, setWalkthroughRunMetadata] = useState<WalkthroughRunMetadata | null>(null);
  const [walkthroughIsStale, setWalkthroughIsStale] = useState(false);
  const [isGeneratingWalkthrough, setIsGeneratingWalkthrough] = useState(false);
  // 'incremental' when the in-flight run was triggered with force=false and a
  // previous walkthrough exists; 'full' otherwise. Used by the running-strip
  // copy. Null when no run is in flight.
  const [currentGenerationMode, setCurrentGenerationMode] = useState<'incremental' | 'full' | null>(null);
  // The most recent headSha we know about — either from the loaded
  // walkthrough or from a successful generation against an override. Used by
  // handleGenerateWalkthroughInteractive to decide whether the live git HEAD
  // represents new commits since our last interaction. dataState.headSha
  // reflects the review snapshot and doesn't move when commits land, so we
  // can't rely on it for live freshness checks.
  const lastKnownHeadShaRef = useRef<string | null>(null);
  // Phase 12: live elapsed seconds for the in-flight walkthrough. The
  // canonical `startedAt` lives on the module-level Map entry so the timer
  // survives WalkthroughView remounts; this state is just the ticked
  // derivation off `Date.now() - entry.startedAt`.
  const [walkthroughElapsedSeconds, setWalkthroughElapsedSeconds] = useState(0);
  const [walkthroughModelHint, setWalkthroughModelHint] = useState<WalkthroughModelHint | null>(null);
  // Start in the loading state when a review id is present so the empty
  // "Generate walkthrough" CTA does not flash on the first render before
  // the data-fetch effect has had a chance to run. WalkthroughView only
  // mounts when `selectedItem` exists, so at least one of the ids will be
  // truthy in normal usage; falling back to `false` keeps storybook /
  // detached usage from getting stuck on a loading state forever.
  const [isLoading, setIsLoading] = useState(() => Boolean(branchReviewId || workspaceReviewId || prReviewId));
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [readSet, setReadSet] = useState<Set<number>>(() => new Set());
  const [filter, setFilter] = useState<StepFilter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [walkthroughDetailsOpen, setWalkthroughDetailsOpen] = useState(false);
  const [uncontrolledDiffViewMode, setUncontrolledDiffViewMode] = useState<WalkthroughDiffViewMode>('unified');
  const diffViewMode = controlledDiffViewMode || uncontrolledDiffViewMode;
  const setDiffViewMode = useCallback((mode: WalkthroughDiffViewMode) => {
    if (!controlledDiffViewMode) {
      setUncontrolledDiffViewMode(mode);
    }
    onDiffViewModeChange?.(mode);
  }, [controlledDiffViewMode, onDiffViewModeChange]);
  const [locallyResolvedKeys, setLocallyResolvedKeys] = useState<Set<string>>(() => new Set());
  const [resolvedOutcomes, setResolvedOutcomes] = useState<Map<string, 'addressed' | 'dismissed'>>(() => new Map());
  const [pendingOutcomes, setPendingOutcomes] = useState<Map<string, 'addressed' | 'dismissed'>>(() => new Map());
  const [recommendationComments, setRecommendationComments] = useState<RecommendationCommentMap>({});
  const [manualLineComments, setManualLineComments] = useState<ManualLineCommentMap>({});
  const [hydratedRecommendationCommentStorageKey, setHydratedRecommendationCommentStorageKey] = useState<string | null>(null);
  const [hydratedManualLineCommentStorageKey, setHydratedManualLineCommentStorageKey] = useState<string | null>(null);
  const fetchTokenRef = useRef(0);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const hunkAnchorIndexRef = useRef<number | null>(null);
  const stepListRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const initialStepSelectionRef = useRef<string | null>(null);
  const handledGenerationSignalRef = useRef(generationSignal?.id ?? 0);
  const attemptedContentHydrationRef = useRef<Set<string>>(new Set());
  const contentHydrationTokenRef = useRef(0);
  const loadedWalkthroughLookupKeyRef = useRef<string | null>(null);
  const commentDraftSyncSourceIdRef = useRef(`walkthrough-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  // Latest-render mirrors so the regen success path can read the *previous*
  // groups + artifact key from a stale closure (handleGenerateWalkthrough's
  // useCallback deps don't include them) without forcing callback recreation.
  const walkthroughGroupsRef = useRef<ReviewChangeGroup[] | null>(null);
  const walkthroughArtifactKeyRef = useRef<string | null>(null);

  const readStateId = useMemo(() => {
    if (walkthroughArtifactKey) return `artifact:${walkthroughArtifactKey}`;
    if (dataState.baseSha && dataState.headSha) {
      return `diff:${projectId}:${dataState.baseSha}:${dataState.headSha}`;
    }
    return reviewId ? `review:${reviewId}` : '';
  }, [walkthroughArtifactKey, projectId, dataState.baseSha, dataState.headSha, reviewId]);

  useEffect(() => {
    walkthroughGroupsRef.current = walkthroughGroups;
  }, [walkthroughGroups]);
  useEffect(() => {
    walkthroughArtifactKeyRef.current = walkthroughArtifactKey;
  }, [walkthroughArtifactKey]);

  useEffect(() => {
    let cancelled = false;
    const loadWalkthroughModelHint = async () => {
      try {
        const [configsResult, providersResult, contextResult] = await Promise.allSettled([
          providerApi.getConfigs(),
          providerApi.list(),
          providerApi.getContextActive('review'),
        ]);
        if (cancelled) return;

        const configs = configsResult.status === 'fulfilled' ? configsResult.value.configs : [];
        const providers = providersResult.status === 'fulfilled' ? providersResult.value.providers : [];
        const contextProviderId = contextResult.status === 'fulfilled'
          ? contextResult.value.data?.providerId || null
          : null;
        const contextProvider = contextProviderId
          ? providers.find((provider) => provider.id === contextProviderId) || null
          : null;
        const listedActiveProvider = providersResult.status === 'fulfilled'
          ? providersResult.value.activeProvider
          : null;
        const activeProvider = contextProvider
          || listedActiveProvider
          || providers.find((provider) => provider.isActive)
          || null;
        const providerType = activeProvider?.type || configs[0]?.type || null;
        const providerConfig = configs.find((config) => config.type === providerType) || configs[0] || null;
        const defaults = activeProvider?.source === 'cli_detected'
          ? providerConfig?.cliReviewModelDefaults
          : providerConfig?.reviewModelDefaults;
        const modelId = defaults?.walkthrough
          || defaults?.triage
          || activeProvider?.model
          || providerConfig?.defaultModel
          || null;
        const modelLabel = providerConfig?.models.find((model) => model.id === modelId)?.label || modelId;
        setWalkthroughModelHint({
          providerLabel: providerConfig?.label || activeProvider?.label || providerType,
          providerSource: activeProvider?.source || null,
          modelId,
          modelLabel,
        });
      } catch {
        if (!cancelled) setWalkthroughModelHint(null);
      }
    };
    void loadWalkthroughModelHint();
    window.addEventListener('review-provider-changed', loadWalkthroughModelHint);
    return () => {
      cancelled = true;
      window.removeEventListener('review-provider-changed', loadWalkthroughModelHint);
    };
  }, []);

  useEffect(() => {
    setReadSet(readStateId ? getReadSteps(readStateId) : new Set());
    setActiveIndex(0);
    setActiveFilePath(null);
    setLocallyResolvedKeys(new Set());
    setResolvedOutcomes(new Map());
    setPendingOutcomes(new Map());
    initialStepSelectionRef.current = null;
  }, [readStateId, reviewId]);

  // Scroll right pane to top when the active step changes. RAF guard
  // so the new step content is in the DOM before we scroll.
  useEffect(() => {
    const node = rightPaneRef.current;
    if (!node) return;
    hunkAnchorIndexRef.current = null;
    const handle = requestAnimationFrame(() => {
      node.scrollTop = 0;
    });
    return () => cancelAnimationFrame(handle);
  }, [activeIndex, diffViewMode]);

  // Close filter dropdown on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const onClick = (e: MouseEvent) => {
      const node = filterRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setFilterOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [filterOpen]);

  const outcomeScope: ReviewOutcomeScope | null = useMemo(() => {
    if (branchReviewId) return { projectId, reviewType: 'branch_review', reviewId: branchReviewId };
    if (workspaceReviewId) return { projectId, reviewType: 'workspace_review', reviewId: workspaceReviewId };
    if (prReviewId) return { projectId, reviewType: 'pr_review', reviewId: prReviewId };
    return null;
  }, [projectId, branchReviewId, workspaceReviewId, prReviewId]);
  const recommendationCommentStorageKey = useMemo(() => (
    prReviewId
      ? buildRecommendationCommentStorageKey({ projectId, prReviewId })
      : null
  ), [projectId, prReviewId]);
  const manualLineCommentStorageKey = useMemo(() => (
    prReviewId
      ? buildManualLineCommentStorageKey({ projectId, prReviewId })
      : null
  ), [projectId, prReviewId]);

  const readRecommendationCommentsFromStorage = useCallback((): RecommendationCommentMap => {
    if (!recommendationCommentStorageKey) return {};
    try {
      const raw = localStorage.getItem(recommendationCommentStorageKey);
      return raw ? normalizeRecommendationCommentMap(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  }, [recommendationCommentStorageKey]);

  const readManualLineCommentsFromStorage = useCallback((): ManualLineCommentMap => {
    if (!manualLineCommentStorageKey) return {};
    try {
      const raw = localStorage.getItem(manualLineCommentStorageKey);
      return raw ? normalizeManualLineCommentMap(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  }, [manualLineCommentStorageKey]);

  useEffect(() => {
    if (!recommendationCommentStorageKey) {
      setHydratedRecommendationCommentStorageKey(null);
      setRecommendationComments({});
      return;
    }
    setRecommendationComments(readRecommendationCommentsFromStorage());
    setHydratedRecommendationCommentStorageKey(recommendationCommentStorageKey);
  }, [recommendationCommentStorageKey, readRecommendationCommentsFromStorage]);

  useEffect(() => {
    if (!recommendationCommentStorageKey || hydratedRecommendationCommentStorageKey !== recommendationCommentStorageKey) return;
    try {
      localStorage.setItem(recommendationCommentStorageKey, JSON.stringify(recommendationComments));
      window.dispatchEvent(new CustomEvent<ReviewCommentDraftsUpdatedDetail>(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, {
        detail: {
          kind: 'recommendation',
          storageKey: recommendationCommentStorageKey,
          sourceId: commentDraftSyncSourceIdRef.current,
        },
      }));
    } catch {
      // Ignore localStorage write failures.
    }
  }, [recommendationCommentStorageKey, hydratedRecommendationCommentStorageKey, recommendationComments]);

  useEffect(() => {
    if (!manualLineCommentStorageKey) {
      setHydratedManualLineCommentStorageKey(null);
      setManualLineComments({});
      return;
    }
    setManualLineComments(readManualLineCommentsFromStorage());
    setHydratedManualLineCommentStorageKey(manualLineCommentStorageKey);
  }, [manualLineCommentStorageKey, readManualLineCommentsFromStorage]);

  useEffect(() => {
    if (!manualLineCommentStorageKey || hydratedManualLineCommentStorageKey !== manualLineCommentStorageKey) return;
    try {
      localStorage.setItem(manualLineCommentStorageKey, JSON.stringify(manualLineComments));
      window.dispatchEvent(new CustomEvent<ReviewCommentDraftsUpdatedDetail>(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, {
        detail: {
          kind: 'manual_line',
          storageKey: manualLineCommentStorageKey,
          sourceId: commentDraftSyncSourceIdRef.current,
        },
      }));
    } catch {
      // Ignore localStorage write failures.
    }
  }, [manualLineCommentStorageKey, hydratedManualLineCommentStorageKey, manualLineComments]);

  useEffect(() => {
    if (!recommendationCommentStorageKey) return;
    const syncRecommendationComments = (event: Event) => {
      const detail = (event as CustomEvent<ReviewCommentDraftsUpdatedDetail>).detail;
      if (!detail || detail.kind !== 'recommendation' || detail.storageKey !== recommendationCommentStorageKey) return;
      if (detail.sourceId === commentDraftSyncSourceIdRef.current) return;
      const next = readRecommendationCommentsFromStorage();
      setRecommendationComments((prev) => (
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      ));
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== recommendationCommentStorageKey) return;
      const next = readRecommendationCommentsFromStorage();
      setRecommendationComments((prev) => (
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      ));
    };
    window.addEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, syncRecommendationComments as EventListener);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, syncRecommendationComments as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, [recommendationCommentStorageKey, readRecommendationCommentsFromStorage]);

  useEffect(() => {
    if (!manualLineCommentStorageKey) return;
    const syncManualLineComments = (event: Event) => {
      const detail = (event as CustomEvent<ReviewCommentDraftsUpdatedDetail>).detail;
      if (!detail || detail.kind !== 'manual_line' || detail.storageKey !== manualLineCommentStorageKey) return;
      if (detail.sourceId === commentDraftSyncSourceIdRef.current) return;
      const next = readManualLineCommentsFromStorage();
      setManualLineComments((prev) => (
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      ));
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== manualLineCommentStorageKey) return;
      const next = readManualLineCommentsFromStorage();
      setManualLineComments((prev) => (
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      ));
    };
    window.addEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, syncManualLineComments as EventListener);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, syncManualLineComments as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, [manualLineCommentStorageKey, readManualLineCommentsFromStorage]);

  useEffect(() => {
    // Phase 11: fetch at idle / running / reviewed so the standalone
    // walkthrough surface remains usable independently from review runs.
    if (!branchReviewId && !workspaceReviewId && !prReviewId) return;

    const token = ++fetchTokenRef.current;
    setIsLoading(true);
    // Do NOT clear walkthroughGroups / walkthroughCacheState /
    // walkthroughArtifactKey / walkthroughIsStale / loadedWalkthroughLookupKeyRef
    // here. This effect re-runs on `lifecycle` changes (e.g. running →
    // reviewed when a review completes), but the walkthrough is keyed by
    // (baseSha, headSha) — not by lifecycle. Wiping state up front made
    // the rendered walkthrough vanish, and the SHA-watcher effect below
    // would not refetch it because the SHAs were unchanged. The
    // SHA-watcher handles clearing/refetching correctly when the cache
    // key actually changes.
    const load = async () => {
      try {
        if (branchReviewId) {
          const response = await branchReviewApi.get(projectId, branchReviewId, { includeContent: true });
          if (token !== fetchTokenRef.current) return;
          const br = response.branchReview;
          const headSha = br?.headSha || br?.reviewHeadSha || null;
          const brWithReviewForkPoint = br as typeof br & { reviewForkPointSha?: string | null };
          const baseSha = pickWalkthroughBaseSha(headSha, [
            br?.mergeBaseSha,
            br?.forkPointSha,
            br?.reviewMergeBaseSha,
            brWithReviewForkPoint?.reviewForkPointSha,
          ]);
          setDataState({
            review: br?.reviewJson ?? null,
            files: Array.isArray(br?.files) ? br.files : [],
            baseSha,
            headSha,
          });
        } else if (workspaceReviewId) {
          const response = await workspaceReviewApi.get(projectId, workspaceReviewId, { includeContent: true });
          if (token !== fetchTokenRef.current) return;
          const ws = response.workspaceReview;
          // Workspace review's SHA isn't a real commit (dirty tree), but we
          // still pass headSha — the walkthrough cache will simply miss
          // until the user commits.
          setDataState({
            review: ws?.reviewJson ?? null,
            files: Array.isArray(ws?.files) ? ws.files : [],
            baseSha: null,
            headSha: ws?.reviewHeadSha || ws?.headSha || null,
          });
        } else if (prReviewId) {
          // PR review API differs from branch/workspace: `get()` returns
          // file summaries only. Keep the initial walkthrough render fast;
          // the active step hydrates patch contents below after the shell is
          // already visible.
          const response = await prReviewApi.get(projectId, prReviewId);
          if (token !== fetchTokenRef.current) return;
          const pr = response.prReview;
          const reviewJson = pr?.reviewJson ?? null;
          const summaries = Array.isArray(response.files) ? response.files : [];
          const baseSha = pr?.baseSha || null;
          const headSha = pr?.headSha || null;
          let initialWalkthrough: Awaited<ReturnType<typeof walkthroughApi.get>> = null;
          if (baseSha && headSha) {
            try {
              initialWalkthrough = await walkthroughApi.get(projectId, baseSha, headSha, { includeStale: true });
            } catch {
              initialWalkthrough = null;
            }
            if (token !== fetchTokenRef.current) return;
          }
          const initialWalkthroughGroups = initialWalkthrough && Array.isArray(initialWalkthrough.changeGroups)
            ? initialWalkthrough.changeGroups as ReviewChangeGroup[]
            : null;

          if (baseSha && headSha) {
            loadedWalkthroughLookupKeyRef.current = walkthroughKey(projectId, baseSha, headSha);
          }
          if (initialWalkthroughGroups) {
            setWalkthroughGroups(initialWalkthroughGroups);
            setWalkthroughCacheState('present');
            setWalkthroughArtifactKey(resolveWalkthroughArtifactKey(initialWalkthrough));
            setWalkthroughRunMetadata(normalizeWalkthroughRunMetadata(initialWalkthrough));
            setWalkthroughIsStale(initialWalkthrough?.stale === true);
            lastKnownHeadShaRef.current = resolveWalkthroughHeadSha(initialWalkthrough, headSha);
            onWalkthroughCountChange?.(initialWalkthroughGroups.length);
          } else if (baseSha && headSha) {
            setWalkthroughGroups(null);
            setWalkthroughCacheState('missing');
            setWalkthroughArtifactKey(null);
            setWalkthroughRunMetadata(null);
            setWalkthroughIsStale(false);
            lastKnownHeadShaRef.current = headSha;
            onWalkthroughCountChange?.(null);
          }

          setDataState({
            review: reviewJson,
            files: summaries,
            baseSha,
            headSha,
          });
        }
      } catch {
        if (token !== fetchTokenRef.current) return;
        setDataState({ review: null, files: [], baseSha: null, headSha: null });
      } finally {
        if (token === fetchTokenRef.current) setIsLoading(false);
      }
    };
    void load();
  }, [lifecycle, projectId, branchReviewId, workspaceReviewId, prReviewId, onWalkthroughCountChange]);

  useEffect(() => {
    attemptedContentHydrationRef.current = new Set();
    contentHydrationTokenRef.current += 1;
  }, [projectId, branchReviewId, workspaceReviewId, prReviewId, dataState.baseSha, dataState.headSha]);

  // Phase 11: when (baseSha, headSha) is known, look up the standalone
  // walkthrough first. If missing, the changeGroups memo below falls
  // through to legacy reviewJson.changeGroups.
  useEffect(() => {
    const baseSha = dataState.baseSha;
    const headSha = dataState.headSha;
    if (!baseSha || !headSha) {
      setWalkthroughGroups(null);
      setWalkthroughCacheState('missing');
      setWalkthroughArtifactKey(null);
      setWalkthroughRunMetadata(null);
      setWalkthroughIsStale(false);
      loadedWalkthroughLookupKeyRef.current = null;
      lastKnownHeadShaRef.current = null;
      return;
    }
    const lookupKey = walkthroughKey(projectId, baseSha, headSha);
    if (loadedWalkthroughLookupKeyRef.current === lookupKey) return;
    setWalkthroughCacheState('unknown');
    let cancelled = false;
    walkthroughApi.get(projectId, baseSha, headSha, { includeStale: true })
      .then((wt) => {
        if (cancelled) return;
        loadedWalkthroughLookupKeyRef.current = lookupKey;
        if (wt && Array.isArray(wt.changeGroups)) {
          setWalkthroughGroups(wt.changeGroups as ReviewChangeGroup[]);
          setWalkthroughCacheState('present');
          setWalkthroughArtifactKey(resolveWalkthroughArtifactKey(wt));
          setWalkthroughRunMetadata(normalizeWalkthroughRunMetadata(wt));
          setWalkthroughIsStale(wt.stale === true);
          lastKnownHeadShaRef.current = resolveWalkthroughHeadSha(wt, headSha);
          onWalkthroughCountChange?.((wt.changeGroups as ReviewChangeGroup[]).length);
        } else {
          setWalkthroughGroups(null);
          setWalkthroughCacheState('missing');
          setWalkthroughArtifactKey(null);
          setWalkthroughRunMetadata(null);
          setWalkthroughIsStale(false);
          lastKnownHeadShaRef.current = headSha;
          onWalkthroughCountChange?.(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        loadedWalkthroughLookupKeyRef.current = lookupKey;
        setWalkthroughGroups(null);
        setWalkthroughCacheState('missing');
        setWalkthroughArtifactKey(null);
        setWalkthroughRunMetadata(null);
        setWalkthroughIsStale(false);
        onWalkthroughCountChange?.(null);
      });
    return () => { cancelled = true; };
  }, [projectId, dataState.baseSha, dataState.headSha, onWalkthroughCountChange]);

  // Phase 11: prefer the standalone walkthrough; fall back to legacy
  // reviewJson.changeGroups only when no fresh walkthrough is cached.
  const changeGroups: ReviewChangeGroup[] = useMemo(() => {
    if (walkthroughCacheState === 'present') {
      return Array.isArray(walkthroughGroups) ? walkthroughGroups : [];
    }
    if (walkthroughCacheState === 'unknown' && dataState.baseSha && dataState.headSha) {
      return [];
    }
    return Array.isArray(dataState.review?.changeGroups) ? dataState.review!.changeGroups : [];
  }, [walkthroughCacheState, walkthroughGroups, dataState.baseSha, dataState.headSha, dataState.review]);
  const recommendations: ReviewRecommendation[] = useMemo(
    () => (Array.isArray(dataState.review?.recommendations) ? dataState.review!.recommendations : []),
    [dataState.review],
  );
  const openRecommendations: ReviewRecommendation[] = useMemo(
    () => recommendations.filter((rec) => {
      if (rec.type !== 'issue' && rec.type !== 'suggestion') return false;
      const key = buildReviewRecommendationKey(rec);
      return !locallyResolvedKeys.has(key) && !resolvedOutcomes.has(key);
    }),
    [recommendations, locallyResolvedKeys, resolvedOutcomes],
  );
  const orderedChangeGroups: ReviewChangeGroup[] = useMemo(() => {
    if (changeGroups.length <= 1) return changeGroups;
    const map = buildWalkthroughChangeMap(changeGroups, openRecommendations);
    if (map.readOrder.length !== changeGroups.length) return changeGroups;
    const ordered = map.readOrder
      .map((index) => changeGroups[index])
      .filter((group): group is ReviewChangeGroup => Boolean(group));
    return ordered.length === changeGroups.length ? ordered : changeGroups;
  }, [changeGroups, openRecommendations]);

  const steps: StepMeta[] = useMemo(() => {
    const pathToFirstStepIndex = new Map<string, number>();
    for (let groupIndex = 0; groupIndex < orderedChangeGroups.length; groupIndex += 1) {
      const group = orderedChangeGroups[groupIndex];
      for (const file of group.files || []) {
        const path = typeof file?.path === 'string' ? file.path : '';
        if (!path || pathToFirstStepIndex.has(path)) continue;
        pathToFirstStepIndex.set(path, groupIndex);
      }
    }

    return orderedChangeGroups.map((group, index) => {
      let adds = 0;
      let dels = 0;
      const paths = new Set<string>();
      for (const file of group.files || []) {
        adds += Number(file?.additions) || 0;
        dels += Number(file?.deletions) || 0;
        if (file?.path) paths.add(file.path);
      }
      let highestRecSev: SevLevel | null = null;
      for (const rec of openRecommendations) {
        if (!rec.file || !paths.has(rec.file)) continue;
        if (pathToFirstStepIndex.get(rec.file) !== index) continue;
        highestRecSev = maxSev(highestRecSev, toRecSevLevel(rec));
      }
      const sev = highestRecSev;
      return {
        group,
        index,
        files: (group.files || []).length,
        adds,
        dels,
        sev,
      };
    });
  }, [orderedChangeGroups, openRecommendations]);

  useEffect(() => {
    if (!readStateId || steps.length === 0) return;
    if (initialStepSelectionRef.current === readStateId) return;
    const persistedReadSet = getReadSteps(readStateId);
    const firstUnread = steps.find((step) => !persistedReadSet.has(step.index));
    setActiveIndex(firstUnread?.index ?? steps[0]?.index ?? 0);
    setActiveFilePath(null);
    initialStepSelectionRef.current = readStateId;
  }, [readStateId, steps]);

  // Phase 11: deterministic findings → step mapping. Pure helper, useMemo-
  // wrapped to avoid the "derived array drives effect → infinite render"
  // anti-pattern documented in CLAUDE.md. Currently used to surface a
  // count of findings that landed outside any step ("Other findings"
  // badge); the per-file overlay logic in RightPane continues to use
  // `findingsByFile`, which gives the same result for in-step findings.
  const stepInputs = useMemo(
    () => steps.map((s) => ({ files: s.group.files || [] })),
    [steps],
  );
  const actionableFindings = useMemo(
    () => openRecommendations,
    [openRecommendations],
  );
  const findingsToStepsResult = useMemo(
    () => mapFindingsToSteps(stepInputs, actionableFindings),
    [stepInputs, actionableFindings],
  );
  const walkthroughChangeMap = useMemo(
    () => buildWalkthroughChangeMap(orderedChangeGroups, actionableFindings),
    [orderedChangeGroups, actionableFindings],
  );
  const stepRoleLabels = useMemo(() => {
    const result = new Map<number, string | null>();
    for (const node of walkthroughChangeMap.nodes) {
      result.set(node.stepIndex, shortStepRole(node.primaryRole));
    }
    return result;
  }, [walkthroughChangeMap]);
  const orphanFindingCount = findingsToStepsResult.findingsWithoutStep.length;
  const walkthroughDetailsRows = useMemo(
    () => buildWalkthroughDetailsRows(walkthroughRunMetadata),
    [walkthroughRunMetadata],
  );

  const filteredSteps = useMemo(() => {
    if (filter === 'unread') return steps.filter((s) => !readSet.has(s.index));
    if (filter === 'flagged') return steps.filter((s) => s.sev === 'HIGH' || s.sev === 'MED');
    return steps;
  }, [steps, filter, readSet]);

  const navigateFilteredStep = useCallback((fromStepIndex: number, delta: number) => {
    if (filteredSteps.length === 0) return;
    const currentPosition = filteredSteps.findIndex((step) => step.index === fromStepIndex);
    if (currentPosition < 0) return;
    const nextPosition = Math.max(0, Math.min(filteredSteps.length - 1, currentPosition + delta));
    const nextStep = filteredSteps[nextPosition];
    if (!nextStep || nextStep.index === fromStepIndex) return;
    setActiveIndex(nextStep.index);
    setActiveFilePath(null);
    window.requestAnimationFrame(() => {
      stepListRef.current
        ?.querySelector<HTMLElement>(`[data-walkthrough-step-index="${nextStep.index}"]`)
        ?.focus();
    });
  }, [filteredSteps]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const isNPHunkShortcut = event.key === 'n' || event.key === 'N' || event.key === 'p' || event.key === 'P';
      const isJKStepShortcut = event.key === 'j' || event.key === 'J' || event.key === 'k' || event.key === 'K';
      const isArrowShortcut = event.key === 'ArrowDown' || event.key === 'ArrowUp';
      if (!isNPHunkShortcut && !isJKStepShortcut && !isArrowShortcut) return;

      const activeElement = document.activeElement as HTMLElement | null;
      const tag = (activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (activeElement?.isContentEditable) return;

      const stepList = stepListRef.current;
      const activeInsideStepList = Boolean(stepList?.contains(activeElement) || stepList?.matches(':hover'));
      if (activeInsideStepList && (isJKStepShortcut || isArrowShortcut)) {
        event.preventDefault();
        navigateFilteredStep(activeIndex, event.key === 'ArrowUp' || event.key.toLowerCase() === 'j' ? -1 : 1);
        return;
      }

      const rightPane = rightPaneRef.current;
      if (!rightPane) return;
      const activeInsideRightPane = rightPane.contains(activeElement) || rightPane.matches(':hover');
      if (isArrowShortcut && !activeInsideRightPane) return;
      if (isJKStepShortcut) return;

      const anchors = Array.from(
        rightPane.querySelectorAll<HTMLElement>('[data-atlas-walkthrough-hunk-anchor="true"]')
      );
      if (anchors.length === 0) return;

      event.preventDefault();
      const direction = event.key === 'ArrowDown' || event.key.toLowerCase() === 'n' ? 'next' : 'prev';
      const currentIndex = hunkAnchorIndexRef.current;
      const nextIndex = currentIndex != null && currentIndex >= 0 && currentIndex < anchors.length
        ? (direction === 'next'
          ? (currentIndex + 1) % anchors.length
          : (currentIndex - 1 + anchors.length) % anchors.length)
        : (direction === 'next' ? 0 : anchors.length - 1);
      hunkAnchorIndexRef.current = nextIndex;

      const target = anchors[nextIndex];
      const filePath = target?.closest<HTMLElement>('[data-step-file-section]')?.getAttribute('data-step-file-section');
      if (filePath) setActiveFilePath(filePath);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeIndex, navigateFilteredStep, setActiveFilePath]);

  const readCount = useMemo(
    () => steps.filter((step) => readSet.has(step.index)).length,
    [steps, readSet],
  );
  const flaggedCount = useMemo(
    () => steps.filter((s) => s.sev === 'HIGH' || s.sev === 'MED').length,
    [steps],
  );

  const handleMarkRead = useCallback(() => {
    if (!readStateId) return;
    const willMarkRead = !readSet.has(activeIndex);
    const next = setStepRead(readStateId, activeIndex, willMarkRead);
    setReadSet(new Set(next));
    if (!willMarkRead) return;

    // Fire-and-forget analytics beacon — only on unread→read transitions.
    // Idempotent on the server by (project, base, head, stepIndex).
    if (dataState.baseSha && dataState.headSha) {
      walkthroughApi
        .recordStepRead(projectId, dataState.baseSha, dataState.headSha, activeIndex)
        .catch(() => { /* analytics best-effort */ });
    }

    const currentStepPosition = steps.findIndex((step) => step.index === activeIndex);
    const nextStep = currentStepPosition >= 0 ? steps[currentStepPosition + 1] : null;
    if (nextStep) {
      setActiveIndex(nextStep.index);
      setActiveFilePath(null);
    }
  }, [readStateId, activeIndex, readSet, steps, projectId, dataState.baseSha, dataState.headSha]);

  const resolveStatus = (index: number): StepRowStatus => {
    if (index === activeIndex) return 'active';
    if (readSet.has(index)) return 'read';
    return 'unread';
  };

  const persistOutcome = useCallback(
    async (rec: ReviewRecommendation, status: 'addressed' | 'dismissed') => {
      if (!outcomeScope) return;
      const key = buildReviewRecommendationKey(rec);
      setPendingOutcomes((prev) => {
        const next = new Map(prev);
        next.set(key, status);
        return next;
      });
      try {
        await reviewApi.setOutcome(
          projectId,
          { reviewType: outcomeScope.reviewType, reviewId: outcomeScope.reviewId },
          { recommendation: rec, recommendationKey: key, status },
        );
        setResolvedOutcomes((prev) => {
          const next = new Map(prev);
          next.set(key, status);
          return next;
        });
        setLocallyResolvedKeys((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      } catch (err) {
        // Roll back: leave both resolved and locally-resolved untouched so
        // the AI card stays clickable and the step row's "n issues
        // resolved" counter stays honest.
        console.warn('[walkthrough] outcome persistence failed', err);
      } finally {
        setPendingOutcomes((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [outcomeScope, projectId],
  );

  const handleDismiss = useCallback((rec: ReviewRecommendation) => { void persistOutcome(rec, 'dismissed'); }, [persistOutcome]);
  const handleAddressed = useCallback((rec: ReviewRecommendation) => { void persistOutcome(rec, 'addressed'); }, [persistOutcome]);

  const handleComment = useCallback((rec: ReviewRecommendation) => {
    // TODO(inline-comment): threaded comments ship in a later milestone.
    // For now, jump to the finding in Files mode.
    if (!onSelectFile) return;
    const file = typeof rec.file === 'string' ? rec.file : '';
    if (!file) return;
    onSelectFile({ filePath: file, line: rec.line ?? null });
  }, [onSelectFile]);

  const handleSaveRecommendationComment = useCallback((rec: ReviewRecommendation, comment: string) => {
    if (!prReviewId || rec.type === 'praise') return;
    const trimmed = comment.trim();
    const key = getRecommendationFingerprint(rec);
    setRecommendationComments((prev) => {
      const next = { ...prev };
      if (!trimmed) {
        delete next[key];
        return next;
      }
      next[key] = { comment: trimmed, updatedAt: new Date().toISOString() };
      return next;
    });
  }, [prReviewId]);

  const handleClearRecommendationComment = useCallback((rec: ReviewRecommendation) => {
    const key = getRecommendationFingerprint(rec);
    setRecommendationComments((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const getManualLineComment = useCallback((path: string, line: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const normalizedPath = String(path || '').trim();
    const normalizedLine = Number.isFinite(Number(line)) && Number(line) > 0
      ? Math.floor(Number(line))
      : null;
    if (!normalizedPath || !normalizedLine) return '';
    const draft = Object.values(manualLineComments).find((entry) => (
      entry.path === normalizedPath
      && entry.line === normalizedLine
      && (entry.side || 'RIGHT') === side
    ));
    return draft?.body || '';
  }, [manualLineComments]);

  const handleSaveManualLineComment = useCallback((path: string, line: number, body: string, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    if (!prReviewId) return;
    const normalizedPath = String(path || '').trim();
    const normalizedLine = Number.isFinite(Number(line)) && Number(line) > 0
      ? Math.floor(Number(line))
      : null;
    const trimmed = String(body || '').trim();
    if (!normalizedPath || !normalizedLine || !trimmed) return;
    setManualLineComments((prev) => {
      const existingDraft = Object.values(prev).find((entry) => (
        entry.path === normalizedPath
        && entry.line === normalizedLine
        && (entry.side || 'RIGHT') === side
      ));
      const id = existingDraft?.id || `lc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        ...prev,
        [id]: {
          id,
          path: normalizedPath,
          line: normalizedLine,
          side,
          body: trimmed,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  }, [prReviewId]);

  const handleClearManualLineComment = useCallback((path: string, line: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const normalizedPath = String(path || '').trim();
    const normalizedLine = Number.isFinite(Number(line)) && Number(line) > 0
      ? Math.floor(Number(line))
      : null;
    if (!normalizedPath || !normalizedLine) return;
    setManualLineComments((prev) => {
      const existingDraft = Object.values(prev).find((entry) => (
        entry.path === normalizedPath
        && entry.line === normalizedLine
        && (entry.side || 'RIGHT') === side
      ));
      if (!existingDraft) return prev;
      const next = { ...prev };
      delete next[existingDraft.id];
      return next;
    });
  }, []);

  // Phase 11: Generate walkthrough CTA wires to the standalone
  // /walkthroughs endpoint, NOT a full-review run. The button stays
  // available even after a review completes — running a full review must
  // not auto-trigger walkthrough generation.
  //
  // Generation state is tracked in a module-level Map keyed by SHAs so the
  // "Generating…" UI persists across tab switches / WalkthroughView
  // remounts. On mount we re-attach to any in-flight promise; the Stop
  // button aborts the HTTP request via the entry's AbortController.
  const handleGenerateWalkthrough = useCallback(async (options?: { force?: boolean; bypassCache?: boolean; headShaOverride?: string | null }) => {
    const baseSha = dataState.baseSha;
    // Allow callers to override headSha when they've fetched a fresher value
    // (e.g., the interactive handler detected new commits via git-status).
    // The in-flight map is keyed by the effective headSha; consumers that
    // need to find the run use project/base-prefix lookup because dataState
    // may still hold the previously loaded walkthrough head.
    const headSha = options?.headShaOverride || dataState.headSha;
    if (!baseSha || !headSha) return;
    const key = walkthroughKey(projectId, baseSha, headSha);
    // Same logic the API call uses to decide force; surface it on state so
    // the running-strip can render the right copy ("incremental update" vs.
    // "full walkthrough") while the run is in flight.
    const sendForce = options?.force === true || steps.length === 0;
    setCurrentGenerationMode(sendForce ? 'full' : 'incremental');
    let entry = inFlightWalkthroughs.get(key);
    if (!entry) {
      const abort = new AbortController();
      // Self-reference so the .finally callback can check its own
      // identity in the map. Without this, a late .finally from an aborted
      // run could delete a freshly-started successor entry.
      const newEntry: InFlightWalkthrough = {
        promise: Promise.resolve(null),
        abort,
        startedAt: Date.now(),
        mode: sendForce ? 'full' : 'incremental',
      };
      newEntry.promise = walkthroughApi
        .generate(projectId, baseSha, headSha, {
          // Empty cached rows mean "no usable walkthrough" in the UI.
          // Regenerate rather than returning the same empty artifact forever.
          // Stale walkthroughs (new commits since last) are NOT auto-forced
          // here — the backend's incremental path narrates only the new
          // commits. Use options.force when the caller (e.g., the choice
          // dialog or Cmd+Shift+R) explicitly wants a full regen.
          force: sendForce,
          bypassCache: options?.bypassCache === true,
          reviewType: prReviewId ? 'pr_review' : branchReviewId ? 'branch_review' : workspaceReviewId ? 'workspace_review' : undefined,
          reviewId: prReviewId || branchReviewId || workspaceReviewId || null,
          signal: abort.signal,
        })
        .finally(() => {
          if (inFlightWalkthroughs.get(key) === newEntry) {
            inFlightWalkthroughs.delete(key);
          }
        });
      entry = newEntry;
      inFlightWalkthroughs.set(key, entry);
    }
    // Capture for race-safe state updates: if a newer run replaces this
    // entry while we're awaiting (Stop + immediate re-Generate), the
    // outgoing run must not clobber the new run's `isGenerating` state.
    const myEntry = entry;
    setCurrentGenerationMode(myEntry.mode);
    setIsGeneratingWalkthrough(true);
    let noChangesResult: { previousHeadSha: string | null } | null = null;
    try {
      const wt = await myEntry.promise;
      const stillRelevant = inFlightWalkthroughs.get(key) === myEntry
        || !inFlightWalkthroughs.has(key);
      if (stillRelevant && wt && Array.isArray((wt as { changeGroups?: unknown }).changeGroups)) {
        const generated = wt as {
          id?: unknown;
          updatedAt?: unknown;
          changeGroups: ReviewChangeGroup[];
          noChanges?: boolean;
          previousHeadSha?: string | null;
        };
        const artifactKey = resolveWalkthroughArtifactKey(generated);
        setWalkthroughGroups(generated.changeGroups);
        setWalkthroughCacheState('present');
        setWalkthroughArtifactKey(artifactKey);
        setWalkthroughRunMetadata(normalizeWalkthroughRunMetadata(generated));
        setWalkthroughIsStale(false);
        // We just generated for `headSha` (which may be an override). Mark
        // that as the live-HEAD baseline so a subsequent Generate click
        // doesn't see "new commits" against the now-old dataState.headSha.
        lastKnownHeadShaRef.current = headSha;
        onWalkthroughCountChange?.(generated.changeGroups.length);
        const carriedReadSet = migrateReadStateAcrossArtifacts(
          walkthroughArtifactKeyRef.current,
          walkthroughGroupsRef.current,
          artifactKey,
          generated.changeGroups,
        );
        setReadSet(carriedReadSet);
        initialStepSelectionRef.current = null;
        if (generated.noChanges === true && options?.force !== true) {
          noChangesResult = { previousHeadSha: generated.previousHeadSha ?? null };
        }
      }
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const code = (err as { code?: string })?.code;
      if (name !== 'AbortError' && name !== 'CanceledError' && code !== 'ERR_CANCELED') {
        console.warn('[walkthrough] generation failed', err);
        void popup.alert({
          title: 'Walkthrough generation failed',
          message: describeApiError(err, 'Atlas could not generate a walkthrough. The previous walkthrough was left unchanged.'),
          okLabel: 'OK',
          danger: true,
        });
      }
    } finally {
      // Only flip generating off if our run is still the relevant one. A
      // newer run that replaced us in the map owns the state now.
      const current = inFlightWalkthroughs.get(key);
      if (current === undefined || current === myEntry) {
        setIsGeneratingWalkthrough(false);
        setCurrentGenerationMode(null);
      }
    }
    if (noChangesResult) {
      const confirmed = await popup.confirm({
        title: 'No new commits since last walkthrough',
        message: 'Atlas already covered every commit on this branch. Generate a full walkthrough from the base commit instead?',
        confirmLabel: 'Generate full walkthrough',
        cancelLabel: 'Keep current walkthrough',
      });
      if (confirmed) {
        await handleGenerateWalkthroughRef.current?.({ force: true });
      }
    }
  }, [projectId, dataState.baseSha, dataState.headSha, steps.length, walkthroughIsStale, onWalkthroughCountChange, popup]);
  const handleGenerateWalkthroughRef = useRef(handleGenerateWalkthrough);
  useEffect(() => {
    handleGenerateWalkthroughRef.current = handleGenerateWalkthrough;
  }, [handleGenerateWalkthrough]);

  // Interactive entry point used by the stale-banner button and the
  // top-bar "Generate walkthrough" button. Refreshes the live git HEAD
  // before deciding which popup to show, so the user gets the latest state
  // even if the tab hasn't been refreshed since new commits landed.
  //
  //   - No existing walkthrough → generate directly (nothing to choose).
  //   - Live HEAD differs from the loaded walkthrough's HEAD → new commits
  //     available → choice popup (incremental default vs. full).
  //   - Live HEAD matches → no new commits → simple confirm for full regen.
  //     Offering an incremental choice here would be misleading: incremental
  //     would just return noChanges.
  const handleGenerateWalkthroughInteractive = useCallback(async () => {
    if (steps.length === 0) {
      await handleGenerateWalkthrough();
      return;
    }

    // Live freshness check: re-fetch git status so we see commits that have
    // landed on the branch since the walkthrough was loaded. Best-effort —
    // if the call fails, fall back to the React-state walkthroughIsStale
    // flag so we don't block the user.
    //
    // PR reviews are skipped here: the PR HEAD lives on GitHub and may not
    // match the local branch HEAD at all (the user may not have the PR
    // branch checked out). The backend handles PR incremental via its own
    // latest-walkthrough lookup keyed on baseSha; we just trust
    // walkthroughIsStale for the popup choice.
    let liveHeadSha: string | null = null;
    if (!prReviewId) {
      try {
        const status = await projectApi.getGitStatus(projectId);
        const sha = typeof status?.headSha === 'string' ? status.headSha.trim() : '';
        if (sha) liveHeadSha = sha;
      } catch {
        // ignore — fall through to stale flag
      }
    }
    const baseline = lastKnownHeadShaRef.current || dataState.headSha;
    const hasNewCommits = walkthroughIsStale || (liveHeadSha ? liveHeadSha !== baseline : false);

    if (!hasNewCommits) {
      const confirmed = await popup.confirm({
        title: 'Regenerate full walkthrough?',
        message: 'This walkthrough already covers the latest commit. Regenerate the full walkthrough from the base again?',
        confirmLabel: 'Regenerate full walkthrough',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;
      await handleGenerateWalkthrough({ force: true });
      return;
    }

    const choice = await popup.choose<'incremental' | 'full'>({
      title: 'New commits since last walkthrough',
      message: 'Atlas can narrate only the new commits for an updated walkthrough, or regenerate the full walkthrough from the base.',
      options: [
        { key: 'incremental', label: 'Update with new commits', tone: 'primary' },
        { key: 'full', label: 'Regenerate full walkthrough', tone: 'secondary' },
      ],
    });
    if (choice === null) return;
    // Pass the freshly-fetched headSha so the backend computes the diff
    // against the actual latest commit, not the stale dataState snapshot.
    // For PR reviews liveHeadSha is null and the backend uses the PR
    // snapshot's headSha (which it validates against the PR review record).
    await handleGenerateWalkthrough({
      force: choice === 'full',
      bypassCache: choice === 'incremental',
      headShaOverride: liveHeadSha,
    });
  }, [handleGenerateWalkthrough, popup, projectId, prReviewId, steps.length, walkthroughIsStale, dataState.headSha]);

  const handleStopWalkthrough = useCallback(() => {
    const baseSha = dataState.baseSha;
    if (!baseSha) return;
    // Look up by (projectId, baseSha) prefix instead of constructing a key
    // from dataState.headSha — the in-flight entry may have been keyed with
    // a headShaOverride and computing from dataState.headSha would miss it,
    // leaving the AbortController unfired and the request running.
    const found = findInFlightForBase(projectId, baseSha);
    if (found) {
      found.entry.abort.abort();
      inFlightWalkthroughs.delete(found.key);
    }
    setIsGeneratingWalkthrough(false);
    setCurrentGenerationMode(null);
  }, [projectId, dataState.baseSha, onWalkthroughCountChange]);

  useEffect(() => {
    onGenerationStateChange?.(
      isGeneratingWalkthrough,
      isGeneratingWalkthrough ? handleStopWalkthrough : null,
    );
  }, [handleStopWalkthrough, isGeneratingWalkthrough, onGenerationStateChange]);

  useEffect(() => {
    return () => {
      onGenerationStateChange?.(false, null);
    };
  }, [onGenerationStateChange]);

  useEffect(() => {
    const signalId = generationSignal?.id ?? 0;
    if (signalId === handledGenerationSignalRef.current) return;
    if (isGeneratingWalkthrough) {
      // Drop the queued generation while generating; the user can press Cmd+R
      // again after the run resolves to request a fresh regeneration.
      handledGenerationSignalRef.current = signalId;
      return;
    }
    handledGenerationSignalRef.current = signalId;
    const requestGeneration = async () => {
      // Top-bar button path: route through the choice popup so the user
      // sees the same incremental-vs-full options as the stale banner.
      if (generationSignal?.interactive) {
        await handleGenerateWalkthroughInteractive();
        return;
      }
      if (!generationSignal?.force) {
        await handleGenerateWalkthrough();
        return;
      }
      const confirmed = await popup.confirm({
        title: steps.length > 0 && !walkthroughIsStale
          ? 'Walkthrough already generated'
          : 'Generate full walkthrough?',
        message: steps.length > 0 && !walkthroughIsStale
          ? 'This walkthrough already covers the latest commit. Regenerate the full walkthrough again?'
          : 'Generate a full walkthrough for this diff? This bypasses the walkthrough cache and may take longer.',
        confirmLabel: 'Generate full walkthrough',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;
      await handleGenerateWalkthrough({ force: true });
    };
    void requestGeneration();
  }, [generationSignal, handleGenerateWalkthrough, handleGenerateWalkthroughInteractive, isGeneratingWalkthrough, popup, steps.length, walkthroughIsStale]);

  // Re-attach to an in-flight generation when the component mounts (or
  // when the SHAs change) so the "Generating…" state persists across tab
  // switches. Look up by (projectId, baseSha) prefix because the in-flight
  // headSha may differ from dataState.headSha (override flow).
  useEffect(() => {
    const baseSha = dataState.baseSha;
    if (!baseSha) return;
    const found = findInFlightForBase(projectId, baseSha);
    if (!found) return;
    const { key, entry } = found;
    const myEntry = entry;
    let cancelled = false;
    setIsGeneratingWalkthrough(true);
    setCurrentGenerationMode(entry.mode);
    entry.promise
      .then((wt) => {
        if (cancelled) return;
        const stillRelevant = inFlightWalkthroughs.get(key) === myEntry
          || !inFlightWalkthroughs.has(key);
        if (stillRelevant && wt && Array.isArray((wt as { changeGroups?: unknown }).changeGroups)) {
          const generated = wt as { id?: unknown; updatedAt?: unknown; changeGroups: ReviewChangeGroup[] };
          const artifactKey = resolveWalkthroughArtifactKey(generated);
          setWalkthroughGroups(generated.changeGroups);
          setWalkthroughCacheState('present');
          setWalkthroughArtifactKey(artifactKey);
          setWalkthroughRunMetadata(normalizeWalkthroughRunMetadata(generated));
          setWalkthroughIsStale(false);
          onWalkthroughCountChange?.(generated.changeGroups.length);
          const carriedReadSet = migrateReadStateAcrossArtifacts(
            walkthroughArtifactKeyRef.current,
            walkthroughGroupsRef.current,
            artifactKey,
            generated.changeGroups,
          );
          setReadSet(carriedReadSet);
          initialStepSelectionRef.current = null;
        }
      })
      .catch(() => { /* error is logged by the originating handler */ })
      .finally(() => {
        if (cancelled) return;
        // Same race-safe gate as handleGenerateWalkthrough: a newer run
        // that replaced our entry owns the state now.
        const current = inFlightWalkthroughs.get(key);
        if (current === undefined || current === myEntry) {
          setIsGeneratingWalkthrough(false);
          setCurrentGenerationMode(null);
        }
      });
    return () => { cancelled = true; };
    // dataState.headSha stays in deps so the effect re-fires when the user
    // navigates between reviews with the same base; the prefix lookup
    // above handles the case where the in-flight key uses an override SHA.
  }, [projectId, dataState.baseSha, dataState.headSha]);

  // Phase 12: tick elapsed seconds while a walkthrough is generating. The
  // interval is anchored to `isGeneratingWalkthrough` AND the SHA pair so
  // it cleans up on stop / unmount / SHA change. The interval reads
  // `Date.now() - entry.startedAt` so a tab-switch remount picks up the
  // existing counter rather than restarting from zero.
  useEffect(() => {
    if (!isGeneratingWalkthrough) {
      // Reset to 0 when not generating so the next generation starts fresh.
      setWalkthroughElapsedSeconds(0);
      return;
    }
    const baseSha = dataState.baseSha;
    if (!baseSha) return;

    const tick = () => {
      // Look up by (projectId, baseSha) prefix so a headShaOverride
      // generation still ticks. Computing a key from dataState.headSha would
      // miss the entry whenever an override was used.
      const found = findInFlightForBase(projectId, baseSha);
      if (!found) {
        // Generation finished or aborted between renders — let the
        // `isGeneratingWalkthrough` flag flip handle teardown.
        return;
      }
      const elapsed = Math.max(0, Math.floor((Date.now() - found.entry.startedAt) / 1000));
      setWalkthroughElapsedSeconds(elapsed);
    };
    tick(); // seed immediately so a remount during generation shows the live count without a 1s gap
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [isGeneratingWalkthrough, projectId, dataState.baseSha, dataState.headSha]);

  // Phase 12: heuristic phase labels for the RunningView shell. Walkthrough
  // generation is single-call and fast (cheap-tier model), so backend
  // doesn't emit phase events — we infer from elapsed seconds. These
  // strings match the phase-switch contract in RunningView.buildCurrentStepText.
  const walkthroughPhaseLabel = useMemo<string>(() => {
    if (walkthroughElapsedSeconds < 2) return 'preparing_diff';
    return 'generating_walkthrough';
  }, [walkthroughElapsedSeconds]);

  const walkthroughDiffStats = useMemo(() => {
    const byPath = new Map<string, { additions: number; deletions: number }>();
    for (const file of dataState.files || []) {
      const path = typeof file?.path === 'string' ? file.path.trim() : '';
      if (!path) continue;
      const existing = byPath.get(path) || { additions: 0, deletions: 0 };
      byPath.set(path, {
        additions: existing.additions + (Number(file.additions) || 0),
        deletions: existing.deletions + (Number(file.deletions) || 0),
      });
    }
    if (byPath.size === 0) {
      for (const step of steps) {
        for (const file of step.group.files || []) {
          const path = typeof file?.path === 'string' ? file.path.trim() : '';
          if (!path) continue;
          const existing = byPath.get(path) || { additions: 0, deletions: 0 };
          byPath.set(path, {
            additions: existing.additions + (Number(file.additions) || 0),
            deletions: existing.deletions + (Number(file.deletions) || 0),
          });
        }
      }
    }
    let additions = 0;
    let deletions = 0;
    for (const stats of byPath.values()) {
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { files: byPath.size, additions, deletions };
  }, [dataState.files, steps]);

  const walkthroughScopeLabel = useMemo(() => {
    const base = shortSha(dataState.baseSha);
    const head = shortSha(dataState.headSha);
    return base && head ? `${base}..${head}` : '';
  }, [dataState.baseSha, dataState.headSha]);

  // Phase 12: small activity log for the RunningView Activity panel. Pure
  // derivation from current state — no I/O. useMemo to keep the array
  // reference stable across renders (RunningView treats `logTail` as a
  // value prop, but stable refs avoid spurious child re-renders).
  const walkthroughActivityLog = useMemo<string[]>(() => {
    if (!isGeneratingWalkthrough) return [];
    const generationMode = currentGenerationMode === 'incremental'
      ? 'incremental update'
      : 'full walkthrough';
    const cacheLabel = currentGenerationMode === 'incremental'
      ? 'bypassing cache for new commits'
      : walkthroughCacheState === 'present'
        ? 'regenerating cached walkthrough'
        : 'new walkthrough';
    const lines = [
      `phase: ${walkthroughPhaseLabel}`,
      `mode: ${generationMode}`,
      `model: ${formatWalkthroughModelLine(walkthroughModelHint)}`,
    ];
    if (walkthroughScopeLabel) lines.push(`scope: ${walkthroughScopeLabel}`);
    if (walkthroughDiffStats.files > 0) {
      lines.push(`files: ${walkthroughDiffStats.files} (+${walkthroughDiffStats.additions} / -${walkthroughDiffStats.deletions})`);
    }
    lines.push(
      `cache: ${cacheLabel}`,
      `elapsed: ${walkthroughElapsedSeconds}s`,
    );
    return lines;
  }, [
    currentGenerationMode,
    isGeneratingWalkthrough,
    walkthroughCacheState,
    walkthroughDiffStats.additions,
    walkthroughDiffStats.deletions,
    walkthroughDiffStats.files,
    walkthroughElapsedSeconds,
    walkthroughModelHint,
    walkthroughPhaseLabel,
    walkthroughScopeLabel,
  ]);

  // Phase 12: pipeline steps for the RunningView shell. Three-step shape
  // (Preparing diff → Generating walkthrough → Saving) chosen to match
  // the standard review-running surface. The third step ("Saving") is
  // visual scaffolding — when the API resolves, isGeneratingWalkthrough
  // flips to false and we exit this view, so it never visibly transitions
  // to active. Memoised so the array reference is stable across renders.
  const walkthroughRunningSteps = useMemo<RunningStepSpec[]>(() => {
    if (walkthroughPhaseLabel === 'preparing_diff') {
      return [
        { id: 'prep', label: 'Preparing diff', state: 'active' },
        { id: 'gen', label: 'Generating walkthrough', state: 'pending' },
        { id: 'save', label: 'Saving', state: 'pending' },
      ];
    }
    return [
      { id: 'prep', label: 'Preparing diff', state: 'done' },
      { id: 'gen', label: 'Generating walkthrough', state: 'active' },
      { id: 'save', label: 'Saving', state: 'pending' },
    ];
  }, [walkthroughPhaseLabel]);

  const canGenerateWalkthrough = Boolean(dataState.baseSha && dataState.headSha);

  // True while the walkthrough cache lookup (effect at the SHAs change)
  // has not yet resolved into 'present' or 'missing'. Used to suppress the
  // empty "Generate walkthrough" CTA between the moment dataState SHAs land
  // and the moment the cache fetch confirms whether a walkthrough exists,
  // which otherwise causes the CTA to flash for users who already have a
  // completed walkthrough cached.
  const isWalkthroughLookupPending = walkthroughCacheState === 'unknown' && canGenerateWalkthrough;

  const activeStepFilePaths = useMemo(() => {
    const active = steps[activeIndex];
    return getGroupedWalkthroughFilePaths(active?.group.files);
  }, [steps, activeIndex]);

  useEffect(() => {
    if (activeStepFilePaths.length === 0) return;
    if (!branchReviewId && !workspaceReviewId && !prReviewId) return;

    const filesByPath = new Map(
      dataState.files
        .filter((file) => file?.path)
        .map((file) => [file.path, file] as const),
    );
    const missingPaths = activeStepFilePaths.filter((path) => {
      const existing = filesByPath.get(path) as BranchReviewFileContent | undefined;
      if (
        existing
        && Object.prototype.hasOwnProperty.call(existing, 'patch')
        && Object.prototype.hasOwnProperty.call(existing, 'before')
        && Object.prototype.hasOwnProperty.call(existing, 'after')
      ) {
        return false;
      }
      const key = `${branchReviewId || workspaceReviewId || prReviewId || 'review'}:${path}`;
      return !attemptedContentHydrationRef.current.has(key);
    });
    if (missingPaths.length === 0) return;

    const reviewKey = branchReviewId || workspaceReviewId || prReviewId || 'review';
    for (const path of missingPaths) {
      attemptedContentHydrationRef.current.add(`${reviewKey}:${path}`);
    }

    const token = contentHydrationTokenRef.current;
    const loadContents = async () => {
      try {
        const response = branchReviewId
          ? await branchReviewApi.getFileContents(projectId, branchReviewId, missingPaths)
          : workspaceReviewId
            ? await workspaceReviewApi.getFileContents(projectId, workspaceReviewId, missingPaths)
            : prReviewId
              ? await prReviewApi.getFileContents(projectId, prReviewId, missingPaths)
              : null;
        if (!response || token !== contentHydrationTokenRef.current) return;
        const hydratedFiles = Array.isArray(response.files) ? response.files : [];
        if (hydratedFiles.length === 0) return;
        setDataState((prev) => {
          const merged = new Map<string, BranchReviewFileSummary | BranchReviewFileContent>();
          for (const file of prev.files) {
            if (file?.path) merged.set(file.path, file);
          }
          for (const file of hydratedFiles) {
            if (!file?.path) continue;
            const existing = merged.get(file.path);
            merged.set(file.path, {
              ...(existing || {
                path: file.path,
                additions: Number((file as { additions?: number }).additions) || 0,
                deletions: Number((file as { deletions?: number }).deletions) || 0,
                status: file.status,
                oldPath: file.oldPath,
              }),
              ...file,
            });
          }
          return {
            ...prev,
            files: Array.from(merged.values()),
          };
        });
      } catch (err) {
        console.warn('[walkthrough] step file content hydration failed', err);
        if (token === contentHydrationTokenRef.current) {
          for (const path of missingPaths) {
            attemptedContentHydrationRef.current.delete(`${reviewKey}:${path}`);
          }
        }
      }
    };
    void loadContents();
  }, [
    activeStepFilePaths,
    branchReviewId,
    workspaceReviewId,
    prReviewId,
    projectId,
    dataState.files,
  ]);

  // Empty state (Generate walkthrough CTA). Phase 11: when SHAs are resolved
  // (branch review row exists with headSha + mergeBaseSha), the CTA generates
  // a standalone walkthrough without needing a review run.
  // Phase 12: while a generation is in flight, swap the left pane to the
  // standard RunningView shell (3-step heuristic pipeline + elapsed
  // ticker + activity log) and keep the right pane as a translucent
  // backdrop preview without the popup CTA — RunningView's footer Stop
  // is the canonical cancel affordance in this state.
  //
  // IMPORTANT: when standalone walkthrough generation completes at the
  // idle or reviewed lifecycle, steps populate without changing the review
  // lifecycle. The empty/generating branches must therefore NOT short-circuit
  // the steps render — only enter them when there are no steps to show.
  if (isGeneratingWalkthrough && steps.length === 0) {
    return (
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: walkthroughGridColumns, minHeight: 0 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: 'var(--review-panel-alt-bg)',
          }}
        >
          <RunningView
            steps={walkthroughRunningSteps}
            progress={{
              phase: walkthroughPhaseLabel,
              elapsedSeconds: walkthroughElapsedSeconds,
            }}
            logTail={walkthroughActivityLog}
            onStop={handleStopWalkthrough}
          />
        </div>
        {resizeHandle}
        <WalkthroughPlaceholderPane
          onGenerate={handleGenerateWalkthrough}
          onStop={handleStopWalkthrough}
          onRunReview={onRunReview}
          canGenerate={canGenerateWalkthrough}
          isGenerating={isGeneratingWalkthrough}
          showCta={false}
        />
      </div>
    );
  }
  if (lifecycle === 'idle' && steps.length === 0 && !isLoading && !isWalkthroughLookupPending) {
    return (
      <WalkthroughPlaceholderPane
        onGenerate={handleGenerateWalkthrough}
        onStop={handleStopWalkthrough}
        onRunReview={onRunReview}
        canGenerate={canGenerateWalkthrough}
        isGenerating={isGeneratingWalkthrough}
      />
    );
  }

  // Phase 11: completed review but no walkthrough yet — show the
  // Generate CTA. Running a full review must NOT auto-generate a
  // walkthrough; the user explicitly opts in here.
  if (!isLoading && !isWalkthroughLookupPending && steps.length === 0) {
    return (
      <WalkthroughPlaceholderPane
        onGenerate={handleGenerateWalkthrough}
        onStop={handleStopWalkthrough}
        onRunReview={onRunReview}
        canGenerate={canGenerateWalkthrough}
        isGenerating={isGeneratingWalkthrough}
      />
    );
  }

  return (
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: walkthroughGridColumns, minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--review-panel-alt-bg)',
        }}
      >
      {isGeneratingWalkthrough && steps.length > 0 && (
        <RunningReviewStrip
          steps={walkthroughRunningSteps}
          currentStep="Atlas is generating walkthrough"
          progress={{
            phase: walkthroughPhaseLabel,
            elapsedSeconds: walkthroughElapsedSeconds,
          }}
          logTail={walkthroughActivityLog}
          elapsedLabel={`${walkthroughElapsedSeconds}s`}
          metaLabel={currentGenerationMode === 'incremental'
            ? 'Walkthrough · updating with new commits'
            : 'Walkthrough · generating full walkthrough'}
        />
      )}
      {/* Left-pane sticky header */}
      <div
        ref={filterRef}
        style={{
          padding: '8px 14px',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          borderBottom: '1px solid var(--review-shell-divider)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
          background: 'var(--review-panel-header-bg)',
          position: 'relative',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Steps</span>
        <span style={{ color: 'var(--text-tertiary)' }}>
          {steps.length} · {readCount} read · {flaggedCount} flagged
        </span>
        {orphanFindingCount > 0 && (
          <span
            title={`${orphanFindingCount} finding${orphanFindingCount === 1 ? '' : 's'} not anchored to any walkthrough step`}
            style={{
              padding: '1px 6px',
              borderRadius: 9,
              fontSize: 10,
              fontWeight: 600,
              border: '1px solid var(--border-default)',
              color: 'var(--text-tertiary)',
              background: 'var(--bg-surface)',
            }}
          >
            +{orphanFindingCount} outside steps
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => {
            setWalkthroughDetailsOpen((open) => !open);
            setFilterOpen(false);
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: walkthroughDetailsOpen ? 'var(--text-primary)' : 'var(--text-tertiary)',
            fontSize: 11,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          Details
        </button>
        <button
          type="button"
          onClick={() => {
            setFilterOpen((v) => !v);
            setWalkthroughDetailsOpen(false);
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-tertiary)',
            fontSize: 11,
            cursor: 'pointer',
            padding: 0,
            textTransform: 'capitalize',
          }}
        >
          {filter === 'all' ? 'All' : filter === 'unread' ? 'Unread' : 'Flagged'} {'\u25BE'}
        </button>
        {walkthroughDetailsOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              right: 14,
              marginTop: 4,
              width: 360,
              maxWidth: 'calc(100vw - 32px)',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: 6,
              zIndex: 6,
              boxShadow: '0 14px 32px rgba(0,0,0,0.32)',
              padding: '10px 12px',
              display: 'grid',
              gridTemplateColumns: 'minmax(110px, 0.36fr) minmax(0, 1fr)',
              gap: '7px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            {walkthroughDetailsRows.map((row) => (
              <div key={row.label} style={{ display: 'contents' }}>
                <div style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {row.label}
                </div>
                <div style={{ minWidth: 0, color: 'var(--text-primary)', textAlign: 'right' }}>
                  <span>{row.value}</span>
                  {row.detail && (
                    <span style={{ marginLeft: 6, color: 'var(--text-tertiary)' }}>
                      ({row.detail})
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {filterOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              right: 14,
              marginTop: 4,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: 4,
              zIndex: 5,
              display: 'grid',
              minWidth: 100,
              boxShadow: '0 4px 12px rgba(0,0,0,0.24)',
            }}
          >
            {(['all', 'unread', 'flagged'] as StepFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => { setFilter(f); setFilterOpen(false); }}
                style={{
                  padding: '6px 10px',
                  border: 'none',
                  background: filter === f ? 'var(--review-segment-active-bg)' : 'transparent',
                  color: 'var(--text-primary)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: 11,
                  textTransform: 'capitalize',
                }}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {walkthroughIsStale && (
        <div
          style={{
            padding: '8px 14px 9px',
            borderBottom: '1px solid var(--review-shell-divider)',
            flexShrink: 0,
            background: 'var(--review-panel-alt-bg)',
            color: 'var(--sev-med)',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 0.5,
            lineHeight: 1.45,
            textTransform: 'uppercase',
          }}
        >
          Walkthrough is stale · showing the last generated version
        </div>
      )}

      {/* Step list */}
      <div ref={stepListRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {filteredSteps.length === 0 ? (
          <div style={{ padding: 20, fontSize: 11.5, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            No steps match the current filter.
          </div>
        ) : (
          filteredSteps.map((meta) => (
            <WalkthroughStepRow
              key={meta.index}
              index={meta.index}
              title={meta.group.label || `Step ${meta.index + 1}`}
              status={resolveStatus(meta.index)}
              files={meta.files}
              adds={meta.adds}
              dels={meta.dels}
              read={readSet.has(meta.index)}
              sev={meta.sev}
              roleLabel={stepRoleLabels.get(meta.index) || null}
              onSelect={() => setActiveIndex(meta.index)}
              onNavigate={(delta) => navigateFilteredStep(meta.index, delta)}
            />
          ))
        )}
      </div>

      {/* Footer — keyboard hints (display only) */}
      <div
        style={{
          padding: '6px 16px',
          borderTop: '1px solid var(--review-shell-divider)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 10.5,
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          <span>next</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>m</Kbd>
          <span>mark read</span>
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>{'\u2318\u23CE'}</Kbd>
          <span>approve</span>
        </span>
      </div>
      </div>
      {resizeHandle}
      {/* Right pane: step detail header + files list + diff sections */}
      <RightPane
        steps={steps}
        activeIndex={activeIndex}
        setActiveIndex={setActiveIndex}
        readSet={readSet}
        onMarkRead={handleMarkRead}
        activeFilePath={activeFilePath}
        setActiveFilePath={setActiveFilePath}
        files={dataState.files}
        recommendations={findingsToStepsResult.stepFindings}
        isLoading={isLoading}
        rightPaneRef={rightPaneRef}
        resolvedOutcomes={resolvedOutcomes}
        pendingOutcomes={pendingOutcomes}
        onApplyFix={undefined}
        onComment={handleComment}
        onDismiss={handleDismiss}
        onAddressed={handleAddressed}
        canCommentOnRecommendation={Boolean(prReviewId)}
        commentDisabledReason={!prReviewId && (branchReviewId || workspaceReviewId)
          ? 'Comments on branch reviews are disabled because they only publish to GitHub pull requests. Open or switch to a PR from this branch to comment there.'
          : null}
        getRecommendationComment={(rec) => recommendationComments[getRecommendationFingerprint(rec)]?.comment || ''}
        onSaveRecommendationComment={handleSaveRecommendationComment}
        onClearRecommendationComment={handleClearRecommendationComment}
        canCommentOnAnyLine={Boolean(prReviewId)}
        getManualLineComment={getManualLineComment}
        onSaveManualLineComment={handleSaveManualLineComment}
        onClearManualLineComment={handleClearManualLineComment}
        onAskAtlasSelection={onAskAtlasSelection}
        diffViewMode={diffViewMode}
        onDiffViewModeChange={setDiffViewMode}
      />
    </div>
  );
}

/**
 * Right pane — step header + files list + per-file diff sections.
 */
function RightPane({
  steps,
  activeIndex,
  setActiveIndex,
  readSet,
  onMarkRead,
  activeFilePath,
  setActiveFilePath,
  files,
  recommendations,
  isLoading,
  rightPaneRef,
  resolvedOutcomes,
  pendingOutcomes,
  onApplyFix,
  onComment,
  onDismiss,
  onAddressed,
  canCommentOnRecommendation,
  commentDisabledReason,
  getRecommendationComment,
  onSaveRecommendationComment,
  onClearRecommendationComment,
  canCommentOnAnyLine,
  getManualLineComment,
  onSaveManualLineComment,
  onClearManualLineComment,
  onAskAtlasSelection,
  diffViewMode,
  onDiffViewModeChange,
}: {
  steps: StepMeta[];
  activeIndex: number;
  setActiveIndex: (n: number) => void;
  readSet: Set<number>;
  onMarkRead: () => void;
  activeFilePath: string | null;
  setActiveFilePath: (p: string | null) => void;
  files: Array<BranchReviewFileSummary | BranchReviewFileContent>;
  recommendations: ReviewRecommendation[][];
  isLoading: boolean;
  rightPaneRef: MutableRefObject<HTMLDivElement | null>;
  resolvedOutcomes: Map<string, 'addressed' | 'dismissed'>;
  pendingOutcomes: Map<string, 'addressed' | 'dismissed'>;
  onApplyFix?: (rec: ReviewRecommendation) => void;
  onComment?: (rec: ReviewRecommendation) => void;
  onDismiss?: (rec: ReviewRecommendation) => void;
  onAddressed?: (rec: ReviewRecommendation) => void;
  canCommentOnRecommendation: boolean;
  commentDisabledReason?: string | null;
  getRecommendationComment?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearRecommendationComment?: (rec: ReviewRecommendation) => void;
  canCommentOnAnyLine: boolean;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSaveManualLineComment?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  onAskAtlasSelection?: (payload: {
    attachment: Extract<ReviewAgentAttachment, { type: 'line_range' }>;
    prompt: string;
  }) => void;
  diffViewMode: WalkthroughDiffViewMode;
  onDiffViewModeChange: (mode: WalkthroughDiffViewMode) => void;
}) {
  const active = steps[activeIndex];
  const isRead = active ? readSet.has(active.index) : false;
  const filesByPath = useMemo(() => {
    const m = new Map<string, BranchReviewFileSummary | BranchReviewFileContent>();
    for (const f of files) if (f?.path) m.set(f.path, f);
    return m;
  }, [files]);

  const stepFilePaths = useMemo(() => {
    if (!active) return [] as string[];
    return getGroupedWalkthroughFilePaths(active.group.files);
  }, [active]);

  const activeRecommendations = recommendations[active?.index ?? -1] || [];
  const groupedStepFiles = useMemo(
    () => groupWalkthroughFilesByRole(active?.group.files || []),
    [active],
  );
  const reviewFocus = useMemo(
    () => buildWalkthroughReviewFocus(active?.group, activeRecommendations),
    [active, activeRecommendations],
  );
  const [expandedFileGroups, setExpandedFileGroups] = useState<Set<string>>(() => new Set());
  const stickyHeaderRef = useRef<HTMLDivElement | null>(null);
  const filesInStepRef = useRef<HTMLDivElement | null>(null);
  const [showFilesInStepPill, setShowFilesInStepPill] = useState(false);
  const [filesInStepOverlayOpen, setFilesInStepOverlayOpen] = useState(false);
  useEffect(() => {
    setExpandedFileGroups(new Set());
    setFilesInStepOverlayOpen(false);
  }, [active?.index]);

  useEffect(() => {
    const pane = rightPaneRef.current;
    if (!pane) return;
    let rafId = 0;

    const update = () => {
      rafId = 0;
      const header = stickyHeaderRef.current;
      const fileMap = filesInStepRef.current;
      if (!header || !fileMap) {
        setShowFilesInStepPill(false);
        return;
      }
      const headerBottom = header.getBoundingClientRect().bottom;
      const fileMapBottom = fileMap.getBoundingClientRect().bottom;
      const nextVisible = fileMapBottom <= headerBottom + 6;
      setShowFilesInStepPill(nextVisible);
      if (!nextVisible) setFilesInStepOverlayOpen(false);
    };

    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(update);
    };

    const handleScroll = () => {
      setFilesInStepOverlayOpen(false);
      scheduleUpdate();
    };

    scheduleUpdate();
    pane.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      pane.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', scheduleUpdate);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [rightPaneRef, active?.index, groupedStepFiles.length]);

  const findingsByFile = useMemo(() => {
    const map = new Map<string, ReviewRecommendation[]>();
    for (const rec of activeRecommendations) {
      const path = typeof rec.file === 'string' ? rec.file : '';
      if (!path) continue;
      const existing = map.get(path) || [];
      existing.push(rec);
      map.set(path, existing);
    }
    return map;
  }, [activeRecommendations]);

  const highestSevForFile = useCallback((path: string): SevLevel | null => {
    const recs = findingsByFile.get(path) || [];
    let best: SevLevel | null = null;
    for (const rec of recs) {
      const s = normalizeRecommendationSeverity(rec);
      const level: SevLevel | null = s === 'critical' || s === 'high' ? 'HIGH'
        : s === 'medium' ? 'MED' : s === 'low' ? 'LOW' : null;
      if (level === 'HIGH') return 'HIGH';
      if (level === 'MED' && best !== 'MED') best = 'MED';
      if (level === 'LOW' && !best) best = 'LOW';
    }
    return best;
  }, [findingsByFile]);

  const focusStepFile = useCallback((path: string) => {
    setActiveFilePath(path);
    setFilesInStepOverlayOpen(false);

    const pane = rightPaneRef.current;
    if (!pane) return;
    const target = Array.from(
      pane.querySelectorAll<HTMLElement>('[data-step-file-section]')
    ).find((node) => node.getAttribute('data-step-file-section') === path);
    if (!target) return;

    const paneTop = pane.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    const headerHeight = stickyHeaderRef.current?.getBoundingClientRect().height || 0;
    pane.scrollTo({
      top: Math.max(0, pane.scrollTop + targetTop - paneTop - headerHeight - 8),
      behavior: 'smooth',
    });
  }, [rightPaneRef, setActiveFilePath]);

  if (!active) {
    return (
      <div
        ref={rightPaneRef}
        style={{
          minWidth: 0,
          background: 'var(--review-panel-bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          fontSize: 12,
        }}
      >
        {isLoading ? 'Loading steps…' : 'No step selected'}
      </div>
    );
  }

  const total = steps.length;
  const canPrev = activeIndex > 0;
  const canNext = activeIndex < total - 1;
  const prevLabel = canPrev ? `Step ${activeIndex}` : 'Step 1';
  const nextLabel = canNext ? `Step ${activeIndex + 2}` : `Step ${total}`;
  const renderFilesInStepGroups = (densePadding = false) => (
    groupedStepFiles.map((group) => {
      const groupKey = group.role;
      const groupOpen = !group.collapsedByDefault || expandedFileGroups.has(groupKey);
      const groupIdSegment = group.role.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'group';
      const groupControlId = `walkthrough-file-group-${active.index}-${groupIdSegment}${densePadding ? '-overlay' : ''}`;
      const groupButtonId = `${groupControlId}-button`;
      return (
        <div
          key={`${densePadding ? 'overlay' : 'inline'}-${group.role}`}
          style={{
            borderTop: '1px solid color-mix(in oklab, var(--review-shell-divider) 55%, transparent)',
          }}
        >
          <button
            id={groupButtonId}
            type="button"
            aria-controls={groupControlId}
            aria-expanded={groupOpen}
            onClick={() => {
              setExpandedFileGroups((prev) => {
                const next = new Set(prev);
                if (groupOpen) next.delete(groupKey);
                else next.add(groupKey);
                return next;
              });
            }}
            style={{
              width: '100%',
              minHeight: 28,
              padding: densePadding ? '6px 12px' : '6px 20px',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              fontSize: 11,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: 'none',
              background: 'transparent',
              textAlign: 'left',
            }}
          >
            <svg
              aria-hidden="true"
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: groupOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 120ms ease',
                color: 'var(--text-tertiary)',
                flexShrink: 0,
              }}
            >
              <polyline points="6 3 11 8 6 13" />
            </svg>
            <span>{group.label}</span>
            <span style={{ color: 'var(--text-tertiary)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
              {group.files.length}
            </span>
            {group.collapsedByDefault && !groupOpen && (
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 500, fontSize: 10 }}>
                collapsed
              </span>
            )}
          </button>
          <div
            id={groupControlId}
            role="region"
            aria-labelledby={groupButtonId}
            hidden={!groupOpen}
          >
            {groupOpen && group.files.map((f, i) => {
              const sev = highestSevForFile(f.path);
              return (
                <div key={`${group.role}-${f.path}-${i}`} style={{ padding: densePadding ? '0 6px 0 8px' : '0 6px 0 14px' }}>
                  <FileRow
                    path={f.path}
                    sev={sev ?? undefined}
                    adds={f.additions}
                    dels={f.deletions}
                    active={activeFilePath === f.path}
                    dense
                    onClick={() => focusStepFile(f.path)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      );
    })
  );

  return (
    <div
      ref={rightPaneRef}
      style={{
        minWidth: 0,
        background: 'var(--review-panel-bg)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
      }}
    >
      {/* Sticky step header */}
      <div
        ref={stickyHeaderRef}
        style={{
          padding: '18px 20px 16px',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          zIndex: 2,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 6,
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: 0.4,
          }}
        >
          <span>STEP {active.index + 1} OF {total}</span>
          {active.sev && (
            <>
              <span style={{ width: 3, height: 3, borderRadius: 2, background: 'var(--border-default)' }} />
              <SevChip level={active.sev} />
            </>
          )}
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" size="sm" onClick={() => canPrev && setActiveIndex(activeIndex - 1)} disabled={!canPrev}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="10 3 5 8 10 13" />
            </svg>
            {prevLabel}
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => canNext && setActiveIndex(activeIndex + 1)} disabled={!canNext}>
            {nextLabel}
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 3 11 8 6 13" />
            </svg>
          </Btn>
        </div>
        <h2
          style={{
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: -0.25,
            lineHeight: 1.3,
            margin: '0 0 6px',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {active.group.label || `Step ${active.index + 1}`}
        </h2>
        {active.group.description && (
          <p
            style={{
              fontSize: 12.5,
              lineHeight: 1.6,
              color: 'var(--text-secondary)',
              margin: 0,
              maxWidth: 640,
            }}
          >
            {active.group.description}
          </p>
        )}
        {reviewFocus.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              marginTop: 10,
              maxWidth: 760,
            }}
          >
            {reviewFocus.map((item) => (
              <span
                key={item}
                title={item}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  minHeight: 22,
                  maxWidth: '100%',
                  padding: '2px 7px',
                  borderRadius: 999,
                  border: '1px solid var(--border-default)',
                  background: 'var(--review-panel-bg)',
                  color: 'var(--text-secondary)',
                  fontSize: 10.5,
                  lineHeight: 1.35,
                }}
              >
                {item}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 10 }}>
          <Btn variant="primary" size="sm" onClick={onMarkRead}>
            {isRead ? '\u2713 Read' : 'Mark read'}
          </Btn>
          <div style={{ flex: 1 }} />
          <WalkthroughDiffModeToggle
            mode={diffViewMode}
            onChange={onDiffViewModeChange}
          />
        </div>
        {showFilesInStepPill && (
          <button
            type="button"
            onClick={() => setFilesInStepOverlayOpen((open) => !open)}
            aria-expanded={filesInStepOverlayOpen}
            aria-label="Show files in this walkthrough step"
            style={{
              marginTop: 10,
              minHeight: 24,
              padding: '2px 9px',
              borderRadius: 999,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              cursor: 'pointer',
              fontFamily: 'var(--font-ui)',
              boxShadow: '0 6px 18px color-mix(in oklab, black 18%, transparent)',
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = 'var(--bg-hover)';
              event.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'var(--bg-surface)';
              event.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 4.5h10" />
              <path d="M3 8h10" />
              <path d="M3 11.5h6" />
            </svg>
            Files in step
            <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
              {active.group.files?.length ?? 0}
            </span>
          </button>
        )}
        {showFilesInStepPill && filesInStepOverlayOpen && (
          <div
            role="dialog"
            aria-label="Files in this walkthrough step"
            style={{
              position: 'absolute',
              left: 20,
              right: 20,
              top: 'calc(100% - 1px)',
              maxHeight: 'min(360px, 52vh)',
              overflow: 'auto',
              overscrollBehavior: 'contain',
              border: '1px solid var(--review-shell-divider)',
              borderRadius: 6,
              background: 'var(--bg-surface)',
              boxShadow: '0 18px 40px color-mix(in oklab, black 32%, transparent)',
              zIndex: 5,
              animation: 'walkthrough-file-map-overlay-in 140ms ease-out',
            }}
          >
            <div
              style={{
                minHeight: 34,
                padding: '8px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderBottom: '1px solid var(--review-shell-divider)',
                background: 'var(--review-panel-header-bg)',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              <span
                style={{
                  fontSize: 10.5,
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  fontWeight: 700,
                }}
              >
                Files in step
              </span>
              <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                ({active.group.files?.length ?? 0})
              </span>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                aria-label="Hide files in step"
                onClick={() => setFilesInStepOverlayOpen(false)}
                style={{
                  width: 22,
                  height: 22,
                  border: '1px solid var(--border-default)',
                  borderRadius: 5,
                  background: 'transparent',
                  color: 'var(--text-tertiary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  padding: 0,
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = 'var(--bg-hover)';
                  event.currentTarget.style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = 'transparent';
                  event.currentTarget.style.color = 'var(--text-tertiary)';
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="m4.15 3.3 3.85 3.85 3.85-3.85.85.85L8.85 8l3.85 3.85-.85.85L8 8.85 4.15 12.7l-.85-.85L7.15 8 3.3 4.15l.85-.85Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </div>
            {renderFilesInStepGroups(true)}
          </div>
        )}
      </div>

      {/* Files in step */}
      <div ref={filesInStepRef} style={{ borderBottom: '1px solid var(--review-shell-divider)', flexShrink: 0 }}>
        <div
          style={{
            padding: '10px 20px',
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          Files in step
          <span
            style={{
              color: 'var(--text-tertiary)',
              textTransform: 'none',
              letterSpacing: 0,
              fontWeight: 400,
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
            }}
          >
            ({active.group.files?.length ?? 0})
          </span>
        </div>
        {renderFilesInStepGroups(false)}
      </div>

      {/* Per-file diff sections */}
      <div>
        {stepFilePaths.map((path) => {
          const summary = filesByPath.get(path);
          const summaryWithContent = summary as BranchReviewFileContent | undefined;
          const patch = summaryWithContent?.patch ?? null;
          const before = summaryWithContent?.before ?? null;
          const after = summaryWithContent?.after ?? null;
          const fileEntry = (active.group.files || []).find((f) => f.path === path);
          const sev = highestSevForFile(path);
          const oldPath = (summary as BranchReviewFileSummary | BranchReviewFileContent | undefined)?.oldPath
            || (fileEntry as { oldPath?: string | null } | undefined)?.oldPath
            || null;
          return (
            <StepFileSection
              key={path}
              path={path}
              oldPath={oldPath}
              sev={sev}
              adds={fileEntry?.additions ?? summary?.additions ?? 0}
              dels={fileEntry?.deletions ?? summary?.deletions ?? 0}
              patch={patch}
              before={before}
              after={after}
              findings={findingsByFile.get(path) || []}
              active={activeFilePath === path}
              resolvedOutcomes={resolvedOutcomes}
              pendingOutcomes={pendingOutcomes}
              recommendationKey={buildReviewRecommendationKey}
              onApplyFix={onApplyFix}
              onComment={onComment}
              onDismiss={onDismiss}
              onAddressed={onAddressed}
              canCommentOnRecommendation={canCommentOnRecommendation}
              commentDisabledReason={commentDisabledReason}
              getRecommendationComment={getRecommendationComment}
              onSaveRecommendationComment={onSaveRecommendationComment}
              onClearRecommendationComment={onClearRecommendationComment}
              canCommentOnAnyLine={canCommentOnAnyLine}
              getManualLineComment={getManualLineComment}
              onSaveManualLineComment={onSaveManualLineComment}
              onClearManualLineComment={onClearManualLineComment}
              onAskAtlasSelection={onAskAtlasSelection}
              viewMode={diffViewMode}
            />
          );
        })}
      </div>
    </div>
  );
}

function WalkthroughDiffModeToggle({
  mode,
  onChange,
}: {
  mode: WalkthroughDiffViewMode;
  onChange: (mode: WalkthroughDiffViewMode) => void;
}) {
  const buttonStyle = (active: boolean): CSSProperties => ({
    minHeight: 24,
    padding: '0 0 6px',
    borderRadius: 0,
    border: 'none',
    borderBottom: `2px solid ${active ? 'var(--accent-blue)' : 'transparent'}`,
    background: 'transparent',
    color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
    fontSize: 10,
    fontFamily: 'var(--font-sans)',
    fontWeight: active ? 700 : 600,
    cursor: 'pointer',
  });

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => onChange('unified')}
        style={buttonStyle(mode === 'unified')}
      >
        Unified
      </button>
      <button
        type="button"
        onClick={() => onChange('split')}
        style={buttonStyle(mode === 'split')}
      >
        Split
      </button>
    </div>
  );
}
