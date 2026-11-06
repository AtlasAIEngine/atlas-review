/**
 * ReviewPanel Component
 * Three-panel code review layout: File tree | Diff | AI Review Summary
 *
 * Patterns implemented:
 *   1. Three-panel layout (Graphite/Critique/CodeRabbit)
 *   2. Changeset summary card with status chips
 *   5. Progressive disclosure (4 layers)
 *   7. Analyzer status chips (Critique-style)
 *   9. Ship-it workflow bar
 *  10. Side-by-side / unified diff toggle
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import toast from '@/lib/toast';
import { changesetApi, reviewApi, projectApi, actionApi, shortCommitSha } from '@/services/api';
import type { AvailableChecks } from '@/services/api';
import type {
  ChangeSet,
  ChangeSetFileChange,
  ReviewResult,
  ReviewStatus,
  RiskLevel,
  ReviewChangeGroup,
  ReviewRecommendation,
  VerificationStatus,
} from '@/types';
import { computeUnifiedDiff, buildConfidenceMap, collapseContext } from '@/utils/diff';
import type { DiffLine, DiffSegment, ConfidenceEntry, DiffLineOrCollapsed, CollapsedSection } from '@/utils/diff';
import { getRecommendationPatchLine } from '@/utils/reviewNavigation';

interface ReviewPanelProps {
  projectId: string;
  changesetId: string;
  onClose: () => void;
  onNavigateToSettings?: () => void;
  onNavigateToPublish?: (changesetId: string) => void;
}

type DiffViewMode = 'unified' | 'split' | 'raw';
type DisclosureLayer = 'verdict' | 'walkthrough' | 'inline' | 'deep';

// ── Design tokens mapped to Tailwind-compatible values ──────────────────
const RISK_COLORS: Record<RiskLevel, { bg: string; border: string; text: string; dot: string }> = {
  low:      { bg: 'bg-green-900/10', border: 'border-green-700/20', text: 'text-green-400', dot: 'bg-green-400' },
  medium:   { bg: 'bg-yellow-900/10', border: 'border-yellow-700/20', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  high:     { bg: 'bg-red-900/10', border: 'border-red-700/20', text: 'text-red-400', dot: 'bg-red-400' },
  critical: { bg: 'bg-red-900/20', border: 'border-red-700/30', text: 'text-red-300', dot: 'bg-red-500' },
};

function ReviewPanel({ projectId, changesetId, onClose, onNavigateToSettings, onNavigateToPublish }: ReviewPanelProps) {
  const [changeset, setChangeset] = useState<ChangeSet | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);
  const [diffMode, setDiffMode] = useState<DiffViewMode>('unified');
  const [disclosureLayer, setDisclosureLayer] = useState<DisclosureLayer>('verdict');
  const [isReviewing, setIsReviewing] = useState(false);
  const [availableChecks, setAvailableChecks] = useState<AvailableChecks | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [showCommitModal, setShowCommitModal] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const refreshChangeset = useCallback(async () => {
    const response = await changesetApi.get(projectId, changesetId);
    setChangeset(response.changeset);
  }, [projectId, changesetId]);

  // Load changeset data
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const [csResp, checks] = await Promise.all([
          changesetApi.get(projectId, changesetId),
          changesetApi.getAvailableChecks(projectId).catch(() => ({ lint: false, unit: false, e2e: false, hasChecks: false, checks: [] })),
        ]);
        setChangeset(csResp.changeset);
        setAvailableChecks(checks);
      } catch (error) {
        toast.error('Failed to load changeset');
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [projectId, changesetId]);

  // Poll while a queued/background review is in progress.
  useEffect(() => {
    if (!changeset) return;
    const status = changeset.reviewStatus;
    if (status !== 'queued' && status !== 'reviewing') return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        await refreshChangeset();
      } catch {
        // Keep polling; transient refresh failures should not stop background review updates.
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [changeset?.id, changeset?.reviewStatus, refreshChangeset]);

  const selectedFile = changeset?.files?.[selectedFileIdx] || null;
  const review = changeset?.reviewData as ReviewResult | null | undefined;
  const reviewStatus = (changeset?.reviewStatus || 'none') as ReviewStatus;
  const isBackgroundReviewing = reviewStatus === 'queued' || reviewStatus === 'reviewing';

  // Compute diff stats
  const totalStats = useMemo(() => {
    if (!changeset?.files) return { additions: 0, deletions: 0 };
    return changeset.files.reduce((acc, f) => {
      const before = f.before ? f.before.split('\n').length : 0;
      const after = f.after ? f.after.split('\n').length : 0;
      if (f.before === null) acc.additions += after;
      else if (f.after === null) acc.deletions += before;
      else {
        acc.additions += Math.max(0, after - before);
        acc.deletions += Math.max(0, before - after);
      }
      return acc;
    }, { additions: 0, deletions: 0 });
  }, [changeset]);

  // Recommendations for the currently selected file
  const fileRecommendations = useMemo(() => {
    if (!review?.recommendations || !selectedFile) return [];
    return review.recommendations.filter(r => r.file === selectedFile.path);
  }, [review, selectedFile]);

  // Confidence overlay toggle
  const [showConfidence, setShowConfidence] = useState(false);

  // Build confidence map for the selected file
  const confidenceMap = useMemo(() => {
    if (!showConfidence || !fileRecommendations.length || !selectedFile) return new Map<number, ConfidenceEntry>();
    const content = selectedFile.after ?? selectedFile.before ?? '';
    const totalLines = content.split('\n').length;
    return buildConfidenceMap(fileRecommendations, totalLines);
  }, [showConfidence, fileRecommendations, selectedFile]);

  // Apply a suggested fix by replacing a line in the file
  const [applyingFixIdx, setApplyingFixIdx] = useState<number | null>(null);
  const handleApplyFix = useCallback(async (rec: ReviewRecommendation) => {
    if (!selectedFile || !rec.suggestedFix || !rec.line) return;
    const recIdx = review?.recommendations?.indexOf(rec) ?? -1;
    setApplyingFixIdx(recIdx);
    try {
      const currentContent = selectedFile.after ?? selectedFile.before ?? '';
      const lines = currentContent.split('\n');
      const lineIdx = rec.line - 1;
      if (lineIdx < 0 || lineIdx >= lines.length) {
        toast.error('Line number out of range');
        return;
      }
      // Replace the target line(s) with the suggested fix
      const fixLines = rec.suggestedFix.split('\n');
      lines.splice(lineIdx, fixLines.length > 1 ? fixLines.length : 1, ...fixLines);
      const newContent = lines.join('\n');
      await projectApi.updateFileContent(projectId, selectedFile.path, newContent);
      // Update local state so the diff refreshes
      setChangeset(prev => {
        if (!prev?.files) return prev;
        return {
          ...prev,
          files: prev.files.map(f =>
            f.path === selectedFile.path ? { ...f, after: newContent } : f
          ),
        };
      });
      toast.success(`Applied fix to ${selectedFile.path.split('/').pop()}:${rec.line}`);
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to apply fix');
    } finally {
      setApplyingFixIdx(null);
    }
  }, [projectId, selectedFile, review]);

  const handleReview = useCallback(async () => {
    if (reviewStatus === 'queued' || reviewStatus === 'reviewing') return;
    setIsReviewing(true);
    try {
      await reviewApi.enqueue(projectId, changesetId, reviewStatus === 'reviewed');
      setChangeset(prev => prev ? {
        ...prev,
        reviewStatus: 'queued',
      } : prev);
      toast.success('Review queued');
      await refreshChangeset();
    } catch (error: any) {
      const msg = error.response?.data?.error || error.message || 'Review failed';
      if (msg.includes('No active AI provider') && onNavigateToSettings) {
        toast.error('No AI provider configured');
      } else {
        toast.error(msg);
      }
    } finally {
      setIsReviewing(false);
    }
  }, [projectId, changesetId, reviewStatus, onNavigateToSettings, refreshChangeset]);

  const handleVerify = useCallback(async () => {
    if (!availableChecks || (!(availableChecks.hasChecks) && (!availableChecks.checks || availableChecks.checks.length === 0))) {
      toast.error('No verification checks available for this project');
      return;
    }
    setIsVerifying(true);
    try {
      const result = await changesetApi.runVerification(projectId, changesetId);
      setChangeset(prev => prev ? {
        ...prev,
        verification: result.verification,
        status: result.status || prev.status,
        ...(result.commitSha ? { commitSha: result.commitSha } : {}),
      } : prev);
      const passed = Object.values(result.results).filter(r => r.status === 'pass').length;
      const failed = Object.values(result.results).filter(r => r.status === 'fail').length;
      if (failed === 0) {
        const commitLabel = shortCommitSha(result.commitSha);
        toast.success(result.autoCommitted
          ? `All ${passed} checks passed — auto-committed ${commitLabel || 'unknown'}`
          : `All ${passed} checks passed`);
      } else {
        toast.error(`${failed} check(s) failed, ${passed} passed`);
      }
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to run verification');
    } finally {
      setIsVerifying(false);
    }
  }, [projectId, changesetId, availableChecks, shortCommitSha]);

  const handleCommit = useCallback(async () => {
    setShowCommitModal(false);
    setIsCommitting(true);
    try {
      const result = await changesetApi.commit(projectId, changesetId, commitMessage || undefined);
      setChangeset(prev => prev ? {
        ...prev,
        commitSha: result.commitSha,
        commitMessage: commitMessage || prev.title,
        status: 'committed',
      } : prev);
      toast.success(`Committed: ${shortCommitSha(result.commitSha) || 'unknown'}`);
      setCommitMessage('');
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to commit');
    } finally {
      setIsCommitting(false);
    }
  }, [projectId, changesetId, commitMessage, shortCommitSha]);

  const handleDeploy = useCallback(() => {
    if (onNavigateToPublish) {
      onNavigateToPublish(changesetId);
    }
  }, [changesetId, onNavigateToPublish]);

  const handlePush = useCallback(async () => {
    setIsPushing(true);
    try {
      const result = await actionApi.push(projectId, changesetId);
      if (result.success) {
        toast.success(`Pushed to ${(result.data as any)?.branch || 'remote'}`);
      } else {
        toast.error(result.error || 'Push failed');
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Push failed');
    } finally {
      setIsPushing(false);
    }
  }, [projectId, changesetId]);

  const handleRollback = useCallback(async () => {
    setIsRollingBack(true);
    try {
      const result = await actionApi.rollback(projectId, changesetId, { autoPush: false });
      if (result.success) {
        toast.success(`Rolled back — created ${(result.data as any)?.revertDisplayId || 'revert changeset'}`);
        // Reload changeset to reflect reverted status
        const csResp = await changesetApi.get(projectId, changesetId);
        setChangeset(csResp.changeset);
      } else {
        toast.error(result.error || 'Rollback failed');
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Rollback failed');
    } finally {
      setIsRollingBack(false);
    }
  }, [projectId, changesetId]);

  const handleExport = useCallback(() => {
    const url = actionApi.exportBundle(projectId, changesetId);
    window.open(url, '_blank');
  }, [projectId, changesetId]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'j' || e.key === 'J') {
        setSelectedFileIdx(prev => Math.min(prev + 1, (changeset?.files?.length || 1) - 1));
      } else if (e.key === 'k' || e.key === 'K') {
        setSelectedFileIdx(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'd' || e.key === 'D') {
        setDiffMode(prev => prev === 'unified' ? 'split' : prev === 'split' ? 'raw' : 'unified');
      } else if (e.key === 'a' || e.key === 'A') {
        setDisclosureLayer(prev => {
          const layers: DisclosureLayer[] = ['verdict', 'walkthrough', 'inline', 'deep'];
          const idx = layers.indexOf(prev);
          return layers[(idx + 1) % layers.length];
        });
      } else if (e.key === 'r' || e.key === 'R') {
        setShowConfidence(prev => !prev);
      } else if (e.key === '?') {
        setShowShortcuts(prev => !prev);
      } else if (e.key === 'Escape') {
        if (showShortcuts) { setShowShortcuts(false); return; }
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [changeset, onClose, showShortcuts]);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: '#0d1117' }}>
        <div className="text-center">
          <svg className="w-6 h-6 animate-spin mx-auto mb-3" style={{ color: '#8b949e' }} fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span style={{ color: '#8b949e', fontSize: 13 }}>Loading changeset...</span>
        </div>
      </div>
    );
  }

  if (!changeset) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: '#0d1117', color: '#f85149' }}>
        Changeset not found
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: '#0d1117', color: '#e6edf3', fontFamily: "'Inter', -apple-system, sans-serif" }}>

      {/* ── HEADER BAR ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 h-10 flex-shrink-0" style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>
        <button onClick={onClose} className="p-1 rounded hover:bg-[#292e36] transition-colors" style={{ color: '#8b949e' }}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#6e7681' }}>Review</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{changeset.displayId}</span>
        <span style={{ fontSize: 13, color: '#8b949e' }} className="truncate flex-1">{changeset.title}</span>

        {/* Analyzer chips (Pattern 7) */}
        <div className="flex items-center gap-1.5">
          {review && (
            <StatusChip
              status={review.riskLevel === 'low' || review.riskLevel === 'medium' ? 'pass' : 'fail'}
              label={`Risk: ${review.riskLevel}`}
            />
          )}
          <VerifChip label="Lint" status={changeset.verification?.lint} />
          <VerifChip label="Unit" status={changeset.verification?.unit} />
          <VerifChip label="E2E" status={changeset.verification?.e2e} />
        </div>

        {/* Review button */}
        <button
          onClick={handleReview}
          disabled={isReviewing || isBackgroundReviewing || !changeset.files?.length}
          className="px-3 py-1 text-xs font-medium rounded transition-colors disabled:opacity-40"
          style={{
            background: (isReviewing || isBackgroundReviewing) ? '#21262d' : 'rgba(188, 140, 255, 0.15)',
            color: (isReviewing || isBackgroundReviewing) ? '#8b949e' : '#bc8cff',
            border: '1px solid rgba(188, 140, 255, 0.3)',
          }}
        >
          {isReviewing ? 'Queueing...' : reviewStatus === 'queued' ? 'Queued...' : isBackgroundReviewing ? 'Reviewing...' : reviewStatus === 'reviewed' ? 'Re-review' : '✦ Review'}
        </button>
        <span style={{ fontSize: 10, color: '#484f58' }} className="hidden lg:inline">J/K navigate</span>
        <button
          onClick={() => setShowShortcuts(v => !v)}
          className="w-7 h-7 flex items-center justify-center rounded transition-colors hover:bg-[#292e36]"
          style={{ color: '#6e7681', fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}
          title="Keyboard shortcuts (?)"
        >?</button>
      </div>

      {/* ── THREE-PANEL BODY ────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* LEFT PANEL — File Tree */}
        <div className="flex-shrink-0 overflow-y-auto" style={{ width: 240, background: '#161b22', borderRight: '1px solid #30363d' }}>
          <div className="px-3.5 py-2.5 flex items-center justify-between" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#6e7681', borderBottom: '1px solid #30363d' }}>
            <span>Changed Files ({changeset.files?.length || 0})</span>
            <span style={{ fontSize: 10, fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>
              <span style={{ color: '#3fb950' }}>+{totalStats.additions}</span>{' '}
              <span style={{ color: '#f85149' }}>-{totalStats.deletions}</span>
            </span>
          </div>
          {changeset.files?.map((file, idx) => (
            <FileTreeItem
              key={file.path}
              file={file}
              isActive={idx === selectedFileIdx}
              onClick={() => setSelectedFileIdx(idx)}
              reviewGroup={review?.changeGroups?.find(g => g.files.some(f => f.path === file.path))}
            />
          ))}
        </div>

        {/* CENTER PANEL — Diff Viewer */}
        <div className="flex-1 overflow-hidden flex flex-col" style={{ background: '#0d1117' }}>
          {selectedFile && (
            <>
              {/* Diff header */}
              <div className="flex items-center gap-3 px-4 py-2 flex-shrink-0" style={{ background: '#161b22', borderBottom: '1px solid #30363d', fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                <span style={{ color: '#8b949e' }}>{selectedFile.path.split('/').slice(0, -1).join('/')}/</span>
                <span style={{ fontWeight: 600 }}>{selectedFile.path.split('/').pop()}</span>
                <div className="flex ml-auto items-center gap-2">
                  {/* Confidence overlay toggle */}
                  <button
                    onClick={() => setShowConfidence(v => !v)}
                    className="px-2 py-1 text-xs font-medium rounded transition-colors"
                    style={{
                      background: showConfidence ? 'rgba(210, 153, 34, 0.15)' : 'transparent',
                      color: showConfidence ? '#d29922' : '#6e7681',
                      border: `1px solid ${showConfidence ? 'rgba(210, 153, 34, 0.3)' : '#30363d'}`,
                    }}
                    title="Toggle risk heat-map overlay"
                  >
                    <span style={{ fontSize: 11 }}>{'\u2588'}</span> Risk
                  </button>
                  {/* Unified / Split / Raw toggle */}
                  <div className="flex gap-0 overflow-hidden" style={{ border: '1px solid #30363d', borderRadius: 4 }}>
                    <button
                      onClick={() => setDiffMode('unified')}
                      className="px-2.5 py-1 text-xs font-medium transition-colors"
                      style={{ background: diffMode === 'unified' ? '#21262d' : 'transparent', color: diffMode === 'unified' ? '#e6edf3' : '#8b949e' }}
                    >Unified</button>
                    <button
                      onClick={() => setDiffMode('split')}
                      className="px-2.5 py-1 text-xs font-medium transition-colors"
                      style={{ background: diffMode === 'split' ? '#21262d' : 'transparent', color: diffMode === 'split' ? '#e6edf3' : '#8b949e' }}
                    >Split</button>
                    <button
                      onClick={() => setDiffMode('raw')}
                      className="px-2.5 py-1 text-xs font-medium transition-colors"
                      style={{ background: diffMode === 'raw' ? '#21262d' : 'transparent', color: diffMode === 'raw' ? '#e6edf3' : '#8b949e' }}
                    >Raw</button>
                  </div>
                </div>
              </div>

              {/* Diff content */}
              <div className="flex-1 overflow-auto">
                {diffMode === 'unified' ? (
                  <UnifiedDiff file={selectedFile} recommendations={fileRecommendations} onApplyFix={handleApplyFix} applyingFixIdx={applyingFixIdx} allRecommendations={review?.recommendations} confidenceMap={confidenceMap} />
                ) : diffMode === 'split' ? (
                  <SplitDiff file={selectedFile} recommendations={fileRecommendations} onApplyFix={handleApplyFix} applyingFixIdx={applyingFixIdx} allRecommendations={review?.recommendations} confidenceMap={confidenceMap} />
                ) : (
                  <RawDiff file={selectedFile} />
                )}
              </div>
            </>
          )}
          {!selectedFile && (
            <div className="flex-1 flex items-center justify-center" style={{ color: '#6e7681', fontSize: 13 }}>
              No file selected
            </div>
          )}
        </div>

        {/* RIGHT PANEL — AI Review */}
        <div className="flex-shrink-0 overflow-y-auto" style={{ width: 280, background: '#161b22', borderLeft: '1px solid #30363d' }}>
          <div className="flex items-center gap-1.5 px-3.5 py-2.5" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#6e7681', borderBottom: '1px solid #30363d' }}>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: 'rgba(188, 140, 255, 0.15)', color: '#bc8cff', fontSize: 10, fontWeight: 600 }}>✦ AI</span>
            Review Summary
          </div>
          <div className="p-3.5">
            {reviewStatus === 'none' && (
              <div style={{ fontSize: 13, color: '#6e7681', lineHeight: 1.5 }}>
                Click <strong style={{ color: '#bc8cff' }}>✦ Review</strong> to get an AI analysis of this changeset.
              </div>
            )}
            {(reviewStatus === 'queued' || reviewStatus === 'reviewing') && (
              <div className="flex items-center gap-2" style={{ fontSize: 13, color: '#8b949e' }}>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                {reviewStatus === 'queued' ? 'Queued for analysis...' : 'Analyzing changes...'}
              </div>
            )}
            {reviewStatus === 'failed' && (
              <div className="p-3 rounded" style={{ background: 'rgba(248, 81, 73, 0.08)', border: '1px solid rgba(248, 81, 73, 0.2)', fontSize: 13, color: '#f85149' }}>
                Review failed. Click ✦ Review to retry.
              </div>
            )}
            {review && <ReviewSummary review={review} disclosureLayer={disclosureLayer} setDisclosureLayer={setDisclosureLayer} selectedFilePath={selectedFile?.path} />}
          </div>
        </div>
      </div>

      {/* ── COMMIT MESSAGE MODAL ──────────────────────────────── */}
      {showCommitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
          <div className="rounded-lg p-4 w-96" style={{ background: '#161b22', border: '1px solid #30363d' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#e6edf3' }}>Commit Changeset</div>
            <input
              autoFocus
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCommit(); if (e.key === 'Escape') setShowCommitModal(false); }}
              placeholder={changeset.title}
              className="w-full px-3 py-2 rounded text-sm mb-3"
              style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3', outline: 'none' }}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCommitModal(false)}
                className="px-3 py-1.5 text-xs rounded"
                style={{ color: '#8b949e', border: '1px solid #30363d' }}
              >Cancel</button>
              <button
                onClick={handleCommit}
                className="px-3 py-1.5 text-xs rounded font-medium"
                style={{ background: '#238636', color: '#fff' }}
              >Commit</button>
            </div>
          </div>
        </div>
      )}

      {/* ── KEYBOARD SHORTCUTS OVERLAY (Pattern 8) ───────────── */}
      {showShortcuts && <KeyboardShortcutsPanel onClose={() => setShowShortcuts(false)} />}

      {/* ── SHIP-IT WORKFLOW BAR (Pattern 9) ──────────────────── */}
      <ShipItBar
        changeset={changeset}
        review={review}
        availableChecks={availableChecks}
        shortCommitSha={shortCommitSha}
        isVerifying={isVerifying}
        isCommitting={isCommitting}
        onReview={handleReview}
        onVerify={handleVerify}
        onCommit={() => { setCommitMessage(changeset.title); setShowCommitModal(true); }}
        onDeploy={handleDeploy}
        onPush={handlePush}
        onRollback={handleRollback}
        onExport={handleExport}
        isPushing={isPushing}
        isRollingBack={isRollingBack}
      />
    </div>
  );
}

// ── FILE TREE ITEM ────────────────────────────────────────────────────
function FileTreeItem({ file, isActive, onClick, reviewGroup }: {
  file: ChangeSetFileChange;
  isActive: boolean;
  onClick: () => void;
  reviewGroup?: ReviewChangeGroup;
}) {
  const fileName = file.path.split('/').pop() || file.path;
  const isNew = file.before === null;
  const isDeleted = file.after === null;

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2 px-3.5 py-1.5 cursor-pointer transition-colors"
      style={{
        background: isActive ? '#21262d' : 'transparent',
        color: isActive ? '#58a6ff' : '#e6edf3',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
      }}
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = '#1c2128'; }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: isNew ? '#3fb950' : isDeleted ? '#f85149' : '#d29922' }}
      />
      <span className="truncate">{fileName}</span>
      {/* Risk indicator from review */}
      {reviewGroup && (
        <span
          className="w-1.5 h-1.5 rounded-full ml-auto flex-shrink-0"
          style={{ background: RISK_COLORS[reviewGroup.risk]?.dot || '#6e7681' }}
          title={`${reviewGroup.risk} risk`}
        />
      )}
    </div>
  );
}

// ── ANALYZER STATUS CHIP ──────────────────────────────────────────────
function StatusChip({ status, label }: { status: 'pass' | 'fail' | 'running' | 'neutral'; label: string }) {
  const styles: Record<string, { bg: string; border: string; color: string }> = {
    pass:    { bg: 'rgba(63,185,80,0.1)', border: 'rgba(63,185,80,0.2)', color: '#3fb950' },
    fail:    { bg: 'rgba(248,81,73,0.1)', border: 'rgba(248,81,73,0.2)', color: '#f85149' },
    running: { bg: 'rgba(210,153,34,0.1)', border: 'rgba(210,153,34,0.2)', color: '#d29922' },
    neutral: { bg: '#21262d', border: '#30363d', color: '#8b949e' },
  };
  const s = styles[status] || styles.neutral;
  const icon = status === 'pass' ? '\u2713' : status === 'fail' ? '!' : status === 'running' ? '\u22EF' : '\u2013';

  return (
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
      <span className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-[8px] font-bold" style={{ background: s.color, color: '#000' }}>{icon}</span>
      {label}
    </div>
  );
}

function VerifChip({ label, status }: { label: string; status?: VerificationStatus }) {
  if (!status || status === 'not_run') return <StatusChip status="neutral" label={label} />;
  return <StatusChip status={status === 'pass' ? 'pass' : 'fail'} label={label} />;
}

// ── REVIEW SUMMARY (Progressive Disclosure — Pattern 5) ───────────────
function ReviewSummary({ review, disclosureLayer, setDisclosureLayer, selectedFilePath }: {
  review: ReviewResult;
  disclosureLayer: DisclosureLayer;
  setDisclosureLayer: (layer: DisclosureLayer) => void;
  selectedFilePath?: string;
}) {
  const riskLevel: RiskLevel | 'unknown' = (
    review.riskLevel === 'low'
    || review.riskLevel === 'medium'
    || review.riskLevel === 'high'
    || review.riskLevel === 'critical'
  ) ? review.riskLevel : 'unknown';
  const issues = review.recommendations.filter(r => r.type === 'issue');
  const suggestions = review.recommendations.filter(r => r.type === 'suggestion');
  const praises = review.recommendations.filter(r => r.type === 'praise');
  const highSeverity = review.recommendations.filter(
    (r) => r.severity === 'high' || r.severity === 'critical'
  );
  const coverageTotal = (review.stats as any).filesTotal || review.stats.filesAnalyzed;
  const deepReviewed = (review.stats as any).filesDeepReviewed || review.stats.filesAnalyzed;
  const reviewMode = (review.stats as any).reviewMode || 'full';
  const chunkCount = (review.stats as any).chunkCount || 1;
  const totalReviewTokens = review.tokensUsed.input + review.tokensUsed.output;
  const reviewCostLabel = review.estimatedCost != null
    ? `${review.costIsApproximate ? 'Approx cost' : 'Estimated cost'}: $${review.estimatedCost.toFixed(4)}`
    : 'Estimate unavailable';

  return (
    <div className="space-y-3">
      {/* Status chips */}
      <div className="flex flex-wrap gap-1.5">
        {issues.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(248,81,73,0.12)', border: '1px solid rgba(248,81,73,0.2)', color: '#f85149' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#f85149' }} />
            {issues.length} Issue{issues.length > 1 ? 's' : ''}
          </span>
        )}
        {highSeverity.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(248,81,73,0.12)', border: '1px solid rgba(248,81,73,0.2)', color: '#f85149' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#f85149' }} />
            {highSeverity.length} High Risk
          </span>
        )}
        {suggestions.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(210,153,34,0.12)', border: '1px solid rgba(210,153,34,0.2)', color: '#d29922' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#d29922' }} />
            {suggestions.length} Suggestion{suggestions.length > 1 ? 's' : ''}
          </span>
        )}
        {praises.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.2)', color: '#3fb950' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#3fb950' }} />
            {praises.length} Praise
          </span>
        )}
      </div>

      {/* Layer 1: Glanceable verdict (always visible) */}
      <div className="p-2.5 rounded" style={{ background: riskLevel === 'low' ? 'rgba(63,185,80,0.06)' : riskLevel === 'medium' || riskLevel === 'unknown' ? 'rgba(210,153,34,0.06)' : 'rgba(248,81,73,0.06)', border: `1px solid ${riskLevel === 'low' ? 'rgba(63,185,80,0.15)' : riskLevel === 'medium' || riskLevel === 'unknown' ? 'rgba(210,153,34,0.15)' : 'rgba(248,81,73,0.15)'}`, borderRadius: 6 }}>
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ background: riskLevel === 'low' ? '#3fb950' : riskLevel === 'medium' || riskLevel === 'unknown' ? '#d29922' : '#f85149' }} />
          <span className="text-xs font-semibold uppercase" style={{ color: riskLevel === 'low' ? '#3fb950' : riskLevel === 'medium' || riskLevel === 'unknown' ? '#d29922' : '#f85149' }}>
            {riskLevel === 'unknown' ? 'Unrated' : `${riskLevel} risk`}
          </span>
          <span className="text-xs ml-auto" style={{ color: '#6e7681' }}>{review.stats.estimatedComplexity}</span>
        </div>
        <p style={{ fontSize: 13, color: '#8b949e', lineHeight: 1.5 }}>{review.summary}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: '#21262d', border: '1px solid #30363d', color: '#8b949e' }}>
            {Math.min(deepReviewed, coverageTotal)}/{coverageTotal} files
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: '#21262d', border: '1px solid #30363d', color: '#8b949e' }}>
            {reviewMode === 'focused' ? 'focused' : 'full'}
          </span>
          {chunkCount > 1 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: '#21262d', border: '1px solid #30363d', color: '#8b949e' }}>
              {chunkCount} chunks
            </span>
          )}
        </div>
      </div>

      {/* Layer navigation */}
      <div className="flex gap-1">
        {(['verdict', 'walkthrough', 'inline', 'deep'] as DisclosureLayer[]).map((layer, idx) => (
          <button
            key={layer}
            onClick={() => setDisclosureLayer(layer)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors"
            style={{
              background: disclosureLayer === layer ? '#21262d' : 'transparent',
              color: disclosureLayer === layer ? '#e6edf3' : '#6e7681',
            }}
          >
            <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px]" style={{ background: '#21262d' }}>{idx + 1}</span>
            {layer === 'verdict' ? 'Verdict' : layer === 'walkthrough' ? 'Walk' : layer === 'inline' ? 'Inline' : 'Deep'}
          </button>
        ))}
      </div>

      {/* Layer 2: Walkthrough */}
      {(disclosureLayer === 'walkthrough' || disclosureLayer === 'inline' || disclosureLayer === 'deep') && (
        <div className="space-y-1">
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6e7681' }}>Walkthrough</div>
          {review.changeGroups.map((group, idx) => (
            <div key={idx} className="p-2 rounded" style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 6 }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: RISK_COLORS[group.risk]?.dot.includes('green') ? '#3fb950' : group.risk === 'medium' ? '#d29922' : '#f85149' }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>{group.label}</span>
              </div>
              <p style={{ fontSize: 12, color: '#6e7681', marginBottom: 4 }}>{group.description}</p>
              {group.files.map((file, fIdx) => (
                <div key={fIdx} className="flex items-center gap-2 py-1" style={{ borderTop: fIdx > 0 ? '1px solid #21262d' : 'none' }}>
                  <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", background: file.additions > 0 && file.deletions === 0 ? 'rgba(63,185,80,0.15)' : 'rgba(210,153,34,0.15)', color: file.additions > 0 && file.deletions === 0 ? '#3fb950' : '#d29922' }}>
                    {file.additions > 0 && file.deletions === 0 ? 'A' : 'M'}
                  </span>
                  <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: selectedFilePath === file.path ? '#58a6ff' : '#e6edf3' }}>{file.path.split('/').pop()}</span>
                  <span className="ml-auto" style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: '#6e7681' }}>
                    <span style={{ color: '#3fb950' }}>+{file.additions}</span>{' '}
                    <span style={{ color: '#f85149' }}>-{file.deletions}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Layer 3: Inline findings */}
      {(disclosureLayer === 'inline' || disclosureLayer === 'deep') && review.recommendations.length > 0 && (
        <div className="space-y-1.5">
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6e7681' }}>Findings</div>
          {review.recommendations.map((rec, idx) => (
            <FindingCard key={idx} rec={rec} />
          ))}
        </div>
      )}

      {/* Layer 4: Deep dive metadata */}
      {disclosureLayer === 'deep' && (
        <div className="space-y-2">
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6e7681' }}>Analysis Details</div>
          <div className="p-2.5 rounded" style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 6, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#6e7681', lineHeight: 1.6 }}>
            <div>Provider: {review.provider.type}/{review.provider.model}</div>
            <div>Input tokens: {review.tokensUsed.input.toLocaleString()}</div>
            <div>Output tokens: {review.tokensUsed.output.toLocaleString()}</div>
            <div>Total tokens: {totalReviewTokens.toLocaleString()}</div>
            <div>{reviewCostLabel}</div>
            <div>Files analyzed: {review.stats.filesAnalyzed}</div>
            <div>Complexity: {review.stats.estimatedComplexity}</div>
            <div>Reviewed: {new Date(review.reviewedAt).toLocaleString()}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── FINDING CARD ──────────────────────────────────────────────────────
function FindingCard({ rec }: { rec: ReviewRecommendation }) {
  const typeStyles = {
    issue:      { bg: 'rgba(248,81,73,0.06)', border: 'rgba(248,81,73,0.15)', color: '#f85149', label: 'Issue', icon: '●' },
    suggestion: { bg: 'rgba(210,153,34,0.06)', border: 'rgba(210,153,34,0.15)', color: '#d29922', label: 'Suggestion', icon: '●' },
    praise:     { bg: 'rgba(63,185,80,0.06)',  border: 'rgba(63,185,80,0.15)',  color: '#3fb950',  label: 'Praise', icon: '●' },
  };
  const s = typeStyles[rec.type] || typeStyles.suggestion;

  return (
    <div className="p-2 rounded cursor-pointer transition-colors" style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 4, fontSize: 12 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = s.bg.replace('0.06', '0.1'); }}
      onMouseLeave={(e) => { e.currentTarget.style.background = s.bg; }}
    >
      <div className="flex items-center gap-1.5">
        <span style={{ color: s.color }}>{s.icon}</span>
        <span style={{ color: '#e6edf3', fontWeight: 500 }}>{rec.title}</span>
        {rec.file && (
          <span className="ml-auto" style={{ color: '#6e7681', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
            {rec.file.split('/').pop()}{rec.line ? `:${rec.line}` : ''}
          </span>
        )}
      </div>
      <p style={{ color: '#d1d5db', marginTop: 4, lineHeight: 1.4 }}>{rec.description}</p>
    </div>
  );
}

// ── WORD-LEVEL HIGHLIGHT RENDERER ─────────────────────────────────────
function DiffLineContent({ segments, type }: { segments: DiffSegment[]; type: 'context' | 'add' | 'del' }) {
  const highlightBg = type === 'add' ? 'rgba(63,185,80,0.4)' : type === 'del' ? 'rgba(248,81,73,0.4)' : 'transparent';
  return (
    <>
      {segments.map((seg, i) => (
        seg.highlighted ? (
          <span key={i} style={{ background: highlightBg, borderRadius: 2 }}>{seg.text}</span>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      ))}
    </>
  );
}

// ── INLINE COMMENT (Pattern 3) ───────────────────────────────────────
function InlineComment({ rec, onApplyFix, isApplying }: {
  rec: ReviewRecommendation;
  onApplyFix?: (rec: ReviewRecommendation) => void;
  isApplying?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const typeStyles = {
    issue:      { bg: 'rgba(248,81,73,0.08)', border: '#f8514980', accent: '#f85149', icon: '\u26A0' },
    suggestion: { bg: 'rgba(210,153,34,0.08)', border: '#d2992280', accent: '#d29922', icon: '\uD83D\uDCA1' },
    praise:     { bg: 'rgba(63,185,80,0.08)',  border: '#3fb95080', accent: '#3fb950', icon: '\u2713' },
  };
  const s = typeStyles[rec.type] || typeStyles.suggestion;

  return (
    <div style={{ background: s.bg, borderLeft: `3px solid ${s.accent}`, borderBottom: '1px solid #21262d', padding: '8px 12px' }}>
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span style={{ fontSize: 13 }}>{s.icon}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: s.accent, textTransform: 'uppercase' }}>{rec.type}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: '#e6edf3' }}>{rec.title}</span>
        <span className="ml-auto flex items-center gap-2">
          {rec.suggestedFix && onApplyFix && (
            <button
              onClick={(e) => { e.stopPropagation(); onApplyFix(rec); }}
              disabled={isApplying}
              className="px-2 py-0.5 rounded text-xs font-medium transition-colors"
              style={{
                background: isApplying ? '#21262d' : 'rgba(63,185,80,0.15)',
                color: isApplying ? '#8b949e' : '#3fb950',
                border: '1px solid rgba(63,185,80,0.3)',
              }}
            >
              {isApplying ? 'Applying...' : 'Apply Fix'}
            </button>
          )}
          <span style={{ fontSize: 11, color: '#6e7681' }}>{expanded ? '\u25B2' : '\u25BC'}</span>
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 6 }}>
          <p style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.5 }}>{rec.description}</p>
          {rec.suggestedFix && (
            <pre style={{
              marginTop: 6, padding: 8, borderRadius: 4,
              background: '#0d1117', border: '1px solid #3f3f5f',
              fontSize: 11, color: '#3fb950', lineHeight: 1.5,
              overflow: 'auto', fontFamily: "'JetBrains Mono', monospace",
            }}>{rec.suggestedFix}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── UNIFIED DIFF ──────────────────────────────────────────────────────
function UnifiedDiff({ file, recommendations, onApplyFix, applyingFixIdx, allRecommendations, confidenceMap }: {
  file: ChangeSetFileChange;
  recommendations?: ReviewRecommendation[];
  onApplyFix?: (rec: ReviewRecommendation) => void;
  applyingFixIdx?: number | null;
  allRecommendations?: ReviewRecommendation[];
  confidenceMap?: Map<number, ConfidenceEntry>;
}) {
  const allLines = useMemo(() => computeUnifiedDiff(file.before ?? null, file.after ?? null), [file]);
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());

  const displayItems = useMemo(() => {
    const collapsed = collapseContext(allLines);
    // Re-expand sections the user has opened
    if (expandedSections.size === 0) return collapsed;
    const result: DiffLineOrCollapsed[] = [];
    for (const item of collapsed) {
      if (item.type === 'collapsed' && expandedSections.has((item as CollapsedSection).startIdx)) {
        for (let i = (item as CollapsedSection).startIdx; i < (item as CollapsedSection).endIdx; i++) {
          result.push(allLines[i]);
        }
      } else {
        result.push(item);
      }
    }
    return result;
  }, [allLines, expandedSections]);

  const handleExpand = useCallback((startIdx: number) => {
    setExpandedSections(prev => new Set([...prev, startIdx]));
  }, []);

  // Build a map: newLineNum → recommendations for that line
  const lineRecsMap = useMemo(() => {
    const map = new Map<number, ReviewRecommendation[]>();
    if (!recommendations) return map;
    for (const rec of recommendations) {
      const patchLine = getRecommendationPatchLine(rec);
      if (patchLine) {
        const existing = map.get(patchLine) || [];
        existing.push(rec);
        map.set(patchLine, existing);
      }
    }
    return map;
  }, [recommendations]);

  const hasConfidence = confidenceMap && confidenceMap.size > 0;
  const colCount = hasConfidence ? 4 : 3;

  return (
    <div>
      <table className="w-full border-collapse" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: '20px' }}>
        <tbody>
          {/* Hunk header */}
          <tr>
            {hasConfidence && <td style={{ width: 4, minWidth: 4, background: 'rgba(88,166,255,0.08)' }} />}
            <td className="select-none text-right pr-3" style={{ width: 48, minWidth: 48, color: '#6e7681', borderRight: '1px solid #21262d', background: 'rgba(88,166,255,0.08)' }} />
            <td className="select-none text-right pr-3" style={{ width: 48, minWidth: 48, color: '#6e7681', borderRight: '1px solid #21262d', background: 'rgba(88,166,255,0.08)' }} />
            <td className="pl-3 italic" style={{ color: '#58a6ff', background: 'rgba(88,166,255,0.08)' }}>
              @@ {file.path} @@
            </td>
          </tr>
          {displayItems.map((item, idx) => {
            if (item.type === 'collapsed') {
              const section = item as CollapsedSection;
              return (
                <tr key={`collapsed-${idx}`}>
                  <td colSpan={colCount} style={{ padding: 0 }}>
                    <button
                      onClick={() => handleExpand(section.startIdx)}
                      style={{
                        width: '100%', padding: '4px 12px', background: 'rgba(88,166,255,0.06)',
                        border: 'none', borderTop: '1px solid #21262d', borderBottom: '1px solid #21262d',
                        color: '#58a6ff', fontSize: 11, cursor: 'pointer', textAlign: 'center',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(88,166,255,0.12)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(88,166,255,0.06)'; }}
                    >
                      {'\u2193'} Show {section.count} hidden lines {'\u2193'}
                    </button>
                  </td>
                </tr>
              );
            }
            const line = item as DiffLine;
            const lineRecs = line.newNum ? lineRecsMap.get(line.newNum) : undefined;
            const lineNum = line.newNum ?? line.oldNum ?? 0;
            const conf = hasConfidence ? confidenceMap!.get(lineNum) : undefined;
            const diffBg = line.type === 'add' ? 'var(--diff-add-bg)' : line.type === 'del' ? 'var(--diff-del-bg)' : 'transparent';
            const rowBg = conf?.bg && line.type === 'context' ? conf.bg : diffBg;
            return (
              <React.Fragment key={idx}>
                <tr style={{ background: rowBg }}>
                  {hasConfidence && (
                    <td style={{ width: 4, minWidth: 4, padding: 0, background: conf?.color || 'transparent' }} />
                  )}
                  <td className="select-none text-right pr-3" style={{
                    width: 48, minWidth: 48, color: 'var(--text-tertiary)', borderRight: '1px solid var(--diff-gutter-border)',
                    background: line.type === 'add' ? 'var(--diff-add-line)' : line.type === 'del' ? 'var(--diff-del-line)' : 'transparent',
                  }}>{line.oldNum || ''}</td>
                  <td className="select-none text-right pr-3" style={{
                    width: 48, minWidth: 48, color: 'var(--text-tertiary)', borderRight: '1px solid var(--diff-gutter-border)',
                    background: line.type === 'add' ? 'var(--diff-add-line)' : line.type === 'del' ? 'var(--diff-del-line)' : 'transparent',
                  }}>
                    {line.newNum || ''}
                    {lineRecs && lineRecs.length > 0 && (
                      <span style={{ marginLeft: 2, fontSize: 10, color: lineRecs.some(r => r.type === 'issue') ? '#f85149' : '#d29922' }}>{'\u25CF'}</span>
                    )}
                  </td>
                  <td className="pl-3" style={{ whiteSpace: 'pre' }}>
                    <span style={{ color: line.type === 'add' ? 'var(--diff-add-symbol)' : line.type === 'del' ? 'var(--diff-del-symbol)' : 'var(--text-tertiary)', userSelect: 'none', width: 16, display: 'inline-block' }}>
                      {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                    </span>
                    {line.segments ? (
                      <DiffLineContent segments={line.segments} type={line.type} />
                    ) : (
                      line.content
                    )}
                  </td>
                </tr>
                {lineRecs?.map((rec, rIdx) => (
                  <tr key={`comment-${idx}-${rIdx}`}>
                    <td colSpan={colCount} style={{ padding: 0 }}>
                      <InlineComment
                        rec={rec}
                        onApplyFix={onApplyFix}
                        isApplying={applyingFixIdx !== null && applyingFixIdx !== undefined && allRecommendations?.[applyingFixIdx] === rec}
                      />
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {/* File-level recommendations without a specific line */}
      {recommendations && recommendations.filter(r => !r.line).length > 0 && (
        <div style={{ borderTop: '1px solid #21262d', padding: '8px 0' }}>
          {recommendations.filter(r => !r.line).map((rec, idx) => (
            <InlineComment
              key={`file-${idx}`}
              rec={rec}
              onApplyFix={rec.suggestedFix ? onApplyFix : undefined}
              isApplying={applyingFixIdx !== null && applyingFixIdx !== undefined && allRecommendations?.[applyingFixIdx] === rec}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── SPLIT DIFF ────────────────────────────────────────────────────────
interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

type SplitRowOrCollapsed = SplitRow | CollapsedSection;

function buildSplitRowsWithCollapse(items: DiffLineOrCollapsed[]): SplitRowOrCollapsed[] {
  const result: SplitRowOrCollapsed[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.type === 'collapsed') {
      result.push(item as CollapsedSection);
      i++;
      continue;
    }
    const line = item as DiffLine;
    if (line.type === 'context') {
      result.push({ left: line, right: line });
      i++;
    } else if (line.type === 'del') {
      const dels: DiffLine[] = [];
      while (i < items.length && (items[i] as DiffLine).type === 'del') { dels.push(items[i] as DiffLine); i++; }
      const adds: DiffLine[] = [];
      while (i < items.length && (items[i] as DiffLine).type === 'add') { adds.push(items[i] as DiffLine); i++; }
      const maxPairs = Math.max(dels.length, adds.length);
      for (let p = 0; p < maxPairs; p++) {
        result.push({ left: dels[p] || null, right: adds[p] || null });
      }
    } else {
      result.push({ left: null, right: line });
      i++;
    }
  }
  return result;
}

function SplitDiff({ file, recommendations, onApplyFix, applyingFixIdx, allRecommendations, confidenceMap }: {
  file: ChangeSetFileChange;
  recommendations?: ReviewRecommendation[];
  onApplyFix?: (rec: ReviewRecommendation) => void;
  applyingFixIdx?: number | null;
  allRecommendations?: ReviewRecommendation[];
  confidenceMap?: Map<number, ConfidenceEntry>;
}) {
  const allLines = useMemo(() => computeUnifiedDiff(file.before ?? null, file.after ?? null), [file]);
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());

  const displayItems = useMemo(() => {
    const collapsed = collapseContext(allLines);
    if (expandedSections.size === 0) return collapsed;
    const result: DiffLineOrCollapsed[] = [];
    for (const item of collapsed) {
      if (item.type === 'collapsed' && expandedSections.has((item as CollapsedSection).startIdx)) {
        for (let i = (item as CollapsedSection).startIdx; i < (item as CollapsedSection).endIdx; i++) {
          result.push(allLines[i]);
        }
      } else {
        result.push(item);
      }
    }
    return result;
  }, [allLines, expandedSections]);

  const splitRows = useMemo(() => buildSplitRowsWithCollapse(displayItems), [displayItems]);

  const handleExpand = useCallback((startIdx: number) => {
    setExpandedSections(prev => new Set([...prev, startIdx]));
  }, []);

  // Build line → recs map for after-side inline comments
  const lineRecsMap = useMemo(() => {
    const map = new Map<number, ReviewRecommendation[]>();
    if (!recommendations) return map;
    for (const rec of recommendations) {
      const patchLine = getRecommendationPatchLine(rec);
      if (patchLine) {
        const existing = map.get(patchLine) || [];
        existing.push(rec);
        map.set(patchLine, existing);
      }
    }
    return map;
  }, [recommendations]);

  const hasConfidence = confidenceMap && confidenceMap.size > 0;

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: '20px' }}>
      <div className="grid grid-cols-2">
        <div style={{ borderRight: '1px solid #30363d' }}>
          <div className="px-2.5 py-1.5" style={{ background: '#1c2128', fontSize: 11, color: '#6e7681', borderBottom: '1px solid #21262d' }}>
            {file.path} (before)
          </div>
        </div>
        <div>
          <div className="px-2.5 py-1.5" style={{ background: '#1c2128', fontSize: 11, color: '#6e7681', borderBottom: '1px solid #21262d' }}>
            {file.path} (after)
          </div>
        </div>
      </div>
      {splitRows.map((rowOrCollapsed, i) => {
        if ('count' in rowOrCollapsed && 'startIdx' in rowOrCollapsed) {
          const section = rowOrCollapsed as CollapsedSection;
          return (
            <div key={`collapsed-${i}`}>
              <button
                onClick={() => handleExpand(section.startIdx)}
                style={{
                  width: '100%', padding: '4px 12px', background: 'rgba(88,166,255,0.06)',
                  border: 'none', borderTop: '1px solid #21262d', borderBottom: '1px solid #21262d',
                  color: '#58a6ff', fontSize: 11, cursor: 'pointer', textAlign: 'center',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(88,166,255,0.12)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(88,166,255,0.06)'; }}
              >
                {'\u2193'} Show {section.count} hidden lines {'\u2193'}
              </button>
            </div>
          );
        }
        const row = rowOrCollapsed as SplitRow;
        const rightNewNum = row.right?.newNum;
        const lineRecs = rightNewNum ? lineRecsMap.get(rightNewNum) : undefined;
        const lineNum = rightNewNum ?? row.left?.oldNum ?? 0;
        const conf = hasConfidence ? confidenceMap!.get(lineNum) : undefined;
        return (
          <React.Fragment key={i}>
            <div className="grid grid-cols-2">
              {/* Left (old) */}
              <div className="flex" style={{
                borderRight: '1px solid #30363d',
                background: !row.left ? '#1c2128' : row.left.type === 'del' ? 'var(--diff-del-bg)' : (conf?.bg || 'transparent'),
              }}>
                {hasConfidence && (
                  <div style={{ width: 4, minWidth: 4, background: row.left?.type === 'del' ? 'transparent' : (conf?.color || 'transparent') }} />
                )}
                <div className="select-none text-right pr-2" style={{
                  width: 36, minWidth: 36, color: 'var(--text-tertiary)',
                  background: row.left?.type === 'del' ? 'var(--diff-del-line)' : 'transparent',
                }}>
                  {row.left?.oldNum || ''}
                </div>
                <div className="select-none text-center" style={{ width: 16, minWidth: 16, color: row.left?.type === 'del' ? 'var(--diff-del-symbol)' : 'var(--text-tertiary)' }}>
                  {row.left?.type === 'del' ? '\u2212' : ' '}
                </div>
                <div className="pl-1 flex-1" style={{ whiteSpace: 'pre' }}>
                  {row.left ? (
                    row.left.segments ? <DiffLineContent segments={row.left.segments} type={row.left.type} /> : row.left.content
                  ) : ''}
                </div>
              </div>
              {/* Right (new) */}
              <div className="flex" style={{
                background: !row.right ? '#1c2128' : row.right.type === 'add' ? 'var(--diff-add-bg)' : (conf?.bg || 'transparent'),
              }}>
                {hasConfidence && (
                  <div style={{ width: 4, minWidth: 4, background: row.right?.type === 'add' ? 'transparent' : (conf?.color || 'transparent') }} />
                )}
                <div className="select-none text-right pr-2" style={{
                  width: 36, minWidth: 36, color: 'var(--text-tertiary)',
                  background: row.right?.type === 'add' ? 'var(--diff-add-line)' : 'transparent',
                }}>
                  {row.right?.newNum || ''}
                </div>
                <div className="select-none text-center" style={{ width: 16, minWidth: 16, color: row.right?.type === 'add' ? 'var(--diff-add-symbol)' : 'var(--text-tertiary)' }}>
                  {row.right?.type === 'add' ? '+' : ' '}
                </div>
                <div className="pl-1 flex-1" style={{ whiteSpace: 'pre' }}>
                  {row.right ? (
                    row.right.segments ? <DiffLineContent segments={row.right.segments} type={row.right.type} /> : row.right.content
                  ) : ''}
                </div>
              </div>
            </div>
            {lineRecs?.map((rec, rIdx) => (
              <InlineComment
                key={`split-comment-${i}-${rIdx}`}
                rec={rec}
                onApplyFix={onApplyFix}
                isApplying={applyingFixIdx !== null && applyingFixIdx !== undefined && allRecommendations?.[applyingFixIdx] === rec}
              />
            ))}
          </React.Fragment>
        );
      })}
      {recommendations && recommendations.filter(r => !r.line).length > 0 && (
        <div style={{ borderTop: '1px solid #21262d', padding: '8px 0' }}>
          {recommendations.filter(r => !r.line).map((rec, idx) => (
            <InlineComment
              key={`split-file-${idx}`}
              rec={rec}
              onApplyFix={rec.suggestedFix ? onApplyFix : undefined}
              isApplying={applyingFixIdx !== null && applyingFixIdx !== undefined && allRecommendations?.[applyingFixIdx] === rec}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── RAW DIFF ──────────────────────────────────────────────────────────
function RawDiff({ file }: { file: ChangeSetFileChange }) {
  const rawText = useMemo(() => {
    const lines = computeUnifiedDiff(file.before ?? null, file.after ?? null);
    const header = [
      `--- a/${file.path}`,
      `+++ b/${file.path}`,
      `@@ -1,${(file.before ?? '').split('\n').length} +1,${(file.after ?? '').split('\n').length} @@`,
    ];
    const body = lines.map(line => {
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      return prefix + line.content;
    });
    return [...header, ...body];
  }, [file]);

  return (
    <pre style={{
      margin: 0, padding: 16, background: '#0d1117',
      fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: '20px',
      overflow: 'auto', minHeight: '100%',
    }}>
      {rawText.map((line, i) => {
        let color = '#8b949e';
        if (line.startsWith('+')) color = '#3fb950';
        else if (line.startsWith('-')) color = '#f85149';
        else if (line.startsWith('@@')) color = '#58a6ff';
        return (
          <div key={i} style={{ color, whiteSpace: 'pre' }}>{line}</div>
        );
      })}
    </pre>
  );
}

// ── SHIP-IT BAR (Pattern 9) ──────────────────────────────────────────
interface ShipItBarProps {
  changeset: ChangeSet;
  review?: ReviewResult | null;
  availableChecks?: AvailableChecks | null;
  shortCommitSha: (rawCommitSha: unknown) => string | null;
  isVerifying?: boolean;
  isCommitting?: boolean;
  onReview: () => void;
  onVerify: () => void;
  onCommit: () => void;
  onDeploy: () => void;
  onPush?: () => void;
  onRollback?: () => void;
  onExport?: () => void;
  isPushing?: boolean;
  isRollingBack?: boolean;
}

function ShipItBar({ changeset, review, availableChecks, shortCommitSha, isVerifying, isCommitting, onReview, onVerify, onCommit, onDeploy, onPush, onRollback, onExport, isPushing, isRollingBack }: ShipItBarProps) {
  type StepDef = { label: string; meta: string; status: 'done' | 'current' | 'pending'; action?: () => void; loading?: boolean; disabled?: boolean };

  const reviewed = changeset.reviewStatus === 'reviewed';
  const hasChecks = Boolean(availableChecks && (availableChecks.hasChecks || (availableChecks.checks?.length || 0) > 0 || availableChecks.lint || availableChecks.unit || availableChecks.e2e));
  const enabledCheckIds = availableChecks?.checks?.filter((check) => check.enabled !== false).map((check) => check.id) || [];
  const anyCheckFailed = Boolean(
    enabledCheckIds.length > 0
      ? enabledCheckIds.some((checkId) => changeset.verification?.checks?.[checkId]?.status === 'fail')
      : changeset.verification && (changeset.verification.lint === 'fail' || changeset.verification.unit === 'fail' || changeset.verification.e2e === 'fail')
  );
  const allChecksPassed = Boolean(
    hasChecks && changeset.verification && (
      enabledCheckIds.length > 0
        ? enabledCheckIds.every((checkId) => changeset.verification?.checks?.[checkId]?.status === 'pass')
        : changeset.verification.lint !== 'fail' && changeset.verification.unit !== 'fail' && changeset.verification.e2e !== 'fail'
    )
  );
  const verifyDone = !hasChecks || allChecksPassed;
  const shortSha = shortCommitSha(changeset.commitSha);
  const committed = !!shortSha;
  const published = changeset.status === 'published';
  const reviewRiskLabel = (
    review?.riskLevel === 'low'
    || review?.riskLevel === 'medium'
    || review?.riskLevel === 'high'
    || review?.riskLevel === 'critical'
  ) ? `${review.riskLevel} risk` : 'Reviewed';

  const steps: StepDef[] = [
    {
      label: 'Review',
      meta: reviewed ? reviewRiskLabel : 'Not reviewed',
      status: reviewed ? 'done' : 'current',
      action: reviewed ? undefined : onReview,
    },
    {
      label: 'Verify',
      meta: isVerifying ? 'Running...' : !hasChecks ? 'N/A — no scripts' : allChecksPassed ? 'Checks pass' : anyCheckFailed ? 'Failed' : 'Pending',
      status: verifyDone ? 'done' : reviewed ? 'current' : 'pending',
      action: hasChecks ? onVerify : undefined,
      loading: isVerifying,
      disabled: !reviewed || isVerifying,
    },
    {
      label: 'Commit',
      meta: isCommitting ? 'Committing...' : committed ? shortSha! : 'Waiting',
      status: committed ? 'done' : (reviewed && verifyDone) ? 'current' : 'pending',
      action: committed ? undefined : onCommit,
      loading: isCommitting,
      disabled: !reviewed || isCommitting,
    },
    {
      label: 'Deploy',
      meta: published ? 'Live' : 'Waiting',
      status: published ? 'done' : committed ? 'current' : 'pending',
      action: published ? undefined : onDeploy,
      disabled: !committed,
    },
  ];

  const stepColors = { done: '#3fb950', current: '#58a6ff', pending: '#6e7681' };
  const stepBg = { done: 'rgba(63,185,80,0.15)', current: 'rgba(88,166,255,0.15)', pending: '#21262d' };
  const icons = { Review: '\uD83D\uDC41', Verify: '\u2713', Commit: '\uD83D\uDCE6', Deploy: '\uD83D\uDE80' };

  // Action buttons (show after commit)
  const actionButtons: { label: string; icon: string; onClick?: () => void; loading?: boolean; disabled?: boolean; color: string }[] = [];
  if (committed) {
    if (onPush) {
      actionButtons.push({ label: 'Push', icon: '\u2B06', onClick: onPush, loading: isPushing, disabled: isPushing || isRollingBack, color: '#58a6ff' });
    }
    if (onRollback && changeset.status !== 'reverted') {
      actionButtons.push({ label: 'Rollback', icon: '\u21A9', onClick: onRollback, loading: isRollingBack, disabled: isPushing || isRollingBack, color: '#f85149' });
    }
    if (onExport) {
      actionButtons.push({ label: 'Export', icon: '\uD83D\uDCE5', onClick: onExport, disabled: false, color: '#8b949e' });
    }
  }

  return (
    <div className="flex-shrink-0" style={{ background: '#161b22', borderTop: '1px solid #30363d' }}>
      {/* Main Ship-It flow */}
      <div className="flex items-center px-5 py-2.5">
        {steps.map((step, idx) => {
          const isClickable = step.action && !step.disabled && step.status !== 'done';
          const tooltip = step.label === 'Verify' && !hasChecks
            ? 'No lint/test/e2e scripts found in package.json. Add scripts to enable verification.'
            : undefined;
          return (
            <div key={step.label} className="flex items-center">
              <div
                className={`flex flex-col items-center gap-1 min-w-[70px] ${isClickable ? 'cursor-pointer' : ''}`}
                title={tooltip}
                onClick={isClickable ? step.action : undefined}
                onMouseEnter={(e) => { if (isClickable) e.currentTarget.style.opacity = '0.85'; }}
                onMouseLeave={(e) => { if (isClickable) e.currentTarget.style.opacity = '1'; }}
              >
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm transition-all"
                  style={{
                    background: step.loading ? 'rgba(210,153,34,0.15)' : stepBg[step.status],
                    boxShadow: step.status === 'current' ? `0 0 0 2px ${stepColors.current}40` : 'none',
                  }}
                >
                  {step.loading ? (
                    <svg className="w-4 h-4 animate-spin" style={{ color: '#d29922' }} fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : step.status === 'done' ? '\u2713' : icons[step.label as keyof typeof icons]}
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, color: step.loading ? '#d29922' : stepColors[step.status] }}>{step.label}</div>
                <div style={{ fontSize: 10, color: anyCheckFailed && step.label === 'Verify' ? '#f85149' : '#6e7681' }}>{step.meta}</div>
                {isClickable && (
                  <div style={{ fontSize: 9, color: stepColors.current, marginTop: -2, fontWeight: 500 }}>Click to run</div>
                )}
              </div>
              {idx < steps.length - 1 && (
                <div className="flex-shrink-0 mb-7" style={{
                  width: 40, height: 2,
                  background: step.status === 'done' && steps[idx + 1].status !== 'pending'
                    ? 'linear-gradient(90deg, #3fb950, #58a6ff)'
                    : step.status === 'done' ? '#3fb950' : '#30363d',
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Action buttons row */}
      {actionButtons.length > 0 && (
        <div className="flex items-center gap-2 px-5 pb-2.5">
          {actionButtons.map((btn) => (
            <button
              key={btn.label}
              onClick={btn.disabled ? undefined : btn.onClick}
              disabled={btn.disabled}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors"
              style={{
                background: '#21262d',
                border: `1px solid ${btn.color}40`,
                color: btn.disabled ? '#484f58' : btn.color,
                cursor: btn.disabled ? 'not-allowed' : 'pointer',
                opacity: btn.disabled ? 0.5 : 1,
              }}
            >
              {btn.loading ? (
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <span>{btn.icon}</span>
              )}
              {btn.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── KEYBOARD SHORTCUTS PANEL (Pattern 8) ─────────────────────────────

const SHORTCUTS: { key: string; description: string }[] = [
  { key: 'J', description: 'Next file' },
  { key: 'K', description: 'Previous file' },
  { key: 'D', description: 'Cycle diff mode (unified / split / raw)' },
  { key: 'A', description: 'Cycle disclosure layer (verdict → walk → inline → deep)' },
  { key: 'R', description: 'Toggle risk heat-map overlay' },
  { key: '?', description: 'Toggle this shortcuts panel' },
  { key: 'Esc', description: 'Close panel / close review' },
];

function KeyboardShortcutsPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="rounded-lg overflow-hidden"
        style={{ width: 360, background: '#161b22', border: '1px solid #30363d', boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid #30363d' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#e6edf3' }}>Keyboard Shortcuts</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#292e36] transition-colors" style={{ color: '#8b949e' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="px-4 py-3 space-y-2">
          {SHORTCUTS.map(({ key, description }) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <span style={{ fontSize: 13, color: '#8b949e' }}>{description}</span>
              <kbd style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 28, height: 24, padding: '0 6px',
                background: '#0d1117', border: '1px solid #30363d', borderRadius: 4,
                fontSize: 12, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace",
                color: '#e6edf3', boxShadow: '0 1px 0 #21262d',
              }}>{key}</kbd>
            </div>
          ))}
        </div>
        <div className="px-4 py-2.5" style={{ borderTop: '1px solid #30363d', fontSize: 11, color: '#6e7681' }}>
          Press <kbd style={{ fontSize: 10, padding: '1px 4px', border: '1px solid #30363d', borderRadius: 3, background: '#0d1117' }}>?</kbd> to toggle
        </div>
      </div>
    </div>
  );
}

export default ReviewPanel;
