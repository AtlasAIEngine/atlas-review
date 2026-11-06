/**
 * TrustReviewView — Three-panel review layout (Screen 2)
 * Left: Change Set list (~240px), Center: diff viewer (flex), Right: AI review (~440px+ responsive)
 * Includes project header bar and bottom keyboard shortcut hints.
 */

import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import toast from '@/lib/toast';
import { projectApi, settingsApi, branchReviewApi, prReviewApi, reviewApi, watcherApi, workspaceReviewApi, walkthroughApi, providerApi, type ReviewModelConfig } from '@/services/api';
import type { BranchReviewDiffScope, GitHubPrConversations, GitHubPrIssueComment, GitHubPrReviewThread, GitHubPrThreadComment, ReviewRecommendation, ReviewResult } from '@/types';
import githubApi from '@/services/githubApi';
import { openExternal } from '@/utils/openExternal';
import { subscribeProjectSocket } from '@/services/projectSocket';
import type { BranchReview, BranchReviewStatus, Project, PrReview, ReviewStatus, ReviewLifecycle, ReviewLifecycleStatus, ReviewFileFilter, WorkspaceReview } from '@/types';
import { loadPanelWidths, savePanelWidths } from '@/utils/panelWidths';
import { beginPanelResizeInteraction, endPanelResizeInteraction } from '@/utils/panelResizeInteraction';
import TrustDiffViewer from './TrustDiffViewer';
import type { BranchReviewSnapshot, DiffNavigationTarget } from './TrustDiffViewer';
import TrustReviewPanel from './TrustReviewPanel';
import type { TrustReviewPanelRef } from './TrustReviewPanel';
import AgentInstructionsModal from './AgentInstructionsModal';
import ProjectNotesModal from './ProjectNotesModal';
import PrivateNotesModal from './PrivateNotesModal';
import { usePopup } from './shared/PopupProvider';
import {
  LARGE_DIFF_PARTIAL_POPUP_THRESHOLD,
} from '@/constants/reviewPartialMode';
import { emitAutoReviewSettingChanged } from '@/constants/autoReviewEvents';
import { askPartialOrFull } from '@/lib/askPartialOrFull';
import { ReviewShellTopBar } from './review/ReviewShellTopBar';
import type { ReviewShellMode, ReviewShellLifecycle } from './review/ReviewShellTopBar';
import { SubmitPopover } from './review/SubmitPopover';
import type { SubmitAction } from './review/SubmitPopover';
import { BranchActionsPopover } from './review/BranchActionsPopover';
import type { ReviewActionMenuItem } from './review/BranchActionsPopover';
import { CopyMenuButton } from './review/CopyMenuButton';
import {
  buildReviewMarkdown,
  buildGitHubReviewCommentMarkdown,
  buildFixPrompt,
  formatBaseBranchLabel,
  buildManualLineCommentStorageKey,
  copyTextToClipboard,
  getBranchReviewDiffScope,
  getRecommendationFingerprint,
  normalizeManualLineCommentMap,
  REVIEW_COMMENT_DRAFTS_UPDATED_EVENT,
  sanitizeFileNamePart,
} from './review/reviewPanelUtils';
import { NotRunView } from './review/NotRunView';
import { FailedReviewView } from './review/FailedReviewView';
import { QueuedReviewPill, RunningReviewStrip, RunningView } from './review/RunningView';
import { FindingsView } from './review/FindingsView';
import { FilesView } from './review/FilesView';
import { FileTreeList } from './review/FileTreeList';
import { WalkthroughView, type WalkthroughGenerationSignal } from './review/WalkthroughView';
import {
  GITHUB_CONVERSATION_RETRY_DELAY_MS,
  PR_REVIEW_CONVERSATIONS_UPDATED_EVENT,
  describeGitHubConversationLoadError,
  describeGitHubConversationRetry,
  getGitHubConversationDiffTarget,
  isRetryableGitHubConversationLoadError,
  shouldAutoSyncGitHubConversations,
  type PrReviewConversationsUpdatedDetail,
} from './review/GitHubConversation';
import { GitHubConversationsSection } from './review/GitHubConversationsSection';
import { ReviewAgentDrawer } from './review/ReviewAgentDrawer';
import type { ReviewAgentAttachment, ReviewAgentOpenOptions, ReviewAgentScope } from '@/services/reviewAgentApi';
import { getPrStaleReviewSummary, isPrReviewStaleFromReview } from '@/lib/reviewPublishActions';
import { normalizeRecommendationSeverity, sanitizeRecommendationDescription } from './review/reviewPanelUtils';
import { getDiffScopeSummaryFromStats } from './review/reviewPanelUtils';
import { formatRecommendationDisplayLocation, formatRecommendationSourceLocation, getRecommendationPatchLine, getRecommendationSourceFile, getRecommendationSourceLine } from '@/utils/reviewNavigation';
import { formatShortcut } from '@/utils/keyboardShortcuts';
import { Btn, SevChip } from './review/primitives';
import { tokenize } from './review/primitives/tokenize';
import {
  hasInFlightOrPendingProgress,
  isActiveLifecycleStatus,
  isActiveReviewProgressPhase,
  parseProgressTimestamp,
  shouldClearStaleProgress,
  shouldReplaceBranchSnapshot,
} from '@/utils/reviewReconciliation';
import {
  isExplicitReviewSelectionLocked,
  pickCurrentReviewSelection,
  type ReviewSelectionSource,
} from './review/reviewSelection';
import { formatProviderModelBadgeLabel, pickShellProvider } from './trustPipelineShellUtils';

/** Union selection model: supports branch reviews and PR reviews */
type SelectedItem = {
  id: string;
  type: 'branch_review' | 'pr_review' | 'workspace_review';
} | null;

type ReviewDiffViewMode = 'unified' | 'split';

const REVIEW_DIFF_VIEW_MODE_STORAGE_KEY = 'atlas_review_diff_view_mode';

function readStoredReviewDiffViewMode(): ReviewDiffViewMode {
  if (typeof window === 'undefined') return 'unified';
  try {
    const stored = window.localStorage.getItem(REVIEW_DIFF_VIEW_MODE_STORAGE_KEY);
    return stored === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

function persistReviewDiffViewMode(mode: ReviewDiffViewMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REVIEW_DIFF_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore localStorage failures in private/quota-limited environments.
  }
}

type BranchReviewProgress = {
  queueId?: string | null;
  phase?: string;
  currentChunk: number;
  totalChunks: number;
  filesCompleted: number;
  totalFiles: number;
  activeChunkFiles?: number;
  elapsedSeconds?: number;
  splitDepth?: number;
  splitParts?: number;
  agenticToolSummary?: string | null;
  agentName?: string | null;
  reviewModel?: string | null;
  reviewModelStrategy?: string | null;
  reviewModelEffectiveStrategy?: string | null;
  diffScopeMode?: 'full' | 'delta' | null;
  diffScopeCommitCount?: number;
  diffBaseSha?: string | null;
  diffHeadSha?: string | null;
  prRequestedMode?: 'auto' | 'full' | 'agentic_discovery' | null;
  prEffectiveMode?: 'auto' | 'full' | 'agentic_discovery' | null;
  prPipelineMode?: 'standard' | 'agentic_discovery' | null;
  totalPrFiles?: number;
  effectiveReviewFiles?: number;
  partialMode?: boolean;
  totalScopeFiles?: number;
  updatedAt?: string | null;
  // Live cli-agentic counters: incremented per tool-use event by the
  // backend so RunningView can show "X of Y turns" without waiting
  // for the review to finish.
  agenticToolUseCount?: number;
  agenticMaxTurns?: number;
};

type QueuedBranchReviewRun = {
  queueId: string | null;
  position: number | null;
  queuedAt: string | null;
  updatedAt: string | null;
  progress: BranchReviewProgress;
};

const RUNNING_PROGRESS_CACHE_PREFIX = 'atlas.review.runningProgress:';

function extractRepoLabelFromAccessError(message?: string | null): string | null {
  const text = String(message || '').trim();
  if (!text) return null;
  const match = text.match(/pull requests for\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
  return match?.[1] || null;
}

function isProgressResetPhase(phase?: string): boolean {
  const normalized = String(phase || '').trim().toLowerCase();
  return normalized === 'queued' || normalized === 'reviewing';
}

/**
 * Map a live review-progress phase (as emitted by the backend socket
 * pipeline) to a step index in the 4-step running-view checklist:
 * 0 = Preparing files, 1 = Triage, 2 = Reviewing, 3 = Synthesising.
 * Unknown / mid-review phases default to Reviewing so the UI doesn't
 * freeze at Triage while the backend actually churns through files.
 */
function getRunningStepIndex(phase?: string): number {
  const p = String(phase || '').trim().toLowerCase();
  if (!p || p === 'queued' || p === 'preparing_files') return 0;
  if (p === 'file_triage') return 1;
  if (p === 'synthesizing') return 3;
  return 2; // file_review_*, single_*, chunk_*, agentic_*, reviewing, running, retrying, provider_retry, file_partial
}

function buildRunningSteps(phase?: string): Array<{ id: string; label: string; state: 'pending' | 'active' | 'done' }> {
  const idx = getRunningStepIndex(phase);
  const labels: Array<{ id: string; label: string }> = [
    { id: 'prep',   label: 'Preparing files' },
    { id: 'triage', label: 'Triage' },
    { id: 'review', label: 'Reviewing' },
    { id: 'synth',  label: 'Synthesising summary' },
  ];
  return labels.map((s, i) => ({
    ...s,
    state: i < idx ? 'done' : i === idx ? 'active' : 'pending',
  }));
}

function formatRunningDuration(totalSeconds?: number | null): string | null {
  const value = Number(totalSeconds);
  if (!Number.isFinite(value) || value < 0) return null;
  const safeSeconds = Math.max(0, Math.floor(value));
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

function shortShaRange(baseSha?: string | null, headSha?: string | null): string | null {
  const base = String(baseSha || '').trim();
  const head = String(headSha || '').trim();
  if (!base || !head) return null;
  return `${base.slice(0, 7)}..${head.slice(0, 7)}`;
}

function pickStandaloneWalkthroughBaseSha(
  headSha: string | null,
  candidates: Array<unknown>,
): string | null {
  const head = typeof headSha === 'string' ? headSha.trim() : '';
  const normalized = candidates
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (!head) return normalized[0] || null;
  return normalized.find((value) => value !== head) || null;
}

function buildRunningStatusMeta(progress: BranchReviewProgress | null, fallbackFileCount?: number | null): string | null {
  if (!progress) return null;
  const agentName = String(progress.agentName || '').trim() || 'Agent';
  const isAgenticDiscovery = progress.prEffectiveMode === 'agentic_discovery'
    || progress.prPipelineMode === 'agentic_discovery';
  const isPartial = progress.partialMode === true;
  const modeLabel = isPartial
    ? 'partial review'
    : progress.diffScopeMode === 'delta'
      ? (isAgenticDiscovery ? 'incremental discovery' : 'incremental review')
      : (isAgenticDiscovery ? 'agentic discovery' : 'full review');
  const reviewedCount = Math.max(
    0,
    Number(progress.effectiveReviewFiles || progress.totalFiles || fallbackFileCount || 0) || 0,
  );
  const totalScopeCount = Math.max(0, Number(progress.totalScopeFiles || 0) || 0);
  const fileLabel = isPartial && totalScopeCount > reviewedCount && reviewedCount > 0
    ? `${reviewedCount} of ${totalScopeCount} files`
    : reviewedCount > 0
      ? `${reviewedCount} files`
      : null;
  const range = shortShaRange(progress.diffBaseSha, progress.diffHeadSha);
  const elapsed = formatRunningDuration(progress.elapsedSeconds);
  const parts = [
    `${agentName} review`,
    modeLabel,
    fileLabel,
    range,
    elapsed ? `${elapsed} elapsed` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' • ') : null;
}

function resolveRunningReviewModelFallback(
  config: ReviewModelConfig | null,
  providerModelLabel: string | null,
  activeProviderLabel: string | null,
): string | null {
  const configuredReviewModel = config?.strategy === 'custom' && typeof config.customModels?.review === 'string'
    ? config.customModels.review.trim()
    : '';
  if (configuredReviewModel) return configuredReviewModel;
  const providerModel = typeof providerModelLabel === 'string' ? providerModelLabel.trim() : '';
  if (providerModel) return providerModel;
  const providerLabel = typeof activeProviderLabel === 'string' ? activeProviderLabel.trim() : '';
  return providerLabel || null;
}

function isProgressRunStartPhase(phase?: string): boolean {
  const normalized = String(phase || '').trim().toLowerCase();
  return normalized === 'queued'
    || normalized === 'reviewing'
    || normalized === 'running'
    || normalized === 'preparing_files'
    || normalized === 'file_triage'
    || normalized === 'single_start'
    || normalized === 'chunk_start'
    || normalized === 'file_review_start';
}

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'input'
    || tag === 'textarea'
    || tag === 'select'
    || element.isContentEditable;
}

function mergeBranchReviewProgress(
  existing: BranchReviewProgress | undefined,
  incoming: BranchReviewProgress
): BranchReviewProgress {
  if (!existing) return incoming;

  const existingTs = parseProgressTimestamp(existing.updatedAt);
  const incomingTs = parseProgressTimestamp(incoming.updatedAt);
  const incomingPhase = String(incoming.phase || '').trim().toLowerCase();
  const existingPhase = String(existing.phase || '').trim().toLowerCase();

  // Drop out-of-order socket events.
  if (incomingTs !== null && existingTs !== null && incomingTs < existingTs) {
    return existing;
  }

  // Accept explicit run resets when a newer run emits fresh start-state counters.
  const existingHasProgress = (existing.currentChunk || 0) > 0
    || (existing.filesCompleted || 0) > 0
    || (existing.totalFiles || 0) > 0;
  const incomingLooksLikeRunStart = isProgressRunStartPhase(incomingPhase)
    && (incoming.currentChunk || 0) <= 1
    && (incoming.filesCompleted || 0) === 0;
  const incomingIsNewerRun = incomingTs !== null
    && (existingTs === null || incomingTs > existingTs);
  if (existingHasProgress && incomingLooksLikeRunStart && incomingIsNewerRun) {
    return incoming;
  }

  // Prevent delayed queued/reviewing events from resetting visible progress
  // after chunk/file counters already advanced.
  if (isProgressResetPhase(incomingPhase)) {
    const existingHasAdvanced = (existing.currentChunk || 0) > 0 || (existing.filesCompleted || 0) > 0;
    const incomingIsZeroState = (incoming.currentChunk || 0) === 0 && (incoming.filesCompleted || 0) === 0;
    const hasNewerTimestamp = incomingTs !== null && (existingTs === null || incomingTs > existingTs);
    if (existingHasAdvanced && incomingIsZeroState && !hasNewerTimestamp) {
      return existing;
    }
  }

  const merged: BranchReviewProgress = { ...incoming };

  // Chunk processing can run in parallel, so apply monotonic counters to avoid
  // progress jitter (e.g. 3/8 -> 2/8 -> 4/8) from out-of-order arrivals.
  if (isActiveReviewProgressPhase(existingPhase) && isActiveReviewProgressPhase(incomingPhase)) {
    merged.currentChunk = Math.max(existing.currentChunk || 0, incoming.currentChunk || 0);
    merged.totalChunks = Math.max(existing.totalChunks || 0, incoming.totalChunks || 0);
    merged.filesCompleted = Math.max(existing.filesCompleted || 0, incoming.filesCompleted || 0);
    merged.totalFiles = Math.max(existing.totalFiles || 0, incoming.totalFiles || 0);
  }

  if (!merged.agenticToolSummary && existing.agenticToolSummary) {
    merged.agenticToolSummary = existing.agenticToolSummary;
  }

  if (!merged.agentName && existing.agentName) {
    merged.agentName = existing.agentName;
  }

  if (!merged.reviewModel && existing.reviewModel) {
    merged.reviewModel = existing.reviewModel;
  }

  if (!merged.reviewModelStrategy && existing.reviewModelStrategy) {
    merged.reviewModelStrategy = existing.reviewModelStrategy;
  }

  if (!merged.reviewModelEffectiveStrategy && existing.reviewModelEffectiveStrategy) {
    merged.reviewModelEffectiveStrategy = existing.reviewModelEffectiveStrategy;
  }

  if (!merged.diffScopeMode && existing.diffScopeMode) {
    merged.diffScopeMode = existing.diffScopeMode;
  }

  if (!((merged.diffScopeCommitCount || 0) > 0) && (existing.diffScopeCommitCount || 0) > 0) {
    merged.diffScopeCommitCount = existing.diffScopeCommitCount;
  }

  if (!merged.diffBaseSha && existing.diffBaseSha) {
    merged.diffBaseSha = existing.diffBaseSha;
  }

  if (!merged.diffHeadSha && existing.diffHeadSha) {
    merged.diffHeadSha = existing.diffHeadSha;
  }

  if (!merged.prRequestedMode && existing.prRequestedMode) {
    merged.prRequestedMode = existing.prRequestedMode;
  }

  if (!merged.prEffectiveMode && existing.prEffectiveMode) {
    merged.prEffectiveMode = existing.prEffectiveMode;
  }

  if (!merged.prPipelineMode && existing.prPipelineMode) {
    merged.prPipelineMode = existing.prPipelineMode;
  }

  if (!((merged.totalPrFiles || 0) > 0) && (existing.totalPrFiles || 0) > 0) {
    merged.totalPrFiles = existing.totalPrFiles;
  }

  if (!((merged.effectiveReviewFiles || 0) > 0) && (existing.effectiveReviewFiles || 0) > 0) {
    merged.effectiveReviewFiles = existing.effectiveReviewFiles;
  }

  // Partial flag is sticky once set: a later non-partial emit must not clear it.
  if (!merged.partialMode && existing.partialMode) {
    merged.partialMode = existing.partialMode;
  }

  if (!((merged.totalScopeFiles || 0) > 0) && (existing.totalScopeFiles || 0) > 0) {
    merged.totalScopeFiles = existing.totalScopeFiles;
  }

  if (!merged.updatedAt && existing.updatedAt) {
    merged.updatedAt = existing.updatedAt;
  }

  if (!merged.queueId && existing.queueId) {
    merged.queueId = existing.queueId;
  }

  return merged;
}

function isSameBranchReviewProgress(
  a: BranchReviewProgress | undefined,
  b: BranchReviewProgress
): boolean {
  if (!a) return false;
  return (
    (a.phase || '') === (b.phase || '')
    && (a.queueId || null) === (b.queueId || null)
    && a.currentChunk === b.currentChunk
    && a.totalChunks === b.totalChunks
    && a.filesCompleted === b.filesCompleted
    && a.totalFiles === b.totalFiles
    && (a.activeChunkFiles || 0) === (b.activeChunkFiles || 0)
    && (a.elapsedSeconds || 0) === (b.elapsedSeconds || 0)
    && (a.splitDepth || 0) === (b.splitDepth || 0)
    && (a.splitParts || 0) === (b.splitParts || 0)
    && (a.agenticToolSummary || null) === (b.agenticToolSummary || null)
    && (a.agentName || null) === (b.agentName || null)
    && (a.reviewModel || null) === (b.reviewModel || null)
    && (a.reviewModelStrategy || null) === (b.reviewModelStrategy || null)
    && (a.reviewModelEffectiveStrategy || null) === (b.reviewModelEffectiveStrategy || null)
    && (a.diffScopeMode || null) === (b.diffScopeMode || null)
    && (a.diffScopeCommitCount || 0) === (b.diffScopeCommitCount || 0)
    && (a.diffBaseSha || null) === (b.diffBaseSha || null)
    && (a.diffHeadSha || null) === (b.diffHeadSha || null)
    && (a.prRequestedMode || null) === (b.prRequestedMode || null)
    && (a.prEffectiveMode || null) === (b.prEffectiveMode || null)
    && (a.prPipelineMode || null) === (b.prPipelineMode || null)
    && (a.totalPrFiles || 0) === (b.totalPrFiles || 0)
    && (a.effectiveReviewFiles || 0) === (b.effectiveReviewFiles || 0)
    && (a.partialMode === true) === (b.partialMode === true)
    && (a.totalScopeFiles || 0) === (b.totalScopeFiles || 0)
    && (a.updatedAt || null) === (b.updatedAt || null)
  );
}

function normalizeProgressCandidate(raw: unknown): BranchReviewProgress | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<BranchReviewProgress>;
  const phase = typeof value.phase === 'string' ? value.phase : undefined;
  const progress: BranchReviewProgress = {
    queueId: typeof value.queueId === 'string' && value.queueId.trim() ? value.queueId : null,
    phase,
    currentChunk: Math.max(0, Number(value.currentChunk) || 0),
    totalChunks: Math.max(0, Number(value.totalChunks) || 0),
    filesCompleted: Math.max(0, Number(value.filesCompleted) || 0),
    totalFiles: Math.max(0, Number(value.totalFiles) || 0),
    activeChunkFiles: Math.max(0, Number(value.activeChunkFiles) || 0),
    elapsedSeconds: Math.max(0, Number(value.elapsedSeconds) || 0),
    splitDepth: Math.max(0, Number(value.splitDepth) || 0),
    splitParts: Math.max(0, Number(value.splitParts) || 0),
    agenticToolSummary: typeof value.agenticToolSummary === 'string' ? value.agenticToolSummary : null,
    agentName: typeof value.agentName === 'string' ? value.agentName : null,
    reviewModel: typeof value.reviewModel === 'string' ? value.reviewModel : null,
    reviewModelStrategy: typeof value.reviewModelStrategy === 'string' ? value.reviewModelStrategy : null,
    reviewModelEffectiveStrategy: typeof value.reviewModelEffectiveStrategy === 'string' ? value.reviewModelEffectiveStrategy : null,
    diffScopeMode: value.diffScopeMode === 'delta' || value.diffScopeMode === 'full' ? value.diffScopeMode : null,
    diffScopeCommitCount: Math.max(0, Number(value.diffScopeCommitCount) || 0),
    diffBaseSha: typeof value.diffBaseSha === 'string' ? value.diffBaseSha : null,
    diffHeadSha: typeof value.diffHeadSha === 'string' ? value.diffHeadSha : null,
    prRequestedMode: value.prRequestedMode === 'auto' || value.prRequestedMode === 'full' || value.prRequestedMode === 'agentic_discovery'
      ? value.prRequestedMode
      : null,
    prEffectiveMode: value.prEffectiveMode === 'auto' || value.prEffectiveMode === 'full' || value.prEffectiveMode === 'agentic_discovery'
      ? value.prEffectiveMode
      : null,
    prPipelineMode: value.prPipelineMode === 'standard' || value.prPipelineMode === 'agentic_discovery'
      ? value.prPipelineMode
      : null,
    totalPrFiles: Math.max(0, Number(value.totalPrFiles) || 0),
    effectiveReviewFiles: Math.max(0, Number(value.effectiveReviewFiles) || 0),
    partialMode: value.partialMode === true,
    totalScopeFiles: Math.max(0, Number(value.totalScopeFiles) || 0),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
  if (!progress.phase && !hasInFlightOrPendingProgress(progress)) return null;
  return progress;
}

function buildQueuedBranchReviewRunFromEntry(entry: {
  id?: string | null;
  position?: number | null;
  queuedAt?: string | null;
  updatedAt?: string | null;
  progress?: Partial<BranchReviewProgress> | null;
} | null | undefined): QueuedBranchReviewRun | null {
  if (!entry) return null;
  const progress = normalizeProgressCandidate({
    ...(entry.progress || {}),
    phase: entry.progress?.phase || 'queued',
    updatedAt: entry.progress?.updatedAt || entry.updatedAt || entry.queuedAt || null,
  });
  if (!progress) return null;
  return {
    queueId: typeof entry.id === 'string' && entry.id.trim() ? entry.id : null,
    position: Number.isFinite(entry.position) ? Number(entry.position) : null,
    queuedAt: typeof entry.queuedAt === 'string' ? entry.queuedAt : null,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    progress,
  };
}

function getQueueEntrySnapshotHeadSha(entry: {
  autoReviewSnapshot?: { headSha?: string | null } | null;
  progress?: { diffHeadSha?: string | null } | null;
} | null | undefined): string | null {
  const snapshotHead = typeof entry?.autoReviewSnapshot?.headSha === 'string'
    ? entry.autoReviewSnapshot.headSha.trim()
    : '';
  if (snapshotHead) return snapshotHead;
  const progressHead = typeof entry?.progress?.diffHeadSha === 'string'
    ? entry.progress.diffHeadSha.trim()
    : '';
  return progressHead || null;
}

function getRunningProgressCacheKey(projectId: string): string {
  return `${RUNNING_PROGRESS_CACHE_PREFIX}${projectId}`;
}

function readRunningProgressCache(projectId: string): Record<string, BranchReviewProgress> {
  if (!projectId || typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(getRunningProgressCacheKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, BranchReviewProgress> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedId = String(id || '').trim();
      const progress = normalizeProgressCandidate(value);
      if (normalizedId && progress) result[normalizedId] = progress;
    }
    return result;
  } catch {
    return {};
  }
}

function writeRunningProgressCache(projectId: string, progressById: Record<string, BranchReviewProgress>): void {
  if (!projectId || typeof window === 'undefined') return;
  try {
    const key = getRunningProgressCacheKey(projectId);
    const entries = Object.entries(progressById);
    if (entries.length === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Best-effort cache only.
  }
}

const LEGACY_REVIEW_STATUS_TO_LIFECYCLE: Record<'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed', ReviewLifecycleStatus> = {
  none: 'completed',
  queued: 'queued',
  reviewing: 'running',
  reviewed: 'completed',
  failed: 'failed',
};
const TERMINAL_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['partial', 'failed', 'completed']);

function normalizeLegacyReviewStatusValue(
  value: unknown,
  fallback: 'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed' = 'none'
): 'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed' {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'none'
    || normalized === 'queued'
    || normalized === 'reviewing'
    || normalized === 'reviewed'
    || normalized === 'failed'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeLifecycleStatusValue(
  value: unknown,
  fallback: ReviewLifecycleStatus = 'queued'
): ReviewLifecycleStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'queued'
    || normalized === 'running'
    || normalized === 'retrying'
    || normalized === 'partial'
    || normalized === 'failed'
    || normalized === 'completed'
  ) {
    return normalized;
  }
  if (
    normalized === 'none'
    || normalized === 'reviewing'
    || normalized === 'reviewed'
  ) {
    return LEGACY_REVIEW_STATUS_TO_LIFECYCLE[normalized];
  }
  return fallback;
}

function mapLifecycleStatusToPhase(status: ReviewLifecycleStatus, sourceStatus: 'none' | 'queued' | 'reviewing' | 'reviewed' | 'failed'): string {
  if (status === 'completed') return sourceStatus === 'none' ? 'idle' : 'complete';
  if (status === 'running') return 'running';
  return status;
}

type BranchSnapshotState = {
  id: string;
  branchName: string;
  baseBranch: string;
  baseBranchSource?: BranchReview['baseBranchSource'] | null;
  headSha: string | null;
  commitCount: number;
  fileCount: number;
  reviewStatus: ReviewStatus;
  reviewLifecycleStatus: ReviewLifecycleStatus;
  reviewLifecyclePhase: string;
  reviewLifecycleIsActive: boolean;
  reviewLifecycleIsTerminal: boolean;
  reviewSourceStatus: string | null;
  reviewError: string | null;
  isWorktree?: boolean;
  worktreePath?: string | null;
  updatedAt: string | null;
};

type ChangeGroupFileFilter = ReviewFileFilter | null;

type ReviewCommitSummary = {
  hash?: string | null;
  message?: string | null;
  author?: string | null;
  date?: string | null;
};

type BranchReviewWithCommits = BranchReview & {
  commits?: ReviewCommitSummary[];
};

type LastCommitPreview = {
  branchName: string;
  baseBranch: string;
  mergeBaseSha?: string | null;
  forkPointSha?: string | null;
  headSha?: string | null;
  fileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  commitCount: number;
  firstCommitAt?: string | null;
  lastCommitAt?: string | null;
  commits?: ReviewCommitSummary[];
};

function normalizeBranchNameForBaseComparison(value: string | null | undefined): string {
  return String(value || '').trim().replace(/^refs\/heads\//, '').toLowerCase();
}

function isKnownBaseBranchName(value: string | null | undefined): boolean {
  const normalized = normalizeBranchNameForBaseComparison(value);
  return normalized === 'main'
    || normalized === 'master'
    || normalized === 'develop'
    || normalized === 'development'
    || normalized === 'staging'
    || normalized === 'release'
    || normalized.startsWith('release/');
}

// Phase 07 / Task 2: legacy three-panel collapse rails were retired. The
// Direction C shell uses one resizable divider between the review list and diff.

function normalizeBranchSnapshot(review: {
  id: string;
  branchName?: string;
  baseBranch?: string;
  baseBranchSource?: BranchReview['baseBranchSource'] | null;
  headSha?: string | null;
  commitCount?: number;
  fileCount?: number;
  reviewStatus?: ReviewStatus;
  reviewLifecycle?: ReviewLifecycle | null;
  reviewError?: string | null;
  isWorktree?: boolean;
  worktreePath?: string | null;
  updatedAt?: string | null;
}): BranchSnapshotState {
  const rawHead = typeof review.headSha === 'string' ? review.headSha.trim() : '';
  const reviewLifecycle = (review.reviewLifecycle && typeof review.reviewLifecycle === 'object')
    ? review.reviewLifecycle
    : null;
  const normalizedSourceStatus = normalizeLegacyReviewStatusValue(
    reviewLifecycle?.sourceStatus || review.reviewStatus || 'none',
    'none'
  );
  const lifecycleStatus = normalizeLifecycleStatusValue(
    reviewLifecycle?.status || reviewLifecycle?.sourceStatus || review.reviewStatus || 'none',
    'completed'
  );
  const lifecyclePhaseValue = typeof reviewLifecycle?.phase === 'string' && reviewLifecycle.phase.trim()
    ? reviewLifecycle.phase.trim()
    : mapLifecycleStatusToPhase(lifecycleStatus, normalizedSourceStatus);
  const lifecyclePhase = lifecyclePhaseValue.toLowerCase();
  const lifecycleIsTerminal = reviewLifecycle?.isTerminal === true
    || TERMINAL_LIFECYCLE_STATUSES.has(lifecycleStatus);
  const lifecycleIsActive = !lifecycleIsTerminal && (
    reviewLifecycle?.isActive === true
    || isActiveLifecycleStatus(lifecycleStatus)
    || isActiveReviewProgressPhase(lifecyclePhase)
  );
  const lifecycleError = typeof reviewLifecycle?.error === 'string' && reviewLifecycle.error.trim().length > 0
    ? reviewLifecycle.error.trim()
    : null;
  const lifecycleUpdatedAt = typeof reviewLifecycle?.updatedAt === 'string'
    ? reviewLifecycle.updatedAt
    : null;
  return {
    id: review.id,
    branchName: typeof review.branchName === 'string' ? review.branchName : '',
    baseBranch: typeof review.baseBranch === 'string' ? review.baseBranch : '',
    baseBranchSource: review.baseBranchSource || null,
    headSha: rawHead.length > 0 ? rawHead : null,
    commitCount: Number.isFinite(Number(review.commitCount)) ? Number(review.commitCount) : 0,
    fileCount: Number.isFinite(Number(review.fileCount)) ? Number(review.fileCount) : 0,
    reviewStatus: review.reviewStatus || 'none',
    reviewLifecycleStatus: lifecycleStatus,
    reviewLifecyclePhase: lifecyclePhase,
    reviewLifecycleIsActive: lifecycleIsActive,
    reviewLifecycleIsTerminal: lifecycleIsTerminal,
    reviewSourceStatus: String(reviewLifecycle?.sourceStatus || review.reviewStatus || '').trim().toLowerCase() || null,
    reviewError: lifecycleError || (typeof review.reviewError === 'string' && review.reviewError.trim().length > 0
      ? review.reviewError.trim()
      : null),
    isWorktree: review.isWorktree === true,
    worktreePath: typeof review.worktreePath === 'string' && review.worktreePath.trim()
      ? review.worktreePath.trim()
      : null,
    updatedAt: lifecycleUpdatedAt || (typeof review.updatedAt === 'string' ? review.updatedAt : null),
  };
}

// Phase 07 / Task 2: `shortSha` was only consumed by the retired project-
// header banner, not by any remaining render path.

const LEFT_PANEL_DEFAULT_WIDTH = 440;
const LEFT_PANEL_MIN_WIDTH = 220;
const CENTER_PANEL_MIN_WIDTH = 200; // files/diff panel min width (flexible drag)
const REVIEW_AGENT_DEFAULT_WIDTH = 520;
const REVIEW_AGENT_MIN_WIDTH = 360;
const REVIEW_AGENT_MAX_WIDTH = 760;
const STALE_BACKGROUND_REVIEW_MS = 5 * 60 * 1000;
const PANEL_RESIZE_HANDLE_WIDTH = 6;
const BRANCH_BANNER_SWITCH_WINDOW_MS = 5 * 60 * 1000;
const TRUST_REVIEW_PANEL_WIDTHS_STORAGE_KEY = 'atlas_ui_review_panel_widths_v7';
const INITIAL_PROJECT_LOAD_GRACE_MS = 20_000;
const INITIAL_PROJECT_LOAD_SETTLE_MS = 1_500;
const INITIAL_REVIEW_SELECTION_RETRY_MS = 1_000;
const INITIAL_REVIEW_SELECTION_MAX_ATTEMPTS = 6;

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeBranchNameForAction(value: unknown): string {
  return String(value || '').trim().replace(/^refs\/heads\//, '');
}

function InitialProjectLoadState({ label, meta }: { label: string; meta: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-6)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)' }}>
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            border: '2px solid var(--border-muted)',
            borderTopColor: 'var(--accent-blue)',
            animation: 'spin 0.9s linear infinite',
          }}
        />
        <div style={{ textAlign: 'center' }}>
          <p style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
            {label}
          </p>
          <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>
            {meta}
          </p>
        </div>
      </div>
    </div>
  );
}

function IdlePrConversationsPanel({
  projectId,
  prReviewId,
  prAuthorLogin,
  onOpenThread,
}: {
  projectId: string;
  prReviewId: string | null | undefined;
  prAuthorLogin?: string | null;
  onOpenThread: (thread: GitHubPrReviewThread) => void;
}) {
  const [conversations, setConversations] = useState<GitHubPrConversations | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [busyCommentId, setBusyCommentId] = useState<string | null>(null);
  const [busyIssueCommentId, setBusyIssueCommentId] = useState<string | null>(null);
  const popup = usePopup();

  const publishConversations = useCallback((nextConversations: GitHubPrConversations | null) => {
    setConversations(nextConversations);
    window.dispatchEvent(new CustomEvent<PrReviewConversationsUpdatedDetail>(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, {
      detail: { projectId, prReviewId: prReviewId || '', conversations: nextConversations },
    }));
  }, [projectId, prReviewId]);

  const loadConversations = useCallback(async (sync = false) => {
    if (!prReviewId) {
      setConversations(null);
      setError(null);
      return;
    }
    if (sync) {
      setIsSyncing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = sync
            ? await prReviewApi.syncConversations(projectId, prReviewId)
            : await prReviewApi.getConversations(projectId, prReviewId);
          setError(null);
          publishConversations(response.conversations);
          if (!sync && shouldAutoSyncGitHubConversations(response.conversations)) {
            void loadConversations(true);
          }
          return;
        } catch (err) {
          if (attempt === 0 && isRetryableGitHubConversationLoadError(err)) {
            setError(describeGitHubConversationRetry(err));
            await new Promise((resolve) => window.setTimeout(resolve, GITHUB_CONVERSATION_RETRY_DELAY_MS));
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      setError(describeGitHubConversationLoadError(err));
    } finally {
      if (sync) {
        setIsSyncing(false);
      } else {
        setIsLoading(false);
      }
    }
  }, [projectId, prReviewId, publishConversations]);

  useEffect(() => {
    void loadConversations(false);
  }, [loadConversations]);

  useEffect(() => {
    const handleConversationsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<PrReviewConversationsUpdatedDetail>).detail;
      if (!detail || detail.projectId !== projectId || detail.prReviewId !== prReviewId) return;
      setConversations(detail.conversations);
    };
    window.addEventListener(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, handleConversationsUpdated);
    return () => window.removeEventListener(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, handleConversationsUpdated);
  }, [projectId, prReviewId]);

  if (!prReviewId) return null;

  const handleReplyThread = async (thread: GitHubPrReviewThread, body: string) => {
    if (!prReviewId || busyThreadId) return;
    const threadNodeId = thread.nodeId || thread.id;
    setBusyThreadId(thread.id);
    setError(null);
    try {
      const response = await prReviewApi.replyToConversationThread(projectId, prReviewId, threadNodeId, body);
      publishConversations(response.conversations);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Failed to reply to GitHub conversation';
      setError(message);
      throw new Error(message);
    } finally {
      setBusyThreadId(null);
    }
  };

  const handleSetThreadResolved = async (thread: GitHubPrReviewThread, resolved: boolean) => {
    if (!prReviewId || busyThreadId) return;
    const threadNodeId = thread.nodeId || thread.id;
    setBusyThreadId(thread.id);
    setError(null);
    try {
      const response = await prReviewApi.setConversationThreadResolution(projectId, prReviewId, threadNodeId, resolved);
      publishConversations(response.conversations);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Failed to update GitHub conversation';
      setError(message);
      throw new Error(message);
    } finally {
      setBusyThreadId(null);
    }
  };

  const handleUpdateComment = async (comment: GitHubPrThreadComment, body: string) => {
    if (!prReviewId || busyCommentId) return;
    const commentNodeId = comment.nodeId || comment.id;
    setBusyCommentId(comment.id);
    setError(null);
    try {
      const response = await prReviewApi.updateConversationComment(projectId, prReviewId, commentNodeId, body);
      publishConversations(response.conversations);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Failed to update GitHub comment';
      setError(message);
      throw new Error(message);
    } finally {
      setBusyCommentId(null);
    }
  };

  const handleDeleteComment = async (comment: GitHubPrThreadComment) => {
    if (!prReviewId || busyCommentId) return;
    const commentNodeId = comment.nodeId || comment.id;
    setBusyCommentId(comment.id);
    setError(null);
    try {
      const response = await prReviewApi.deleteConversationComment(projectId, prReviewId, commentNodeId);
      publishConversations(response.conversations);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Failed to delete GitHub comment';
      setError(message);
      throw new Error(message);
    } finally {
      setBusyCommentId(null);
    }
  };

  const handleConfirmDeleteComment = async (comment: GitHubPrThreadComment) => {
    const author = comment.authorLogin ? ` from ${comment.authorLogin}` : '';
    const isReply = Boolean(comment.replyToNodeId);
    return popup.confirm({
      title: isReply ? 'Delete GitHub reply?' : 'Delete GitHub comment?',
      message: `This will delete the ${isReply ? 'reply' : 'comment'}${author} from the GitHub pull request conversation.`,
      confirmLabel: isReply ? 'Delete reply' : 'Delete comment',
      cancelLabel: 'Cancel',
      danger: true,
    });
  };

  const handleReplyIssueComment = async (body: string) => {
    if (!prReviewId || busyIssueCommentId) return;
    setBusyIssueCommentId('__new__');
    setError(null);
    try {
      const response = await prReviewApi.addIssueComment(projectId, prReviewId, body);
      publishConversations(response.conversations);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Failed to reply to PR comment';
      setError(message);
      throw new Error(message);
    } finally {
      setBusyIssueCommentId(null);
    }
  };

  const handleUpdateIssueComment = async (comment: GitHubPrIssueComment, body: string) => {
    if (!prReviewId || busyIssueCommentId) return;
    const commentNodeId = comment.nodeId || comment.id;
    setBusyIssueCommentId(comment.id);
    setError(null);
    try {
      const response = await prReviewApi.updateIssueComment(projectId, prReviewId, commentNodeId, body);
      publishConversations(response.conversations);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Failed to update PR comment';
      setError(message);
      throw new Error(message);
    } finally {
      setBusyIssueCommentId(null);
    }
  };

  const handleDeleteIssueComment = async (comment: GitHubPrIssueComment) => {
    if (!prReviewId || busyIssueCommentId) return;
    const commentNodeId = comment.nodeId || comment.id;
    setBusyIssueCommentId(comment.id);
    setError(null);
    try {
      const response = await prReviewApi.deleteIssueComment(projectId, prReviewId, commentNodeId);
      publishConversations(response.conversations);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Failed to delete PR comment';
      setError(message);
      throw new Error(message);
    } finally {
      setBusyIssueCommentId(null);
    }
  };

  const handleConfirmDeleteIssueComment = async (comment: GitHubPrIssueComment) => {
    const author = comment.authorLogin ? ` from ${comment.authorLogin}` : '';
    return popup.confirm({
      title: 'Delete PR comment?',
      message: `This will delete the PR comment${author} from GitHub.`,
      confirmLabel: 'Delete comment',
      cancelLabel: 'Cancel',
      danger: true,
    });
  };

  return (
    <GitHubConversationsSection
      conversations={conversations}
      isLoading={isLoading}
      isSyncing={isSyncing}
      error={error}
      prAuthorLogin={prAuthorLogin}
      onRefresh={() => { void loadConversations(true); }}
      onOpenThread={onOpenThread}
      onReplyThread={handleReplyThread}
      onSetThreadResolved={handleSetThreadResolved}
      onUpdateComment={handleUpdateComment}
      onDeleteComment={handleDeleteComment}
      onConfirmDeleteComment={handleConfirmDeleteComment}
      onReplyIssueComment={handleReplyIssueComment}
      onUpdateIssueComment={handleUpdateIssueComment}
      onDeleteIssueComment={handleDeleteIssueComment}
      onConfirmDeleteIssueComment={handleConfirmDeleteIssueComment}
      busyThreadId={busyThreadId}
      busyCommentId={busyCommentId}
      busyIssueCommentId={busyIssueCommentId}
    />
  );
}

function ReviewOverviewPane({
  kind,
  title,
  branchLabel,
  baseBranch,
  fileCount,
  additions,
  deletions,
  commitCount,
  updatedAt,
  htmlUrl,
  lifecycle,
  summaryMarkdown,
  summaryFallback,
  onOpenExternal,
}: {
  kind: 'branch' | 'pr' | 'review';
  title?: string | null;
  branchLabel?: string | null;
  baseBranch?: string | null;
  fileCount?: number | null;
  additions?: number | null;
  deletions?: number | null;
  commitCount?: number | null;
  updatedAt?: string | null;
  htmlUrl?: string | null;
  lifecycle: ReviewShellLifecycle;
  summaryMarkdown?: string | null;
  summaryFallback?: string | null;
  onOpenExternal?: ((url: string) => void) | null;
}) {
  const heading = lifecycle === 'failed'
    ? `Review failed for ${kind === 'pr' ? 'pull request' : kind === 'branch' ? 'branch' : 'changes'}`
    : lifecycle === 'running'
    ? `Reviewing ${kind === 'pr' ? 'pull request' : kind === 'branch' ? 'branch' : 'changes'}`
    : kind === 'pr'
      ? 'Pull request summary'
      : kind === 'branch'
        ? 'Branch commit summary'
        : 'Review summary';
  const description = lifecycle === 'failed'
    ? 'The review did not complete. The scope summary is still available here; retry from the review panel when ready.'
    : lifecycle === 'running'
    ? 'Atlas is analyzing this review. Use this metadata while the review runs; the full changed-file browser is available in Files.'
    : 'Scope and recent commits for this review. Open the Files tab to browse changed files.';
  const subject = kind === 'pr' ? 'Pull request' : kind === 'branch' ? 'Branch' : 'Review';
  const changeParts = [
    typeof fileCount === 'number' && fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : null,
    typeof additions === 'number' && additions > 0 ? `+${additions}` : null,
    typeof deletions === 'number' && deletions > 0 ? `-${deletions}` : null,
    typeof commitCount === 'number' && commitCount > 0 ? `${commitCount} commit${commitCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const renderedMarkdown = String(summaryMarkdown || '').trim();
  const fallbackText = String(summaryFallback || '').trim();

  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      padding: '36px 52px',
      background: 'var(--review-panel-bg)',
    }}>
      <div style={{
        width: 'min(860px, 100%)',
        margin: '0 auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 760, color: 'var(--text-primary)', letterSpacing: -0.5 }}>
              {heading}
            </h1>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.65, marginTop: 10, maxWidth: 720 }}>
              {description}
            </div>
          </div>
          {htmlUrl && onOpenExternal && (
            <button
              type="button"
              onClick={() => onOpenExternal(htmlUrl)}
              style={{
                border: '1px solid var(--review-shell-divider)',
                borderRadius: 6,
                background: 'var(--review-panel-header-bg)',
                color: 'var(--text-secondary)',
                fontWeight: 650,
                fontSize: 12,
                padding: '7px 10px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Open on GitHub
            </button>
          )}
        </div>

        <div style={{
          display: 'grid',
          gap: 10,
          marginBottom: 26,
          padding: '14px 0',
          borderTop: '1px solid var(--review-shell-divider)',
          borderBottom: '1px solid var(--review-shell-divider)',
        }}>
          {title && (
            <OverviewRow label={subject} value={title} />
          )}
          {(branchLabel || baseBranch) && (
            <OverviewRow
              label="Scope"
              value={(
                <>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{branchLabel || 'changes'}</span>
                  {baseBranch && (
                    <>
                      <span style={{ color: 'var(--text-tertiary)' }}> &rarr; </span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{formatBaseBranchLabel(baseBranch)}</span>
                    </>
                  )}
                </>
              )}
            />
          )}
          {changeParts.length > 0 && (
            <OverviewRow label="Changes" value={changeParts.join(' · ')} />
          )}
          {updatedAt && (
            <OverviewRow label="Updated" value={relativeTimeLabel(updatedAt)} />
          )}
        </div>

        {renderedMarkdown ? (
          <ReviewOverviewMarkdown markdown={renderedMarkdown} onOpenExternal={onOpenExternal} />
        ) : (
          <div style={{
            border: '1px dashed var(--review-shell-divider)',
            borderRadius: 8,
            padding: 18,
            color: 'var(--text-secondary)',
            fontSize: 13,
            lineHeight: 1.65,
            background: 'var(--review-panel-alt-bg)',
          }}>
            {fallbackText || 'No summary metadata is available for this review yet.'}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewOverviewMarkdown({
  markdown,
  onOpenExternal,
}: {
  markdown: string;
  onOpenExternal?: ((url: string) => void) | null;
}) {
  const normalizedMarkdown = normalizeReviewOverviewMarkdown(markdown);

  return (
    <div
      className="pr-summary-markdown"
      style={{
        color: 'var(--text-primary)',
        fontSize: 14,
        lineHeight: 1.72,
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
                if (href && onOpenExternal) onOpenExternal(href);
              }}
              style={{ color: 'var(--accent-blue)', textDecoration: 'none', cursor: 'pointer' }}
            >
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h1 style={{ fontSize: 22, lineHeight: 1.25, margin: '0 0 14px', paddingBottom: 10, borderBottom: '1px solid var(--review-shell-divider)' }}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontSize: 19, lineHeight: 1.3, margin: '28px 0 12px', paddingBottom: 8, borderBottom: '1px solid var(--review-shell-divider)' }}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontSize: 15, lineHeight: 1.35, margin: '22px 0 10px' }}>
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p style={{ margin: '0 0 13px', color: 'var(--text-primary)' }}>
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul style={{ margin: '0 0 18px', paddingLeft: 24 }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: '0 0 18px', paddingLeft: 24 }}>
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li style={{ marginBottom: 7, paddingLeft: 2 }}>
              {children}
            </li>
          ),
          code: ({ children }) => (
            <code style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.92em',
              background: 'var(--review-panel-alt-bg)',
              border: '1px solid var(--review-shell-divider)',
              borderRadius: 4,
              padding: '1px 5px',
            }}>
              {children}
            </code>
          ),
          blockquote: ({ children }) => (
            <blockquote style={{
              margin: '0 0 16px',
              padding: '0 0 0 14px',
              borderLeft: '3px solid var(--review-shell-divider)',
              color: 'var(--text-secondary)',
            }}>
              {children}
            </blockquote>
          ),
        }}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}

function normalizeReviewOverviewMarkdown(markdown: string): string {
  return markdown.replace(
    /<!--\s*stage-review-badge-begin\s*-->([\s\S]*?)<!--\s*stage-review-badge-end\s*-->/gi,
    (_match, badgeHtml: string) => {
      const href = extractHtmlHref(badgeHtml);
      const safeHref = href ? sanitizeMarkdownHttpHref(href) : null;
      return safeHref ? `[Open in Stage](${safeHref})` : '';
    },
  );
}

function extractHtmlHref(html: string): string | null {
  const match = html.match(/<a\b[^>]*\bhref=(["'])(.*?)\1/i);
  return match?.[2] ? decodeHtmlAttribute(match[2]) : null;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function sanitizeMarkdownHttpHref(href: string): string | null {
  const trimmed = href.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return trimmed.replace(/[\u0000-\u001F\u007F\s()[\]<>]/g, (char) => encodeURIComponent(char));
}

function OverviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr', gap: 12, alignItems: 'baseline' }}>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-tertiary)', fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, minWidth: 0 }}>
        {value}
      </div>
    </div>
  );
}

function FindingCodePlaceholder({ hasFindings }: { hasFindings: boolean }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-6)' }}>
      <div style={{ maxWidth: 420, textAlign: 'center', color: 'var(--text-tertiary)' }}>
        <div style={{ color: 'var(--text-primary)', fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 'var(--space-2)' }}>
          {hasFindings ? 'Select a finding to view code context' : 'No findings to inspect'}
        </div>
        <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          {hasFindings
            ? 'The Findings tab only shows code for the selected AI finding. Use Files to browse the full diff.'
            : 'This review has no actionable findings. Use Files to browse the changed files.'}
        </div>
      </div>
    </div>
  );
}

function FindingDetailsPane({
  finding,
  reason,
}: {
  finding: ReviewRecommendation;
  reason?: string | null;
}) {
  const severity = normalizeRecommendationSeverity(finding);
  const sevLevel = severity === 'critical' || severity === 'high'
    ? 'HIGH'
    : severity === 'medium'
      ? 'MED'
      : 'LOW';
  const sourceLocation = formatRecommendationSourceLocation(finding);
  const displayLocation = formatRecommendationDisplayLocation(finding) || sourceLocation;
  const description = sanitizeRecommendationDescription(finding.description) || finding.description || '';
  const snippet = String(finding.targetSnippet || finding.evidenceSnippet || finding.sourceAnchor?.snippet || '').trim();
  const suggestedFix = String(finding.suggestedFix || '').trim();

  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      padding: 'var(--space-5)',
      background: 'var(--review-panel-bg)',
    }}>
      <div style={{
        maxWidth: 760,
        margin: '0 auto',
        display: 'grid',
        gap: 'var(--space-3)',
      }}>
        <div style={{
          border: '1px solid var(--review-shell-divider)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--review-panel-alt-bg)',
          padding: 'var(--space-4)',
          boxShadow: 'var(--review-card-shadow)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {finding.findingId && (
              <span style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-tertiary)',
                padding: '2px 6px',
                borderRadius: 4,
                background: 'var(--review-chip-neutral-bg)',
                border: '1px solid var(--review-chip-neutral-border)',
              }}>
                {finding.findingId}
              </span>
            )}
            <SevChip level={sevLevel} />
            {suggestedFix && (
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                color: 'var(--accent-blue)',
                padding: '2px 6px',
                borderRadius: 4,
                background: 'color-mix(in oklab, var(--accent-blue) 14%, transparent)',
                border: '1px solid color-mix(in oklab, var(--accent-blue) 30%, transparent)',
              }}>
                Proposed fix
              </span>
            )}
          </div>

          <div style={{
            fontSize: 16,
            lineHeight: 1.35,
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginBottom: 8,
          }}>
            {finding.title}
          </div>

          {displayLocation && (
            <div style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--accent-blue)',
              marginBottom: reason ? 10 : 14,
              overflowWrap: 'anywhere',
            }}>
              Anchor: {displayLocation}
            </div>
          )}

          {reason && (
            <div style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              lineHeight: 1.5,
              marginBottom: 14,
            }}>
              {reason}
            </div>
          )}

          {description && (
            <DetailBlock title="Finding">
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {description}
              </div>
            </DetailBlock>
          )}

          {snippet && (
            <DetailBlock title="Evidence">
              <DetailsCodeBlock code={snippet} />
            </DetailBlock>
          )}

          {suggestedFix && (
            <DetailBlock title="Suggested fix">
              <DetailsCodeBlock code={suggestedFix} copyable />
            </DetailBlock>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
      <div style={{
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

const detailsCodeBlockStyle = {
  margin: 0,
  padding: 10,
  borderRadius: 6,
  border: '1px solid var(--border-muted)',
  background: 'var(--review-code-bg)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const;

const DETAILS_TOKEN_VAR: Record<'keyword' | 'string' | 'comment' | 'number', string> = {
  keyword: 'var(--diff-token-keyword)',
  string: 'var(--diff-token-string)',
  comment: 'var(--diff-token-comment)',
  number: 'var(--diff-token-number)',
};

function DetailsCodeBlock({ code, copyable = false }: { code: string; copyable?: boolean }) {
  const lines = String(code || '').split(/\r?\n/);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  return (
    <div style={{ position: 'relative' }}>
      <pre style={{
        ...detailsCodeBlockStyle,
        paddingBottom: copyable ? 38 : detailsCodeBlockStyle.padding,
      }}>
        {lines.map((line, lineIndex) => {
          const tokens = tokenize(line);
          return (
            <div key={lineIndex} style={{ minHeight: '1.55em' }}>
              {tokens.map((token, tokenIndex) => (
                <span
                  key={tokenIndex}
                  data-token={token.token || undefined}
                  style={{ color: token.token ? DETAILS_TOKEN_VAR[token.token] : undefined }}
                >
                  {token.text}
                </span>
              ))}
            </div>
          );
        })}
      </pre>
      {copyable && (
        <button
          type="button"
          aria-label="Copy suggested fix"
          title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy suggested fix'}
          onClick={async () => {
            const copied = await copyTextToClipboard(code);
            setCopyState(copied ? 'copied' : 'failed');
          }}
          style={{
            position: 'absolute',
            right: 8,
            bottom: 8,
            width: 26,
            height: 24,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 5,
            border: '1px solid var(--border-muted)',
            background: 'var(--bg-surface-raised)',
            color: copyState === 'copied'
              ? 'var(--sev-ok)'
              : copyState === 'failed'
                ? 'var(--sev-high)'
                : 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          {copyState === 'copied' ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="3 8 6 11 13 4" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="5" y="5" width="9" height="9" rx="1.5" />
              <path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}

function relativeTimeLabel(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'Unknown';
  const diff = Math.max(0, Date.now() - then);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function shortCommitSha(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed.slice(0, 7) : null;
}

function buildBranchCommitSummaryMarkdown(commits: ReviewCommitSummary[] | null | undefined): string {
  const visibleCommits = Array.isArray(commits)
    ? commits
      .map((commit) => ({
        ...commit,
        message: String(commit?.message || '').trim(),
      }))
      .filter((commit) => commit.message.length > 0)
    : [];

  if (visibleCommits.length === 0) return '';

  const lines = ['## Commit messages', ''];
  for (const commit of visibleCommits.slice(0, 30)) {
    const sha = shortCommitSha(commit.hash);
    const author = String(commit.author || '').trim();
    const dateLabel = commit.date ? relativeTimeLabel(commit.date) : null;
    const meta = [sha ? `\`${sha}\`` : null, author ? escapeMarkdownText(author) : null, dateLabel].filter(Boolean);
    lines.push(`- ${escapeMarkdownText(commit.message)}${meta.length > 0 ? ` _${meta.join(' · ')}_` : ''}`);
  }
  if (visibleCommits.length > 30) {
    lines.push(`- _${visibleCommits.length - 30} more commit${visibleCommits.length - 30 === 1 ? '' : 's'} not shown_`);
  }
  return lines.join('\n');
}

function maxLeftWidthForTwoPaneContainer(containerWidth: number, centerPanelMinWidth: number = CENTER_PANEL_MIN_WIDTH): number {
  const safeWidth = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 1440;
  return Math.max(LEFT_PANEL_MIN_WIDTH, safeWidth - PANEL_RESIZE_HANDLE_WIDTH - centerPanelMinWidth);
}

function maxLeftWidthForReviewContainer(
  containerWidth: number,
  assistantOpen: boolean,
  assistantWidth: number,
  centerPanelMinWidth: number = CENTER_PANEL_MIN_WIDTH
): number {
  const safeWidth = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 1440;
  const assistantSpace = assistantOpen ? PANEL_RESIZE_HANDLE_WIDTH + assistantWidth : 0;
  return Math.max(LEFT_PANEL_MIN_WIDTH, safeWidth - PANEL_RESIZE_HANDLE_WIDTH - assistantSpace - centerPanelMinWidth);
}

function maxAssistantWidthForReviewContainer(
  containerWidth: number,
  leftPaneWidth: number,
  centerPanelMinWidth: number = CENTER_PANEL_MIN_WIDTH
): number {
  const safeWidth = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 1440;
  const available = safeWidth - leftPaneWidth - (PANEL_RESIZE_HANDLE_WIDTH * 2) - centerPanelMinWidth;
  return Math.max(REVIEW_AGENT_MIN_WIDTH, Math.min(REVIEW_AGENT_MAX_WIDTH, available));
}

function getDefaultPanelWidths(viewportWidth: number) {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1440;

  const leftWidth = clampWidth(
    LEFT_PANEL_DEFAULT_WIDTH,
    LEFT_PANEL_MIN_WIDTH,
    maxLeftWidthForTwoPaneContainer(safeViewport, CENTER_PANEL_MIN_WIDTH)
  );

  const rightWidth = clampWidth(
    REVIEW_AGENT_DEFAULT_WIDTH,
    REVIEW_AGENT_MIN_WIDTH,
    maxAssistantWidthForReviewContainer(safeViewport, leftWidth, CENTER_PANEL_MIN_WIDTH)
  );

  return { leftWidth, rightWidth };
}

function getInitialPanelWidths(viewportWidth: number) {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1440;
  const defaults = getDefaultPanelWidths(safeViewport);
  const stored = loadPanelWidths(TRUST_REVIEW_PANEL_WIDTHS_STORAGE_KEY);
  if (!stored) return defaults;

  const leftWidth = clampWidth(
    Number(stored.leftWidth),
    LEFT_PANEL_MIN_WIDTH,
    maxLeftWidthForTwoPaneContainer(safeViewport, CENTER_PANEL_MIN_WIDTH)
  );
  const rightWidth = clampWidth(
    Number(stored.rightWidth ?? defaults.rightWidth),
    REVIEW_AGENT_MIN_WIDTH,
    maxAssistantWidthForReviewContainer(safeViewport, leftWidth, CENTER_PANEL_MIN_WIDTH)
  );

  return { leftWidth, rightWidth };
}

// Locally tick the elapsed counter between server heartbeats so the
// running review doesn't appear frozen when the backend only emits
// progress on sparse events (e.g. Claude agentic exploration before
// the first tool_use). Resets/resyncs whenever the server value
// changes or the run stops.
function useTickingElapsedSeconds(serverSeconds: number | null | undefined, isRunning: boolean): number {
  const safeServer = Math.max(0, Math.floor(Number(serverSeconds) || 0));
  const [displayElapsed, setDisplayElapsed] = useState(safeServer);
  const lastServerRef = useRef(safeServer);
  const wasRunningRef = useRef(false);

  useEffect(() => {
    if (safeServer !== lastServerRef.current) {
      const wentBackward = safeServer < lastServerRef.current;
      lastServerRef.current = safeServer;
      setDisplayElapsed((prev) => (wentBackward ? safeServer : Math.max(prev, safeServer)));
    }
  }, [safeServer]);

  useEffect(() => {
    const started = isRunning && !wasRunningRef.current;
    const stopped = !isRunning && wasRunningRef.current;
    wasRunningRef.current = isRunning;
    // On both start and stop transitions, snap to the server value:
    // start so we ignore stale ticks from a previous run; stop so the
    // local ticker that ran ahead of the final heartbeat doesn't leave
    // a permanently inflated duration on the completed review.
    if (!started && !stopped) return;
    setDisplayElapsed(safeServer);
    lastServerRef.current = safeServer;
  }, [isRunning, safeServer]);

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => {
      setDisplayElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  return displayElapsed;
}

interface TrustReviewViewProps {
  projectId: string;
  activeProviderLabel?: string | null;
  onBack: () => void;
  onShowShortcuts?: () => void;
  onOpenGlobalSettingsSection?: (section: 'github' | 'cloud') => void;
  refreshKey?: number;
  /**
   * When provided (Phase 07 ProjectHome handoff), the review view opens
   * directly on this selection instead of waiting for the user to pick
   * from the legacy sidebar. Pass `null` (or omit) to preserve the
   * no-selection placeholder behavior.
   */
  initialSelectedItem?: { id: string; type: 'branch_review' | 'pr_review' | 'workspace_review' } | null;
  initialBaseBranchName?: string | null;
}

function TrustReviewView({
  projectId,
  activeProviderLabel = null,
  onBack,
  onShowShortcuts,
  onOpenGlobalSettingsSection,
  refreshKey,
  initialSelectedItem = null,
  initialBaseBranchName = null,
}: TrustReviewViewProps) {
  const popup = usePopup();
  const [project, setProject] = useState<Project | null>(null);
  const [showAgentInstructionsModal, setShowAgentInstructionsModal] = useState(false);
  const [showProjectNotesModal, setShowProjectNotesModal] = useState(false);
  const [showPrivateNotesModal, setShowPrivateNotesModal] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [gitRepoSlug, setGitRepoSlug] = useState<string | null>(null);
  const branchRef = useRef<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<SelectedItem>(initialSelectedItem ?? null);
  const [activeChangeGroupFilter, setActiveChangeGroupFilter] = useState<ChangeGroupFileFilter>(null);
  // Visible-file cap override for the currently selected review. `undefined`
  // means "use backend default (200)"; the user can extend it via the
  // FileTreeList's "Show 50 more files" footer or TrustDiffViewer's
  // "Load all files" link. Resets when the selected review changes.
  const [reviewVisibleFileLimit, setReviewVisibleFileLimit] = useState<number | undefined>(undefined);
  const [isProjectMetaLoading, setIsProjectMetaLoading] = useState(true);
  const [isReviewListInitialLoading, setIsReviewListInitialLoading] = useState(true);
  const [isWithinInitialProjectLoadGrace, setIsWithinInitialProjectLoadGrace] = useState(true);

  // Branch auto-review toggle state
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(false);

  // Branch banner state
  const [branchBanner, setBranchBanner] = useState<{
    type: 'topic' | 'no-changes' | 'detached';
    branchName?: string;
    baseBranch?: string;
    baseBranchSource?: BranchReview['baseBranchSource'] | null;
    fileCount?: number;
    headSha?: string | null;
    commitCount?: number;
    updatedAt?: string | null;
    branchReviewId?: string;
  } | null>(null);
  const [baseLastCommitPreview, setBaseLastCommitPreview] = useState<LastCommitPreview | null>(null);
  const [baseLastCommitPreviewLoading, setBaseLastCommitPreviewLoading] = useState(false);
  const [baseLastCommitPreviewError, setBaseLastCommitPreviewError] = useState<string | null>(null);
  const [selectedPrReview, setSelectedPrReview] = useState<PrReview | null>(null);
  const [selectedPrReviewLoading, setSelectedPrReviewLoading] = useState(initialSelectedItem?.type === 'pr_review');
  const [prSyncInProgress, setPrSyncInProgress] = useState(false);
  const [prAccessDenied, setPrAccessDenied] = useState(false);

  const [latestBranchSnapshotsById, setLatestBranchSnapshotsById] = useState<Record<string, BranchSnapshotState>>({});
  const [loadedBranchSnapshotsById, setLoadedBranchSnapshotsById] = useState<Record<string, BranchSnapshotState>>({});
  const [branchRefreshTokenById, setBranchRefreshTokenById] = useState<Record<string, number>>({});
  const [brRefreshKey, setBrRefreshKey] = useState(0);
  const [prRefreshKey, setPrRefreshKey] = useState(0);
  const [refreshingBranchReviewId, setRefreshingBranchReviewId] = useState<string | null>(null);
  const refreshFallbackTimerRef = useRef<number | null>(null);
  const initialProjectLoadGraceTimerRef = useRef<number | null>(null);
  const [bannerReviewBusyById, setBannerReviewBusyById] = useState<Record<string, boolean>>({});
  const bannerReviewBusyTimeoutsRef = useRef<Record<string, number>>({});

  // Change base branch state
  const [showBranchSelector, setShowBranchSelector] = useState(false);
  const [availableBranches, setAvailableBranches] = useState<Array<{ name: string; current: boolean }>>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [changingBaseBranch, setChangingBaseBranch] = useState<string | null>(null);
  const branchSelectorRef = useRef<HTMLDivElement>(null);
  const [branchReviewScopeByKey, setBranchReviewScopeByKey] = useState<Record<string, BranchReviewDiffScope>>({});
  const baseChangeReviewBusyRef = useRef(false);
  const baseLastCommitMaterializedRef = useRef<string | null>(null);
  const featureLastCommitScopeRepairRef = useRef<string | null>(null);

  // Direction C shell mode: Findings | Walkthrough | Files.
  const [reviewShellMode, setReviewShellMode] = useState<ReviewShellMode>('findings');
  const [reviewDiffViewMode, setReviewDiffViewModeState] = useState<ReviewDiffViewMode>(readStoredReviewDiffViewMode);
  const setReviewDiffViewMode = useCallback((mode: ReviewDiffViewMode) => {
    setReviewDiffViewModeState(mode);
    persistReviewDiffViewMode(mode);
  }, []);
  const toggleReviewDiffViewMode = useCallback(() => {
    setReviewDiffViewModeState((current) => {
      const next = current === 'unified' ? 'split' : 'unified';
      persistReviewDiffViewMode(next);
      return next;
    });
  }, []);
  const [filesModeActivePath, setFilesModeActivePath] = useState<string | null>(null);
  const [walkthroughGenerationSignal, setWalkthroughGenerationSignal] = useState<WalkthroughGenerationSignal>({ id: 0, force: false });
  const [walkthroughGenerationActive, setWalkthroughGenerationActive] = useState(false);
  const [standaloneWalkthroughCount, setStandaloneWalkthroughCount] = useState<number | null>(null);
  const walkthroughStopRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    setFilesModeActivePath(null);
  }, [selectedItem?.id, selectedItem?.type, reviewShellMode]);

  const triggerWalkthroughGeneration = useCallback((force = false, options: { interactive?: boolean } = {}) => {
    setWalkthroughGenerationSignal((current) => ({
      id: current.id + 1,
      force,
      ...(options.interactive ? { interactive: true } : {}),
    }));
  }, []);
  useEffect(() => {
    setWalkthroughGenerationActive(false);
    walkthroughStopRef.current = null;
  }, [selectedItem?.id, selectedItem?.type]);

  // Fetch the selected branch / workspace review's reviewJson so the shell
  // top bar can render real severity counts. PR reviews already carry
  // reviewJson on `selectedPrReview` so they don't need a parallel fetch.
  // Without this, completed branches always rendered as 0 high / 0 med /
  // 0 low and labelled "Clean" even when the findings panel had issues.
  const [selectedBranchReviewJson, setSelectedBranchReviewJson] = useState<ReviewResult | null>(null);
  const [selectedBranchReviewDetails, setSelectedBranchReviewDetails] = useState<BranchReviewWithCommits | null>(null);
  useEffect(() => {
    if (!selectedItem) {
      setSelectedBranchReviewJson(null);
      setSelectedBranchReviewDetails(null);
      return;
    }
    if (selectedItem.type === 'pr_review') {
      // PR review JSON lives on selectedPrReview already.
      setSelectedBranchReviewJson(null);
      setSelectedBranchReviewDetails(null);
      return;
    }
    setSelectedBranchReviewJson(null);
    setSelectedBranchReviewDetails(null);
    let cancelled = false;
    (async () => {
      try {
        if (selectedItem.type === 'branch_review') {
          const res = await branchReviewApi.get(projectId, selectedItem.id);
          if (cancelled) return;
          setSelectedBranchReviewJson((res.branchReview as { reviewJson?: ReviewResult | null })?.reviewJson ?? null);
          setSelectedBranchReviewDetails(res.branchReview as BranchReviewWithCommits);
        } else if (selectedItem.type === 'workspace_review') {
          const res = await workspaceReviewApi.get(projectId, selectedItem.id);
          if (cancelled) return;
          setSelectedBranchReviewJson((res.workspaceReview as { reviewJson?: ReviewResult | null })?.reviewJson ?? null);
          setSelectedBranchReviewDetails(null);
        }
      } catch {
        if (!cancelled) {
          setSelectedBranchReviewJson(null);
          setSelectedBranchReviewDetails(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedItem, projectId, branchRefreshTokenById[selectedItem?.id || '']]);
  const [submitPopoverOpen, setSubmitPopoverOpen] = useState(false);
  const [submitPopoverFocusRequest, setSubmitPopoverFocusRequest] = useState(0);
  const [isReviewAgentOpen, setIsReviewAgentOpen] = useState(false);
  const [reviewAgentExtraAttachments, setReviewAgentExtraAttachments] = useState<ReviewAgentAttachment[]>([]);
  const [reviewAgentDraftRequest, setReviewAgentDraftRequest] = useState<{ id: string; text: string } | null>(null);
  const [prReviewActionById, setPrReviewActionById] = useState<Record<string, SubmitAction | null>>({});

  const handleCloseAgentInstructionsModal = useCallback(() => {
    setShowAgentInstructionsModal(false);
  }, []);

  // Keep a ref to the current selectedItem for use in socket callbacks (avoids stale closures)
  const selectedItemRef = useRef<SelectedItem>(initialSelectedItem ?? null);
  const selectedItemSourceRef = useRef<ReviewSelectionSource>(initialSelectedItem ? 'explicit' : 'auto');

  // Sync ref whenever state changes
  useEffect(() => {
    selectedItemRef.current = selectedItem;
  }, [selectedItem]);

  useEffect(() => {
    branchRef.current = branch;
  }, [branch]);

  useEffect(() => {
    if (selectedItem?.type !== 'pr_review') {
      setSelectedPrReview(null);
      setSelectedPrReviewLoading(false);
      return;
    }

    let cancelled = false;
    setSelectedPrReviewLoading(true);

    void prReviewApi.get(projectId, selectedItem.id)
      .then((response) => {
        if (cancelled) return;
        setSelectedPrReview(response.prReview);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to load selected PR review metadata:', error);
        setSelectedPrReview(null);
      })
      .finally(() => {
        if (cancelled) return;
        setSelectedPrReviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, selectedItem, prRefreshKey]);

  // Phase 07: selection is handed off via `initialSelectedItem` from
  // ProjectHome and consumed by `useState` on mount. TrustPipelineShell
  // unmounts this component whenever projectId or projectView changes,
  // so a prop-driven reset effect is redundant — and its StrictMode
  // double-invocation was wiping the initial selection.

  const resetSelectionForBranchSwitch = useCallback(() => {
    selectedItemRef.current = null;
    selectedItemSourceRef.current = 'auto';
    setSelectedItem(null);
    setSelectedPrReview(null);
    setSelectedPrReviewLoading(false);
    setActiveChangeGroupFilter(null);
  }, []);

  // Refresh key for child list component (incremented when socket events arrive)
  const [brProgressById, setBrProgressById] = useState<Record<string, BranchReviewProgress>>(
    () => readRunningProgressCache(projectId)
  );
  const [runningReviewModelConfig, setRunningReviewModelConfig] = useState<ReviewModelConfig | null>(null);
  const [runningReviewProviderModelLabel, setRunningReviewProviderModelLabel] = useState<string | null>(null);
  const brProgressByIdRef = useRef(brProgressById);
  brProgressByIdRef.current = brProgressById;
  const [brQueuedRerunById, setBrQueuedRerunById] = useState<Record<string, QueuedBranchReviewRun>>({});
  const [cancellingQueuedReviewById, setCancellingQueuedReviewById] = useState<Record<string, boolean>>({});
  const activeProgressCount = Object.keys(brProgressById).length;
  const progressBufferRef = useRef<Record<string, BranchReviewProgress>>({});
  const progressFlushTimerRef = useRef<number | null>(null);
  const recentTopicSwitchAtRef = useRef(0);
  const projectLoadPrSyncPopupShownRef = useRef(false);
  const projectLoadPrSyncSettledRef = useRef(false);

  useEffect(() => {
    setBrProgressById(readRunningProgressCache(projectId));
    setBrQueuedRerunById({});
    setCancellingQueuedReviewById({});
    progressBufferRef.current = {};
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const loadReviewModelConfig = () => {
      settingsApi.getReviewModelConfig()
        .then((config) => {
          if (!cancelled) setRunningReviewModelConfig(config);
        })
        .catch(() => {
          if (!cancelled) setRunningReviewModelConfig(null);
        });
    };
    loadReviewModelConfig();
    const handleReviewModelConfigChanged = (event: Event) => {
      const nextConfig = (event as CustomEvent<ReviewModelConfig>).detail;
      if (nextConfig && typeof nextConfig === 'object') {
        setRunningReviewModelConfig(nextConfig);
        return;
      }
      loadReviewModelConfig();
    };
    window.addEventListener('provider-changed', loadReviewModelConfig);
    window.addEventListener('review-provider-changed', loadReviewModelConfig);
    window.addEventListener('review-model-config-changed', handleReviewModelConfigChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('provider-changed', loadReviewModelConfig);
      window.removeEventListener('review-provider-changed', loadReviewModelConfig);
      window.removeEventListener('review-model-config-changed', handleReviewModelConfigChanged);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadReviewProviderModelLabel = async () => {
      try {
        const [providerList, contextActive, providerConfigs] = await Promise.all([
          providerApi.list(),
          providerApi.getContextActive('review'),
          providerApi.getConfigs().catch(() => ({ success: false, configs: [] })),
        ]);
        if (cancelled) return;
        const selectedProvider = pickShellProvider(
          providerList.providers || [],
          contextActive.data?.providerId || null,
          providerList.activeProvider || null,
        );
        const modelLabel = selectedProvider
          ? formatProviderModelBadgeLabel(
            selectedProvider,
            contextActive.data?.model || selectedProvider.model,
            providerConfigs.configs || [],
          )
          : null;
        setRunningReviewProviderModelLabel(modelLabel);
      } catch {
        if (!cancelled) setRunningReviewProviderModelLabel(null);
      }
    };
    loadReviewProviderModelLabel();
    window.addEventListener('provider-changed', loadReviewProviderModelLabel);
    window.addEventListener('review-provider-changed', loadReviewProviderModelLabel);
    return () => {
      cancelled = true;
      window.removeEventListener('provider-changed', loadReviewProviderModelLabel);
      window.removeEventListener('review-provider-changed', loadReviewProviderModelLabel);
    };
  }, []);

  useEffect(() => {
    writeRunningProgressCache(projectId, brProgressById);
  }, [projectId, brProgressById]);

  useEffect(() => {
    const selectedReviewId = selectedItem?.id || null;
    if (!selectedReviewId) return;
    let cancelled = false;

    const hydrateRunningProgress = async () => {
      try {
        const response = await reviewApi.getQueue();
        if (cancelled) return;
        const matchingEntries = (response.queue || []).filter((entry) => (
          entry.branchReviewId === selectedReviewId
          || entry.prReviewId === selectedReviewId
          || entry.workspaceReviewId === selectedReviewId
        ));
        const matchingRunningEntry = matchingEntries.find((entry) => {
          const status = normalizeLifecycleStatusValue(entry.lifecycle?.status || entry.status || 'queued', 'queued');
          return status !== 'queued' && isActiveLifecycleStatus(status);
        }) || null;
        const matchingQueuedEntry = matchingEntries.find((entry) => {
          const status = normalizeLifecycleStatusValue(entry.lifecycle?.status || entry.status || 'queued', 'queued');
          return status === 'queued';
        }) || null;
        if (!matchingRunningEntry && !matchingQueuedEntry) {
          setBrProgressById((prev) => {
            if (!prev[selectedReviewId]) return prev;
            const next = { ...prev };
            delete next[selectedReviewId];
            return next;
          });
          setBrQueuedRerunById((prev) => {
            if (!prev[selectedReviewId]) return prev;
            const next = { ...prev };
            delete next[selectedReviewId];
            return next;
          });
          delete progressBufferRef.current[selectedReviewId];
          return;
        }
        const lifecycleStatus = normalizeLifecycleStatusValue(
          matchingRunningEntry?.lifecycle?.status
            || matchingRunningEntry?.status
            || matchingQueuedEntry?.lifecycle?.status
            || matchingQueuedEntry?.status
            || 'queued',
          'queued'
        );
        if (!isActiveLifecycleStatus(lifecycleStatus) && !matchingQueuedEntry) {
          setBrProgressById((prev) => {
            if (!prev[selectedReviewId]) return prev;
            const next = { ...prev };
            delete next[selectedReviewId];
            return next;
          });
          delete progressBufferRef.current[selectedReviewId];
          return;
        }
        const runningHeadSha = getQueueEntrySnapshotHeadSha(matchingRunningEntry);
        const queuedHeadSha = getQueueEntrySnapshotHeadSha(matchingQueuedEntry);
        const queuedMatchesRunningHead = Boolean(runningHeadSha && queuedHeadSha && runningHeadSha === queuedHeadSha);
        const queuedRun = matchingQueuedEntry && matchingRunningEntry && !queuedMatchesRunningHead
          ? buildQueuedBranchReviewRunFromEntry(matchingQueuedEntry)
          : null;
        setBrQueuedRerunById((prev) => {
          if (!queuedRun) {
            if (!prev[selectedReviewId]) return prev;
            const next = { ...prev };
            delete next[selectedReviewId];
            return next;
          }
          return { ...prev, [selectedReviewId]: queuedRun };
        });
        const primaryEntry = matchingRunningEntry || matchingQueuedEntry;
        const queueProgress = normalizeProgressCandidate({
          ...(primaryEntry?.progress || {}),
          queueId: primaryEntry?.id || null,
          phase: primaryEntry?.progress?.phase || lifecycleStatus,
          updatedAt: primaryEntry?.progress?.updatedAt || primaryEntry?.updatedAt || primaryEntry?.queuedAt,
        });
        if (!queueProgress) return;
        setBrProgressById((prev) => {
          const existing = prev[selectedReviewId];
          const merged = mergeBranchReviewProgress(existing, queueProgress);
          if (isSameBranchReviewProgress(existing, merged)) return prev;
          return { ...prev, [selectedReviewId]: merged };
        });
      } catch {
        // Best-effort only; the socket path will still update progress.
      }
    };

    void hydrateRunningProgress();
    return () => {
      cancelled = true;
    };
  }, [selectedItem?.id]);

  // Reset the per-review visible-file cap whenever the user switches reviews.
  useEffect(() => {
    setReviewVisibleFileLimit(undefined);
  }, [selectedItem?.id, selectedItem?.type]);

  const handleLoadMoreReviewFiles = useCallback((currentVisibleCount: number, increment: number = 50) => {
    // Base the next limit on the server-confirmed visible count rather than a
    // hard-coded 200. The backend's default cap is configurable via
    // ATLAS_VISIBLE_REVIEW_FILE_LIMIT — assuming 200 made early "show more"
    // clicks send limits below the real default, which the backend then
    // clamped back, leaving the footer apparently stuck.
    const safeCurrent = Number.isFinite(currentVisibleCount) && currentVisibleCount > 0
      ? Math.floor(currentVisibleCount)
      : 200;
    const safeIncrement = Math.max(1, Math.floor(increment));
    setReviewVisibleFileLimit((prev) => Math.max(prev ?? 0, safeCurrent) + safeIncrement);
  }, []);

  const buildGitHubRepoAccessDeniedToast = useCallback(async (data: {
    error?: string | null;
    code?: string | null;
    connectedLogin?: string | null;
    owner?: string | null;
    repo?: string | null;
  }): Promise<{ title: string; description: string; popupMessage: ReactNode }> => {
    let preferredLogin = String(data?.connectedLogin || '').trim() || null;
    try {
      const installations = await githubApi.getInstallations();
      const preferred = installations.find((entry) => entry.accountType === 'User' && entry.isActive)
        || installations.find((entry) => entry.accountType === 'User')
        || installations.find((entry) => entry.isActive)
        || installations[0]
        || null;
      if (preferred?.accountLogin) {
        preferredLogin = preferred.accountLogin;
      }
    } catch {
      // Ignore account lookup failures and fall back to the payload.
    }

    const explicitRepoLabel = data?.owner && data?.repo
      ? `${data.owner}/${data.repo}`
      : null;
    const parsedRepoLabel = extractRepoLabelFromAccessError(data?.error);
    const repoLabel = explicitRepoLabel || parsedRepoLabel || 'this repository';
    const accountLabel = preferredLogin || 'this GitHub account';
    return {
      title: 'GitHub access required',
      description: preferredLogin
        ? `Connected as ${preferredLogin}\nNo pull request access for ${repoLabel}\nReconnect with an account that has repo access, or grant the Atlas GitHub App access to this repository.`
        : `No pull request access for ${repoLabel}\nReconnect with an account that has repo access, or grant the Atlas GitHub App access to this repository.`,
      popupMessage: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ color: 'var(--text-secondary)' }}>
            You are connected as{' '}
            <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
              {accountLabel}
            </span>
          </div>
          <div style={{ color: 'var(--text-secondary)' }}>
            No pull request access for{' '}
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
              {repoLabel}
            </span>
          </div>
          <div style={{ color: 'var(--text-secondary)' }}>
            Reconnect with an account that has repo access, or grant the Atlas GitHub App access to this repository.
          </div>
        </div>
      ),
    };
  }, []);

  useEffect(() => {
    projectLoadPrSyncPopupShownRef.current = false;
    projectLoadPrSyncSettledRef.current = false;
    setPrAccessDenied(false);
  }, [projectId]);

  // Panel widths
  const initialPanelWidthsRef = useRef(
    getInitialPanelWidths(typeof window !== 'undefined' ? window.innerWidth : 1440)
  );
  const [leftWidth, setLeftWidth] = useState(initialPanelWidthsRef.current.leftWidth);
  const [reviewAgentWidth, setReviewAgentWidth] = useState(initialPanelWidthsRef.current.rightWidth || REVIEW_AGENT_DEFAULT_WIDTH);
  const leftWidthRef = useRef(initialPanelWidthsRef.current.leftWidth);
  const reviewAgentWidthRef = useRef(initialPanelWidthsRef.current.rightWidth || REVIEW_AGENT_DEFAULT_WIDTH);

  // Resize refs
  const isResizingLeftRef = useRef(false);
  const isResizingReviewAgentRef = useRef(false);
  const animFrameRef = useRef<number>();
  const windowResizeFrameRef = useRef<number>();
  const contentAreaRef = useRef<HTMLDivElement | null>(null);
  const centerPanelMinWidthRef = useRef(CENTER_PANEL_MIN_WIDTH);

  // Ref for diff viewer file switching (exposed to right panel)
  const scrollToFileRef = useRef<((target: DiffNavigationTarget) => void) | null>(null);
  const pendingHistoricalNoteTargetRef = useRef<DiffNavigationTarget | null>(null);

  // Ref for review panel actions (keyboard shortcuts)
  const reviewPanelRef = useRef<TrustReviewPanelRef>(null);
  const shellRerunActionRef = useRef<() => void>(() => undefined);
  const shellFullReviewActionRef = useRef<() => void>(() => undefined);
  const pendingPrFindingSelectionRef = useRef<{
    action: 'comment' | 'request_changes';
    body: string;
  } | null>(null);
  const pendingPrApprovalRef = useRef(false);
  const pendingReviewAgentOutcomeRef = useRef<{
    recommendationKey: string;
    status: 'addressed' | 'dismissed';
    note?: string;
  } | null>(null);
  const [reviewPanelBannerState, setReviewPanelBannerState] = useState({
    isFixRunActive: false,
    hasVerificationPending: false,
  });

  // Ref for diff panel focus management
  const diffPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    leftWidthRef.current = leftWidth;
  }, [leftWidth]);

  useEffect(() => {
    reviewAgentWidthRef.current = reviewAgentWidth;
  }, [reviewAgentWidth]);

  useEffect(() => {
    const containerWidth = contentAreaRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const nextRight = clampWidth(
      reviewAgentWidthRef.current,
      REVIEW_AGENT_MIN_WIDTH,
      maxAssistantWidthForReviewContainer(containerWidth, leftWidthRef.current, centerPanelMinWidthRef.current)
    );
    const nextLeft = clampWidth(
      leftWidthRef.current,
      LEFT_PANEL_MIN_WIDTH,
      maxLeftWidthForReviewContainer(containerWidth, isReviewAgentOpen, nextRight, centerPanelMinWidthRef.current)
    );
    if (nextRight !== reviewAgentWidthRef.current) {
      reviewAgentWidthRef.current = nextRight;
      setReviewAgentWidth(nextRight);
    }
    if (nextLeft !== leftWidthRef.current) {
      leftWidthRef.current = nextLeft;
      setLeftWidth(nextLeft);
    }
    savePanelWidths(TRUST_REVIEW_PANEL_WIDTHS_STORAGE_KEY, {
      leftWidth: leftWidthRef.current,
      rightWidth: reviewAgentWidthRef.current,
    });
  }, [isReviewAgentOpen]);

  useEffect(() => {
    setReviewPanelBannerState({
      isFixRunActive: false,
      hasVerificationPending: false,
    });
  }, [selectedItem?.id, selectedItem?.type]);

  useEffect(() => {
    return () => {
      if (refreshFallbackTimerRef.current) {
        window.clearTimeout(refreshFallbackTimerRef.current);
        refreshFallbackTimerRef.current = null;
      }
      if (initialProjectLoadGraceTimerRef.current) {
        window.clearTimeout(initialProjectLoadGraceTimerRef.current);
        initialProjectLoadGraceTimerRef.current = null;
      }
      if (progressFlushTimerRef.current != null) {
        window.clearTimeout(progressFlushTimerRef.current);
        progressFlushTimerRef.current = null;
      }
      progressBufferRef.current = {};
      Object.values(bannerReviewBusyTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      bannerReviewBusyTimeoutsRef.current = {};
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const metaOrCtrl = e.metaKey || e.ctrlKey;
      const activeElement = document.activeElement;
      const isEditable = isEditableElement(activeElement);

      // Cmd/Ctrl+L: Private notes
      if (metaOrCtrl && e.key.toLowerCase() === 'l') {
        if (showPrivateNotesModal && isEditable) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        setShowPrivateNotesModal((prev) => !prev);
        return;
      }

      // Skip when focused on editable controls.
      if (isEditable) return;

      // Cmd/Ctrl+K: toggle Ask Atlas.
      if (metaOrCtrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!selectedItem) return;
        if (isReviewAgentOpen) {
          setIsReviewAgentOpen(false);
          setReviewAgentExtraAttachments([]);
          setReviewAgentDraftRequest(null);
          return;
        }
        setReviewAgentExtraAttachments([]);
        setReviewAgentDraftRequest(null);
        setIsReviewAgentOpen(true);
        return;
      }

      // Escape: back to dashboard
      if (e.key === 'Escape') {
        if (submitPopoverOpen) return;
        e.preventDefault();
        onBack();
        return;
      }

      // Left/right: switch review shell tab.
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !metaOrCtrl && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const modes: ReviewShellMode[] = ['findings', 'walkthrough', 'files'];
        const currentIndex = modes.indexOf(reviewShellMode);
        if (currentIndex < 0) return;
        const direction = e.key === 'ArrowRight' ? 1 : -1;
        const nextIndex = (currentIndex + direction + modes.length) % modes.length;
        setReviewShellMode(modes[nextIndex]);
        return;
      }

      // Cmd/Ctrl+Enter: open the contextual Actions menu and focus its first action.
      if (metaOrCtrl && e.key === 'Enter') {
        e.preventDefault();
        if (selectedItem) {
          setSubmitPopoverOpen(true);
          setSubmitPopoverFocusRequest((value) => value + 1);
        }
        return;
      }

      // Cmd/Ctrl+D: toggle unified/split. Findings and Files are handled by the
      // mounted diff viewer; Walkthrough replaces that viewer, so handle it here.
      if (metaOrCtrl && e.key.toLowerCase() === 'd') {
        if (selectedItem && reviewShellMode === 'walkthrough') {
          e.preventDefault();
          toggleReviewDiffViewMode();
        }
        return;
      }

      // Cmd/Ctrl+Shift+R: force full review, or full walkthrough when the
      // walkthrough tab owns the current action. Check before plain Cmd/Ctrl+R
      // so the shift variant wins the match.
      if (metaOrCtrl && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        if (selectedItem && reviewShellMode === 'walkthrough') {
          triggerWalkthroughGeneration(true);
          return;
        }
        if (selectedItem) {
          shellFullReviewActionRef.current();
        }
        return;
      }

      // Cmd/Ctrl+R: run the tab's primary action.
      if (metaOrCtrl && e.key === 'r') {
        e.preventDefault();
        if (selectedItem && reviewShellMode === 'walkthrough') {
          triggerWalkthroughGeneration(false);
          return;
        }
        if (selectedItem) {
          shellRerunActionRef.current();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedItem,
    isReviewAgentOpen,
    onBack,
    reviewShellMode,
    showPrivateNotesModal,
    submitPopoverOpen,
    toggleReviewDiffViewMode,
    triggerWalkthroughGeneration,
  ]);

  // Load project info
  useEffect(() => {
    setIsProjectMetaLoading(true);
    const load = async () => {
      try {
        const [projResp, gitResp] = await Promise.allSettled([
          projectApi.get(projectId),
          projectApi.getGitStatus(projectId),
        ]);
        if (projResp.status === 'fulfilled') setProject(projResp.value.project);
        if (gitResp.status === 'fulfilled') {
          setBranch(gitResp.value.currentBranch);
          const owner = gitResp.value.owner;
          const repo = gitResp.value.repo;
          setGitRepoSlug(owner && repo && gitResp.value.isGitHub ? `${owner}/${repo}` : null);
        }
      } catch (error) {
        console.error('Failed to load project info:', error);
      } finally {
        setIsProjectMetaLoading(false);
      }
    };
    load();
  }, [projectId]);

  const refreshBranchContext = useCallback(async () => {
    try {
      const gitStatus = await projectApi.getGitStatus(projectId);
      setBranch(gitStatus.currentBranch);
      const owner = gitStatus.owner;
      const repo = gitStatus.repo;
      setGitRepoSlug(owner && repo && gitStatus.isGitHub ? `${owner}/${repo}` : null);
    } catch (error) {
      console.error('Failed to refresh current branch context:', error);
    }
  }, [projectId]);

  useEffect(() => {
    setIsReviewListInitialLoading(true);
  }, [projectId, refreshKey]);

  useEffect(() => {
    setIsWithinInitialProjectLoadGrace(true);
    if (initialProjectLoadGraceTimerRef.current) {
      window.clearTimeout(initialProjectLoadGraceTimerRef.current);
    }
    initialProjectLoadGraceTimerRef.current = window.setTimeout(() => {
      setIsWithinInitialProjectLoadGrace(false);
      initialProjectLoadGraceTimerRef.current = null;
    }, INITIAL_PROJECT_LOAD_GRACE_MS);

    return () => {
      if (initialProjectLoadGraceTimerRef.current) {
        window.clearTimeout(initialProjectLoadGraceTimerRef.current);
        initialProjectLoadGraceTimerRef.current = null;
      }
    };
  }, [projectId, refreshKey]);

  useEffect(() => {
    if (isProjectMetaLoading || isReviewListInitialLoading || selectedItem) {
      return;
    }
    if (initialProjectLoadGraceTimerRef.current) {
      window.clearTimeout(initialProjectLoadGraceTimerRef.current);
    }
    initialProjectLoadGraceTimerRef.current = window.setTimeout(() => {
      setIsWithinInitialProjectLoadGrace(false);
      initialProjectLoadGraceTimerRef.current = null;
    }, INITIAL_PROJECT_LOAD_SETTLE_MS);

    return () => {
      if (initialProjectLoadGraceTimerRef.current) {
        window.clearTimeout(initialProjectLoadGraceTimerRef.current);
        initialProjectLoadGraceTimerRef.current = null;
      }
    };
  }, [isProjectMetaLoading, isReviewListInitialLoading, selectedItem]);

  // Load branch auto-review setting
  useEffect(() => {
    const loadAutoReview = async () => {
      try {
        const result = await settingsApi.get('auto_review_enabled');
        setAutoReviewEnabled(result.value !== 'false');
      } catch {
        // Ignore — setting may not exist yet
      }
    };
    loadAutoReview();
  }, []);

  const toggleAutoReview = useCallback(async () => {
    const newValue = !autoReviewEnabled;
    setAutoReviewEnabled(newValue);
    try {
      await settingsApi.set('auto_review_enabled', String(newValue));
      emitAutoReviewSettingChanged(newValue);
    } catch {
      // Revert on error
      setAutoReviewEnabled(!newValue);
    }
  }, [autoReviewEnabled]);

  // Load branches for Change Base selector
  const refreshPersistentTopicBanner = useCallback(async () => {
    try {
      const result = await branchReviewApi.list(projectId);
      const branchReviews = result.branchReviews || [];
      if (branchReviews.length > 0) {
        setLatestBranchSnapshotsById((prev) => {
          const next = { ...prev };
          for (const review of branchReviews) {
            const normalizedSnapshot = normalizeBranchSnapshot(review);
            if (shouldReplaceBranchSnapshot(next[review.id], normalizedSnapshot)) {
              next[review.id] = normalizedSnapshot;
            }
          }
          return next;
        });

        const reviewStateById = new Map(
          branchReviews.map((review) => [
            review.id,
            {
              status: normalizeLifecycleStatusValue(
                review.reviewLifecycle?.status || review.reviewLifecycle?.sourceStatus || review.reviewStatus || 'none',
                'completed'
              ),
              updatedAt: review.reviewLifecycle?.updatedAt || review.updatedAt || null,
            },
          ])
        );

        const staleIds = Object.entries(brProgressByIdRef.current)
          .filter(([branchReviewId, progress]) => {
            const reviewState = reviewStateById.get(branchReviewId);
            return shouldClearStaleProgress(
              progress,
              reviewState?.status,
              reviewState?.updatedAt || null
            );
          })
          .map(([branchReviewId]) => branchReviewId);

        if (staleIds.length > 0) {
          setBrProgressById((prev) => {
            const next = { ...prev };
            let changed = false;
            staleIds.forEach((branchReviewId) => {
              if (!next[branchReviewId]) return;
              delete next[branchReviewId];
              delete progressBufferRef.current[branchReviewId];
              changed = true;
            });
            return changed ? next : prev;
          });
        }
        staleIds.forEach((id) => {
          const existingTimeoutId = bannerReviewBusyTimeoutsRef.current[id];
          if (existingTimeoutId) {
            window.clearTimeout(existingTimeoutId);
            delete bannerReviewBusyTimeoutsRef.current[id];
          }
        });
        if (staleIds.length > 0) {
          setBannerReviewBusyById((prev) => {
            const next = { ...prev };
            let changed = false;
            staleIds.forEach((id) => {
              if (!next[id]) return;
              delete next[id];
              changed = true;
            });
            return changed ? next : prev;
          });
        }
      }
      const currentReview = branchReviews.find(
        (review) => review.isCurrent && review.status === 'active'
      );

      setBranchBanner((prev) => {
        // Keep transient banners visible until their own lifecycle closes them.
        if (prev?.type === 'no-changes' || prev?.type === 'detached') {
          return prev;
        }

        if (!currentReview) {
          // Preserve the topic banner if the user is actively viewing this review
          // AND the review is still active. Without the active check, a closed/merged
          // review's banner would persist indefinitely with stale counts.
          if (prev?.type === 'topic' && prev.branchReviewId) {
            const viewing = selectedItemRef.current;
            const stillActive = branchReviews.some(
              (r) => r.id === prev.branchReviewId && r.status === 'active'
            );
            if (viewing?.type === 'branch_review' && viewing.id === prev.branchReviewId && stillActive) {
              return prev;
            }
          }
          return prev?.type === 'topic' ? null : prev;
        }

        if (
          prev?.type === 'topic'
          && prev.branchReviewId === currentReview.id
          && prev.branchName === currentReview.branchName
          && prev.baseBranch === currentReview.baseBranch
          && prev.fileCount === currentReview.fileCount
          && prev.commitCount === currentReview.commitCount
          && prev.headSha === (currentReview.headSha || null)
        ) {
          return prev;
        }

        return {
          type: 'topic',
          branchName: currentReview.branchName,
          baseBranch: currentReview.baseBranch,
          fileCount: currentReview.fileCount,
          commitCount: currentReview.commitCount,
          headSha: currentReview.headSha || null,
          updatedAt: currentReview.updatedAt || null,
          branchReviewId: currentReview.id,
        };
      });
    } catch {
      // Best effort only — list component refresh still keeps core state accurate.
    }
  }, [projectId]);

  useEffect(() => {
    void refreshPersistentTopicBanner();
  }, [refreshPersistentTopicBanner, refreshKey]);

  const openBranchSelector = useCallback(async () => {
    if (changingBaseBranch || baseChangeReviewBusyRef.current) return;
    if (showBranchSelector) {
      setShowBranchSelector(false);
      return;
    }
    setLoadingBranches(true);
    setShowBranchSelector(true);
    try {
      const result = await branchReviewApi.listBranches(projectId);
      setAvailableBranches(result.branches || []);
    } catch {
      toast.error('Failed to load branches');
      setShowBranchSelector(false);
    } finally {
      setLoadingBranches(false);
    }
  }, [changingBaseBranch, projectId, showBranchSelector]);

  const handleChangeBase = useCallback(async (newBase: string) => {
    if (changingBaseBranch || baseChangeReviewBusyRef.current) return;
    const rawCurrentEffectiveBase = selectedBranchReviewDetails?.baseBranch
      || branchBanner?.baseBranch
      || project?.baseBranchDisplay
      || project?.baseBranchRef
      || null;
    const currentEffectiveBase = typeof rawCurrentEffectiveBase === 'string'
      ? rawCurrentEffectiveBase.replace(/^refs\/heads\//, '')
      : null;
    if (newBase === currentEffectiveBase) {
      setShowBranchSelector(false);
      return;
    }

    const confirmed = await popup.confirm({
      title: 'Change base branch?',
      message: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div>
            Reviewing <strong>{branchBanner?.branchName || branch || 'current branch'}</strong>
          </div>
          <div>
            Change base from <strong>{currentEffectiveBase || 'not set'}</strong> to <strong>{newBase}</strong>?
          </div>
        </div>
      ),
      confirmLabel: 'Change Base',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    const previousProjectBaseDisplay = project?.baseBranchDisplay || null;
    const previousProjectBaseRef = project?.baseBranchRef || null;
    const previousSelectedReviewBase = selectedBranchReviewDetails?.baseBranch || null;
    const previousBannerBase = branchBanner?.type === 'topic'
      ? branchBanner.baseBranch
      : null;
    const selected = selectedItemRef.current;
    const visibleBranchName = selectedBranchReviewDetails?.branchName
      || (branchBanner?.type === 'topic' ? branchBanner.branchName : null)
      || null;
    const scopedReviewId = selected?.type === 'branch_review'
      ? selected.id
      : branchBanner?.type === 'topic' && branchBanner.branchReviewId
        ? branchBanner.branchReviewId
        : selectedBranchReviewDetails?.id || null;
    const scopedToReview = Boolean(scopedReviewId || visibleBranchName);

    setShowBranchSelector(false);
    setChangingBaseBranch(newBase);
    if (!scopedToReview) {
      setProject((prev) => (prev ? ({
        ...prev,
        baseBranchDisplay: newBase,
        baseBranchRef: `refs/heads/${newBase}`,
      }) : prev));
    }
    setSelectedBranchReviewDetails((prev) => (
      scopedReviewId && prev?.id === scopedReviewId
        ? { ...prev, baseBranch: newBase }
        : prev
    ));
    setBranchBanner((prev) => (
      prev?.type === 'topic'
        ? {
            ...prev,
            baseBranch: newBase,
          }
        : prev
    ));

    try {
      // Phase 05: scope the Change Base action to the currently-selected
      // review. If the branch header is showing a review banner while the
      // selection is temporarily unset, still pin that review instead of
      // silently updating only the project-wide base.
      let updatedBranchReview: BranchReview | null = null;
      let targetReviewId = scopedReviewId;
      if (scopedToReview && !targetReviewId && visibleBranchName) {
        const ensured = await branchReviewApi.ensureForBranch(projectId, visibleBranchName);
        targetReviewId = ensured?.branchReview?.id ?? null;
        if (!targetReviewId) {
          throw new Error('Unable to create or load the branch review for this base change');
        }
      }
      if (scopedToReview && targetReviewId) {
        const result = await branchReviewApi.updateReviewBaseBranch(projectId, targetReviewId, newBase, { pin: true });
        updatedBranchReview = result.branchReview;
        setSelectedBranchReviewDetails((prev) => (
          prev?.id === targetReviewId
            ? { ...prev, ...result.branchReview, baseBranch: result.branchReview.baseBranch || newBase }
            : prev
        ));
      } else {
        await branchReviewApi.updateBaseBranch(projectId, newBase);
        setProject((prev) => (prev ? ({
          ...prev,
          baseBranchDisplay: newBase,
          baseBranchRef: `refs/heads/${newBase}`,
        }) : prev));
      }
      setBranchBanner((prev) => (
        prev?.type === 'topic'
          ? {
              ...prev,
              baseBranch: newBase,
            }
          : prev
      ));
      branchReviewApi.invalidateCache(projectId);
      if (scopedToReview && targetReviewId) {
        setActiveChangeGroupFilter(null);
        setBranchRefreshTokenById((prev) => ({
          ...prev,
          [targetReviewId]: (prev[targetReviewId] || 0) + 1,
        }));
        if (updatedBranchReview) {
          const normalizedSnapshot = normalizeBranchSnapshot(updatedBranchReview);
          setLoadedBranchSnapshotsById((prev) => ({
            ...prev,
            [targetReviewId]: normalizedSnapshot,
          }));
          setLatestBranchSnapshotsById((prev) => ({
            ...prev,
            [targetReviewId]: normalizedSnapshot,
          }));
          setRefreshingBranchReviewId(null);
        } else {
          setRefreshingBranchReviewId(targetReviewId);
          setLoadedBranchSnapshotsById((prev) => {
            if (!prev[targetReviewId]) return prev;
            const next = { ...prev };
            delete next[targetReviewId];
            return next;
          });
        }
      }
      toast.success(
        scopedToReview
          ? `Base branch for this review set to ${newBase}`
          : `Project base branch changed to ${newBase}`
      );
      void refreshBranchContext();
      // Refresh the branch review list after the watcher recomputes the diff.
      setBrRefreshKey(prev => prev + 1);
      void refreshPersistentTopicBanner();
    } catch (err: any) {
      if (!scopedToReview) {
        setProject((prev) => (prev ? ({
          ...prev,
          baseBranchDisplay: previousProjectBaseDisplay,
          baseBranchRef: previousProjectBaseRef,
        }) : prev));
      }
      setSelectedBranchReviewDetails((prev) => (
        scopedReviewId && prev?.id === scopedReviewId
          ? { ...prev, baseBranch: previousSelectedReviewBase || '' }
          : prev
      ));
      setBranchBanner((prev) => (
        prev?.type === 'topic'
          ? {
              ...prev,
              baseBranch: previousBannerBase || undefined,
            }
          : prev
      ));
      toast.error(err?.response?.data?.error || 'Failed to change base branch');
    } finally {
      setChangingBaseBranch(null);
    }
  }, [
    branch,
    branchBanner,
    changingBaseBranch,
    popup,
    project,
    projectId,
    refreshBranchContext,
    refreshPersistentTopicBanner,
    selectedBranchReviewDetails?.baseBranch,
    selectedBranchReviewDetails?.branchName,
    selectedBranchReviewDetails?.id,
  ]);

  // Close branch selector on outside click
  useEffect(() => {
    if (!showBranchSelector) return;
    const handleClick = (e: MouseEvent) => {
      if (branchSelectorRef.current && !branchSelectorRef.current.contains(e.target as Node)) {
        setShowBranchSelector(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showBranchSelector]);

  // Panel resize handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = requestAnimationFrame(() => {
        const contentBounds = contentAreaRef.current?.getBoundingClientRect();
        const contentLeft = contentBounds?.left ?? 0;
        const containerWidth = contentBounds?.width ?? window.innerWidth;

        if (isResizingLeftRef.current) {
          const desiredWidth = e.clientX - contentLeft;
          const maxLeft = maxLeftWidthForReviewContainer(
            containerWidth,
            isReviewAgentOpen,
            reviewAgentWidthRef.current,
            centerPanelMinWidthRef.current
          );
          const newWidth = clampWidth(desiredWidth, LEFT_PANEL_MIN_WIDTH, maxLeft);
          leftWidthRef.current = newWidth;
          setLeftWidth(newWidth);
        }
        if (isResizingReviewAgentRef.current) {
          const desiredWidth = (contentLeft + containerWidth) - e.clientX;
          const maxRight = maxAssistantWidthForReviewContainer(
            containerWidth,
            leftWidthRef.current,
            centerPanelMinWidthRef.current
          );
          const newWidth = clampWidth(desiredWidth, REVIEW_AGENT_MIN_WIDTH, maxRight);
          reviewAgentWidthRef.current = newWidth;
          setReviewAgentWidth(newWidth);
        }
      });
    };

    const stopResizing = () => {
      const wasResizing = isResizingLeftRef.current || isResizingReviewAgentRef.current;
      isResizingLeftRef.current = false;
      isResizingReviewAgentRef.current = false;
      if (!wasResizing) return;
      endPanelResizeInteraction();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

      savePanelWidths(TRUST_REVIEW_PANEL_WIDTHS_STORAGE_KEY, {
        leftWidth: leftWidthRef.current,
        rightWidth: reviewAgentWidthRef.current,
      });
    };

    const handleWindowResize = () => {
      if (windowResizeFrameRef.current) cancelAnimationFrame(windowResizeFrameRef.current);
      windowResizeFrameRef.current = requestAnimationFrame(() => {
        windowResizeFrameRef.current = undefined;

        const nextLeft = clampWidth(
          leftWidthRef.current,
          LEFT_PANEL_MIN_WIDTH,
          maxLeftWidthForReviewContainer(
            contentAreaRef.current?.getBoundingClientRect().width ?? window.innerWidth,
            isReviewAgentOpen,
            reviewAgentWidthRef.current,
            centerPanelMinWidthRef.current
          )
        );
        const nextRight = clampWidth(
          reviewAgentWidthRef.current,
          REVIEW_AGENT_MIN_WIDTH,
          maxAssistantWidthForReviewContainer(
            contentAreaRef.current?.getBoundingClientRect().width ?? window.innerWidth,
            nextLeft,
            centerPanelMinWidthRef.current
          )
        );
        if (nextLeft !== leftWidthRef.current) {
          leftWidthRef.current = nextLeft;
          setLeftWidth(nextLeft);
        }
        if (nextRight !== reviewAgentWidthRef.current) {
          reviewAgentWidthRef.current = nextRight;
          setReviewAgentWidth(nextRight);
        }

        savePanelWidths(TRUST_REVIEW_PANEL_WIDTHS_STORAGE_KEY, {
          leftWidth: leftWidthRef.current,
          rightWidth: reviewAgentWidthRef.current,
        });
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResizing);
    window.addEventListener('blur', stopResizing);
    window.addEventListener('resize', handleWindowResize);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResizing);
      window.removeEventListener('blur', stopResizing);
      window.removeEventListener('resize', handleWindowResize);
      endPanelResizeInteraction();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (windowResizeFrameRef.current) cancelAnimationFrame(windowResizeFrameRef.current);
    };
  }, [isReviewAgentOpen]);

  const startResize = useCallback((event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    isResizingLeftRef.current = true;
    beginPanelResizeInteraction(event);
  }, []);

  const startReviewAgentResize = useCallback((event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    isResizingReviewAgentRef.current = true;
    beginPanelResizeInteraction(event);
  }, []);

  const handleSelectItem = useCallback((
    id: string,
    type: 'branch_review' | 'pr_review' | 'workspace_review',
    options: { source?: ReviewSelectionSource } = {},
  ) => {
    const nextSelection: SelectedItem = { id, type };
    if (type === 'pr_review') {
      setSelectedPrReviewLoading(true);
      setSelectedPrReview((prev) => (prev?.id === id ? prev : null));
    } else {
      setSelectedPrReview(null);
      setSelectedPrReviewLoading(false);
    }
    selectedItemRef.current = nextSelection;
    selectedItemSourceRef.current = options.source || 'explicit';
    setSelectedItem(nextSelection);
    // Focus diff panel after selection (next tick so React renders first)
    requestAnimationFrame(() => {
      diffPanelRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!initialSelectedItem) return;
    const current = selectedItemRef.current;
    if (current?.id === initialSelectedItem.id && current.type === initialSelectedItem.type) return;
    handleSelectItem(initialSelectedItem.id, initialSelectedItem.type, { source: 'explicit' });
    setIsReviewListInitialLoading(false);
  }, [handleSelectItem, initialSelectedItem]);

  useEffect(() => {
    if (!initialBaseBranchName) return;
    selectedItemRef.current = null;
    selectedItemSourceRef.current = 'explicit';
    setSelectedItem(null);
    setIsReviewListInitialLoading(false);
  }, [initialBaseBranchName]);

  const resolveCurrentReviewSelection = useCallback(async (preferredBranchName?: string | null) => {
    if (selectedItemRef.current || initialBaseBranchName) return;
    try {
      const [branchResult, workspaceResult, gitStatusResult] = await Promise.allSettled([
        branchReviewApi.list(projectId, { refreshCurrent: true, waitForReconcile: true }),
        workspaceReviewApi.list(projectId),
        projectApi.getGitStatus(projectId),
      ]);
      if (selectedItemRef.current) return;

      if (gitStatusResult.status === 'fulfilled') {
        setBranch(gitStatusResult.value.currentBranch);
        const owner = gitStatusResult.value.owner;
        const repo = gitStatusResult.value.repo;
        setGitRepoSlug(owner && repo && gitStatusResult.value.isGitHub ? `${owner}/${repo}` : null);
      }

      const selection = pickCurrentReviewSelection({
        branchReviews: branchResult.status === 'fulfilled' ? (branchResult.value.branchReviews || []) : [],
        workspaceReviews: workspaceResult.status === 'fulfilled' ? (workspaceResult.value.workspaceReviews || []) : [],
        currentBranchName: preferredBranchName || (
          gitStatusResult.status === 'fulfilled'
            ? gitStatusResult.value.currentBranch
            : branchRef.current
        ),
      });
      if (selection) {
        handleSelectItem(selection.id, selection.type, { source: 'auto' });
      }
    } catch (error) {
      console.error('Failed to resolve current review selection:', error);
    }
  }, [handleSelectItem, initialBaseBranchName, projectId]);

  useEffect(() => {
    if (initialBaseBranchName) {
      setIsReviewListInitialLoading(false);
      return undefined;
    }

    let cancelled = false;

    const waitForNextSelectionAttempt = () => new Promise<void>((resolve) => {
      window.setTimeout(resolve, INITIAL_REVIEW_SELECTION_RETRY_MS);
    });

    const bootstrapReviewSelection = async () => {
      try {
        for (let attempt = 0; attempt < INITIAL_REVIEW_SELECTION_MAX_ATTEMPTS; attempt += 1) {
          if (cancelled || selectedItemRef.current) return;

          const [branchResult, workspaceResult, gitStatusResult] = await Promise.allSettled([
            branchReviewApi.list(
              projectId,
              attempt === 0
                ? { refreshCurrent: true, waitForReconcile: true }
                : { waitForReconcile: true }
            ),
            workspaceReviewApi.list(projectId),
            projectApi.getGitStatus(projectId),
          ]);
          if (cancelled || selectedItemRef.current) return;

          const branchReviews = branchResult.status === 'fulfilled'
            ? (branchResult.value.branchReviews || [])
            : [];
          const workspaceReviews = workspaceResult.status === 'fulfilled'
            ? (workspaceResult.value.workspaceReviews || [])
            : [];

          if (gitStatusResult.status === 'fulfilled') {
            setBranch(gitStatusResult.value.currentBranch);
            const owner = gitStatusResult.value.owner;
            const repo = gitStatusResult.value.repo;
            setGitRepoSlug(owner && repo && gitStatusResult.value.isGitHub ? `${owner}/${repo}` : null);
          }

          if (branchReviews.length > 0) {
            setLatestBranchSnapshotsById((prev) => {
              const next = { ...prev };
              let changed = false;
              for (const review of branchReviews) {
                const normalizedSnapshot = normalizeBranchSnapshot(review);
                if (shouldReplaceBranchSnapshot(next[review.id], normalizedSnapshot)) {
                  next[review.id] = normalizedSnapshot;
                  changed = true;
                }
              }
              return changed ? next : prev;
            });
          }

          const currentSelection = pickCurrentReviewSelection({
            branchReviews,
            workspaceReviews,
            currentBranchName: gitStatusResult.status === 'fulfilled'
              ? gitStatusResult.value.currentBranch
              : branchRef.current,
          });
          if (currentSelection) {
            handleSelectItem(currentSelection.id, currentSelection.type, { source: 'auto' });
            return;
          }

          if (attempt < INITIAL_REVIEW_SELECTION_MAX_ATTEMPTS - 1) {
            await waitForNextSelectionAttempt();
          }
        }
      } catch (error) {
        console.error('Failed to bootstrap review selection:', error);
      } finally {
        if (!cancelled) {
          setIsReviewListInitialLoading(false);
        }
      }
    };

    void bootstrapReviewSelection();

    return () => {
      cancelled = true;
    };
  }, [handleSelectItem, initialBaseBranchName, projectId, refreshKey]);

  const handleOpenHistoricalNote = useCallback((payload: {
    reviewId: string;
    reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
    target: DiffNavigationTarget | null;
  }) => {
    pendingHistoricalNoteTargetRef.current = payload.target;
    const currentSelection = selectedItemRef.current;
    if (currentSelection?.id === payload.reviewId && currentSelection.type === payload.reviewType) {
      if (!payload.target) return;
      pendingHistoricalNoteTargetRef.current = null;
      requestAnimationFrame(() => {
        scrollToFileRef.current?.(payload.target!);
      });
      return;
    }
    handleSelectItem(payload.reviewId, payload.reviewType, { source: 'explicit' });
  }, [handleSelectItem]);

  useEffect(() => {
    const pendingTarget = pendingHistoricalNoteTargetRef.current;
    if (!pendingTarget || !selectedItem) return;
    if (!scrollToFileRef.current) return;
    pendingHistoricalNoteTargetRef.current = null;
    requestAnimationFrame(() => {
      scrollToFileRef.current?.(pendingTarget);
    });
  }, [selectedItem?.id, selectedItem?.type]);

  const beginSelectedPrRefresh = useCallback((targetPrReviewId?: string | null) => {
    const current = selectedItemRef.current;
    if (current?.type !== 'pr_review') return;
    if (targetPrReviewId && current.id !== targetPrReviewId) return;
    setSelectedPrReviewLoading(true);
  }, []);

  useEffect(() => {
    setActiveChangeGroupFilter(null);
  }, [selectedItem?.id, selectedItem?.type]);

  const markBannerReviewBusy = useCallback((branchReviewId: string) => {
    if (!branchReviewId) return;
    setBannerReviewBusyById((prev) => ({
      ...prev,
      [branchReviewId]: true,
    }));
    const existingTimeoutId = bannerReviewBusyTimeoutsRef.current[branchReviewId];
    if (existingTimeoutId) {
      window.clearTimeout(existingTimeoutId);
    }
    bannerReviewBusyTimeoutsRef.current[branchReviewId] = window.setTimeout(() => {
      setBannerReviewBusyById((prev) => {
        if (!prev[branchReviewId]) return prev;
        const next = { ...prev };
        delete next[branchReviewId];
        return next;
      });
      delete bannerReviewBusyTimeoutsRef.current[branchReviewId];
    }, 15000);
  }, []);

  const clearBannerReviewBusy = useCallback((branchReviewId?: string) => {
    if (!branchReviewId) return;
    const existingTimeoutId = bannerReviewBusyTimeoutsRef.current[branchReviewId];
    if (existingTimeoutId) {
      window.clearTimeout(existingTimeoutId);
      delete bannerReviewBusyTimeoutsRef.current[branchReviewId];
    }
    setBannerReviewBusyById((prev) => {
      if (!prev[branchReviewId]) return prev;
      const next = { ...prev };
      delete next[branchReviewId];
      return next;
    });
  }, []);

  const flushBufferedBranchReviewProgress = useCallback(() => {
    if (progressFlushTimerRef.current != null) {
      window.clearTimeout(progressFlushTimerRef.current);
      progressFlushTimerRef.current = null;
    }
    const buffered = progressBufferRef.current;
    progressBufferRef.current = {};
    setBrProgressById((prev) => {
      let changed = false;
      const next: Record<string, BranchReviewProgress> = { ...prev };
      for (const [id, value] of Object.entries(buffered)) {
        const existing = prev[id];
        const merged = mergeBranchReviewProgress(existing, value);
        if (isSameBranchReviewProgress(existing, merged)) {
          continue;
        }
        next[id] = merged;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const scheduleBranchReviewProgressFlush = useCallback(() => {
    if (progressFlushTimerRef.current != null) return;
    progressFlushTimerRef.current = window.setTimeout(() => {
      flushBufferedBranchReviewProgress();
    }, 120);
  }, [flushBufferedBranchReviewProgress]);

  const queueProgressUpdate = useCallback((branchReviewId: string, progress: BranchReviewProgress) => {
    if (!branchReviewId) return;
    progressBufferRef.current[branchReviewId] = progress;
    scheduleBranchReviewProgressFlush();
  }, [scheduleBranchReviewProgressFlush]);

  const clearQueuedBranchReviewRun = useCallback((branchReviewId?: string) => {
    if (!branchReviewId) return;
    setBrQueuedRerunById((prev) => {
      if (!prev[branchReviewId]) return prev;
      const next = { ...prev };
      delete next[branchReviewId];
      return next;
    });
    setCancellingQueuedReviewById((prev) => {
      if (!prev[branchReviewId]) return prev;
      const next = { ...prev };
      delete next[branchReviewId];
      return next;
    });
  }, []);

  const resetBranchReviewProgress = useCallback((branchReviewId?: string) => {
    if (!branchReviewId) return;
    if (progressFlushTimerRef.current != null) {
      window.clearTimeout(progressFlushTimerRef.current);
      progressFlushTimerRef.current = null;
    }
    if (progressBufferRef.current[branchReviewId]) {
      const nextBuffered = { ...progressBufferRef.current };
      delete nextBuffered[branchReviewId];
      progressBufferRef.current = nextBuffered;
    }
    if (Object.keys(progressBufferRef.current).length > 0) {
      scheduleBranchReviewProgressFlush();
    }
    setBrProgressById((prev) => {
      if (!prev[branchReviewId]) return prev;
      const next = { ...prev };
      delete next[branchReviewId];
      return next;
    });
  }, [scheduleBranchReviewProgressFlush]);

  const handleCancelQueuedBranchReview = useCallback(async (branchReviewId: string, queueId: string | null | undefined) => {
    if (!branchReviewId || !queueId) return;
    setCancellingQueuedReviewById((prev) => ({ ...prev, [branchReviewId]: true }));
    try {
      await reviewApi.cancelQueueEntry(queueId);
      clearQueuedBranchReviewRun(branchReviewId);
      toast.success('Queued review cancelled');
    } catch (err) {
      console.error('Failed to cancel queued review:', err);
      toast.error('Failed to cancel queued review');
      setCancellingQueuedReviewById((prev) => {
        if (!prev[branchReviewId]) return prev;
        const next = { ...prev };
        delete next[branchReviewId];
        return next;
      });
    }
  }, [clearQueuedBranchReviewRun]);

  const bumpBranchReviewRefreshToken = useCallback((branchReviewId?: string) => {
    if (!branchReviewId) return;
    setBranchRefreshTokenById((prev) => ({
      ...prev,
      [branchReviewId]: (prev[branchReviewId] || 0) + 1,
    }));
  }, []);

  const handleBannerReviewNow = useCallback(async (targetId: string, options?: { full?: boolean }) => {
    if (!targetId) return;
    const forceFull = options?.full === true;
    const current = selectedItemRef.current;
    const isPr = current?.type === 'pr_review' && current.id === targetId;
    const isWorkspace = current?.type === 'workspace_review' && current.id === targetId;

    // Delegate to the panel's triggerReview when the selected review matches,
    // so review-specific confirmation and scope logic stays in one place.
    const isSelectedReview = (
      (current?.type === 'branch_review' || current?.type === 'pr_review' || current?.type === 'workspace_review')
      && current.id === targetId
    );
    if (isSelectedReview && reviewPanelRef.current) {
      const panel = reviewPanelRef.current;
      markBannerReviewBusy(targetId);
      const trigger = forceFull
        ? panel.triggerFullReview
        : panel.triggerReview;
      void trigger().then((queued) => {
        if (!queued) {
          clearBannerReviewBusy(targetId);
        }
      });
      return;
    }

    if (forceFull) {
      const title = isPr
        ? 'Run full PR review?'
        : isWorkspace
          ? 'Run full workspace review?'
          : 'Run full branch review?';
      const message = isPr
        ? 'Atlas will run a fresh full-PR review on the current diff. This re-examines every changed file instead of the incremental delta.'
        : isWorkspace
          ? 'Atlas will run a fresh full workspace review on the current snapshot.'
          : 'Atlas will keep the current review visible while it runs a fresh full-branch review against the base branch.';
      const confirmed = await popup.confirm({
        title,
        message,
        confirmLabel: 'Run full review',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;
    }

    // Pre-flight large-diff popup for branch reviews when the panel isn't
    // mounted (NotRunView state). Mirrors the panel-side logic in
    // TrustReviewPanel.handleReviewNow so the popup fires regardless of which
    // entry point the user used.
    let usePartial = false;
    if (!forceFull && !isPr && !isWorkspace) {
      const snapshot = latestBranchSnapshotsById[targetId] || loadedBranchSnapshotsById[targetId];
      const branchFileCount = Number(snapshot?.fileCount) || 0;
      if (branchFileCount >= LARGE_DIFF_PARTIAL_POPUP_THRESHOLD) {
        const choice = await askPartialOrFull(popup, branchFileCount);
        if (choice === null) {
          // User dismissed (Esc / clicked backdrop / Cancel) — abort entirely.
          // markBannerReviewBusy is not called until after the popup, so we
          // must not call clearBannerReviewBusy here — doing so would clear a
          // busy flag set by an unrelated review on the same target.
          return;
        }
        usePartial = choice === 'partial';
      }
    }

    markBannerReviewBusy(targetId);
    try {
      if (isPr) {
        await prReviewApi.queueReview(projectId, targetId, {
          ...(forceFull ? { reviewMode: 'auto' as const, forceFullScope: true } : {}),
          policySource: 'working_tree',
        });
      } else if (isWorkspace) {
        await workspaceReviewApi.queueReview(projectId, targetId, {
          ...(forceFull ? { reviewMode: 'full' as const } : {}),
          policySource: 'working_tree',
        });
      } else {
        await branchReviewApi.queueReview(projectId, targetId, {
          ...(forceFull ? { reviewMode: 'full' as const } : {}),
          ...(usePartial ? { partial: true } : {}),
          policySource: 'working_tree',
        });
        branchReviewApi.invalidateCache(projectId, targetId);
      }
      const nowIso = new Date().toISOString();
      if (!isPr) {
        setLatestBranchSnapshotsById((prev) => {
          const existing = prev[targetId];
          if (!existing) return prev;
          return {
            ...prev,
            [targetId]: {
              ...existing,
              reviewStatus: 'queued',
              reviewLifecycleStatus: 'queued',
              reviewLifecyclePhase: 'queued',
              reviewLifecycleIsActive: true,
              reviewLifecycleIsTerminal: false,
              reviewSourceStatus: 'queued',
              reviewError: null,
              updatedAt: nowIso,
            },
          };
        });
        setLoadedBranchSnapshotsById((prev) => {
          const existing = prev[targetId];
          if (!existing) return prev;
          return {
            ...prev,
            [targetId]: {
              ...existing,
              reviewStatus: 'queued',
              reviewLifecycleStatus: 'queued',
              reviewLifecyclePhase: 'queued',
              reviewLifecycleIsActive: true,
              reviewLifecycleIsTerminal: false,
              reviewSourceStatus: 'queued',
              reviewError: null,
              updatedAt: nowIso,
            },
          };
        });
      }
      resetBranchReviewProgress(targetId);
      queueProgressUpdate(targetId, {
        phase: 'queued',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 0,
        updatedAt: nowIso,
      });
      // Ensure selected panels (diff/review) fetch the latest lifecycle snapshot on rerun.
      const selected = selectedItemRef.current;
      if ((selected?.type === 'branch_review' || selected?.type === 'pr_review') && selected.id === targetId) {
        bumpBranchReviewRefreshToken(targetId);
      }
    } catch (error: any) {
      clearBannerReviewBusy(targetId);
      const message = error?.response?.data?.error || error?.message || 'Failed to queue review';
      toast.error(message);
    }
  }, [projectId, markBannerReviewBusy, clearBannerReviewBusy, popup, queueProgressUpdate, bumpBranchReviewRefreshToken, resetBranchReviewProgress, latestBranchSnapshotsById, loadedBranchSnapshotsById]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const reconcileCurrentBranch = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const gitStatus = await projectApi.getGitStatus(projectId);
        if (cancelled) return;
        const nextBranch = gitStatus.currentBranch || null;
        if (nextBranch === branchRef.current) return;
        // First observation after mount: just record the branch. Don't treat
        // it as a "branch switch" — the user's explicit selection (e.g.,
        // viewing a non-current branch's review) must not be wiped.
        const isInitialDetection = branchRef.current === null;
        await watcherApi.syncNow(projectId).catch(() => null);
        branchRef.current = nextBranch;
        setBranch(nextBranch);
        if (!isInitialDetection) {
          const selectionLocked = isExplicitReviewSelectionLocked({
            selection: selectedItemRef.current,
            source: selectedItemSourceRef.current,
          });
          if (!selectionLocked) {
            resetSelectionForBranchSwitch();
          }
        }
        branchReviewApi.invalidateCache(projectId);
        const current = selectedItemRef.current;
        if (current?.type === 'branch_review') {
          bumpBranchReviewRefreshToken(current.id);
        }
        setBrRefreshKey((prev) => prev + 1);
        void refreshPersistentTopicBanner();
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to reconcile current branch:', error);
        }
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void reconcileCurrentBranch();
    }, 5000);

    const handleFocus = () => {
      void reconcileCurrentBranch();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void reconcileCurrentBranch();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void reconcileCurrentBranch();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [projectId, refreshPersistentTopicBanner, bumpBranchReviewRefreshToken, resetSelectionForBranchSwitch]);

  const handleBannerStopReview = useCallback(async (targetId: string) => {
    if (!targetId) return;
    const current = selectedItemRef.current;
    const isPr = current?.type === 'pr_review' && current.id === targetId;
    try {
      if (isPr) {
        await prReviewApi.stopReview(projectId, targetId);
        prReviewApi.invalidateCache(projectId, targetId);
      } else {
        await branchReviewApi.stopReview(projectId, targetId);
        branchReviewApi.invalidateCache(projectId, targetId);
      }
      resetBranchReviewProgress(targetId);
      delete progressBufferRef.current[targetId];
      clearBannerReviewBusy(targetId);
      bumpBranchReviewRefreshToken(targetId);
    } catch (err) {
      console.error('Failed to stop review:', err);
    }
  }, [projectId, clearBannerReviewBusy, bumpBranchReviewRefreshToken, resetBranchReviewProgress]);

  const handleBranchReviewSnapshotLoaded = useCallback((snapshot: BranchReviewSnapshot | null) => {
    if (!snapshot?.id) return;
    setLoadedBranchSnapshotsById((prev) => ({
      ...prev,
      [snapshot.id]: normalizeBranchSnapshot(snapshot),
    }));
    setRefreshingBranchReviewId((current) => (current === snapshot.id ? null : current));
    if (refreshFallbackTimerRef.current) {
      window.clearTimeout(refreshFallbackTimerRef.current);
      refreshFallbackTimerRef.current = null;
    }
  }, []);

  const handleRefreshBranchFiles = useCallback((branchReviewId: string) => {
    if (!branchReviewId) return;
    branchReviewApi.invalidateCache(projectId, branchReviewId);
    setRefreshingBranchReviewId(branchReviewId);
    bumpBranchReviewRefreshToken(branchReviewId);
    if (refreshFallbackTimerRef.current) {
      window.clearTimeout(refreshFallbackTimerRef.current);
      refreshFallbackTimerRef.current = null;
    }
    refreshFallbackTimerRef.current = window.setTimeout(() => {
      setRefreshingBranchReviewId((current) => (current === branchReviewId ? null : current));
      refreshFallbackTimerRef.current = null;
    }, 12000);
    void refreshPersistentTopicBanner();
    setBrRefreshKey((prev) => prev + 1);
    toast.success('Refreshing branch files...');
  }, [projectId, refreshPersistentTopicBanner, bumpBranchReviewRefreshToken]);

  const handleBranchReviewDeleted = useCallback((branchReviewId: string) => {
    if (!branchReviewId) return;

    branchReviewApi.invalidateCache(projectId, branchReviewId);
    resetBranchReviewProgress(branchReviewId);
    delete progressBufferRef.current[branchReviewId];

    const existingTimeoutId = bannerReviewBusyTimeoutsRef.current[branchReviewId];
    if (existingTimeoutId) {
      window.clearTimeout(existingTimeoutId);
      delete bannerReviewBusyTimeoutsRef.current[branchReviewId];
    }

    setBannerReviewBusyById((prev) => {
      if (!prev[branchReviewId]) return prev;
      const next = { ...prev };
      delete next[branchReviewId];
      return next;
    });
    setRefreshingBranchReviewId((current) => (current === branchReviewId ? null : current));

    bumpBranchReviewRefreshToken(branchReviewId);
    setBrRefreshKey((prev) => prev + 1);
    void refreshPersistentTopicBanner();
    toast.success('AI review cleared. Branch files and details are preserved.');
  }, [projectId, refreshPersistentTopicBanner, resetBranchReviewProgress, bumpBranchReviewRefreshToken]);

  // Shared project socket for branch and PR review events
  useEffect(() => {
    const unsubscribeSocket = subscribeProjectSocket(projectId, {
      'branch-review-update': (data: {
      type: 'created' | 'updated';
      branchReview?: {
        id: string;
        branchName: string;
        baseBranch: string;
        fileCount: number;
        commitCount?: number;
        headSha?: string | null;
        status?: BranchReviewStatus;
        isCurrent?: boolean;
        reviewStatus?: ReviewStatus;
        reviewLifecycle?: ReviewLifecycle | null;
        reviewError?: string | null;
        updatedAt?: string | null;
      };
    }) => {
      if (data.branchReview) {
        branchReviewApi.invalidateCache(projectId, data.branchReview.id);
        setLatestBranchSnapshotsById((prev) => {
          const next = { ...prev };
          const normalizedSnapshot = normalizeBranchSnapshot({
            id: data.branchReview!.id,
            branchName: data.branchReview!.branchName,
            baseBranch: data.branchReview!.baseBranch,
            fileCount: data.branchReview!.fileCount,
            commitCount: data.branchReview!.commitCount || 0,
            headSha: data.branchReview!.headSha || null,
            reviewStatus: data.branchReview!.reviewStatus || 'none',
            reviewLifecycle: data.branchReview!.reviewLifecycle || null,
            reviewError: data.branchReview!.reviewError || null,
            updatedAt: data.branchReview!.updatedAt || null,
          });
          if (shouldReplaceBranchSnapshot(next[data.branchReview!.id], normalizedSnapshot)) {
            next[data.branchReview!.id] = normalizedSnapshot;
          }
          return next;
        });
        const now = Date.now();
        const switchedRecently = (now - recentTopicSwitchAtRef.current) <= BRANCH_BANNER_SWITCH_WINDOW_MS;
        const current = selectedItemRef.current;
        const alreadyViewingThisReview = current?.type === 'branch_review' && current.id === data.branchReview.id;
        const isCurrentActiveReview = data.branchReview.isCurrent === true
          && (data.branchReview.status || 'active') === 'active';
        if (!current && isCurrentActiveReview) {
          handleSelectItem(data.branchReview.id, 'branch_review', { source: 'auto' });
        }
        if (alreadyViewingThisReview) {
          bumpBranchReviewRefreshToken(data.branchReview.id);
        }
        // Update the banner in two cases:
        // 1. Recently switched branches and not viewing this review (existing behavior)
        // 2. Currently viewing the updated review — keeps banner in sync so the
        //    staleness check and Refresh button work even if the async
        //    refreshPersistentTopicBanner() call is slow or fails.
        if (switchedRecently || alreadyViewingThisReview) {
          setBranchBanner((prev) => {
            // Don't overwrite transient banners
            if (prev?.type === 'no-changes' || prev?.type === 'detached') return prev;
            return {
              type: 'topic',
              branchName: data.branchReview!.branchName,
              baseBranch: data.branchReview!.baseBranch,
              fileCount: data.branchReview!.fileCount,
              commitCount: data.branchReview!.commitCount || 0,
              headSha: data.branchReview!.headSha || null,
              updatedAt: data.branchReview!.updatedAt || null,
              branchReviewId: data.branchReview!.id,
            };
          });
        }
      }
      setBrRefreshKey(prev => prev + 1);
      void refreshPersistentTopicBanner();
    },

      'branch-no-changes': (data: { branch: string; baseBranch: string }) => {
      setBranchBanner({ type: 'no-changes', branchName: data.branch, baseBranch: data.baseBranch });
      setTimeout(() => setBranchBanner(prev => prev?.type === 'no-changes' ? null : prev), 5000);
    },

      'detached-head': () => {
      setBranchBanner({ type: 'detached' });
    },

      'branch-switched': (data: {
        isBaseBranch?: boolean;
        isWorktree?: boolean;
        currentBranch?: string;
        previousBranch?: string | null;
      }) => {
      branchReviewApi.invalidateCache(projectId);
      if (data.isWorktree) {
        setBrRefreshKey(prev => prev + 1);
        return;
      }
      const nextBranch = typeof data.currentBranch === 'string' ? data.currentBranch.trim() : '';
      const previousBranch = typeof data.previousBranch === 'string' ? data.previousBranch.trim() : '';
      const isInitialBranchDetection = !previousBranch;
      const isSameBranch = Boolean(nextBranch && branchRef.current === nextBranch);
      const currentSelection = selectedItemRef.current;
      const selectionLocked = isExplicitReviewSelectionLocked({
        selection: currentSelection,
        source: selectedItemSourceRef.current,
      });
      if (!selectionLocked && !isInitialBranchDetection && !isSameBranch) {
        resetSelectionForBranchSwitch();
      }
      if (nextBranch) {
        setBranch(nextBranch);
      }
      if (data.isBaseBranch) {
        recentTopicSwitchAtRef.current = 0;
        setBranchBanner(null);
      } else {
        recentTopicSwitchAtRef.current = Date.now();
        void refreshPersistentTopicBanner();
        if (!selectionLocked) {
          void resolveCurrentReviewSelection(nextBranch || null);
        }
      }
      setBrRefreshKey(prev => prev + 1);
    },

      // Branch review AI review lifecycle events
      'branch-review-queued': (data: {
      branchReviewId?: string;
      queueId?: string | null;
      position?: number | null;
      updatedAt?: string;
      reviewLifecycle?: { updatedAt?: string } | null;
    }) => {
      if (data?.branchReviewId) {
        branchReviewApi.invalidateCache(projectId, data.branchReviewId);
        const queuedProgress = {
          queueId: data.queueId || null,
          phase: 'queued',
          currentChunk: 0,
          totalChunks: 0,
          filesCompleted: 0,
          totalFiles: 0,
          updatedAt: data.updatedAt || data.reviewLifecycle?.updatedAt || null,
        };
        const existingProgress = brProgressByIdRef.current[data.branchReviewId] || null;
        const existingPhase = String(existingProgress?.phase || '').trim().toLowerCase();
        const hasActiveProgress = Boolean(
          existingProgress
          && existingPhase !== 'queued'
          && (isActiveReviewProgressPhase(existingPhase) || hasInFlightOrPendingProgress(existingProgress))
        );
        if (hasActiveProgress) {
          const activeQueueId = existingProgress?.queueId || null;
          if (activeQueueId && data.queueId && activeQueueId === data.queueId) {
            clearQueuedBranchReviewRun(data.branchReviewId);
          } else {
            setBrQueuedRerunById((prev) => ({
              ...prev,
              [data.branchReviewId!]: {
                queueId: data.queueId || null,
                position: Number.isFinite(data.position) ? Number(data.position) : null,
                queuedAt: data.updatedAt || data.reviewLifecycle?.updatedAt || null,
                updatedAt: data.updatedAt || data.reviewLifecycle?.updatedAt || null,
                progress: queuedProgress,
              },
            }));
          }
        } else {
          clearQueuedBranchReviewRun(data.branchReviewId);
          resetBranchReviewProgress(data.branchReviewId);
          queueProgressUpdate(data.branchReviewId, queuedProgress);
        }
      }
      setBrRefreshKey(prev => prev + 1);
    },

      'branch-review-queued-cancelled': (data: {
      branchReviewId?: string;
      queueId?: string | null;
    }) => {
      if (data?.branchReviewId) {
        clearQueuedBranchReviewRun(data.branchReviewId);
      }
    },

      'branch-review-reviewing': (data: {
      branchReviewId?: string;
      queueId?: string | null;
      updatedAt?: string;
      reviewLifecycle?: { updatedAt?: string } | null;
    }) => {
      if (data?.branchReviewId) {
        branchReviewApi.invalidateCache(projectId, data.branchReviewId);
        setBrQueuedRerunById((prev) => {
          const queuedRun = prev[data.branchReviewId!];
          if (!queuedRun || (data.queueId && queuedRun.queueId && queuedRun.queueId !== data.queueId)) return prev;
          const next = { ...prev };
          delete next[data.branchReviewId!];
          return next;
        });
        resetBranchReviewProgress(data.branchReviewId);
        queueProgressUpdate(data.branchReviewId, {
          queueId: data.queueId || null,
          phase: 'reviewing',
          currentChunk: 0,
          totalChunks: 0,
          filesCompleted: 0,
          totalFiles: 0,
          updatedAt: data.updatedAt || data.reviewLifecycle?.updatedAt || null,
        });
      }
      setBrRefreshKey(prev => prev + 1);
    },

      'branch-review-progress': (data: {
      branchReviewId: string;
      phase?: string;
      currentChunk: number;
      totalChunks: number;
      filesCompleted: number;
      totalFiles: number;
      activeChunkFiles?: number;
      elapsedSeconds?: number;
      splitDepth?: number;
      splitParts?: number;
      agenticToolSummary?: string | null;
      agentName?: string | null;
      reviewModel?: string | null;
      reviewModelStrategy?: string | null;
      reviewModelEffectiveStrategy?: string | null;
      diffScopeMode?: 'full' | 'delta' | null;
      diffScopeCommitCount?: number;
      diffBaseSha?: string | null;
      diffHeadSha?: string | null;
      prRequestedMode?: 'auto' | 'full' | 'agentic_discovery' | null;
      prEffectiveMode?: 'auto' | 'full' | 'agentic_discovery' | null;
      prPipelineMode?: 'standard' | 'agentic_discovery' | null;
      totalPrFiles?: number;
      effectiveReviewFiles?: number;
      partialMode?: boolean;
      totalScopeFiles?: number;
      queueId?: string | null;
      updatedAt?: string;
      reviewLifecycle?: { updatedAt?: string } | null;
    }) => {
      if (!data?.branchReviewId) return;
      if (data.queueId) {
        setBrQueuedRerunById((prev) => {
          const queuedRun = prev[data.branchReviewId];
          if (!queuedRun || queuedRun.queueId !== data.queueId) return prev;
          const next = { ...prev };
          delete next[data.branchReviewId];
          return next;
        });
      }
      queueProgressUpdate(data.branchReviewId, {
        queueId: data.queueId || null,
        phase: data.phase,
        currentChunk: data.currentChunk || 0,
        totalChunks: data.totalChunks || 0,
        filesCompleted: data.filesCompleted || 0,
        totalFiles: data.totalFiles || 0,
        activeChunkFiles: data.activeChunkFiles || 0,
        elapsedSeconds: data.elapsedSeconds || 0,
        splitDepth: data.splitDepth || 0,
        splitParts: data.splitParts || 0,
        agenticToolSummary: data.agenticToolSummary || null,
        agentName: data.agentName || null,
        reviewModel: data.reviewModel || null,
        reviewModelStrategy: data.reviewModelStrategy || null,
        reviewModelEffectiveStrategy: data.reviewModelEffectiveStrategy || null,
        diffScopeMode: data.diffScopeMode === 'delta'
          ? 'delta'
          : data.diffScopeMode === 'full'
            ? 'full'
            : null,
        diffScopeCommitCount: data.diffScopeCommitCount || 0,
        diffBaseSha: data.diffBaseSha || null,
        diffHeadSha: data.diffHeadSha || null,
        prRequestedMode: data.prRequestedMode || null,
        prEffectiveMode: data.prEffectiveMode || null,
        prPipelineMode: data.prPipelineMode || null,
        totalPrFiles: data.totalPrFiles || 0,
        effectiveReviewFiles: data.effectiveReviewFiles || 0,
        partialMode: data.partialMode === true,
        totalScopeFiles: data.totalScopeFiles || 0,
        updatedAt: data.updatedAt || data.reviewLifecycle?.updatedAt || null,
      });
    },

      'branch-review-reviewed': (data: {
      branchReviewId: string;
      reviewStatus?: ReviewStatus;
      reviewLifecycle?: ReviewLifecycle | null;
      error?: string | null;
    }) => {
      clearBannerReviewBusy(data.branchReviewId);
      branchReviewApi.invalidateCache(projectId, data.branchReviewId);
      bumpBranchReviewRefreshToken(data.branchReviewId);
      if (data.branchReviewId) {
        delete progressBufferRef.current[data.branchReviewId];
        clearQueuedBranchReviewRun(data.branchReviewId);
      }
      setBrProgressById(prev => {
        if (!data?.branchReviewId || !prev[data.branchReviewId]) return prev;
        const next = { ...prev };
        delete next[data.branchReviewId];
        return next;
      });
      // Immediately mark snapshot as terminal so the banner doesn't show stale "Queued"
      // while waiting for the async refreshPersistentTopicBanner() API response.
      if (data.branchReviewId) {
        setLatestBranchSnapshotsById((prev) => {
          const existing = prev[data.branchReviewId];
          if (!existing) return prev;
          const normalizedSnapshot = normalizeBranchSnapshot({
            id: existing.id,
            branchName: existing.branchName,
            baseBranch: existing.baseBranch,
            headSha: existing.headSha,
            commitCount: existing.commitCount,
            fileCount: existing.fileCount,
            reviewStatus: data.reviewStatus || 'reviewed',
            reviewLifecycle: data.reviewLifecycle || null,
            reviewError: data.error || null,
            updatedAt: data.reviewLifecycle?.updatedAt || existing.updatedAt || null,
          });
          if (!shouldReplaceBranchSnapshot(existing, normalizedSnapshot)) {
            return prev;
          }
          return {
            ...prev,
            [data.branchReviewId]: normalizedSnapshot,
          };
        });
      }
      setBrRefreshKey(prev => prev + 1);
      void refreshPersistentTopicBanner();
    },

      'branch-review-review-failed': (data: {
      branchReviewId?: string;
      reviewStatus?: ReviewStatus;
      reviewLifecycle?: ReviewLifecycle | null;
      error?: string | null;
    }) => {
      if (data?.branchReviewId) {
        clearBannerReviewBusy(data.branchReviewId);
        clearQueuedBranchReviewRun(data.branchReviewId);
        branchReviewApi.invalidateCache(projectId, data.branchReviewId);
        bumpBranchReviewRefreshToken(data.branchReviewId);
        delete progressBufferRef.current[data.branchReviewId];
        setBrProgressById(prev => {
          if (!prev[data.branchReviewId!]) return prev;
          const next = { ...prev };
          delete next[data.branchReviewId!];
          return next;
        });
        // Immediately mark snapshot as terminal (failed) so the banner doesn't show stale "Queued"
        setLatestBranchSnapshotsById((prev) => {
          const existing = prev[data.branchReviewId!];
          if (!existing) return prev;
          const normalizedSnapshot = normalizeBranchSnapshot({
            id: existing.id,
            branchName: existing.branchName,
            baseBranch: existing.baseBranch,
            headSha: existing.headSha,
            commitCount: existing.commitCount,
            fileCount: existing.fileCount,
            reviewStatus: data.reviewStatus || 'failed',
            reviewLifecycle: data.reviewLifecycle || null,
            reviewError: data.error || null,
            updatedAt: data.reviewLifecycle?.updatedAt || existing.updatedAt || null,
          });
          if (!shouldReplaceBranchSnapshot(existing, normalizedSnapshot)) {
            return prev;
          }
          return {
            ...prev,
            [data.branchReviewId!]: normalizedSnapshot,
          };
        });
      }
      setBrRefreshKey(prev => prev + 1);
      void refreshPersistentTopicBanner();
    },

      'branch-review-stopped': (data: {
      branchReviewId?: string;
      reviewStatus?: ReviewStatus;
      reviewLifecycle?: ReviewLifecycle | null;
    }) => {
      if (data?.branchReviewId) {
        clearBannerReviewBusy(data.branchReviewId);
        clearQueuedBranchReviewRun(data.branchReviewId);
        branchReviewApi.invalidateCache(projectId, data.branchReviewId);
        bumpBranchReviewRefreshToken(data.branchReviewId);
        delete progressBufferRef.current[data.branchReviewId];
        setBrProgressById(prev => {
          if (!prev[data.branchReviewId!]) return prev;
          const next = { ...prev };
          delete next[data.branchReviewId!];
          return next;
        });
        setLatestBranchSnapshotsById((prev) => {
          const existing = prev[data.branchReviewId!];
          if (!existing) return prev;
          const stoppedReviewStatus = data.reviewStatus
            || (existing.reviewSourceStatus && existing.reviewSourceStatus !== 'none' ? existing.reviewSourceStatus as ReviewStatus : 'none');
          const normalizedSnapshot = normalizeBranchSnapshot({
            id: existing.id,
            branchName: existing.branchName,
            baseBranch: existing.baseBranch,
            headSha: existing.headSha,
            commitCount: existing.commitCount,
            fileCount: existing.fileCount,
            reviewStatus: stoppedReviewStatus,
            reviewLifecycle: data.reviewLifecycle || null,
            reviewError: null,
            updatedAt: data.reviewLifecycle?.updatedAt || existing.updatedAt || null,
          });
          if (!shouldReplaceBranchSnapshot(existing, normalizedSnapshot)) {
            return prev;
          }
          return {
            ...prev,
            [data.branchReviewId!]: normalizedSnapshot,
          };
        });
      }
      setBrRefreshKey(prev => prev + 1);
      void refreshPersistentTopicBanner();
    },

      // ── PR review socket events ──
      'pr-review-queued': (data: {
      prReviewId?: string;
      updatedAt?: string;
      reviewLifecycle?: { updatedAt?: string } | null;
    }) => {
      if (data?.prReviewId) {
        prReviewApi.invalidateCache(projectId, data.prReviewId);
        queueProgressUpdate(data.prReviewId, {
          phase: 'queued',
          currentChunk: 0,
          totalChunks: 0,
          filesCompleted: 0,
          totalFiles: 0,
          updatedAt: data.updatedAt || data.reviewLifecycle?.updatedAt || null,
        });
      }
      beginSelectedPrRefresh(data?.prReviewId);
      setPrRefreshKey(prev => prev + 1);
    },
      'pr-review-reviewing': (data: {
      prReviewId?: string;
      updatedAt?: string;
      reviewLifecycle?: { updatedAt?: string } | null;
    }) => {
      if (data?.prReviewId) {
        prReviewApi.invalidateCache(projectId, data.prReviewId);
        resetBranchReviewProgress(data.prReviewId);
        queueProgressUpdate(data.prReviewId, {
          phase: 'reviewing',
          currentChunk: 0,
          totalChunks: 0,
          filesCompleted: 0,
          totalFiles: 0,
          diffScopeMode: null,
          diffScopeCommitCount: 0,
          diffBaseSha: null,
          diffHeadSha: null,
          updatedAt: data.updatedAt || data.reviewLifecycle?.updatedAt || null,
        });
      }
      beginSelectedPrRefresh(data?.prReviewId);
      setPrRefreshKey(prev => prev + 1);
    },
      'pr-review-progress': (data: {
      prReviewId: string;
      phase?: string;
      currentChunk: number;
      totalChunks: number;
      filesCompleted: number;
      totalFiles: number;
      activeChunkFiles?: number;
      elapsedSeconds?: number;
      splitDepth?: number;
      splitParts?: number;
      agenticToolSummary?: string | null;
      agentName?: string | null;
      reviewModel?: string | null;
      reviewModelStrategy?: string | null;
      reviewModelEffectiveStrategy?: string | null;
      diffScopeMode?: 'full' | 'delta' | null;
      diffScopeCommitCount?: number;
      diffBaseSha?: string | null;
      diffHeadSha?: string | null;
      updatedAt?: string;
      reviewLifecycle?: { updatedAt?: string } | null;
    }) => {
      if (!data?.prReviewId) return;
      queueProgressUpdate(data.prReviewId, {
        phase: data.phase,
        currentChunk: data.currentChunk || 0,
        totalChunks: data.totalChunks || 0,
        filesCompleted: data.filesCompleted || 0,
        totalFiles: data.totalFiles || 0,
        activeChunkFiles: data.activeChunkFiles || 0,
        elapsedSeconds: data.elapsedSeconds || 0,
        splitDepth: data.splitDepth || 0,
        splitParts: data.splitParts || 0,
        agenticToolSummary: data.agenticToolSummary || null,
        agentName: data.agentName || null,
        reviewModel: data.reviewModel || null,
        reviewModelStrategy: data.reviewModelStrategy || null,
        reviewModelEffectiveStrategy: data.reviewModelEffectiveStrategy || null,
        diffScopeMode: data.diffScopeMode === 'delta'
          ? 'delta'
          : data.diffScopeMode === 'full'
            ? 'full'
            : null,
        diffScopeCommitCount: data.diffScopeCommitCount || 0,
        diffBaseSha: data.diffBaseSha || null,
        diffHeadSha: data.diffHeadSha || null,
        updatedAt: data.updatedAt || data.reviewLifecycle?.updatedAt || null,
      });
    },
      'pr-review-reviewed': (data: {
      prReviewId?: string;
      reviewLifecycle?: ReviewLifecycle | null;
    }) => {
      if (data?.prReviewId) {
        prReviewApi.invalidateCache(projectId, data.prReviewId);
        clearBannerReviewBusy(data.prReviewId);
        bumpBranchReviewRefreshToken(data.prReviewId);
        delete progressBufferRef.current[data.prReviewId];
        setBrProgressById(prev => {
          if (!prev[data.prReviewId!]) return prev;
          const next = { ...prev };
          delete next[data.prReviewId!];
          return next;
        });
      }
      beginSelectedPrRefresh(data?.prReviewId);
      setPrRefreshKey(prev => prev + 1);
    },
      'pr-review-review-failed': (data: {
      prReviewId?: string;
      error?: string | null;
      reviewLifecycle?: ReviewLifecycle | null;
    }) => {
      if (data?.prReviewId) {
        prReviewApi.invalidateCache(projectId, data.prReviewId);
        clearBannerReviewBusy(data.prReviewId);
        bumpBranchReviewRefreshToken(data.prReviewId);
        delete progressBufferRef.current[data.prReviewId];
        setBrProgressById(prev => {
          if (!prev[data.prReviewId!]) return prev;
          const next = { ...prev };
          delete next[data.prReviewId!];
          return next;
        });
      }
      beginSelectedPrRefresh(data?.prReviewId);
      setPrRefreshKey(prev => prev + 1);
    },
      'pr-review-stopped': (data: {
      prReviewId?: string;
      reviewLifecycle?: ReviewLifecycle | null;
    }) => {
      if (data?.prReviewId) {
        prReviewApi.invalidateCache(projectId, data.prReviewId);
        clearBannerReviewBusy(data.prReviewId);
        bumpBranchReviewRefreshToken(data.prReviewId);
        delete progressBufferRef.current[data.prReviewId];
        setBrProgressById(prev => {
          if (!prev[data.prReviewId!]) return prev;
          const next = { ...prev };
          delete next[data.prReviewId!];
          return next;
        });
      }
      beginSelectedPrRefresh(data?.prReviewId);
      setPrRefreshKey(prev => prev + 1);
    },
      'pr-sync-started': (data: {
        source?: string | null;
      }) => {
      if (data?.source === 'auto' && !projectLoadPrSyncSettledRef.current) {
        projectLoadPrSyncPopupShownRef.current = false;
      }
      setPrAccessDenied(false);
      setPrSyncInProgress(true);
    },
      'pr-sync-completed': (data: {
        source?: string | null;
      }) => {
      setPrSyncInProgress(false);
      setPrAccessDenied(false);
      if (data?.source === 'auto' && !projectLoadPrSyncSettledRef.current) {
        projectLoadPrSyncSettledRef.current = true;
      }
      beginSelectedPrRefresh();
      setPrRefreshKey(prev => prev + 1);
    },
      'pr-sync-failed': (data: {
        error?: string | null;
        source?: string | null;
        code?: string | null;
        connectedLogin?: string | null;
        owner?: string | null;
        repo?: string | null;
      }) => {
      setPrSyncInProgress(false);
      if (!data?.error) {
        return;
      }
      const looksLikeRepoAccessDenied = data?.code === 'GITHUB_REPO_ACCESS_DENIED'
        || /cannot access pull requests/i.test(String(data.error || ''));
      if (looksLikeRepoAccessDenied) {
        setPrAccessDenied(true);
      }
      if (data?.source === 'auto') {
        if (!projectLoadPrSyncSettledRef.current) {
          projectLoadPrSyncSettledRef.current = true;
        }
        if (looksLikeRepoAccessDenied) {
          void buildGitHubRepoAccessDeniedToast(data).then(({ title, popupMessage }) => {
            if (!projectLoadPrSyncPopupShownRef.current) {
              projectLoadPrSyncPopupShownRef.current = true;
              void popup.alert({
                title,
                message: popupMessage,
                okLabel: 'OK',
              });
            }
          });
          return;
        }
        toast.error(data.error);
        return;
      }
      if (looksLikeRepoAccessDenied) {
        void buildGitHubRepoAccessDeniedToast(data).then(({ title, description }) => {
          toast.error(title, {
            description,
            duration: 5200,
          });
        });
        return;
      }
      toast.error(data.error);
    },
    });

    return () => {
      unsubscribeSocket();
    };
  }, [projectId, refreshPersistentTopicBanner, clearBannerReviewBusy, clearQueuedBranchReviewRun, queueProgressUpdate, bumpBranchReviewRefreshToken, resetBranchReviewProgress, resetSelectionForBranchSwitch, resolveCurrentReviewSelection, buildGitHubRepoAccessDeniedToast, popup, beginSelectedPrRefresh]);

  // Reconcile in-memory BR progress with persisted review status.
  // Prevents stuck progress state when terminal socket events are missed.
  useEffect(() => {
    if (activeProgressCount === 0) return;

    let cancelled = false;
    const reconcileProgress = async () => {
      try {
        const [branchResult, prResult, workspaceResult] = await Promise.allSettled([
          branchReviewApi.list(projectId),
          prReviewApi.list(projectId),
          workspaceReviewApi.list(projectId),
        ]);
        if (cancelled) return;

        const reviewStateById = new Map<string, { status: ReviewLifecycleStatus; updatedAt: string | null }>();
        if (branchResult.status === 'fulfilled') {
          for (const review of branchResult.value.branchReviews || []) {
            reviewStateById.set(review.id, {
              status: normalizeLifecycleStatusValue(
                review.reviewLifecycle?.status || review.reviewLifecycle?.sourceStatus || review.reviewStatus || 'none',
                'completed'
              ),
              updatedAt: review.reviewLifecycle?.updatedAt || review.updatedAt || null,
            });
          }
        }
        if (prResult.status === 'fulfilled') {
          for (const review of prResult.value.prReviews || []) {
            reviewStateById.set(review.id, {
              status: normalizeLifecycleStatusValue(
                review.reviewLifecycle?.status || review.reviewLifecycle?.sourceStatus || review.reviewStatus || 'none',
                'completed'
              ),
              updatedAt: review.reviewLifecycle?.updatedAt || review.updatedAt || null,
            });
          }
        }
        if (workspaceResult.status === 'fulfilled') {
          for (const review of (workspaceResult.value.workspaceReviews || []) as WorkspaceReview[]) {
            reviewStateById.set(review.id, {
              status: normalizeLifecycleStatusValue(
                review.reviewLifecycle?.status || review.reviewLifecycle?.sourceStatus || review.reviewStatus || 'none',
                'completed'
              ),
              updatedAt: review.reviewLifecycle?.updatedAt || review.updatedAt || null,
            });
          }
        }
        if (
          branchResult.status === 'rejected'
          && prResult.status === 'rejected'
          && workspaceResult.status === 'rejected'
        ) {
          return;
        }
        const staleIds: string[] = [];

        setBrProgressById((prev) => {
          let changed = false;
          const next: Record<string, BranchReviewProgress> = { ...prev };

          for (const [branchReviewId, progress] of Object.entries(prev)) {
            const reviewState = reviewStateById.get(branchReviewId);
            const status = reviewState?.status;
            const shouldClear = shouldClearStaleProgress(progress, status, reviewState?.updatedAt || null);
            if (shouldClear) {
              delete next[branchReviewId];
              staleIds.push(branchReviewId);
              changed = true;
            }
          }

          return changed ? next : prev;
        });

        staleIds.forEach((id) => clearBannerReviewBusy(id));
        staleIds.forEach((id) => {
          delete progressBufferRef.current[id];
        });
      } catch {
        // Best-effort reconciliation only.
      }
    };

    void reconcileProgress();
    const intervalId = window.setInterval(() => {
      void reconcileProgress();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [projectId, activeProgressCount, clearBannerReviewBusy, brRefreshKey]);

  const selectedBranchReviewId = selectedItem?.type === 'branch_review'
    ? selectedItem.id
    : null;
  const showInitialProjectLoadState = !selectedItem && (
    isProjectMetaLoading
    || isReviewListInitialLoading
    || isWithinInitialProjectLoadGrace
  );
  const initialProjectLoadLabel = isProjectMetaLoading
    ? 'Opening project…'
    : isReviewListInitialLoading
      ? 'Loading reviews…'
      : 'Finishing first load…';
  const initialProjectLoadMeta = isProjectMetaLoading
    ? 'Atlas is loading project metadata and branch state.'
    : isReviewListInitialLoading
      ? 'Atlas is resolving the current branch and local changes first. Pull requests load in the background.'
      : 'Large projects can take longer on first open. Atlas is waiting for the initial review selection.';
  const currentBaseBranchName = project?.baseBranchDisplay
    || project?.baseBranchRef
    || branchBanner?.baseBranch
    || null;
  const emptyStateBranchName = initialBaseBranchName || branch;
  const normalizedCurrentBaseBranchName = normalizeBranchNameForBaseComparison(currentBaseBranchName);
  const hasCurrentBranchContext = !selectedItem && Boolean(emptyStateBranchName);
  const currentBranchIsBase = Boolean(
    emptyStateBranchName
    && normalizedCurrentBaseBranchName
    && normalizeBranchNameForBaseComparison(emptyStateBranchName) === normalizedCurrentBaseBranchName
  );
  const emptyReviewTitle = emptyStateBranchName
    ? (currentBranchIsBase ? `${emptyStateBranchName} is the base branch` : `Current branch: ${emptyStateBranchName}`)
    : 'No review selected';
  const emptyReviewMessage = emptyStateBranchName
    ? (
      currentBranchIsBase
        ? `Atlas does not review the base branch against itself. Use Last commit to review the latest commit on ${emptyStateBranchName}.`
        : `Atlas has not selected a branch review or pull request yet. If ${emptyStateBranchName} has reviewable changes${currentBaseBranchName ? ` against ${currentBaseBranchName}` : ''}, it will appear here once detected.`
    )
    : 'Select a branch review or pull request to view AI review details.';
  const emptyDiffMessage = emptyStateBranchName
    ? (
      currentBranchIsBase
        ? `Base branches are not reviewed against themselves. Use the latest-commit scope to inspect files and run review.`
        : `Waiting for a branch review or pull request for ${emptyStateBranchName}${currentBaseBranchName ? ` vs ${currentBaseBranchName}` : ''}.`
    )
    : 'Select a review item to view diff';
  useEffect(() => {
    if (!currentBranchIsBase || !emptyStateBranchName) {
      setBaseLastCommitPreview(null);
      setBaseLastCommitPreviewError(null);
      setBaseLastCommitPreviewLoading(false);
      return undefined;
    }

    let cancelled = false;
    setBaseLastCommitPreviewLoading(true);
    setBaseLastCommitPreviewError(null);
    void (async () => {
      try {
        const response = await branchReviewApi.getLastCommitPreview(projectId, emptyStateBranchName);
        if (cancelled) return;
        setBaseLastCommitPreview(response.preview || null);
      } catch (error: any) {
        if (cancelled) return;
        setBaseLastCommitPreview(null);
        setBaseLastCommitPreviewError(
          error?.response?.data?.error
          || error?.message
          || 'Unable to load latest commit metadata.'
        );
      } finally {
        if (!cancelled) setBaseLastCommitPreviewLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentBranchIsBase, emptyStateBranchName, projectId]);
  const selectedLatestSnapshot = selectedBranchReviewId
    ? latestBranchSnapshotsById[selectedBranchReviewId] || null
    : null;
  const selectedLoadedSnapshot = selectedBranchReviewId
    ? loadedBranchSnapshotsById[selectedBranchReviewId] || null
    : null;
  const selectedBranchHeadChanged = Boolean(
    selectedLatestSnapshot?.headSha
    && selectedLoadedSnapshot?.headSha
    && selectedLatestSnapshot.headSha !== selectedLoadedSnapshot.headSha
  );
  const selectedBranchCommitDelta = selectedLatestSnapshot && selectedLoadedSnapshot
    ? selectedLatestSnapshot.commitCount - selectedLoadedSnapshot.commitCount
    : 0;
  const selectedBranchFileDelta = selectedLatestSnapshot && selectedLoadedSnapshot
    ? selectedLatestSnapshot.fileCount - selectedLoadedSnapshot.fileCount
    : 0;
  const selectedBranchUpdatedDeltaMs = selectedLatestSnapshot?.updatedAt && selectedLoadedSnapshot?.updatedAt
    ? Math.max(0, new Date(selectedLatestSnapshot.updatedAt).getTime() - new Date(selectedLoadedSnapshot.updatedAt).getTime())
    : 0;
  const selectedBranchSnapshotStale = Boolean(
    selectedLatestSnapshot
    && selectedLoadedSnapshot
    && (
      selectedBranchHeadChanged
      || selectedBranchCommitDelta > 0
      || (selectedBranchUpdatedDeltaMs > 0 && selectedBranchFileDelta !== 0)
    )
  );
  const showBranchRefreshAction = Boolean(
    branchBanner?.type === 'topic'
    && branchBanner.branchReviewId
    && selectedBranchReviewId
    && selectedBranchReviewId === branchBanner.branchReviewId
    && selectedBranchSnapshotStale
  );
  const isRefreshingSelectedBranch = Boolean(
    refreshingBranchReviewId
    && selectedBranchReviewId
    && refreshingBranchReviewId === selectedBranchReviewId
  );
  const branchSnapshotStaleMessage = selectedBranchSnapshotStale
    ? 'Branch changed since this loaded snapshot. Refresh files before approving.'
    : null;
  const reviewNowTargetBranchReviewId = selectedItem?.type === 'branch_review'
    ? selectedItem.id
    : selectedItem?.type === 'pr_review'
      ? selectedItem.id
      : (branchBanner?.branchReviewId || null);
  const hasTopBannerReviewAction = Boolean(
    branchBanner?.type === 'topic' && reviewNowTargetBranchReviewId
  );
  const branchBannerProgress = reviewNowTargetBranchReviewId
    ? brProgressById[reviewNowTargetBranchReviewId] || null
    : null;
  const queuedRerunForActiveReview = reviewNowTargetBranchReviewId
    ? brQueuedRerunById[reviewNowTargetBranchReviewId] || null
    : null;
  const queuedRerunCancelDisabled = reviewNowTargetBranchReviewId
    ? Boolean(cancellingQueuedReviewById[reviewNowTargetBranchReviewId])
    : false;
  const queuedRerunNotice = queuedRerunForActiveReview ? (
    <QueuedReviewPill
      position={queuedRerunForActiveReview.position}
      detail="Will start after the current review finishes"
      onCancel={queuedRerunForActiveReview.queueId && reviewNowTargetBranchReviewId
        ? () => { void handleCancelQueuedBranchReview(reviewNowTargetBranchReviewId, queuedRerunForActiveReview.queueId); }
        : undefined}
      cancelDisabled={queuedRerunCancelDisabled || !queuedRerunForActiveReview.queueId}
    />
  ) : null;
  const selectedLatestReviewLifecycleStatus = selectedLatestSnapshot?.reviewLifecycleStatus || 'completed';
  const selectedLatestReviewSourceStatus = normalizeLegacyReviewStatusValue(
    selectedLatestSnapshot?.reviewSourceStatus || selectedLatestSnapshot?.reviewStatus || 'none',
    'none'
  );
  const branchBannerProgressPhase = String(branchBannerProgress?.phase || '').toLowerCase();
  const branchBannerProgressHasActiveReviewWork = Boolean(
    (branchBannerProgress && isActiveReviewProgressPhase(branchBannerProgressPhase))
    || hasInFlightOrPendingProgress(branchBannerProgress)
  );
  const branchBannerUpdatedAtParsed = selectedLatestSnapshot?.updatedAt
    ? Date.parse(selectedLatestSnapshot.updatedAt)
    : 0;
  const branchBannerUpdatedAtMs = Number.isFinite(branchBannerUpdatedAtParsed) ? branchBannerUpdatedAtParsed : 0;
  const branchBannerLifecycleStale = Boolean(
    !branchBannerProgress
    && selectedLatestSnapshot
    && (
      selectedLatestSnapshot.reviewLifecycleIsActive
      || isActiveLifecycleStatus(selectedLatestReviewLifecycleStatus)
    )
    && branchBannerUpdatedAtMs > 0
    && (Date.now() - branchBannerUpdatedAtMs) > STALE_BACKGROUND_REVIEW_MS
  );
  const branchBannerQueued = !branchBannerLifecycleStale && (
    branchBannerProgressPhase === 'queued'
    || (!branchBannerProgress && selectedLatestReviewLifecycleStatus === 'queued')
  );
  const branchBannerRetrying = !branchBannerQueued && (
    branchBannerProgressPhase === 'provider_retry'
    || branchBannerProgressPhase === 'retrying'
    || (!branchBannerLifecycleStale && !branchBannerProgress && selectedLatestReviewLifecycleStatus === 'retrying')
  );
  const branchBannerReviewing = !branchBannerQueued && !branchBannerRetrying && (
    branchBannerProgressHasActiveReviewWork
    || (
      !branchBannerLifecycleStale
      && !branchBannerProgress
      && selectedLatestSnapshot?.reviewLifecycleIsActive === true
      && selectedLatestReviewLifecycleStatus === 'running'
    )
  );
  const branchBannerReviewFailed = !branchBannerQueued
    && !branchBannerRetrying
    && !branchBannerReviewing
    && selectedLatestReviewLifecycleStatus === 'failed';
  const branchBannerReviewPartial = !branchBannerQueued
    && !branchBannerRetrying
    && !branchBannerReviewing
    && selectedLatestReviewLifecycleStatus === 'partial';
  const branchBannerReviewCompleted = !branchBannerQueued
    && !branchBannerRetrying
    && !branchBannerReviewing
    && (
      (
        selectedLatestReviewLifecycleStatus === 'completed'
        && selectedLatestReviewSourceStatus !== 'none'
      )
      || Boolean(selectedBranchReviewJson)
    );
  const branchBannerReviewStatusLabel = branchBannerLifecycleStale
    ? 'Stale'
    : branchBannerQueued
      ? 'Queued'
      : branchBannerRetrying
        ? 'Retrying'
      : branchBannerReviewing
        ? 'Running'
        : branchBannerReviewFailed
          ? 'Failed'
          : branchBannerReviewPartial
            ? 'Partial'
          : branchBannerReviewCompleted
            ? 'Completed'
            : 'Not reviewed';
  const branchBannerReviewStatusColor = branchBannerLifecycleStale
    ? 'var(--accent-yellow)'
    : branchBannerQueued || branchBannerReviewing
      ? 'var(--accent-purple)'
    : branchBannerRetrying
      ? 'var(--accent-yellow)'
    : branchBannerReviewFailed
      ? 'var(--accent-red)'
      : branchBannerReviewPartial
        ? 'var(--accent-yellow)'
      : branchBannerReviewCompleted
        ? 'var(--accent-green)'
        : 'var(--text-tertiary)';
  const branchBannerStarting = Boolean(
    reviewNowTargetBranchReviewId
    && bannerReviewBusyById[reviewNowTargetBranchReviewId]
    && !branchBannerQueued
    && !branchBannerRetrying
    && !branchBannerReviewing
  );
  const branchBannerReviewBusy = branchBannerStarting || branchBannerQueued || branchBannerRetrying || branchBannerReviewing;
  const branchBannerScopeSummary = getDiffScopeSummaryFromStats(
    branchBannerProgress
      ? {
          diffScopeMode: branchBannerProgress.diffScopeMode || undefined,
          diffScopeCommitCount: branchBannerProgress.diffScopeCommitCount || 0,
          diffBaseSha: branchBannerProgress.diffBaseSha || null,
          diffHeadSha: branchBannerProgress.diffHeadSha || null,
          totalChangedFiles: branchBannerProgress.totalFiles || 0,
        }
      : null,
    branchBannerProgress?.totalFiles
  );
  const branchBannerScopeLabel = branchBannerReviewBusy && branchBannerScopeSummary
    ? branchBannerScopeSummary.longLabel
    : null;
  const selectedLatestHasTerminalReview = selectedLatestReviewSourceStatus !== 'none'
    && (
      branchBannerLifecycleStale
      || selectedLatestSnapshot?.reviewLifecycleIsTerminal === true
      || TERMINAL_LIFECYCLE_STATUSES.has(selectedLatestReviewLifecycleStatus)
    )
    || Boolean(selectedBranchReviewJson);
  const isPrSelected = selectedItem?.type === 'pr_review';
  const selectedPrManualLineCommentStorageKey = isPrSelected && selectedItem?.id
    ? buildManualLineCommentStorageKey({ projectId, prReviewId: selectedItem.id })
    : null;
  const [savedManualLineCommentCount, setSavedManualLineCommentCount] = useState(0);
  const refreshSavedManualLineCommentCount = useCallback(() => {
    if (!selectedPrManualLineCommentStorageKey) {
      setSavedManualLineCommentCount(0);
      return;
    }
    try {
      const raw = localStorage.getItem(selectedPrManualLineCommentStorageKey);
      if (!raw) {
        setSavedManualLineCommentCount(0);
        return;
      }
      const comments = normalizeManualLineCommentMap(JSON.parse(raw));
      setSavedManualLineCommentCount(Object.values(comments).filter((entry) => String(entry.body || '').trim()).length);
    } catch {
      setSavedManualLineCommentCount(0);
    }
  }, [selectedPrManualLineCommentStorageKey]);

  useEffect(() => {
    refreshSavedManualLineCommentCount();
  }, [refreshSavedManualLineCommentCount]);

  useEffect(() => {
    if (!selectedPrManualLineCommentStorageKey) return undefined;
    const handleDraftsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; storageKey?: string }>).detail;
      if (!detail || detail.kind !== 'manual_line' || detail.storageKey !== selectedPrManualLineCommentStorageKey) return;
      refreshSavedManualLineCommentCount();
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== selectedPrManualLineCommentStorageKey) return;
      refreshSavedManualLineCommentCount();
    };
    window.addEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, handleDraftsUpdated as EventListener);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, handleDraftsUpdated as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, [refreshSavedManualLineCommentCount, selectedPrManualLineCommentStorageKey]);

  const prBannerLifecycleStatus = normalizeLifecycleStatusValue(
    selectedPrReview?.reviewLifecycle?.status || selectedPrReview?.reviewLifecycle?.sourceStatus || selectedPrReview?.reviewStatus || 'none',
    'completed'
  );
  const prBannerSourceStatus = normalizeLegacyReviewStatusValue(
    selectedPrReview?.reviewLifecycle?.sourceStatus || selectedPrReview?.reviewStatus || 'none',
    'none'
  );
  const prBannerPhase = String(selectedPrReview?.reviewLifecycle?.phase || '').trim().toLowerCase();
  const prBannerProgress = selectedPrReview?.id
    ? brProgressById[selectedPrReview.id] || null
    : null;
  const prBannerScopeSummary = getDiffScopeSummaryFromStats(
    prBannerProgress
      ? {
          diffScopeMode: prBannerProgress.diffScopeMode || undefined,
          diffScopeCommitCount: prBannerProgress.diffScopeCommitCount || 0,
          diffBaseSha: prBannerProgress.diffBaseSha || null,
          diffHeadSha: prBannerProgress.diffHeadSha || null,
          fileCount: prBannerProgress.totalFiles || 0,
          totalChangedFiles: prBannerProgress.totalFiles || 0,
        }
      : selectedPrReview?.reviewJson?.stats || null,
    prBannerProgress?.totalFiles || selectedPrReview?.reviewJson?.stats?.fileCount || selectedPrReview?.fileCount
  );
  const prBannerProgressPhase = String(prBannerProgress?.phase || '').trim().toLowerCase();
  const prBannerProgressHasActiveReviewWork = Boolean(
    (prBannerProgress && isActiveReviewProgressPhase(prBannerProgressPhase))
    || hasInFlightOrPendingProgress(prBannerProgress)
  );
  const prBannerQueued = prBannerProgressPhase === 'queued'
    || (!prBannerProgress && (prBannerPhase === 'queued' || prBannerLifecycleStatus === 'queued'));
  const prBannerRetrying = !prBannerQueued && (
    prBannerProgressPhase === 'retrying'
    || prBannerProgressPhase === 'provider_retry'
    || (!prBannerProgress && (prBannerPhase === 'retrying' || prBannerPhase === 'provider_retry' || prBannerLifecycleStatus === 'retrying'))
  );
  const prBannerReviewing = !prBannerQueued && !prBannerRetrying && (
    prBannerProgressHasActiveReviewWork
    || (!prBannerProgress && prBannerLifecycleStatus === 'running')
  );
  const prBannerReviewFailed = !prBannerQueued && !prBannerRetrying && !prBannerReviewing && prBannerLifecycleStatus === 'failed';
  const prBannerReviewPartial = !prBannerQueued && !prBannerRetrying && !prBannerReviewing && prBannerLifecycleStatus === 'partial';
  const prBannerReviewCompleted = !prBannerQueued
    && !prBannerRetrying
    && !prBannerReviewing
    && (
      (
        prBannerLifecycleStatus === 'completed'
        && prBannerSourceStatus !== 'none'
      )
      || Boolean(selectedPrReview?.reviewJson)
    );
  const selectedPrReviewInitialLoading = selectedPrReviewLoading && !selectedPrReview;
  const prBannerReviewStatusLabel = selectedPrReviewInitialLoading
    ? 'Loading'
    : prBannerQueued
      ? 'Queued'
      : prBannerRetrying
        ? 'Retrying'
      : prBannerReviewing
        ? 'Running'
      : prBannerReviewFailed
        ? 'Failed'
      : prBannerReviewPartial
        ? 'Partial'
      : prBannerReviewCompleted
        ? 'Completed'
      : 'Not reviewed';
  const prBannerReviewStatusColor = selectedPrReviewInitialLoading
    ? 'var(--text-tertiary)'
    : prBannerQueued || prBannerReviewing
      ? 'var(--accent-purple)'
    : prBannerRetrying || prBannerReviewPartial
      ? 'var(--accent-yellow)'
    : prBannerReviewFailed
      ? 'var(--accent-red)'
      : prBannerReviewCompleted
      ? 'var(--accent-green)'
      : 'var(--text-tertiary)';
  const prBannerStarting = Boolean(
    selectedPrReview?.id
    && bannerReviewBusyById[selectedPrReview.id]
    && !prBannerQueued
    && !prBannerRetrying
    && !prBannerReviewing
  );
  const prBannerReviewBusy = selectedPrReviewInitialLoading || prBannerStarting || prBannerQueued || prBannerRetrying || prBannerReviewing;
  const prBannerScopeLabel = prBannerReviewBusy && prBannerScopeSummary
    ? prBannerScopeSummary.longLabel
    : null;
  const prBannerHasTerminalReview = prBannerSourceStatus !== 'none'
    && (
      selectedPrReview?.reviewLifecycle?.isTerminal === true
      || TERMINAL_LIFECYCLE_STATUSES.has(prBannerLifecycleStatus)
    )
    || Boolean(selectedPrReview?.reviewJson);
  const selectedReviewIsLoading = Boolean(
    selectedItem?.type === 'pr_review'
      ? selectedPrReviewInitialLoading
      : selectedItem?.type === 'branch_review'
        ? (isReviewListInitialLoading && !selectedLatestSnapshot)
        : selectedItem?.type === 'workspace_review'
          ? isReviewListInitialLoading
          : false
  );
  const selectedReviewLoadingLabel = selectedItem?.type === 'pr_review'
    ? 'Loading pull request…'
    : selectedItem?.type === 'branch_review'
      ? 'Loading branch review…'
      : 'Loading review…';
  const selectedReviewLoadingMeta = selectedItem?.type === 'pr_review'
    ? 'Atlas is loading PR metadata and review state before showing review actions.'
    : selectedItem?.type === 'branch_review'
      ? 'Atlas is loading branch review metadata before showing review actions.'
      : 'Atlas is loading review metadata before showing review actions.';
  const panelReviewStatusLabel = reviewPanelBannerState.isFixRunActive
    ? 'Running'
    : selectedItem?.type === 'pr_review'
      ? prBannerReviewStatusLabel
      : selectedItem?.type === 'branch_review'
        ? branchBannerReviewStatusLabel
        : null;
  const panelReviewStatusColor = reviewPanelBannerState.isFixRunActive
    ? 'var(--accent-purple)'
    : selectedItem?.type === 'pr_review'
      ? prBannerReviewStatusColor
      : selectedItem?.type === 'branch_review'
        ? branchBannerReviewStatusColor
        : null;
  const panelReviewBusy = reviewPanelBannerState.isFixRunActive
    ? true
    : selectedItem?.type === 'pr_review'
      ? prBannerReviewBusy
      : selectedItem?.type === 'branch_review'
        ? branchBannerReviewBusy
        : false;
  const panelReviewIsLoading = panelReviewStatusLabel === 'Loading';
  const prHasActiveReviewWork = prBannerQueued || prBannerRetrying || prBannerReviewing;
  const prCanStopReview = !panelReviewIsLoading && !selectedPrReviewInitialLoading && prHasActiveReviewWork;
  const branchHasActiveReviewWork = branchBannerQueued || branchBannerRetrying || branchBannerReviewing;
  const reviewInteractionLockReason = changingBaseBranch
    ? `Base branch is changing to ${changingBaseBranch}…`
    : null;
  const baseChangeDisabledReason = changingBaseBranch
    ? reviewInteractionLockReason
    : (
        panelReviewBusy && !panelReviewIsLoading
          ? 'Finish or stop the active review before changing the base branch.'
          : null
      );
  const baseChangeActionDisabled = Boolean(baseChangeDisabledReason);
  const panelReviewActionLabel = reviewPanelBannerState.isFixRunActive
    ? 'Stop fixing'
    : selectedItem?.type === 'pr_review'
      ? (
          prCanStopReview
            ? 'Stop Review'
            : (reviewPanelBannerState.hasVerificationPending
                ? 'Run Verification Review'
                : (prBannerHasTerminalReview ? 'Re-run Review' : 'Run Review'))
        )
      : selectedItem?.type === 'branch_review'
        ? (
            branchHasActiveReviewWork
              ? 'Stop Review'
              : (reviewPanelBannerState.hasVerificationPending
                  ? 'Run Verification Review'
                  : (selectedLatestHasTerminalReview ? 'Re-run Review' : 'Run Review'))
          )
        : null;
  const panelReviewAction = reviewPanelBannerState.isFixRunActive
    ? () => reviewPanelRef.current?.stopFixRun()
    : selectedItem?.type === 'pr_review' && selectedPrReview
      ? () => (
          prCanStopReview
            ? handleBannerStopReview(selectedPrReview.id)
            : handleBannerReviewNow(selectedPrReview.id)
        )
      : selectedItem?.type === 'branch_review' && reviewNowTargetBranchReviewId
        ? () => (
            branchHasActiveReviewWork
              ? handleBannerStopReview(reviewNowTargetBranchReviewId)
              : handleBannerReviewNow(reviewNowTargetBranchReviewId)
          )
        : null;

  useEffect(() => {
    baseChangeReviewBusyRef.current = panelReviewBusy && !panelReviewIsLoading;
  }, [panelReviewBusy, panelReviewIsLoading]);

  // Direction C shell top-bar derivation — lifecycle + severity counts.
  const shellLifecycle: ReviewShellLifecycle = (() => {
    if (selectedReviewIsLoading) return 'loading';
    if (isPrSelected) {
      if (prBannerReviewBusy) return 'running';
      if (prBannerReviewFailed) return 'failed';
      if (prBannerReviewCompleted) return 'reviewed';
      return 'idle';
    }
    if (branchBannerReviewBusy) return 'running';
    if (branchBannerReviewFailed) return 'failed';
    if (branchBannerReviewCompleted) return 'reviewed';
    return 'idle';
  })();
  const activeRunningProgress = isPrSelected ? prBannerProgress : branchBannerProgress;
  const activeRunningProgressPhase = isPrSelected ? prBannerProgressPhase : branchBannerProgressPhase;
  const activeRunningSteps = buildRunningSteps(activeRunningProgressPhase);
  const tickedActiveRunningElapsedSeconds = useTickingElapsedSeconds(
    activeRunningProgress?.elapsedSeconds,
    shellLifecycle === 'running',
  );
  const tickedActiveRunningProgress = useMemo(() => {
    if (!activeRunningProgress) return activeRunningProgress;
    return {
      ...activeRunningProgress,
      elapsedSeconds: tickedActiveRunningElapsedSeconds,
      reviewModel: activeRunningProgress.reviewModel || resolveRunningReviewModelFallback(
        runningReviewModelConfig,
        runningReviewProviderModelLabel,
        activeProviderLabel,
      ),
      reviewModelStrategy: activeRunningProgress.reviewModelStrategy || runningReviewModelConfig?.strategy || null,
      reviewModelEffectiveStrategy: activeRunningProgress.reviewModelEffectiveStrategy
        || activeRunningProgress.reviewModelStrategy
        || runningReviewModelConfig?.strategy
        || null,
    };
  }, [
    activeProviderLabel,
    activeRunningProgress,
    runningReviewModelConfig,
    runningReviewProviderModelLabel,
    tickedActiveRunningElapsedSeconds,
  ]);
  const activeRunningElapsedLabel = formatRunningDuration(tickedActiveRunningElapsedSeconds);
  const runningFallbackFileCount = isPrSelected
    ? (selectedPrReview?.fileCount || null)
    : (selectedLatestSnapshot?.fileCount || branchBannerProgress?.totalFiles || null);
  const shellRunningMetaLine = shellLifecycle === 'running'
    ? buildRunningStatusMeta(tickedActiveRunningProgress, runningFallbackFileCount)
    : null;
  const shellReview: ReviewResult | null = isPrSelected
    ? (selectedPrReview?.reviewJson || null)
    : selectedBranchReviewJson;
  // Surface a header chip when the agentic review stopped without
  // successfully completing — communicates that coverage may be incomplete.
  const shellExecutionWarning = (() => {
    if (shellLifecycle !== 'reviewed') return null;
    const reason = String(shellReview?.stats?.agenticCompletionReason || '').trim();
    if (reason === 'max_turns_reached') {
      return {
        label: 'Hit turn budget',
        tooltip: 'The agentic reviewer ran out of turns before finishing. Some files may not have been deeply reviewed.',
      };
    }
    if (reason === 'liveness_timeout') {
      return {
        label: 'Stopped (no progress)',
        tooltip: 'The agentic reviewer was stopped because it produced no output for too long. Coverage may be incomplete.',
      };
    }
    return null;
  })();
  const selectedReviewFailureMessage = isPrSelected
    ? (
        selectedPrReview?.reviewLifecycle?.error
        || selectedPrReview?.reviewError
        || null
      )
    : (
        selectedLatestSnapshot?.reviewError
        || selectedBranchReviewDetails?.reviewLifecycle?.error
        || selectedBranchReviewDetails?.reviewError
        || null
      );
  const shellReviewStats = shellReview?.stats || null;
  const legacyWalkthroughCount = Array.isArray(shellReview?.changeGroups)
    ? shellReview.changeGroups.length
    : 0;
  const selectedStandaloneWalkthroughHeadSha = selectedItem?.type === 'pr_review'
    ? (selectedPrReview?.reviewHeadSha || selectedPrReview?.headSha || shellReviewStats?.diffHeadSha || null)
    : selectedItem?.type === 'branch_review'
      ? (
          selectedBranchReviewDetails?.headSha
          || selectedBranchReviewDetails?.reviewHeadSha
          || shellReviewStats?.diffHeadSha
          || selectedLatestSnapshot?.headSha
          || null
        )
      : null;
  const selectedStandaloneWalkthroughBaseSha = selectedItem?.type === 'pr_review'
    ? (
        selectedPrReview?.baseSha
        || shellReviewStats?.diffBaseSha
        || shellReviewStats?.diffMergeBaseSha
        || null
      )
    : selectedItem?.type === 'branch_review'
      ? pickStandaloneWalkthroughBaseSha(selectedStandaloneWalkthroughHeadSha, [
          selectedBranchReviewDetails?.mergeBaseSha,
          selectedBranchReviewDetails?.forkPointSha,
          selectedBranchReviewDetails?.reviewMergeBaseSha,
          (selectedBranchReviewDetails as (BranchReviewWithCommits & { reviewForkPointSha?: string | null }) | null)?.reviewForkPointSha,
          shellReviewStats?.diffBaseSha,
          shellReviewStats?.diffMergeBaseSha,
        ])
      : null;
  useEffect(() => {
    setStandaloneWalkthroughCount(null);
    const baseSha = selectedStandaloneWalkthroughBaseSha;
    const headSha = selectedStandaloneWalkthroughHeadSha;
    if (!selectedItem || !baseSha || !headSha) return;

    let cancelled = false;
    walkthroughApi.get(projectId, baseSha, headSha, { includeStale: true })
      .then((walkthrough) => {
        if (cancelled) return;
        setStandaloneWalkthroughCount(
          walkthrough && Array.isArray(walkthrough.changeGroups)
            ? walkthrough.changeGroups.length
            : null
        );
      })
      .catch(() => {
        if (!cancelled) {
          setStandaloneWalkthroughCount(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    selectedItem?.id,
    selectedItem?.type,
    selectedStandaloneWalkthroughBaseSha,
    selectedStandaloneWalkthroughHeadSha,
  ]);
  const walkthroughTabCount = standaloneWalkthroughCount ?? legacyWalkthroughCount;
  const filesTabCount = Math.max(0, Number(
    isPrSelected
      ? (
          selectedPrReview?.fileCount
          || shellReviewStats?.totalChangedFiles
          || shellReviewStats?.filesTotal
          || shellReviewStats?.fileCount
          || 0
        )
      : selectedItem?.type === 'branch_review'
        ? (
            selectedBranchReviewDetails?.fileCount
            || selectedLatestSnapshot?.fileCount
            || branchBanner?.fileCount
            || branchBannerProgress?.totalFiles
            || shellReviewStats?.totalChangedFiles
            || shellReviewStats?.filesTotal
            || shellReviewStats?.fileCount
            || 0
          )
        : (
            shellReviewStats?.totalChangedFiles
            || shellReviewStats?.filesTotal
            || shellReviewStats?.fileCount
            || branchBannerProgress?.totalFiles
            || 0
          )
  ) || 0);
  const hasPersistedReviewSnapshot = Boolean(shellReview && typeof shellReview === 'object');
  const showPriorReviewDuringRun = shellLifecycle === 'running' && hasPersistedReviewSnapshot;
  const reviewContentVisible = shellLifecycle === 'reviewed' || showPriorReviewDuringRun;
  const shellSeverityCounts = (() => {
    const recs = Array.isArray(shellReview?.recommendations) ? shellReview!.recommendations : [];
    let high = 0, med = 0, low = 0;
    for (const rec of recs) {
      if (rec.type !== 'issue' && rec.type !== 'suggestion') continue;
      const sev = normalizeRecommendationSeverity(rec);
      if (sev === 'critical' || sev === 'high') high += 1;
      else if (sev === 'medium') med += 1;
      else low += 1;
    }
    return { high, med, low, total: high + med + low };
  })();
  const selectedReviewKind: 'branch' | 'pr' | 'review' = isPrSelected
    ? 'pr'
    : selectedItem?.type === 'branch_review'
      ? 'branch'
      : 'review';
  const overviewSummaryMarkdown = isPrSelected
    ? (selectedPrReview?.body || null)
    : selectedReviewKind === 'branch'
      ? buildBranchCommitSummaryMarkdown(selectedBranchReviewDetails?.commits)
      : null;
  const overviewSummaryFallback = isPrSelected
    ? 'This pull request does not include a description.'
    : selectedReviewKind === 'branch'
      ? 'No commit messages are available for this branch range yet.'
      : 'No review metadata is available yet.';
  const baseLastCommitSummaryMarkdown = buildBranchCommitSummaryMarkdown(baseLastCommitPreview?.commits);
  const baseLastCommitSummaryFallback = baseLastCommitPreviewLoading
    ? 'Loading latest commit metadata…'
    : baseLastCommitPreviewError
      ? baseLastCommitPreviewError
      : 'No commit message is available for the latest commit yet.';
  const findingCodeFilter = (activeChangeGroupFilter?.kind === 'finding' || activeChangeGroupFilter?.kind === 'github_conversation')
    && Array.isArray(activeChangeGroupFilter.paths)
    && activeChangeGroupFilter.paths.length > 0
    ? activeChangeGroupFilter
    : null;
  const selectedFindingDetails = activeChangeGroupFilter?.kind === 'finding'
    ? activeChangeGroupFilter.finding || null
    : null;
  const showFindingDetailsPane = Boolean(
    reviewShellMode !== 'files'
    && reviewContentVisible
    && selectedFindingDetails
    && (
      activeChangeGroupFilter?.findingDisplayMode === 'details'
      || !findingCodeFilter
    )
  );
  const filesModeFilter = activeChangeGroupFilter?.kind
    && activeChangeGroupFilter.kind !== 'finding'
    && activeChangeGroupFilter.kind !== 'github_conversation'
    ? activeChangeGroupFilter
    : null;
  const hasFindingCodeFocus = Boolean(findingCodeFilter);
  const handleOpenPrConversationThread = useCallback((thread: GitHubPrReviewThread) => {
    const target = getGitHubConversationDiffTarget(thread);
    if (!target?.path) return;
    const focusLine = Number.isFinite(Number(target.line)) && Number(target.line) > 0
      ? Math.floor(Number(target.line))
      : null;
    setActiveChangeGroupFilter({
      paths: [target.path],
      label: focusLine ? `${target.path}:${focusLine}` : target.path,
      kind: 'github_conversation',
      focusLine,
      side: target.side,
    });
    const scrollTarget = {
      filePath: target.path,
      line: focusLine,
      side: target.side,
      suppressNearestDiffToast: true,
    };
    let attempts = 0;
    const scrollWhenReady = () => {
      attempts += 1;
      if (scrollToFileRef.current) {
        scrollToFileRef.current(scrollTarget);
        return;
      }
      if (attempts < 6) {
        window.requestAnimationFrame(scrollWhenReady);
      }
    };
    window.requestAnimationFrame(scrollWhenReady);
  }, []);
  useEffect(() => {
    if (activeChangeGroupFilter?.kind !== 'github_conversation') return;
    const path = Array.isArray(activeChangeGroupFilter.paths) ? activeChangeGroupFilter.paths[0] : null;
    if (!path) return;
    const focusLine = Number.isFinite(Number(activeChangeGroupFilter.focusLine)) && Number(activeChangeGroupFilter.focusLine) > 0
      ? Math.floor(Number(activeChangeGroupFilter.focusLine))
      : null;
    const scrollTarget = {
      filePath: path,
      line: focusLine,
      side: activeChangeGroupFilter.side || 'RIGHT' as const,
      suppressNearestDiffToast: true,
    };
    let cancelled = false;
    let attempts = 0;
    const scrollWhenReady = () => {
      if (cancelled) return;
      attempts += 1;
      if (scrollToFileRef.current) {
        scrollToFileRef.current(scrollTarget);
      }
      if (attempts < 8) {
        window.requestAnimationFrame(scrollWhenReady);
      }
    };
    window.requestAnimationFrame(scrollWhenReady);
    return () => {
      cancelled = true;
    };
  }, [
    activeChangeGroupFilter?.kind,
    activeChangeGroupFilter?.focusLine,
    activeChangeGroupFilter?.side,
    Array.isArray(activeChangeGroupFilter?.paths) ? activeChangeGroupFilter.paths.join('\0') : '',
  ]);
  const selectedBranchHeader = selectedItem?.type === 'branch_review'
    ? (() => {
        const matchingBanner = branchBanner?.type === 'topic' && branchBanner.branchReviewId === selectedItem.id
          ? branchBanner
          : null;
        const branchName = selectedBranchReviewDetails?.branchName
          || selectedLatestSnapshot?.branchName
          || matchingBanner?.branchName
          || '';
        const baseBranch = selectedBranchReviewDetails?.baseBranch
          || selectedLatestSnapshot?.baseBranch
          || matchingBanner?.baseBranch
          || '';
        const baseBranchSource = selectedBranchReviewDetails?.baseBranchSource
          || selectedLatestSnapshot?.baseBranchSource
          || matchingBanner?.baseBranchSource
          || null;
        return branchName ? { branchName, baseBranch, baseBranchSource, reviewId: selectedItem.id } : null;
      })()
    : null;
  const getBranchReviewScopeKey = useCallback((reviewId: string | null | undefined, branchName: string | null | undefined) => (
    String(reviewId || branchName || 'current-branch').trim()
  ), []);
  const selectedBranchScopeKey = selectedBranchHeader
    ? getBranchReviewScopeKey(selectedBranchHeader.reviewId, selectedBranchHeader.branchName)
    : null;
  const selectedBranchCurrentScope = selectedBranchHeader
    ? (
        (selectedBranchScopeKey ? branchReviewScopeByKey[selectedBranchScopeKey] : undefined)
        || getBranchReviewDiffScope(selectedBranchHeader.baseBranch, selectedBranchHeader.baseBranchSource)
      )
    : null;
  const selectedBranchIsBaseBranch = Boolean(
    selectedBranchHeader?.branchName
    && (
      (
        normalizedCurrentBaseBranchName
        && normalizeBranchNameForBaseComparison(selectedBranchHeader.branchName) === normalizedCurrentBaseBranchName
      )
      || isKnownBaseBranchName(selectedBranchHeader.branchName)
    )
  );
  const selectedBaseLastCommitIdleMode = Boolean(
    !isPrSelected
    && selectedBranchHeader
    && selectedBranchCurrentScope === 'last_commit'
    && selectedBranchIsBaseBranch
  );
  useEffect(() => {
    if (!selectedBranchHeader || selectedBranchIsBaseBranch || selectedBranchCurrentScope !== 'last_commit') return;
    const branchName = String(selectedBranchHeader.branchName || '').trim();
    if (!branchName) return;
    const repairKey = `${selectedBranchHeader.reviewId}:${branchName}`;
    if (featureLastCommitScopeRepairRef.current === repairKey) return;
    featureLastCommitScopeRepairRef.current = repairKey;
    if (selectedBranchScopeKey) {
      setBranchReviewScopeByKey((prev) => ({
        ...prev,
        [selectedBranchScopeKey]: 'base_branch',
      }));
    }
    void branchReviewApi.ensureForBranch(projectId, branchName).then((ensured) => {
      const ensuredReview = ensured.branchReview;
      if (!ensuredReview?.id) return;
      setSelectedBranchReviewDetails((prev) => (
        prev?.id === ensuredReview.id
          ? ({ ...(prev || {}), ...ensuredReview } as BranchReviewWithCommits)
          : prev
      ));
      const ensuredSnapshot = normalizeBranchSnapshot(ensuredReview);
      setLatestBranchSnapshotsById((prev) => ({
        ...prev,
        [ensuredReview.id]: ensuredSnapshot,
      }));
      setLoadedBranchSnapshotsById((prev) => ({
        ...prev,
        [ensuredReview.id]: ensuredSnapshot,
      }));
      setBranchBanner((prev) => (
        prev?.type === 'topic' && prev.branchReviewId === ensuredReview.id
          ? {
              ...prev,
              branchName: ensuredReview.branchName || branchName,
              baseBranch: ensuredReview.baseBranch || prev.baseBranch,
              baseBranchSource: ensuredReview.baseBranchSource || null,
              fileCount: ensuredReview.fileCount ?? prev.fileCount,
              commitCount: ensuredReview.commitCount ?? prev.commitCount,
              headSha: ensuredReview.headSha || prev.headSha || null,
              updatedAt: ensuredReview.updatedAt || prev.updatedAt || null,
            }
          : prev
      ));
    }).catch((error: any) => {
      featureLastCommitScopeRepairRef.current = null;
      toast.error(error?.response?.data?.error || error?.message || 'Failed to restore branch review scope');
    });
  }, [
    projectId,
    selectedBranchCurrentScope,
    selectedBranchHeader,
    selectedBranchIsBaseBranch,
    selectedBranchScopeKey,
  ]);
  const handleRunSelectedReview = useCallback(() => {
    if (isPrSelected && selectedPrReview) {
      void handleBannerReviewNow(selectedPrReview.id);
    } else if (selectedItem?.type === 'workspace_review') {
      void handleBannerReviewNow(selectedItem.id);
    } else if (reviewNowTargetBranchReviewId) {
      void handleBannerReviewNow(reviewNowTargetBranchReviewId);
    }
  }, [handleBannerReviewNow, isPrSelected, reviewNowTargetBranchReviewId, selectedItem, selectedPrReview]);
  const handleRunSelectedFullReview = useCallback(() => {
    if (isPrSelected && selectedPrReview) {
      void handleBannerReviewNow(selectedPrReview.id, { full: true });
    } else if (selectedItem?.type === 'workspace_review') {
      void handleBannerReviewNow(selectedItem.id, { full: true });
    } else if (reviewNowTargetBranchReviewId) {
      void handleBannerReviewNow(reviewNowTargetBranchReviewId, { full: true });
    }
  }, [handleBannerReviewNow, isPrSelected, reviewNowTargetBranchReviewId, selectedItem, selectedPrReview]);
  const startLastCommitBranchReview = useCallback(async (branchNameInput: string | null | undefined) => {
    const branchName = String(branchNameInput || '').trim();
    if (!branchName) {
      toast.error('No branch selected for last commit review.');
      return false;
    }
    if (reviewInteractionLockReason) {
      toast.error(reviewInteractionLockReason);
      return false;
    }
    const scopeKey = getBranchReviewScopeKey(selectedBranchReviewId, branchName);
    setBranchReviewScopeByKey((prev) => ({
      ...prev,
      [scopeKey]: 'last_commit',
    }));

    try {
      const ensured = await branchReviewApi.ensureForBranch(projectId, branchName, { diffScope: 'last_commit' });
      const ensuredReview = ensured.branchReview;
      if (!ensuredReview?.id) {
        throw new Error('Unable to create or load the last commit review.');
      }
      setBranchReviewScopeByKey((prev) => ({
        ...prev,
        [getBranchReviewScopeKey(ensuredReview.id, ensuredReview.branchName || branchName)]: 'last_commit',
      }));

      branchReviewApi.invalidateCache(projectId, ensuredReview.id);
      setSelectedBranchReviewDetails((prev) => ({
        ...(prev || {}),
        ...ensuredReview,
      } as BranchReview));
      const ensuredSnapshot = normalizeBranchSnapshot(ensuredReview);
      setLatestBranchSnapshotsById((prev) => ({
        ...prev,
        [ensuredReview.id]: ensuredSnapshot,
      }));
      setLoadedBranchSnapshotsById((prev) => ({
        ...prev,
        [ensuredReview.id]: ensuredSnapshot,
      }));
      setBranchBanner((prev) => (
        prev?.type === 'topic'
          ? {
              ...prev,
              branchReviewId: ensuredReview.id,
              branchName: ensuredReview.branchName || branchName,
              baseBranch: ensuredReview.baseBranch || prev.baseBranch,
              baseBranchSource: ensuredReview.baseBranchSource || prev.baseBranchSource || null,
              fileCount: ensuredReview.fileCount ?? prev.fileCount,
            }
          : prev
      ));
      handleSelectItem(ensuredReview.id, 'branch_review', { source: 'explicit' });

      const queueWithForce = async (force = false) => branchReviewApi.queueReview(projectId, ensuredReview.id, {
        policySource: 'working_tree' as const,
        ...(force ? { force: true } : {}),
      });
      let queueResult = await queueWithForce(false);
      if (queueResult.alreadyReviewed) {
        const confirmed = await popup.confirm({
          title: 'Last commit already reviewed',
          message: 'This latest commit range has already been reviewed. Review it again?',
          confirmLabel: 'Review again',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return false;
        queueResult = await queueWithForce(true);
      }

      const nowIso = new Date().toISOString();
      setLatestBranchSnapshotsById((prev) => {
        const existing = prev[ensuredReview.id] || ensuredReview;
        return {
          ...prev,
          [ensuredReview.id]: {
            ...existing,
            reviewStatus: 'queued',
            reviewLifecycleStatus: 'queued',
            reviewLifecyclePhase: 'queued',
            reviewLifecycleIsActive: true,
            reviewLifecycleIsTerminal: false,
            reviewSourceStatus: 'queued',
            reviewError: null,
            updatedAt: nowIso,
          },
        };
      });
      setLoadedBranchSnapshotsById((prev) => {
        const existing = prev[ensuredReview.id] || ensuredReview;
        return {
          ...prev,
          [ensuredReview.id]: {
            ...existing,
            reviewStatus: 'queued',
            reviewLifecycleStatus: 'queued',
            reviewLifecyclePhase: 'queued',
            reviewLifecycleIsActive: true,
            reviewLifecycleIsTerminal: false,
            reviewSourceStatus: 'queued',
            reviewError: null,
            updatedAt: nowIso,
          },
        };
      });
      resetBranchReviewProgress(ensuredReview.id);
      queueProgressUpdate(ensuredReview.id, {
        queueId: queueResult.id || null,
        phase: 'queued',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 0,
        updatedAt: nowIso,
      });
      bumpBranchReviewRefreshToken(ensuredReview.id);
      return true;
    } catch (error: any) {
      const message = error?.response?.data?.error || error?.message || 'Failed to start last commit review';
      toast.error(message);
      return false;
    }
  }, [
    bumpBranchReviewRefreshToken,
    getBranchReviewScopeKey,
    handleSelectItem,
    popup,
    projectId,
    queueProgressUpdate,
    resetBranchReviewProgress,
    reviewInteractionLockReason,
    selectedBranchReviewId,
  ]);
  const materializeBaseLastCommitReview = useCallback(async (targetMode: ReviewShellMode) => {
    const branchName = String(emptyStateBranchName || branch || '').trim();
    if (!currentBranchIsBase || !branchName) return false;
    if (reviewInteractionLockReason) {
      toast.error(reviewInteractionLockReason);
      return false;
    }

    try {
      const ensured = await branchReviewApi.ensureForBranch(projectId, branchName, { diffScope: 'last_commit' });
      const ensuredReview = ensured.branchReview;
      if (!ensuredReview?.id) {
        throw new Error('Unable to create or load the last commit review.');
      }

      setBranchReviewScopeByKey((prev) => ({
        ...prev,
        [getBranchReviewScopeKey(ensuredReview.id, ensuredReview.branchName || branchName)]: 'last_commit',
      }));

      branchReviewApi.invalidateCache(projectId, ensuredReview.id);
      setSelectedBranchReviewDetails((prev) => ({
        ...(prev || {}),
        ...ensuredReview,
      } as BranchReviewWithCommits));
      const ensuredSnapshot = normalizeBranchSnapshot(ensuredReview);
      setLatestBranchSnapshotsById((prev) => ({
        ...prev,
        [ensuredReview.id]: ensuredSnapshot,
      }));
      setLoadedBranchSnapshotsById((prev) => ({
        ...prev,
        [ensuredReview.id]: ensuredSnapshot,
      }));
      setBranchBanner({
        type: 'topic',
        branchReviewId: ensuredReview.id,
        branchName: ensuredReview.branchName || branchName,
        baseBranch: ensuredReview.baseBranch,
        baseBranchSource: ensuredReview.baseBranchSource || null,
        fileCount: ensuredReview.fileCount,
        commitCount: ensuredReview.commitCount,
        headSha: ensuredReview.headSha || null,
        updatedAt: ensuredReview.updatedAt || null,
      });
      handleSelectItem(ensuredReview.id, 'branch_review', { source: 'explicit' });
      setReviewShellMode(targetMode);
      return true;
    } catch (error: any) {
      const message = error?.response?.data?.error || error?.message || 'Failed to load latest commit files';
      toast.error(message);
      return false;
    }
  }, [
    branch,
    currentBranchIsBase,
    emptyStateBranchName,
    getBranchReviewScopeKey,
    handleSelectItem,
    projectId,
    reviewInteractionLockReason,
  ]);
  const handlePreviewReviewLastCommit = useCallback(() => {
    const branchName = selectedBranchReviewDetails?.branchName
      || branchBanner?.branchName
      || selectedLatestSnapshot?.branchName
      || branch
      || emptyStateBranchName
      || null;
    void startLastCommitBranchReview(branchName);
  }, [
    branch,
    branchBanner?.branchName,
    emptyStateBranchName,
    selectedBranchReviewDetails?.branchName,
    selectedLatestSnapshot?.branchName,
    startLastCommitBranchReview,
  ]);
  const handleReviewShellModeChange = useCallback((mode: ReviewShellMode) => {
    if (!selectedItem && currentBranchIsBase && (mode === 'files' || mode === 'walkthrough')) {
      void materializeBaseLastCommitReview(mode);
      return;
    }
    setReviewShellMode(mode);
  }, [currentBranchIsBase, materializeBaseLastCommitReview, selectedItem]);
  useEffect(() => {
    const branchName = String(emptyStateBranchName || branch || '').trim();
    if (!currentBranchIsBase || !branchName || selectedItem) return;
    if (baseLastCommitMaterializedRef.current === branchName) return;
    baseLastCommitMaterializedRef.current = branchName;
    void materializeBaseLastCommitReview('findings');
  }, [branch, currentBranchIsBase, emptyStateBranchName, materializeBaseLastCommitReview, selectedItem]);
  const handleShellRerun = useCallback(() => {
    if (reviewShellMode === 'walkthrough') {
      triggerWalkthroughGeneration(false);
      return;
    }
    handleRunSelectedReview();
  }, [handleRunSelectedReview, reviewShellMode, triggerWalkthroughGeneration]);
  const handleShellFullReview = useCallback(() => {
    if (reviewShellMode === 'walkthrough') {
      triggerWalkthroughGeneration(true);
      return;
    }
    handleRunSelectedFullReview();
  }, [handleRunSelectedFullReview, reviewShellMode, triggerWalkthroughGeneration]);
  // Top-bar primary button when in walkthrough mode. Routes through the
  // choice popup (incremental default vs. full) so a click matches what
  // the stale-banner button does. Cmd+Shift+R keeps its direct full path
  // via handleShellFullReview above.
  const handleShellGenerateInteractive = useCallback(() => {
    if (reviewShellMode === 'walkthrough') {
      triggerWalkthroughGeneration(false, { interactive: true });
      return;
    }
    handleRunSelectedFullReview();
  }, [handleRunSelectedFullReview, reviewShellMode, triggerWalkthroughGeneration]);
  useEffect(() => {
    shellRerunActionRef.current = handleShellRerun;
    shellFullReviewActionRef.current = handleShellFullReview;
  }, [handleShellFullReview, handleShellRerun]);
  const handleStopSelectedReview = useCallback(() => {
    if (isPrSelected && selectedPrReview) {
      void handleBannerStopReview(selectedPrReview.id);
    } else if (reviewNowTargetBranchReviewId) {
      void handleBannerStopReview(reviewNowTargetBranchReviewId);
    }
  }, [handleBannerStopReview, isPrSelected, reviewNowTargetBranchReviewId, selectedPrReview]);
  const handleWalkthroughGenerationStateChange = useCallback((
    isGenerating: boolean,
    stopGeneration: (() => void) | null,
  ) => {
    setWalkthroughGenerationActive(isGenerating);
    walkthroughStopRef.current = isGenerating ? stopGeneration : null;
  }, []);
  const shellReviewActionItem: ReviewActionMenuItem | null = (() => {
    if (!selectedItem || selectedReviewIsLoading || reviewInteractionLockReason) return null;
    if (reviewPanelBannerState.isFixRunActive) {
      return {
        label: 'Stop fixing',
        description: 'Stop the active Fix Issues run.',
        tone: 'danger',
        onClick: () => reviewPanelRef.current?.stopFixRun(),
      };
    }
    if (reviewShellMode === 'walkthrough' && walkthroughGenerationActive) {
      return {
        label: 'Stop walkthrough',
        description: 'Stop the active walkthrough generation.',
        tone: 'danger',
        onClick: () => walkthroughStopRef.current?.(),
      };
    }
    if (reviewShellMode === 'walkthrough') {
      return {
        label: 'Generate walkthrough',
        description: 'Generate or refresh only the walkthrough for this diff. Review findings stay unchanged.',
        onClick: handleShellGenerateInteractive,
      };
    }
    if (shellLifecycle === 'running') {
      return {
        label: 'Stop review',
        description: 'Stop the active review run.',
        tone: 'danger',
        onClick: handleStopSelectedReview,
      };
    }
    if (shellLifecycle === 'idle') {
      return {
        label: 'Run review',
        description: reviewShellMode === 'files'
          ? 'Run the review for these changed files.'
          : 'Run the review and generate findings.',
        onClick: handleRunSelectedReview,
      };
    }
    if (shellLifecycle === 'failed' || shellLifecycle === 'reviewed') {
      return {
        label: shellLifecycle === 'failed' ? 'Retry review' : 'Re-run review',
        description: reviewShellMode === 'files'
          ? 'Run review for this diff again. The Files view stays available while it runs.'
          : 'Run review findings for this diff again.',
        onClick: handleRunSelectedReview,
      };
    }
    return null;
  })();
  const shellSecondaryActionItem: ReviewActionMenuItem | null = null;
  const reviewAgentScope: ReviewAgentScope | null = selectedItem ? {
    projectId,
    reviewType: selectedItem.type === 'branch_review'
      ? 'branch_review'
      : selectedItem.type === 'workspace_review'
        ? 'workspace_review'
        : 'pr_review',
    reviewId: selectedItem.id,
  } : null;
  const reviewAgentFileFilter = reviewShellMode === 'files' ? filesModeFilter : null;
  const reviewAgentFilePath = Array.isArray(reviewAgentFileFilter?.paths) && reviewAgentFileFilter.paths.length > 0
    ? reviewAgentFileFilter.paths[0]
    : null;
  const reviewAgentAttachments: ReviewAgentAttachment[] = [
    ...(reviewAgentFilePath ? [{ type: 'file' as const, path: reviewAgentFilePath }] : []),
  ];
  const activeReviewAgentAttachments = useMemo<ReviewAgentAttachment[]>(() => {
    const seen = new Set<string>();
    return [...reviewAgentAttachments, ...reviewAgentExtraAttachments]
      .filter((attachment) => {
        const key = JSON.stringify(attachment);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
  }, [reviewAgentAttachments, reviewAgentExtraAttachments]);
  const handleAskAtlasSelection = useCallback((payload: {
    attachment: Extract<ReviewAgentAttachment, { type: 'line_range' }>;
    prompt: string;
  }) => {
    setReviewAgentExtraAttachments([payload.attachment]);
    setReviewAgentDraftRequest({
      id: `${Date.now()}-${payload.attachment.path}-${payload.attachment.startLine}-${payload.attachment.endLine}`,
      text: payload.prompt,
    });
    setIsReviewAgentOpen(true);
  }, []);
  const buildReviewAgentFindingAttachments = useCallback((rec: ReviewRecommendation): ReviewAgentAttachment[] => {
    const attachments: ReviewAgentAttachment[] = [];
    const recommendationKey = getRecommendationFingerprint(rec);
    if (recommendationKey) {
      attachments.push({
        type: 'finding',
        recommendationKey,
        findingId: rec.findingId,
      });
    }
    const sourceFile = getRecommendationSourceFile(rec);
    const sourceLine = getRecommendationPatchLine(rec) ?? getRecommendationSourceLine(rec);
    if (sourceFile && sourceLine) {
      attachments.push({
        type: 'line_range',
        path: sourceFile,
        startLine: sourceLine,
        endLine: sourceLine,
        side: 'RIGHT',
      });
    } else if (sourceFile) {
      attachments.push({ type: 'file', path: sourceFile });
    }
    return attachments;
  }, []);
  const handleAskAtlasFinding = useCallback((rec: ReviewRecommendation) => {
    setReviewAgentExtraAttachments(buildReviewAgentFindingAttachments(rec));
    const prompt = 'Can you explain this finding and whether it is valid?';
    setReviewAgentDraftRequest({
      id: `${Date.now()}-${getRecommendationFingerprint(rec) || rec.title || 'finding'}`,
      text: prompt,
    });
    setIsReviewAgentOpen(true);
  }, [buildReviewAgentFindingAttachments]);
  const handleAskAtlasFile = useCallback((path: string) => {
    setReviewAgentExtraAttachments([{ type: 'file', path }]);
    setReviewAgentDraftRequest({
      id: `${Date.now()}-file-${path}`,
      text: `Can you explain the changes in ${path}?`,
    });
    setIsReviewAgentOpen(true);
  }, []);
  const handleAskAtlasGitHubThread = useCallback((thread: GitHubPrReviewThread) => {
    const target = getGitHubConversationDiffTarget(thread);
    const attachments: ReviewAgentAttachment[] = [
      { type: 'github_thread', threadNodeId: thread.nodeId || thread.id },
    ];
    if (target?.path && target.line) {
      attachments.push({
        type: 'line_range',
        path: target.path,
        startLine: target.line,
        endLine: target.line,
        side: target.side,
      });
    }
    setReviewAgentExtraAttachments(attachments);
    setReviewAgentDraftRequest({
      id: `${Date.now()}-thread-${thread.nodeId || thread.id}`,
      text: 'Can you help me understand this PR review thread and draft a response?',
    });
    setIsReviewAgentOpen(true);
  }, []);
  const removeReviewAgentAttachment = useCallback((target: ReviewAgentAttachment) => {
    const targetKey = JSON.stringify(target);
    setReviewAgentExtraAttachments((prev) => prev.filter((attachment) => JSON.stringify(attachment) !== targetKey));
  }, []);
  const openPrFindingSelectionFromActions = useCallback((
    action: 'comment' | 'request_changes',
    body: string,
  ) => {
    if (!isPrSelected || !selectedItem || selectedItem.type !== 'pr_review') {
      return { ok: false as const, error: 'Select a PR review to publish GitHub comments.' };
    }
    if (selectedReviewIsLoading) {
      return { ok: false as const, error: 'Wait for the PR review to finish loading.' };
    }

    if (reviewShellMode === 'findings' && reviewPanelRef.current) {
      return reviewPanelRef.current.openPrFindingSelectionDialog(action, body);
    }

    pendingPrFindingSelectionRef.current = { action, body };
    setReviewShellMode('findings');
    return { ok: true as const };
  }, [isPrSelected, selectedItem, selectedReviewIsLoading, reviewShellMode]);

  const openPrApprovalFromActions = useCallback(() => {
    if (!isPrSelected || !selectedItem || selectedItem.type !== 'pr_review') {
      return { ok: false as const, error: 'Select a PR review to approve.' };
    }
    if (selectedReviewIsLoading) {
      return { ok: false as const, error: 'Wait for the PR review to finish loading.' };
    }

    if (reviewShellMode === 'findings' && reviewPanelRef.current) {
      return reviewPanelRef.current.openPrApproveDialog();
    }

    pendingPrApprovalRef.current = true;
    setReviewShellMode('findings');
    return { ok: true as const };
  }, [isPrSelected, selectedItem, selectedReviewIsLoading, reviewShellMode]);

  const setReviewAgentOutcomeFromActions = useCallback((
    recommendationKey: string,
    status: 'addressed' | 'dismissed',
    note?: string,
  ) => {
    if (!selectedItem) {
      return { ok: false as const, error: 'Select a review before setting a finding outcome.' };
    }
    if (selectedReviewIsLoading) {
      return { ok: false as const, error: 'Wait for the review to finish loading.' };
    }
    if (reviewShellMode === 'findings' && reviewPanelRef.current) {
      return reviewPanelRef.current.setRecommendationOutcomeByKey(recommendationKey, status, note);
    }

    pendingReviewAgentOutcomeRef.current = { recommendationKey, status, note };
    setReviewShellMode('findings');
    return { ok: true as const };
  }, [selectedItem, selectedReviewIsLoading, reviewShellMode]);

  const publishPrReviewFromActions = useCallback((
    action: 'comment' | 'approve' | 'request_changes',
    body?: string,
  ) => {
    if (action === 'approve') {
      return openPrApprovalFromActions();
    }
    return openPrFindingSelectionFromActions(action, body || '');
  }, [openPrApprovalFromActions, openPrFindingSelectionFromActions]);

  useEffect(() => {
    const pending = pendingPrFindingSelectionRef.current;
    if (!pending || reviewShellMode !== 'findings' || selectedReviewIsLoading) return;
    if (!reviewPanelRef.current) return;
    pendingPrFindingSelectionRef.current = null;
    const result = reviewPanelRef.current.openPrFindingSelectionDialog(pending.action, pending.body);
    if (!result.ok) {
      toast.error(result.error);
    }
  }, [reviewShellMode, selectedReviewIsLoading, selectedItem?.id, selectedItem?.type]);

  useEffect(() => {
    const pending = pendingReviewAgentOutcomeRef.current;
    if (!pending || reviewShellMode !== 'findings' || selectedReviewIsLoading) return;
    if (!reviewPanelRef.current) return;
    pendingReviewAgentOutcomeRef.current = null;
    const result = reviewPanelRef.current.setRecommendationOutcomeByKey(
      pending.recommendationKey,
      pending.status,
      pending.note
    );
    if (!result.ok) {
      toast.error(result.error);
    }
  }, [reviewShellMode, selectedReviewIsLoading, selectedItem?.id, selectedItem?.type]);

  useEffect(() => {
    if (!pendingPrApprovalRef.current || reviewShellMode !== 'findings' || selectedReviewIsLoading) return;
    if (!reviewPanelRef.current) return;
    pendingPrApprovalRef.current = false;
    const result = reviewPanelRef.current.openPrApproveDialog();
    if (!result.ok) {
      toast.error(result.error);
    }
  }, [reviewShellMode, selectedReviewIsLoading, selectedItem?.id, selectedItem?.type]);

  const recordSelectedPrReviewAction = useCallback((action: SubmitAction) => {
    if (!selectedItem || selectedItem.type !== 'pr_review') return;
    setPrReviewActionById((prev) => ({
      ...prev,
      [selectedItem.id]: action,
    }));
  }, [selectedItem]);

  const selectedPrReviewAction = isPrSelected && selectedItem?.type === 'pr_review'
    ? (prReviewActionById[selectedItem.id] ?? selectedPrReview?.latestPublicationAction ?? null)
    : null;
  const selectedPrApprovedInPr = selectedPrReviewAction === 'approve';
  const renderBaseBranchSelector = (baseBranch: string, branchName: string): ReactNode => {
    const trimmedBase = String(baseBranch || '').trim();
    if (!trimmedBase) return null;
    const disabled = baseChangeActionDisabled;
    return (
      <span ref={branchSelectorRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void openBranchSelector();
          }}
          disabled={disabled}
          title={disabled ? (baseChangeDisabledReason || 'Base branch cannot be changed right now') : 'Change base branch'}
          aria-label="Change base branch"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minHeight: 22,
            maxWidth: 260,
            padding: '2px 6px',
            borderRadius: 4,
            border: '1px solid var(--review-shell-divider)',
            background: showBranchSelector ? 'var(--review-segment-active-bg)' : 'transparent',
            color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trimmedBase}</span>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.8 }}>
            <polyline points="3 6 8 11 13 6" />
          </svg>
        </button>
        {showBranchSelector && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 1200,
              width: 260,
              maxHeight: 320,
              overflowY: 'auto',
              padding: 6,
              borderRadius: 8,
              border: '1px solid var(--review-shell-divider)',
              background: 'var(--review-panel-bg)',
              boxShadow: '0 18px 44px rgba(0, 0, 0, 0.42)',
            }}
          >
            {loadingBranches ? (
              <div style={{ padding: '8px 10px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                Loading branches...
              </div>
            ) : availableBranches.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                No branches found.
              </div>
            ) : (
              availableBranches.map((candidate) => {
                const isCurrentBase = candidate.name === trimmedBase;
                const isCurrentBranch = candidate.name === branchName;
                const rowDisabled = isCurrentBase || isCurrentBranch || changingBaseBranch === candidate.name;
                return (
                  <button
                    key={candidate.name}
                    type="button"
                    disabled={rowDisabled}
                    onClick={() => {
                      void handleChangeBase(candidate.name);
                    }}
                    style={{
                      width: '100%',
                      minHeight: 30,
                      padding: '0 8px',
                      border: 0,
                      borderRadius: 5,
                      background: isCurrentBase ? 'var(--review-card-hover)' : 'transparent',
                      color: rowDisabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                      cursor: rowDisabled ? 'default' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      fontFamily: 'var(--font-ui)',
                      fontSize: 12,
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {candidate.name}
                    </span>
                    {isCurrentBase && <span style={{ fontSize: 10, color: 'var(--accent-blue)', flexShrink: 0 }}>base</span>}
                    {isCurrentBranch && <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>branch</span>}
                  </button>
                );
              })
            )}
          </div>
        )}
      </span>
    );
  };

  const shellKindBadge = (() => {
    if (isPrSelected) {
      if (!selectedPrReview) {
        return (
          <>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
              <circle cx="4" cy="4" r="2" />
              <circle cx="4" cy="12" r="2" />
              <path d="M4 6v4" />
              <circle cx="12" cy="4" r="2" />
              <path d="M12 6v4a2 2 0 0 1-2 2H6" />
            </svg>
            <span style={{ color: 'var(--text-tertiary)' }}>Loading pull request…</span>
          </>
        );
      }
      return (
        <>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
            <circle cx="4" cy="4" r="2" />
            <circle cx="4" cy="12" r="2" />
            <path d="M4 6v4" />
            <circle cx="12" cy="4" r="2" />
            <path d="M12 6v4a2 2 0 0 1-2 2H6" />
          </svg>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-primary)' }}>
            PR #{selectedPrReview.githubPrNumber}
          </span>
          <span style={{ color: 'var(--text-tertiary)' }}>
            {selectedPrReview.headBranch} &rarr; {selectedPrReview.baseBranch}
          </span>
        </>
      );
    }
    if (selectedBranchHeader) {
      const scopeKey = getBranchReviewScopeKey(selectedBranchHeader.reviewId, selectedBranchHeader.branchName);
      const persistedCurrentScope = branchReviewScopeByKey[scopeKey]
        || getBranchReviewDiffScope(selectedBranchHeader.baseBranch, selectedBranchHeader.baseBranchSource);
      const currentScope = selectedBranchIsBaseBranch ? persistedCurrentScope : 'base_branch';
      const displayBaseBranch = currentScope === 'base_branch'
        ? (
            persistedCurrentScope === 'last_commit'
              ? (currentBaseBranchName || selectedBranchHeader.baseBranch)
              : selectedBranchHeader.baseBranch
          )
        : selectedBranchHeader.baseBranch;
      return (
        <>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
            <line x1="4" y1="2" x2="4" y2="14" />
            <circle cx="4" cy="2" r="1.5" />
            <circle cx="4" cy="10" r="1.5" />
            <circle cx="12" cy="2" r="1.5" />
            <path d="M12 3.5a6 6 0 0 1-6 6" />
          </svg>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-primary)' }}>
            {selectedBranchHeader.branchName}
          </span>
          {currentScope === 'base_branch' && displayBaseBranch && (
            <span style={{ color: 'var(--text-tertiary)' }}>
              &rarr; {renderBaseBranchSelector(displayBaseBranch, selectedBranchHeader.branchName)}
            </span>
          )}
          {currentScope === 'last_commit' && (
            <span style={{ color: 'var(--text-tertiary)' }}>· Last commit</span>
          )}
        </>
      );
    }
    if (selectedItem?.type === 'branch_review') {
      return <span style={{ color: 'var(--text-tertiary)' }}>Loading branch review…</span>;
    }
    if (branchBanner?.type === 'topic') {
      const scopeKey = getBranchReviewScopeKey(branchBanner.branchReviewId || null, branchBanner.branchName || null);
      const persistedCurrentScope = branchReviewScopeByKey[scopeKey]
        || getBranchReviewDiffScope(branchBanner.baseBranch, branchBanner.baseBranchSource || null);
      const bannerIsBaseBranch = Boolean(
        branchBanner.branchName
        && normalizedCurrentBaseBranchName
        && normalizeBranchNameForBaseComparison(branchBanner.branchName) === normalizedCurrentBaseBranchName
      );
      const currentScope = bannerIsBaseBranch ? persistedCurrentScope : 'base_branch';
      const displayBaseBranch = currentScope === 'base_branch'
        ? (
            persistedCurrentScope === 'last_commit'
              ? (currentBaseBranchName || branchBanner.baseBranch)
              : branchBanner.baseBranch
          )
        : branchBanner.baseBranch;
      return (
        <>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
            <line x1="4" y1="2" x2="4" y2="14" />
            <circle cx="4" cy="2" r="1.5" />
            <circle cx="4" cy="10" r="1.5" />
            <circle cx="12" cy="2" r="1.5" />
            <path d="M12 3.5a6 6 0 0 1-6 6" />
          </svg>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-primary)' }}>
            {branchBanner.branchName}
          </span>
          {currentScope === 'base_branch' && displayBaseBranch && (
            <span style={{ color: 'var(--text-tertiary)' }}>
              &rarr; {renderBaseBranchSelector(displayBaseBranch, branchBanner.branchName || '')}
            </span>
          )}
          {currentScope === 'last_commit' && (
            <span style={{ color: 'var(--text-tertiary)' }}>· Last commit</span>
          )}
        </>
      );
    }
    return <span style={{ color: 'var(--text-tertiary)' }}>No review selected</span>;
  })();

  // Phase 07 / Task 2: legacy chrome handlers / derived values that
  // powered the retired three-panel layout (collapse rails, base-branch
  // selector, side-panel banners, etc.) are still computed to keep the
  // data-fetch / socket effects around them intact. They're no longer
  // rendered. Reference them here to keep the compiler quiet until the
  // next cleanup pass trims the state surface.
  void toggleAutoReview;
  void startResize; void handleRefreshBranchFiles;
  void hasCurrentBranchContext; void showBranchRefreshAction; void isRefreshingSelectedBranch;
  void branchBannerScopeLabel; void prBannerScopeLabel;
  void panelReviewStatusColor;
  void panelReviewActionLabel; void panelReviewAction;
  void prSyncInProgress; void prAccessDenied;
  void onOpenGlobalSettingsSection;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      fontFamily: 'var(--font-sans)',
      background: 'var(--review-shell-bg)',
    }}>
      {/* Direction C shell top bar — status chip, severity counts, mode switcher. */}
      <ReviewShellTopBar
        projectName={project?.name || 'Loading...'}
        kindBadge={shellKindBadge}
        lifecycle={shellLifecycle}
        highCount={shellSeverityCounts.high}
        medCount={shellSeverityCounts.med}
        lowCount={shellSeverityCounts.low}
        totalFindings={shellSeverityCounts.total}
        mode={reviewShellMode}
        onModeChange={handleReviewShellModeChange}
        runningMetaLine={shellRunningMetaLine}
        executionWarning={shellExecutionWarning}
        availableModes={['findings', 'walkthrough', 'files']}
        modeCounts={selectedItem
          ? { walkthrough: walkthroughTabCount, files: filesTabCount }
          : currentBranchIsBase
            ? { walkthrough: 0, files: baseLastCommitPreview?.fileCount || 0 }
            : undefined}
        primaryAction={shellReviewActionItem}
        secondaryAction={shellSecondaryActionItem}
        assistantAction={selectedItem && !selectedReviewIsLoading ? {
          label: 'Ask Atlas',
          onClick: () => {
            if (isReviewAgentOpen) {
              setIsReviewAgentOpen(false);
              setReviewAgentExtraAttachments([]);
              setReviewAgentDraftRequest(null);
              return;
            }
            setReviewAgentExtraAttachments([]);
            setReviewAgentDraftRequest(null);
            setIsReviewAgentOpen(true);
          },
        } : null}
        onBack={onBack}
        onSubmit={selectedItem && !selectedReviewIsLoading ? () => setSubmitPopoverOpen(v => !v) : undefined}
        submitLabel={selectedPrApprovedInPr ? 'Approved in PR' : 'Actions'}
        submitPopover={submitPopoverOpen ? (
          (() => {
            // Resolve the GitHub URL for the current selection (PR or branch).
            const githubUrl: string | null = (() => {
              if (isPrSelected) return selectedPrReview?.htmlUrl || null;
              if (selectedItem?.type !== 'branch_review') return null;
              const gh = project?.github || null;
              let repoFullName = String(gh?.repoFullName || '').trim();
              if (!repoFullName && gh?.repoOwner && gh?.repoName) {
                repoFullName = `${gh.repoOwner}/${gh.repoName}`;
              }
              if (!repoFullName) {
                const cloneUrl = String(gh?.cloneUrl || '').trim();
                const sshMatch = cloneUrl.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
                const httpsMatch = cloneUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
                repoFullName = sshMatch?.[1] || httpsMatch?.[1] || '';
              }
              if (!repoFullName && gitRepoSlug) {
                repoFullName = gitRepoSlug;
              }
              if (!repoFullName) return null;
              const head = selectedBranchReviewDetails?.branchName
                || branchBanner?.branchName
                || selectedLatestSnapshot?.branchName
                || '';
              const base = selectedBranchReviewDetails?.baseBranch
                || branchBanner?.baseBranch
                || selectedLatestSnapshot?.baseBranch
                || currentBaseBranchName
                || '';
              return head && base
                ? `https://github.com/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
                : head
                  ? `https://github.com/${repoFullName}/tree/${encodeURIComponent(head)}`
                  : `https://github.com/${repoFullName}`;
            })();

            if (!isPrSelected && selectedItem?.type === 'branch_review') {
              // Branch reviews: Open on GitHub · Copy (submenu) · Fix issues.
              const branchName = selectedBranchReviewDetails?.branchName
                || branchBanner?.branchName
                || selectedLatestSnapshot?.branchName
                || '';
              const baseBranch = selectedBranchReviewDetails?.baseBranch
                || branchBanner?.baseBranch
                || selectedLatestSnapshot?.baseBranch
                || currentBaseBranchName
                || '';
              const contextLabel = branchName
                ? (baseBranch ? `${branchName} → ${formatBaseBranchLabel(baseBranch)}` : branchName)
                : 'branch review';
              const activeBranchName = normalizeBranchNameForAction(branch);
              const actionBranchName = normalizeBranchNameForAction(branchName);
              const hasMatchingWorktree = Boolean(
                selectedBranchReviewDetails?.worktreePath
                || selectedBranchReviewDetails?.isWorktree
                || selectedLatestSnapshot?.worktreePath
                || selectedLatestSnapshot?.isWorktree
              );
              const fixIssuesDisabledReason = actionBranchName && activeBranchName && actionBranchName !== activeBranchName && !hasMatchingWorktree
                ? `Switch to branch ${actionBranchName} to run Fix Issues. Current worktree branch is ${activeBranchName}.`
                : null;
              const review = selectedBranchReviewJson;
              const filenameBase = sanitizeFileNamePart(
                branchName ? `${branchName}-vs-${formatBaseBranchLabel(baseBranch || 'main')}` : 'branch-review'
              ) || 'review-summary';
              const exports = review
                ? {
                    prompt: buildFixPrompt({ review, contextLabel, includeResolved: true, recommendationResolutions: {} }),
                    githubComment: buildGitHubReviewCommentMarkdown({ review, contextLabel, includeResolved: true, recommendationResolutions: {} }),
                    markdown: buildReviewMarkdown({ review, contextLabel, includeResolved: true, recommendationResolutions: {} }),
                    markdownFilenameBase: filenameBase,
                  }
                : { prompt: null, githubComment: null, markdown: null, markdownFilenameBase: filenameBase };
              return (
                <BranchActionsPopover
                  contextLabel={contextLabel}
                  githubUrl={githubUrl}
                  exports={exports}
                  onOpenFixDialog={reviewPanelRef.current
                    ? () => reviewPanelRef.current?.openFixDialog()
                    : null}
                  fixIssuesDisabledReason={fixIssuesDisabledReason}
                  focusRequestKey={submitPopoverFocusRequest}
                  onClose={() => setSubmitPopoverOpen(false)}
                  onOpenExternal={(url) => { void openExternal(url); }}
                />
              );
            }

            const prSubmitFormVisible = isPrSelected
              ? (reviewContentVisible || shellLifecycle === 'idle')
              : reviewContentVisible;
            const prNeedsSelectionDialogForComments = isPrSelected
              && (reviewContentVisible || savedManualLineCommentCount > 0);
            const prNeedsReviewedSnapshotForApproval = isPrSelected && reviewContentVisible;

            return (
              <SubmitPopover
                kind="pr"
                projectId={projectId}
                branchReviewId={null}
                prReviewId={isPrSelected ? (selectedPrReview?.id || selectedItem?.id || null) : null}
                prHtmlUrl={isPrSelected ? (selectedPrReview?.htmlUrl || null) : null}
                staleReviewMessage={isPrSelected && isPrReviewStaleFromReview(selectedPrReview)
                  ? getPrStaleReviewSummary(selectedPrReview?.reviewActionEligibility || null)
                  : null}
                showSubmitForm={prSubmitFormVisible}
                approveDisabled={selectedPrApprovedInPr}
                focusRequestKey={submitPopoverFocusRequest}
                onClose={() => setSubmitPopoverOpen(false)}
                onSubmitted={(action: SubmitAction) => {
                  recordSelectedPrReviewAction(action);
                  toast.success(`${action === 'request_changes' ? 'Changes requested' : action === 'approve' ? 'Approved' : 'Comment posted'}`);
                  if (isPrSelected) {
                    setPrRefreshKey((k) => k + 1);
                  }
                }}
                onOpenFindingSelection={prNeedsSelectionDialogForComments ? openPrFindingSelectionFromActions : undefined}
                onOpenApproval={prNeedsReviewedSnapshotForApproval ? openPrApprovalFromActions : undefined}
                onOpenOnGitHub={githubUrl ? () => { void openExternal(githubUrl); } : undefined}
              />
            );
          })()
        ) : null}
      />
      {/*
        Phase 07 / Task 2: Direction C dispatcher. The legacy project-
        header chrome + three-panel layout (reviews sidebar + diff viewer
        + AI review panel) was retired here. The ReviewShellTopBar above
        is now the only chrome; the content area dispatches
        (lifecycle × mode) into the Phase 06 view primitives.
      */}
      <div ref={contentAreaRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {/* Walkthrough mode owns both panes (direction-c.jsx:922). When
            active, it replaces the default left-diff split entirely. */}
        {selectedItem && reviewShellMode === 'walkthrough' && !selectedReviewIsLoading ? (
          <WalkthroughView
            projectId={projectId}
            branchReviewId={selectedItem.type === 'branch_review' ? selectedItem.id : null}
            workspaceReviewId={selectedItem.type === 'workspace_review' ? selectedItem.id : null}
            prReviewId={selectedItem.type === 'pr_review' ? selectedItem.id : null}
            lifecycle={showPriorReviewDuringRun ? 'reviewed' : shellLifecycle}
            runningReviewProgress={showPriorReviewDuringRun ? tickedActiveRunningProgress : null}
            runningReviewSteps={activeRunningSteps}
            runningReviewElapsedLabel={activeRunningElapsedLabel}
            runningReviewCurrentStep={panelReviewStatusLabel && panelReviewStatusLabel !== 'Running' ? panelReviewStatusLabel : null}
            runningReviewMetaLabel={shellRunningMetaLine}
            onRunReview={() => {
              if (isPrSelected && selectedPrReview) {
                void handleBannerReviewNow(selectedPrReview.id);
              } else if (reviewNowTargetBranchReviewId) {
                void handleBannerReviewNow(reviewNowTargetBranchReviewId);
              }
            }}
            onSwitchToFindings={() => setReviewShellMode('findings')}
            onSelectFile={(target) => scrollToFileRef.current?.(target)}
            scrollToFileRef={scrollToFileRef}
            generationSignal={walkthroughGenerationSignal}
            onGenerationStateChange={handleWalkthroughGenerationStateChange}
            onWalkthroughCountChange={setStandaloneWalkthroughCount}
            diffViewMode={reviewDiffViewMode}
            onDiffViewModeChange={setReviewDiffViewMode}
            onAskAtlasSelection={handleAskAtlasSelection}
            leftPaneWidth={leftWidth}
            onStartPaneResize={(event) => startResize(event)}
          />
        ) : (
        <>
        {/* Left pane: lifecycle × mode dispatcher */}
        <div
          style={{
            width: leftWidth,
            minWidth: leftWidth,
            flexShrink: 0,
            background: 'var(--review-panel-alt-bg)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          {showInitialProjectLoadState ? (
            <InitialProjectLoadState
              label={initialProjectLoadLabel}
              meta={initialProjectLoadMeta}
            />
          ) : selectedReviewIsLoading ? (
            <InitialProjectLoadState
              label={selectedReviewLoadingLabel}
              meta={selectedReviewLoadingMeta}
            />
          ) : !selectedItem ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-6)' }}>
              <div style={{ maxWidth: 360, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                <div style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  {emptyReviewTitle}
                </div>
                <div style={{ lineHeight: 1.6 }}>{emptyReviewMessage}</div>
                {currentBranchIsBase && (
                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
                    <Btn
                      variant="primary"
                      size="sm"
                      onClick={handlePreviewReviewLastCommit}
                      disabled={Boolean(reviewInteractionLockReason)}
                      title={reviewInteractionLockReason || undefined}
                    >
                      Review last commit
                    </Btn>
                  </div>
                )}
              </div>
            </div>
          ) : reviewShellMode === 'files' ? (
            // Files mode works across every lifecycle — the file list is
            // derived from git, not from the review run, so users can
            // browse changes before running a review and while it's in
            // progress.
            <FilesView header={<span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Files</span>}>
              <FileTreeList
                projectId={projectId}
                branchReviewId={selectedItem.type === 'branch_review' ? selectedItem.id : undefined}
                workspaceReviewId={selectedItem.type === 'workspace_review' ? selectedItem.id : undefined}
                prReviewId={selectedItem.type === 'pr_review' ? selectedItem.id : undefined}
                refreshToken={branchRefreshTokenById[selectedItem.id] || 0}
                activeFileFilter={filesModeFilter}
                onSelectFileFilter={setActiveChangeGroupFilter}
                selectedPath={filesModeActivePath}
                onSelectFile={(path) => scrollToFileRef.current?.({ filePath: path, line: null })}
                visibleFileLimit={reviewVisibleFileLimit}
                onLoadMoreFiles={(currentVisibleCount) => handleLoadMoreReviewFiles(currentVisibleCount, 50)}
              />
            </FilesView>
          ) : shellLifecycle === 'failed' ? (
            <FailedReviewView
              kind={selectedReviewKind}
              error={selectedReviewFailureMessage}
              onRunReview={handleRunSelectedReview}
              disabled={Boolean(reviewInteractionLockReason)}
              disabledReason={reviewInteractionLockReason}
            />
          ) : shellLifecycle === 'idle' && !(isPrSelected && reviewShellMode === 'findings') ? (
            <NotRunView
              kind={selectedReviewKind}
              branchLabel={isPrSelected
                ? (selectedPrReview?.headBranch || null)
                : (
                    selectedBranchReviewDetails?.branchName
                    || selectedLatestSnapshot?.branchName
                    || branchBanner?.branchName
                    || null
                  )}
              baseBranch={isPrSelected
                ? (selectedPrReview?.baseBranch || null)
                : formatBaseBranchLabel(
                    selectedBranchReviewDetails?.baseBranch
                    || selectedLatestSnapshot?.baseBranch
                    || branchBanner?.baseBranch
                    || currentBaseBranchName
                    || null
                  )}
              fileCount={isPrSelected
                ? (selectedPrReview?.fileCount || null)
                : (selectedLatestSnapshot?.fileCount || null)}
              baseBranchMode={selectedBaseLastCommitIdleMode}
              onRunReview={handleRunSelectedReview}
              disabled={Boolean(reviewInteractionLockReason)}
              disabledReason={reviewInteractionLockReason}
              emptyDiffRecovery={!isPrSelected && selectedItem.type === 'branch_review' && (
                Number(
                  selectedBranchReviewDetails?.fileCount
                  ?? selectedLatestSnapshot?.fileCount
                  ?? branchBanner?.fileCount
                  ?? 0
                ) === 0
              ) && (
                selectedBranchReviewDetails?.baseBranch
                || branchBanner?.baseBranch
                || selectedLatestSnapshot?.baseBranch
                || currentBaseBranchName
              ) ? {
                baseBranch: formatBaseBranchLabel(
                  selectedBranchReviewDetails?.baseBranch
                  || branchBanner?.baseBranch
                  || selectedLatestSnapshot?.baseBranch
                  || currentBaseBranchName
                  || null
                ),
                onReviewLastCommit: handlePreviewReviewLastCommit,
                onChangeBase: baseChangeActionDisabled ? undefined : () => { void openBranchSelector(); },
                disabled: Boolean(reviewInteractionLockReason),
                disabledReason: reviewInteractionLockReason,
              } : null}
              footer={isPrSelected ? (
                <IdlePrConversationsPanel
                  projectId={projectId}
                  prReviewId={selectedItem.id}
                  prAuthorLogin={selectedPrReview?.authorLogin || null}
                  onOpenThread={handleOpenPrConversationThread}
                />
              ) : null}
            />
          ) : shellLifecycle === 'running' && !showPriorReviewDuringRun ? (
            <RunningView
              steps={activeRunningSteps}
              currentStep={panelReviewStatusLabel && panelReviewStatusLabel !== 'Running' ? panelReviewStatusLabel : null}
              progress={tickedActiveRunningProgress}
              elapsedLabel={activeRunningElapsedLabel}
              queuedReviewNotice={queuedRerunNotice}
              onStop={() => {
                if (isPrSelected && selectedPrReview) {
                  void handleBannerStopReview(selectedPrReview.id);
                } else if (reviewNowTargetBranchReviewId) {
                  void handleBannerStopReview(reviewNowTargetBranchReviewId);
                }
              }}
              stopDisabled={Boolean(reviewInteractionLockReason)}
            />
          ) : (
            /* mode === 'findings' */
            <FindingsView
              verdict={showPriorReviewDuringRun ? (
                <>
                  <RunningReviewStrip
                    steps={activeRunningSteps}
                    currentStep={panelReviewStatusLabel && panelReviewStatusLabel !== 'Running' ? panelReviewStatusLabel : null}
                    progress={tickedActiveRunningProgress}
                    elapsedLabel={activeRunningElapsedLabel}
                    metaLabel={shellRunningMetaLine}
                  />
                  {queuedRerunNotice ? (
                    <div style={{ margin: '-2px 14px 10px' }}>
                      {queuedRerunNotice}
                    </div>
                  ) : null}
                </>
              ) : null}
              footerAction={(selectedItem.type === 'branch_review' || selectedItem.type === 'pr_review') ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {(() => {
                    // Mirror the Actions popover's Copy submenu (Copy as Prompt /
                    // GitHub comment / Markdown / Download Markdown) on the
                    // findings footer so users can reach it without opening the
                    // popover. Pulls from the same review payloads the Actions
                    // popover already exports from.
                    const review: ReviewResult | null = isPrSelected
                      ? (selectedPrReview?.reviewJson || null)
                      : selectedBranchReviewJson;
                    if (!review) return null;
                    const branchName = isPrSelected
                      ? (selectedPrReview?.headBranch || selectedPrReview?.title || '')
                      : (selectedBranchReviewDetails?.branchName
                        || branchBanner?.branchName
                        || selectedLatestSnapshot?.branchName
                        || '');
                    const baseBranch = isPrSelected
                      ? (selectedPrReview?.baseBranch || '')
                      : (selectedBranchReviewDetails?.baseBranch
                        || branchBanner?.baseBranch
                        || selectedLatestSnapshot?.baseBranch
                        || currentBaseBranchName
                        || '');
                    const contextLabel = branchName
                      ? (baseBranch ? `${branchName} → ${formatBaseBranchLabel(baseBranch)}` : branchName)
                      : (isPrSelected ? 'PR review' : 'branch review');
                    const filenameBase = sanitizeFileNamePart(
                      branchName ? `${branchName}-vs-${formatBaseBranchLabel(baseBranch || 'main')}` : 'review-summary'
                    ) || 'review-summary';
                    return (
                      <CopyMenuButton
                        exports={{
                          prompt: buildFixPrompt({ review, contextLabel, includeResolved: true, recommendationResolutions: {} }),
                          githubComment: buildGitHubReviewCommentMarkdown({ review, contextLabel, includeResolved: true, recommendationResolutions: {} }),
                          markdown: buildReviewMarkdown({ review, contextLabel, includeResolved: true, recommendationResolutions: {} }),
                          markdownFilenameBase: filenameBase,
                        }}
                      />
                    );
                  })()}
                <button
                  type="button"
                  onClick={() => { void reviewPanelRef.current?.clearReview(); }}
                  disabled={Boolean(reviewInteractionLockReason) || shellLifecycle === 'running'}
                  aria-label="Delete review"
                  title={reviewInteractionLockReason || (shellLifecycle === 'running' ? 'Stop the running review before deleting it' : 'Delete the current AI review result')}
                  style={{
                    border: '1px solid var(--review-shell-divider)',
                    background: 'transparent',
                    color: 'var(--text-tertiary)',
                    borderRadius: 5,
                    width: 22,
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    cursor: (reviewInteractionLockReason || shellLifecycle === 'running') ? 'not-allowed' : 'pointer',
                    opacity: (reviewInteractionLockReason || shellLifecycle === 'running') ? 0.5 : 1,
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="M19 6l-1 14H6L5 6" />
                    <path d="M10 11v5" />
                    <path d="M14 11v5" />
                  </svg>
                </button>
                </span>
              ) : null}
            >
              {selectedItem.type === 'branch_review' ? (
                <TrustReviewPanel
                  ref={reviewPanelRef}
                  projectId={projectId}
                  branchReviewId={selectedItem.id}
                  activeProviderLabel={activeProviderLabel}
                  refreshToken={branchRefreshTokenById[selectedItem.id] || 0}
                  hasTopBannerReviewAction={hasTopBannerReviewAction}
                  branchSnapshotStaleMessage={branchSnapshotStaleMessage}
                  suppressBranchReviewProgress={showPriorReviewDuringRun}
                  branchReviewProgress={showPriorReviewDuringRun ? null : (brProgressById[selectedItem.id] || null)}
                  queuedBranchReviewRun={showPriorReviewDuringRun ? null : (brQueuedRerunById[selectedItem.id] || null)}
                  onCancelQueuedBranchReview={(queueId) => { void handleCancelQueuedBranchReview(selectedItem.id, queueId); }}
                  queuedBranchReviewCancelDisabled={Boolean(cancellingQueuedReviewById[selectedItem.id])}
                  interactionLockReason={reviewInteractionLockReason}
                  currentBranchName={branch}
                  activeFileFilter={activeChangeGroupFilter}
                  onSelectFileFilter={setActiveChangeGroupFilter}
                  onScrollToFile={(target) => scrollToFileRef.current?.(target)}
                  onBranchReviewDeleted={handleBranchReviewDeleted}
                  onBannerReviewStateChange={setReviewPanelBannerState}
                  onOpenReviewAgent={(attachments = [], options: ReviewAgentOpenOptions = {}) => {
                    setReviewAgentExtraAttachments(attachments);
                    setReviewAgentDraftRequest(options.prompt ? { id: `${Date.now()}-${options.prompt}`, text: options.prompt } : null);
                    setIsReviewAgentOpen(true);
                  }}
                />
              ) : selectedItem.type === 'workspace_review' ? (
                <TrustReviewPanel
                  ref={reviewPanelRef}
                  projectId={projectId}
                  workspaceReviewId={selectedItem.id}
                  activeProviderLabel={activeProviderLabel}
                  refreshToken={branchRefreshTokenById[selectedItem.id] || 0}
                  suppressBranchReviewProgress={showPriorReviewDuringRun}
                  branchReviewProgress={showPriorReviewDuringRun ? null : (brProgressById[selectedItem.id] || null)}
                  queuedBranchReviewRun={showPriorReviewDuringRun ? null : (brQueuedRerunById[selectedItem.id] || null)}
                  onCancelQueuedBranchReview={(queueId) => { void handleCancelQueuedBranchReview(selectedItem.id, queueId); }}
                  queuedBranchReviewCancelDisabled={Boolean(cancellingQueuedReviewById[selectedItem.id])}
                  interactionLockReason={reviewInteractionLockReason}
                  currentBranchName={branch}
                  activeFileFilter={activeChangeGroupFilter}
                  onSelectFileFilter={setActiveChangeGroupFilter}
                  onScrollToFile={(target) => scrollToFileRef.current?.(target)}
                  onBannerReviewStateChange={setReviewPanelBannerState}
                  onOpenReviewAgent={(attachments = [], options: ReviewAgentOpenOptions = {}) => {
                    setReviewAgentExtraAttachments(attachments);
                    setReviewAgentDraftRequest(options.prompt ? { id: `${Date.now()}-${options.prompt}`, text: options.prompt } : null);
                    setIsReviewAgentOpen(true);
                  }}
                />
              ) : selectedItem.type === 'pr_review' ? (
                <TrustReviewPanel
                  ref={reviewPanelRef}
                  projectId={projectId}
                  prReviewId={selectedItem.id}
                  activeProviderLabel={activeProviderLabel}
                  refreshToken={branchRefreshTokenById[selectedItem.id] || 0}
                  hasTopBannerReviewAction={hasTopBannerReviewAction}
                  suppressBranchReviewProgress={showPriorReviewDuringRun}
                  branchReviewProgress={showPriorReviewDuringRun ? null : (brProgressById[selectedItem.id] || null)}
                  queuedBranchReviewRun={showPriorReviewDuringRun ? null : (brQueuedRerunById[selectedItem.id] || null)}
                  onCancelQueuedBranchReview={(queueId) => { void handleCancelQueuedBranchReview(selectedItem.id, queueId); }}
                  queuedBranchReviewCancelDisabled={Boolean(cancellingQueuedReviewById[selectedItem.id])}
                  interactionLockReason={reviewInteractionLockReason}
                  currentBranchName={branch}
                  activeFileFilter={activeChangeGroupFilter}
                  onSelectFileFilter={setActiveChangeGroupFilter}
                  onScrollToFile={(target) => scrollToFileRef.current?.(target)}
                  onBannerReviewStateChange={setReviewPanelBannerState}
                  onPrReviewPublished={recordSelectedPrReviewAction}
                  onOpenReviewAgent={(attachments = [], options: ReviewAgentOpenOptions = {}) => {
                    setReviewAgentExtraAttachments(attachments);
                    setReviewAgentDraftRequest(options.prompt ? { id: `${Date.now()}-${options.prompt}`, text: options.prompt } : null);
                    setIsReviewAgentOpen(true);
                  }}
                />
              ) : null}
            </FindingsView>
          )}
        </div>

        <div
          role="separator"
          aria-label="Resize review panes"
          title="Resize review panes"
          style={{
            width: PANEL_RESIZE_HANDLE_WIDTH,
            flexShrink: 0,
            cursor: 'col-resize',
            background: 'var(--review-shell-divider)',
            transition: 'background var(--transition-fast)',
          }}
          onMouseDown={(event) => startResize(event)}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--accent-blue)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--review-shell-divider)'; }}
        />

        {/* Right pane: diff viewer */}
        <div
          ref={diffPanelRef}
          key={`diff-${selectedItem?.id || 'none'}-${selectedItem?.type || ''}`}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--review-panel-bg)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {showInitialProjectLoadState ? (
            <InitialProjectLoadState
              label={initialProjectLoadLabel}
              meta={initialProjectLoadMeta}
            />
          ) : selectedReviewIsLoading ? (
            <InitialProjectLoadState
              label={selectedReviewLoadingLabel}
              meta={selectedReviewLoadingMeta}
            />
          ) : selectedItem && reviewShellMode !== 'files' && !hasFindingCodeFocus && (shellLifecycle === 'idle' || shellLifecycle === 'failed' || (shellLifecycle === 'running' && !showPriorReviewDuringRun)) ? (
            <ReviewOverviewPane
              kind={selectedReviewKind}
              title={isPrSelected
                ? (selectedPrReview?.title || null)
                : selectedItem.type === 'branch_review'
                  ? (selectedBranchReviewDetails?.branchName || branchBanner?.branchName || selectedLatestSnapshot?.branchName || null)
                  : emptyReviewTitle}
              branchLabel={isPrSelected
                ? (selectedPrReview?.headBranch || null)
                : selectedItem.type === 'branch_review'
                  ? (selectedBranchReviewDetails?.branchName || branchBanner?.branchName || selectedLatestSnapshot?.branchName || null)
                  : branch}
              baseBranch={isPrSelected
                ? (selectedPrReview?.baseBranch || null)
                : selectedItem.type === 'branch_review'
                  ? (selectedBranchReviewDetails?.baseBranch || branchBanner?.baseBranch || selectedLatestSnapshot?.baseBranch || currentBaseBranchName || null)
                  : currentBaseBranchName}
              fileCount={isPrSelected
                ? (selectedPrReview?.fileCount || null)
                : selectedItem.type === 'branch_review'
                  ? (selectedBranchReviewDetails?.fileCount || selectedLatestSnapshot?.fileCount || branchBanner?.fileCount || null)
                  : null}
              additions={isPrSelected
                ? (selectedPrReview?.totalAdditions || null)
                : selectedItem.type === 'branch_review'
                  ? (selectedBranchReviewDetails?.totalAdditions || null)
                  : null}
              deletions={isPrSelected
                ? (selectedPrReview?.totalDeletions || null)
                : selectedItem.type === 'branch_review'
                  ? (selectedBranchReviewDetails?.totalDeletions || null)
                  : null}
              commitCount={isPrSelected
                ? (selectedPrReview?.commitCount || null)
                : selectedItem.type === 'branch_review'
                  ? (selectedBranchReviewDetails?.commitCount || selectedLatestSnapshot?.commitCount || branchBanner?.commitCount || null)
                  : null}
              updatedAt={isPrSelected
                ? (selectedPrReview?.updatedAt || null)
                : selectedItem.type === 'branch_review'
                  ? (selectedBranchReviewDetails?.updatedAt || selectedLatestSnapshot?.updatedAt || branchBanner?.updatedAt || null)
                  : null}
              htmlUrl={isPrSelected ? (selectedPrReview?.htmlUrl || null) : null}
              lifecycle={shellLifecycle}
              summaryMarkdown={overviewSummaryMarkdown}
              summaryFallback={overviewSummaryFallback}
              onOpenExternal={(url) => { void openExternal(url); }}
            />
          ) : showFindingDetailsPane && selectedFindingDetails ? (
            <FindingDetailsPane
              finding={selectedFindingDetails}
              reason={activeChangeGroupFilter?.findingDetailsReason
                || 'This finding does not have a renderable diff anchor in the current file set.'}
            />
          ) : selectedItem && reviewShellMode !== 'files' && reviewContentVisible && !hasFindingCodeFocus ? (
            <FindingCodePlaceholder hasFindings={shellSeverityCounts.total > 0} />
          ) : selectedItem?.type === 'branch_review' ? (
            <TrustDiffViewer
              projectId={projectId}
              branchReviewId={selectedItem.id}
              branchReviewRefreshToken={branchRefreshTokenById[selectedItem.id] || 0}
              fileFilterPaths={reviewShellMode === 'files' ? filesModeFilter?.paths || null : findingCodeFilter?.paths || null}
              fileFilterLabel={reviewShellMode === 'files' ? filesModeFilter?.label || null : findingCodeFilter?.label || null}
              activeFileFilter={reviewShellMode === 'files' ? filesModeFilter : findingCodeFilter}
              onSelectFileFilter={setActiveChangeGroupFilter}
              onClearFileFilter={() => setActiveChangeGroupFilter(null)}
              onBranchReviewSnapshotChange={handleBranchReviewSnapshotLoaded}
              presentationMode={reviewShellMode === 'files' ? 'files-feed' : 'accordion'}
              onActiveFileChange={reviewShellMode === 'files' ? setFilesModeActivePath : undefined}
              viewMode={reviewDiffViewMode}
              onViewModeChange={setReviewDiffViewMode}
              onAskAtlasSelection={handleAskAtlasSelection}
              onAskAtlasFinding={handleAskAtlasFinding}
              onAskAtlasFile={handleAskAtlasFile}
              onScrollToFileRef={scrollToFileRef}
              visibleFileLimit={reviewVisibleFileLimit}
            />
          ) : selectedItem?.type === 'workspace_review' ? (
            <TrustDiffViewer
              projectId={projectId}
              workspaceReviewId={selectedItem.id}
              branchReviewRefreshToken={branchRefreshTokenById[selectedItem.id] || 0}
              fileFilterPaths={reviewShellMode === 'files' ? filesModeFilter?.paths || null : findingCodeFilter?.paths || null}
              fileFilterLabel={reviewShellMode === 'files' ? filesModeFilter?.label || null : findingCodeFilter?.label || null}
              activeFileFilter={reviewShellMode === 'files' ? filesModeFilter : findingCodeFilter}
              onSelectFileFilter={setActiveChangeGroupFilter}
              onClearFileFilter={() => setActiveChangeGroupFilter(null)}
              presentationMode={reviewShellMode === 'files' ? 'files-feed' : 'accordion'}
              onActiveFileChange={reviewShellMode === 'files' ? setFilesModeActivePath : undefined}
              viewMode={reviewDiffViewMode}
              onViewModeChange={setReviewDiffViewMode}
              onAskAtlasSelection={handleAskAtlasSelection}
              onAskAtlasFinding={handleAskAtlasFinding}
              onAskAtlasFile={handleAskAtlasFile}
              onScrollToFileRef={scrollToFileRef}
              visibleFileLimit={reviewVisibleFileLimit}
            />
          ) : selectedItem?.type === 'pr_review' ? (
            <TrustDiffViewer
              projectId={projectId}
              prReviewId={selectedItem.id}
              branchReviewRefreshToken={branchRefreshTokenById[selectedItem.id] || 0}
              fileFilterPaths={reviewShellMode === 'files' ? filesModeFilter?.paths || null : findingCodeFilter?.paths || null}
              fileFilterLabel={reviewShellMode === 'files' ? filesModeFilter?.label || null : findingCodeFilter?.label || null}
              activeFileFilter={reviewShellMode === 'files' ? filesModeFilter : findingCodeFilter}
              onSelectFileFilter={setActiveChangeGroupFilter}
              onClearFileFilter={() => setActiveChangeGroupFilter(null)}
              presentationMode={reviewShellMode === 'files' ? 'files-feed' : 'accordion'}
              onActiveFileChange={reviewShellMode === 'files' ? setFilesModeActivePath : undefined}
              viewMode={reviewDiffViewMode}
              onViewModeChange={setReviewDiffViewMode}
              onAskAtlasSelection={handleAskAtlasSelection}
              onAskAtlasFinding={handleAskAtlasFinding}
              onAskAtlasFile={handleAskAtlasFile}
              onAskAtlasGitHubThread={handleAskAtlasGitHubThread}
              onScrollToFileRef={scrollToFileRef}
              visibleFileLimit={reviewVisibleFileLimit}
            />
          ) : currentBranchIsBase ? (
            <ReviewOverviewPane
              kind="branch"
              title={emptyStateBranchName ? `${emptyStateBranchName} latest commit` : 'Latest commit'}
              branchLabel={emptyStateBranchName}
              baseBranch={baseLastCommitPreview?.baseBranch || (emptyStateBranchName ? `${emptyStateBranchName}~last-commit` : null)}
              fileCount={baseLastCommitPreview?.fileCount ?? null}
              additions={baseLastCommitPreview?.totalAdditions ?? null}
              deletions={baseLastCommitPreview?.totalDeletions ?? null}
              commitCount={baseLastCommitPreview?.commitCount ?? null}
              updatedAt={baseLastCommitPreview?.lastCommitAt || null}
              htmlUrl={null}
              lifecycle="idle"
              summaryMarkdown={baseLastCommitSummaryMarkdown}
              summaryFallback={baseLastCommitSummaryFallback}
              onOpenExternal={(url) => { void openExternal(url); }}
            />
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-6)' }}>
              <div style={{ maxWidth: 420, textAlign: 'center', color: 'var(--text-tertiary)' }}>
                <div style={{ color: 'var(--text-primary)', fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 'var(--space-2)' }}>
                  {emptyReviewTitle}
                </div>
                <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
                  {emptyDiffMessage}
                </div>
              </div>
            </div>
          )}
        </div>
        </>
        )}
        {isReviewAgentOpen && (
          <div
            role="separator"
            aria-label="Resize review assistant"
            title="Resize review assistant"
            style={{
              width: PANEL_RESIZE_HANDLE_WIDTH,
              flexShrink: 0,
              cursor: 'col-resize',
              background: 'var(--review-shell-divider)',
              transition: 'background var(--transition-fast)',
            }}
            onMouseDown={(event) => startReviewAgentResize(event)}
            onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--accent-blue)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--review-shell-divider)'; }}
          />
        )}
        <ReviewAgentDrawer
          isOpen={isReviewAgentOpen}
          width={reviewAgentWidth}
          variant="embedded"
          scope={reviewAgentScope}
          attachments={activeReviewAgentAttachments}
          draftRequest={reviewAgentDraftRequest}
          onRemoveAttachment={removeReviewAgentAttachment}
          onMessageSent={() => {
            setReviewAgentExtraAttachments([]);
          }}
          onClose={() => {
            setIsReviewAgentOpen(false);
            setReviewAgentExtraAttachments([]);
            setReviewAgentDraftRequest(null);
          }}
          onFixFindings={(recommendationKeys) => {
            if (reviewShellMode === 'findings' && reviewPanelRef.current) {
              const started = reviewPanelRef.current.startFixRunForKeys(recommendationKeys);
              if (started === false) {
                toast.error('Unable to start Fix Issues. Check the review panel for details.');
                return { ok: false, error: 'Fix Issues is blocked for this review. Check the review panel for details.' };
              }
              return { ok: true };
            }
            setReviewShellMode('findings');
            const started = window.setTimeout(() => {
              const started = reviewPanelRef.current?.startFixRunForKeys(recommendationKeys);
              if (started === false) {
                toast.error('Unable to start Fix Issues for the selected finding.');
              }
            }, 0);
            void started;
            return { ok: false, error: 'Opening the findings panel first. Press Run fix again once the panel is ready.' };
          }}
          onRunReview={(mode) => {
            if (mode === 'full') {
              handleRunSelectedFullReview();
            } else {
              handleRunSelectedReview();
            }
            return true;
          }}
          onSetOutcome={(recommendationKey, status, note) => {
            const result = setReviewAgentOutcomeFromActions(recommendationKey, status, note);
            if (!result.ok) {
              toast.error(result.error);
              return false;
            }
            return true;
          }}
          onPublishPrReview={(action, body) => publishPrReviewFromActions(action, body)}
        />
      </div>

      <ReviewShortcutBar onShowShortcuts={onShowShortcuts} />

      <AgentInstructionsModal
        isOpen={showAgentInstructionsModal}
        projectId={projectId}
        projectName={project?.name || projectId}
        onClose={handleCloseAgentInstructionsModal}
      />

      <ProjectNotesModal
        isOpen={showProjectNotesModal}
        projectId={projectId}
        projectName={project?.name || projectId}
        onClose={() => setShowProjectNotesModal(false)}
        onOpenNote={handleOpenHistoricalNote}
      />

      <PrivateNotesModal
        isOpen={showPrivateNotesModal}
        projectId={projectId}
        projectName={project?.name || projectId}
        onClose={() => setShowPrivateNotesModal(false)}
        onOpenNote={handleOpenHistoricalNote}
      />
    </div>
  );
}

interface ReviewShortcutBarProps {
  onShowShortcuts?: () => void;
}

type ReviewShortcutHint = {
  full: string;
  compact: string;
  tight: string;
  onClick?: () => void;
};

function ReviewShortcutBar({ onShowShortcuts }: ReviewShortcutBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = barRef.current;
    if (!node) return;
    const update = () => setWidth(node.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const density: 'full' | 'compact' | 'tight' =
    width > 1240 ? 'full'
    : width > 880 ? 'compact'
    : 'tight';
  const gap = density === 'full' ? 'var(--space-4)' : density === 'compact' ? 'var(--space-3)' : 'var(--space-2)';
  const reviewShortcut = formatShortcut(['primary', 'R']);
  const reviewShortcutCompact = formatShortcut(['primary', 'R'], { compact: true });
  const fullReviewShortcut = formatShortcut(['primary', 'shift', 'R']);
  const fullReviewShortcutCompact = formatShortcut(['primary', 'shift', 'R'], { compact: true });
  const askAtlasShortcut = formatShortcut(['primary', 'K']);
  const askAtlasShortcutCompact = formatShortcut(['primary', 'K'], { compact: true });
  const actionsShortcut = formatShortcut(['primary', 'enter']);
  const actionsShortcutCompact = formatShortcut(['primary', 'enter'], { compact: true });
  const notesShortcut = formatShortcut(['primary', 'L']);
  const notesShortcutCompact = formatShortcut(['primary', 'L'], { compact: true });
  const hints: ReviewShortcutHint[] = [
    { full: 'Esc: back', compact: 'Esc: back', tight: 'Esc' },
    { full: '←/→: switch tab', compact: '←/→: tab', tight: '←/→ tab' },
    { full: `${reviewShortcut}: review`, compact: `${reviewShortcutCompact}: review`, tight: reviewShortcutCompact },
    { full: `${fullReviewShortcut}: full review`, compact: `${fullReviewShortcutCompact}: full`, tight: fullReviewShortcutCompact },
    { full: `${askAtlasShortcut}: Ask Atlas`, compact: `${askAtlasShortcutCompact}: Atlas`, tight: askAtlasShortcutCompact },
    { full: 'n/p: next/prev hunk', compact: 'n/p: hunk', tight: 'n/p' },
    { full: '{}: prev/next file', compact: '{}: file', tight: '{}' },
    { full: '[/]: prev/next comment', compact: '[]: comment', tight: '[]' },
    { full: `${actionsShortcut}: actions`, compact: `${actionsShortcutCompact}: actions`, tight: actionsShortcutCompact },
    { full: `${notesShortcut}: private notes`, compact: `${notesShortcutCompact}: notes`, tight: notesShortcutCompact },
    ...(onShowShortcuts
      ? [{ full: '?: shortcuts', compact: '?: help', tight: '?', onClick: onShowShortcuts }]
      : []),
  ];

  return (
    <div
      ref={barRef}
      style={{
        height: 24,
        minHeight: 24,
        background: 'var(--review-panel-header-bg)',
        borderTop: '1px solid var(--review-shell-divider)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 var(--space-3)',
        fontSize: 'var(--text-xs)',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-tertiary)',
        gap,
        flexShrink: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        lineHeight: '24px',
      }}
    >
      {hints.map((hint) => (
        <span
          key={hint.full}
          title={hint.full}
          onClick={hint.onClick}
          style={{
            flex: '0 0 auto',
            minWidth: 0,
            maxWidth: density === 'tight' ? 74 : density === 'compact' ? 160 : undefined,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            cursor: hint.onClick ? 'pointer' : 'default',
            color: 'var(--text-tertiary)',
            transition: hint.onClick ? 'color var(--transition-fast)' : undefined,
          }}
          onMouseEnter={(e) => {
            if (hint.onClick) e.currentTarget.style.color = 'var(--text-secondary)';
          }}
          onMouseLeave={(e) => {
            if (hint.onClick) e.currentTarget.style.color = 'var(--text-tertiary)';
          }}
        >
          {hint[density]}
        </span>
      ))}
    </div>
  );
}

export default TrustReviewView;
